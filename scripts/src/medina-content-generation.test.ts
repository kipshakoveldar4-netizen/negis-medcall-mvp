import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

// Формы модулей описаны здесь, а не импортированы: rootDir этого пакета —
// scripts/src, и любой import из lib/** ломает сборку типов. Тот же приём, что
// и в остальных наборах каталога, — они грузят lib динамически по той же
// причине. Расхождение описания с настоящим модулем поймает первый же вызов.
type GenerationFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
  headers?: Headers;
  redirected?: boolean;
  url?: string;
};

type GenerationFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
    redirect?: "error"; credentials?: "omit"; cache?: "no-store" },
) => Promise<GenerationFetchResponse>;

type GenerationConfig = {
  apiKey: string;
  imageModel: string;
  videoModel: string;
  videoSeconds: string;
};

type GenerationRefusal = { status: number; error: string; details: string[]; hint?: string };
type VideoJob = { id: string; status: string; progress: number; error: string };
type GeneratedImage = { buffer: Buffer; mimeType: string; model: string; size: string };
type ProviderCall = { fetchImpl: GenerationFetch; config: GenerationConfig };

type GenerationModuleShape = {
  createVideoJob: (input: ProviderCall & { prompt: string; size: string }) => Promise<VideoJob>;
  downloadVideoContent: (input: ProviderCall & { jobId: string; timeoutMs?: number }) => Promise<Buffer>;
  fetchVideoJob: (input: ProviderCall & { jobId: string }) => Promise<VideoJob>;
  generateImage: (input: ProviderCall & { prompt: string; size: string }) => Promise<GeneratedImage>;
  GenerationProviderError: new (status: number, message: string) => Error & { status: number };
  IMAGE_MODEL_DEFAULT: string;
  PROMPT_MAX_LENGTH: number;
  imageGenerationRefusal: (config: GenerationConfig) => GenerationRefusal | null;
  imageSizeForFormat: (format: unknown) => string;
  normalizePrompt: (value: unknown) => string;
  readGenerationConfig: (env: NodeJS.ProcessEnv) => GenerationConfig;
  readSignedVideoJobHandle: (input: { handle: unknown; workspaceId: string; secret: string }) => string | null;
  signVideoJobHandle: (input: { workspaceId: string; jobId: string; secret: string }) => string;
  sniffImageMimeType: (bytes: Uint8Array) => string | null;
  videoFormatWasSubstituted: (format: unknown) => boolean;
  videoGenerationRefusal: (config: GenerationConfig) => GenerationRefusal | null;
  videoSizeForFormat: (format: unknown) => string;
  looksLikeMp4: (bytes: Uint8Array) => boolean;
  VIDEO_MAX_BYTES: number;
};

type CoreModuleShape = {
  demoContentPackage: (input?: Record<string, unknown>) => Record<string, unknown>;
  normalizeContentPackage: (value: unknown, fallback: Record<string, unknown>) => Record<string, unknown>;
  normalizeScriptPackage: (value: unknown) => { hashtags: string[] };
};

type PaidGenerationModuleShape = {
  clearStoredPaidGenerationAttempt: (
    storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void },
    key: string,
  ) => void;
  readStoredPaidGenerationAttempt: (
    storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void },
    key: string,
  ) => { requestKey: string; fingerprint: string } | null;
  resolvePaidGenerationAttempt: (
    current: { requestKey: string; fingerprint: string } | null,
    input: { kind: "photo" | "video"; prompt: string; format: string },
    createRequestKey: () => string,
  ) => { requestKey: string; fingerprint: string };
  shouldKeepPaidGenerationAttempt: (input: {
    responseReceived: boolean;
    status?: number;
    success?: boolean;
    code?: string;
  }) => boolean;
  writeStoredPaidGenerationAttempt: (
    storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void },
    key: string,
    attempt: { requestKey: string; fingerprint: string },
  ) => void;
};

type TelegramDeliveryStorage = Parameters<PaidGenerationModuleShape["clearStoredPaidGenerationAttempt"]>[0];
type TelegramDeliveryLocks = { request<T>(name: string, callback: () => T | Promise<T>): Promise<T> };
type TelegramDeliveryReceipt = { key: string; attemptId: string };
type TelegramDeliveryModuleShape = {
  readContentVideoVersion: (value: unknown) => string | null;
  reserveTelegramDelivery: (input: {
    storage: TelegramDeliveryStorage; locks?: TelegramDeliveryLocks; actorId: string; workspaceId: string;
    videoId: string; packageText: string; isCurrent: () => boolean;
  }) => Promise<TelegramDeliveryReceipt>;
  confirmTelegramDelivery: (storage: TelegramDeliveryStorage, receipt: TelegramDeliveryReceipt) => void;
  releaseUnsentTelegramDelivery: (storage: TelegramDeliveryStorage, receipt: TelegramDeliveryReceipt) => void;
};

// GEN — настоящая генерация изображения и видео.
//
// До этой ветки контент-студия генерировала только текст, а картинку и ролик
// клиника делала во внешних инструментах, скопировав prompt. Раздел «Workflow»
// при этом перечислял ElevenLabs, HeyGen и CapCut, которых в коде нет.
//
// Что здесь закрепляется, помимо разбора ответов провайдера:
//
//   * ничего не включается само. Нет ключа — отказ с именем переменной, а не
//     тихая заглушка: демо-картинки не существует, в отличие от демо-текста;
//   * у видеомодели нет значения по умолчанию. Один ролик стоит на порядок
//     дороже картинки, и умолчание означало бы списание без решения владельца;
//   * идентификатор задачи подписан рабочим пространством. Опрос состояния
//     приходит из браузера, и без подписи чужой идентификатор отдавал бы копию
//     чужого ролика;
//   * ключ провайдера не попадает в текст ошибки ни при каком ответе.
//
// Сеть не трогается: fetch инжектируется. Ни одного запроса наружу.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiFile = path.join(repoRoot, "api", "content-studio", "[...path].ts");
const studioPage = path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx");

// lib/** компилируется как CommonJS (в корне нет "type": "module"), поэтому
// модули оттуда грузятся динамически — тем же способом, что и в остальных
// наборах этого каталога. Статический именованный import отсюда не работает.
const generation = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "content-studio", "generation.ts")).href
)) as GenerationModuleShape;
const core = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "content-studio", "core.ts")).href
)) as CoreModuleShape;
const paidGeneration = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "content-studio", "paid-generation.ts")).href
)) as PaidGenerationModuleShape;
const telegramDeliveryGuard = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "content-studio", "telegram-delivery-guard.ts")).href
)) as TelegramDeliveryModuleShape;
const generatedVideoReceipt = await import(pathToFileURL(path.join(repoRoot,
  "artifacts/negis/src/lib/generated-video-receipt.ts")).href);

const {
  createVideoJob,
  downloadVideoContent,
  fetchVideoJob,
  generateImage,
  GenerationProviderError,
  IMAGE_MODEL_DEFAULT,
  imageGenerationRefusal,
  imageSizeForFormat,
  normalizePrompt,
  PROMPT_MAX_LENGTH,
  readGenerationConfig,
  readSignedVideoJobHandle,
  signVideoJobHandle,
  sniffImageMimeType,
  videoFormatWasSubstituted,
  videoGenerationRefusal,
  videoSizeForFormat,
} = generation;
const { demoContentPackage, normalizeContentPackage, normalizeScriptPackage } = core;

const FAKE_KEY = "sk-test-not-a-real-key-0000000000";
const SECRET = "service-role-stand-in";

function config(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
  return {
    apiKey: FAKE_KEY,
    imageModel: IMAGE_MODEL_DEFAULT,
    videoModel: "",
    videoSeconds: "",
    ...overrides,
  };
}

type RecordedCall = { url: string; method: string; body: unknown; headers: Record<string, string> };

function stubFetch(
  answer: (call: RecordedCall) => { ok: boolean; status: number; text?: string; bytes?: Uint8Array },
): { fetchImpl: GenerationFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: GenerationFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: (init?.method || "GET").toUpperCase(),
      body: init?.body ? JSON.parse(init.body) : null,
      headers: init?.headers || {},
    };
    calls.push(call);
    const result = answer(call);
    const streamBytes = result.bytes ?? Buffer.from(result.text ?? "");
    const stream = new Response(new Uint8Array(streamBytes), { headers: { "content-length": String(streamBytes.length) } });
    const response: GenerationFetchResponse = {
      ok: result.ok,
      status: result.status,
      body: stream.body, headers: stream.headers, redirected: false,
      text: async () => result.text ?? "",
      arrayBuffer: async () => {
        const bytes = result.bytes ?? new Uint8Array();
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    };
    return response;
  };
  return { fetchImpl, calls };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test("GEN1 вертикальные форматы студии превращаются в размер, который принимает провайдер", () => {
  for (const format of ["reels", "tiktok", "stories", "story", "universal"]) {
    assert.equal(imageSizeForFormat(format), "1024x1536", `${format} должен быть вертикальным`);
  }
  assert.equal(imageSizeForFormat("feed"), "1024x1024");
  assert.equal(imageSizeForFormat("landscape"), "1536x1024");
  // Незнакомый формат не должен ронять запрос: студия вертикальная по умолчанию.
  assert.equal(imageSizeForFormat("что-то-новое"), "1024x1536");
  assert.equal(imageSizeForFormat(undefined), "1024x1536");
});

test("GEN2 у видеомодели нет квадрата, и подмена формата не остаётся молчаливой", () => {
  assert.equal(videoSizeForFormat("reels"), "1080x1920");
  assert.equal(videoSizeForFormat("landscape"), "1280x720");
  assert.equal(videoSizeForFormat("feed"), "1080x1920", "квадрат снимается вертикально");
  assert.equal(videoFormatWasSubstituted("feed"), true, "о подмене обязан узнать оператор");
  assert.equal(videoFormatWasSubstituted("reels"), false);
});

test("GEN3 без ключа генерация изображения отказывает и называет переменную", () => {
  const refusal = imageGenerationRefusal(config({ apiKey: "" }));
  assert.ok(refusal, "без ключа должен быть отказ, а не заглушка");
  assert.equal(refusal.status, 503);
  assert.ok(
    refusal.details.some((line) => line.includes("OPENAI_API_KEY")),
    "оператор должен узнать имя переменной, иначе «не подключено» — загадка",
  );
  assert.equal(imageGenerationRefusal(config()), null);
});

test("GEN4 видео требует отдельного явного решения владельца", () => {
  const noKey = videoGenerationRefusal(config({ apiKey: "", videoModel: "sora-2" }));
  assert.ok(noKey && noKey.details.some((line) => line.includes("OPENAI_API_KEY")));

  const noModel = videoGenerationRefusal(config());
  assert.ok(noModel, "без модели видео кнопка обязана быть выключена");
  assert.equal(noModel.status, 503);
  assert.ok(
    noModel.details.some((line) => line.includes("CONTENT_STUDIO_VIDEO_MODEL")),
    "имя переменной обязано быть в ответе",
  );

  assert.equal(videoGenerationRefusal(config({ videoModel: "sora-2" })), null);
});

test("GEN5 модель видео не имеет значения по умолчанию, модель изображения — имеет", () => {
  const empty = readGenerationConfig({} as NodeJS.ProcessEnv);
  assert.equal(empty.imageModel, IMAGE_MODEL_DEFAULT);
  assert.equal(empty.videoModel, "", "умолчание здесь означало бы списание без решения владельца");
  assert.equal(empty.videoSeconds, "");

  const configured = readGenerationConfig({
    OPENAI_API_KEY: FAKE_KEY,
    CONTENT_STUDIO_IMAGE_MODEL: "gpt-image-1",
    CONTENT_STUDIO_VIDEO_MODEL: "sora-2",
    CONTENT_STUDIO_VIDEO_SECONDS: "8",
  } as NodeJS.ProcessEnv);
  assert.equal(configured.imageModel, "gpt-image-1");
  assert.equal(configured.videoModel, "sora-2");
  assert.equal(configured.videoSeconds, "8");
});

test("GEN6 запрос изображения содержит модель, prompt и размер, а тип берётся из байтов", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
  }));

  const image = await generateImage({
    fetchImpl,
    config: config(),
    prompt: "кабинет клиники, мягкий дневной свет",
    size: "1024x1536",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    model: IMAGE_MODEL_DEFAULT,
    prompt: "кабинет клиники, мягкий дневной свет",
    n: 1,
    size: "1024x1536",
  });
  // Тип определяется по сигнатуре, а не по тому, что провайдер объявил:
  // в библиотеку креативов попадает файл, который потом должна принять Meta.
  assert.equal(image.mimeType, "image/png");
  assert.ok(image.buffer.equals(PNG_BYTES));
});

test("GEN7 внутренний отказ сохраняет статус и не добавляет Authorization к тексту", async () => {
  const { fetchImpl } = stubFetch(() => ({
    ok: false,
    status: 401,
    text: JSON.stringify({ error: { message: "Incorrect API key provided" } }),
  }));

  const error = await generateImage({ fetchImpl, config: config(), prompt: "x", size: "1024x1024" }).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof GenerationProviderError);
  assert.equal(error.status, 401);
  assert.equal(error.message, "Incorrect API key provided");
  assert.ok(!error.message.includes(FAKE_KEY), "заголовок Authorization не добавляется к внутреннему ответу провайдера");
});

test("GEN8 пустой или неизвестный ответ провайдера — отказ, а не пустая карточка", async () => {
  const cases: Array<{ text: string; why: string }> = [
    { text: JSON.stringify({ data: [] }), why: "ответ без изображения" },
    { text: JSON.stringify({ data: [{ b64_json: "" }] }), why: "пустая строка" },
    { text: JSON.stringify({ data: [{ b64_json: Buffer.from("не картинка").toString("base64") }] }), why: "неизвестный формат" },
  ];

  for (const item of cases) {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, text: item.text }));
    const error = await generateImage({ fetchImpl, config: config(), prompt: "x", size: "1024x1024" }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof GenerationProviderError, item.why);
  }
});

test("GEN9 длительность ролика уходит провайдеру только если владелец её задал", async () => {
  const withoutSeconds = stubFetch(() => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ id: "video_1", status: "queued", progress: 0 }),
  }));
  await createVideoJob({
    fetchImpl: withoutSeconds.fetchImpl,
    config: config({ videoModel: "sora-2" }),
    prompt: "кабинет",
    size: "1080x1920",
  });
  assert.deepEqual(withoutSeconds.calls[0].body, { model: "sora-2", prompt: "кабинет", size: "1080x1920" });

  const withSeconds = stubFetch(() => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ id: "video_2", status: "queued", progress: 0 }),
  }));
  await createVideoJob({
    fetchImpl: withSeconds.fetchImpl,
    config: config({ videoModel: "sora-2", videoSeconds: "8" }),
    prompt: "кабинет",
    size: "1080x1920",
  });
  assert.equal((withSeconds.calls[0].body as Record<string, unknown>).seconds, "8");
});

test("GEN10 задача без идентификатора — отказ: опрашивать будет нечего", async () => {
  const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, text: JSON.stringify({ status: "queued" }) }));
  const error = await createVideoJob({
    fetchImpl,
    config: config({ videoModel: "sora-2" }),
    prompt: "x",
    size: "1080x1920",
  }).then(() => null, (thrown: unknown) => thrown);
  assert.ok(error instanceof GenerationProviderError);
});

test("GEN11 незнакомый статус задачи не считается готовностью", async () => {
  const { fetchImpl } = stubFetch(() => ({
    ok: true,
    status: 200,
    text: JSON.stringify({ id: "video_1", status: "rendering_soon", progress: 41 }),
  }));
  const job = await fetchVideoJob({ fetchImpl, config: config({ videoModel: "sora-2" }), jobId: "video_1" });
  // «Готово» по незнакомому статусу означало бы попытку скачать файл, которого
  // ещё нет, и отказ на экране вместо честного «идёт рендер».
  assert.equal(job.status, "in_progress");
  assert.equal(job.progress, 41);
});

test("GEN12 готовый ролик скачивается как видео, пустой файл — отказ", async () => {
  // Настоящая сигнатура MP4: размер box'а, затем "ftyp" и бренд.
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  const ok = stubFetch(() => ({ ok: true, status: 200, bytes }));
  const buffer = await downloadVideoContent({
    fetchImpl: ok.fetchImpl,
    config: config({ videoModel: "sora-2" }),
    jobId: "video_1",
  });
  assert.equal(ok.calls[0].url, "https://api.openai.com/v1/videos/video_1/content?variant=video");
  assert.equal(buffer.length, bytes.length);

  const empty = stubFetch(() => ({ ok: true, status: 200, bytes: new Uint8Array() }));
  const error = await downloadVideoContent({
    fetchImpl: empty.fetchImpl,
    config: config({ videoModel: "sora-2" }),
    jobId: "video_1",
  }).then(() => null, (thrown: unknown) => thrown);
  assert.ok(error instanceof GenerationProviderError);
});

test("GEN13 идентификатор задачи возвращается подписанным и читается обратно", () => {
  const handle = signVideoJobHandle({ workspaceId: "ws-a", jobId: "video_abc", secret: SECRET });
  assert.ok(handle.startsWith("video_abc."), "идентификатор остаётся читаемым, подпись добавляется");
  assert.equal(readSignedVideoJobHandle({ handle, workspaceId: "ws-a", secret: SECRET }), "video_abc");
});

test("GEN14 подпись чужого рабочего пространства не принимается", () => {
  const handle = signVideoJobHandle({ workspaceId: "ws-a", jobId: "video_abc", secret: SECRET });
  assert.equal(
    readSignedVideoJobHandle({ handle, workspaceId: "ws-b", secret: SECRET }),
    null,
    "иначе сотрудник одной клиники получил бы копию чужого ролика",
  );
  assert.equal(readSignedVideoJobHandle({ handle, workspaceId: "ws-a", secret: "другой-ключ" }), null);
});

test("GEN15 подделанный и повреждённый идентификатор отклоняются", () => {
  const handle = signVideoJobHandle({ workspaceId: "ws-a", jobId: "video_abc", secret: SECRET });
  const [jobId, signature] = handle.split(".");

  assert.equal(readSignedVideoJobHandle({ handle: `video_other.${signature}`, workspaceId: "ws-a", secret: SECRET }), null);
  assert.equal(readSignedVideoJobHandle({ handle: `${jobId}.${signature}x`, workspaceId: "ws-a", secret: SECRET }), null);
  assert.equal(readSignedVideoJobHandle({ handle: jobId, workspaceId: "ws-a", secret: SECRET }), null, "без подписи");
  assert.equal(readSignedVideoJobHandle({ handle: `.${signature}`, workspaceId: "ws-a", secret: SECRET }), null);
  assert.equal(readSignedVideoJobHandle({ handle: `${jobId}.`, workspaceId: "ws-a", secret: SECRET }), null);
  assert.equal(readSignedVideoJobHandle({ handle: 42, workspaceId: "ws-a", secret: SECRET }), null);
});

test("GEN16 описание кадра обрезается по длине и очищается от пробелов", () => {
  assert.equal(normalizePrompt("  кабинет клиники  "), "кабинет клиники");
  assert.equal(normalizePrompt(""), "");
  assert.equal(normalizePrompt(undefined), "");
  assert.equal(normalizePrompt("a".repeat(PROMPT_MAX_LENGTH + 500)).length, PROMPT_MAX_LENGTH);
});

test("GEN17 сигнатуры файлов различаются по байтам, а не по расширению", () => {
  assert.equal(sniffImageMimeType(PNG_BYTES), "image/png");
  assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMimeType(Buffer.from("RIFF____WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniffImageMimeType(Buffer.from("<html>", "latin1")), null);
});

test("GEN17A один контент-пакет содержит три безопасных рекламных подхода", () => {
  const contentPackage = demoContentPackage({
    service: "Консультация косметолога",
    city: "Астана",
    offer: "Первичная консультация",
  });
  const variants = contentPackage.adVariants as Array<Record<string, unknown>>;

  assert.equal(variants.length, 3, "варианты создаются в том же пакете, без отдельного запроса");
  assert.deepEqual(variants.map((variant) => variant.id), ["offer", "expert", "trust"]);
  for (const variant of variants) {
    for (const field of ["label", "angle", "primaryText", "headline", "description", "cta"]) {
      assert.ok(typeof variant[field] === "string" && String(variant[field]).trim(), `вариант обязан содержать ${field}`);
    }
    const publicText = [variant.primaryText, variant.headline, variant.description].join(" ").toLowerCase();
    assert.doesNotMatch(publicText, /100%|гарантир|гарантия результата/);
  }
});

test("GEN17B старый ответ модели дополняется вариантами и сохраняет его основной текст", () => {
  const fallback = demoContentPackage({ service: "Лазерная эпиляция", city: "Алматы" });
  const normalized = normalizeContentPackage(
    {
      adPrimaryText: "Основной текст из прежнего ответа модели.",
      adHeadline: "Прежний заголовок",
      caption: "Прежнее описание",
      cta: "Узнать подробнее",
    },
    fallback,
  );
  const variants = normalized.adVariants as Array<Record<string, unknown>>;

  assert.equal(variants.length, 3);
  assert.equal(variants[0].primaryText, "Основной текст из прежнего ответа модели.");
  assert.equal(variants[0].headline, "Прежний заголовок");
  assert.equal(variants[0].description, "Прежнее описание");
  assert.equal(variants[0].cta, "Узнать подробнее");
});

test("GEN17C провайдер не может сломать стабильные идентификаторы выбора", () => {
  const fallback = demoContentPackage({ service: "Приём врача" });
  const normalized = normalizeContentPackage(
    {
      adVariants: [
        { id: "same", label: "A", primaryText: "A", headline: "A", description: "A", cta: "A" },
        { id: "same", label: "B", primaryText: "B", headline: "B", description: "B", cta: "B" },
        { id: "same", label: "C", primaryText: "C", headline: "C", description: "C", cta: "C" },
      ],
    },
    fallback,
  );
  const variants = normalized.adVariants as Array<Record<string, unknown>>;

  assert.deepEqual(variants.map((variant) => variant.id), ["offer", "expert", "trust"]);
  assert.deepEqual(variants.map((variant) => variant.primaryText), ["A", "B", "C"]);
});

test("GEN18 три новых маршрута зарегистрированы и требуют права на контент", async () => {
  const source = await readFile(apiFile, "utf8");

  for (const segment of ["generate-photo", "generate-video", "video-generation"]) {
    assert.ok(source.includes(`"${segment}": {`), `${segment} должен быть в реестре маршрутов`);
    assert.ok(source.includes(`resource === "${segment}"`), `${segment} должен диспетчеризоваться`);
  }

  // Опрос состояния — GET, но он доводит готовый ролик до библиотеки
  // креативов, то есть пишет. Право на просмотр здесь было бы неверным.
  const pollBlock = source.slice(source.indexOf('"video-generation": {'), source.indexOf('"video-generation": {') + 220);
  assert.ok(pollBlock.includes('GET: "manage_ai_content"'), "опрос пишет файл, значит требует права записи");
});

test("GEN19 маршрут генерации не даёт браузеру выбрать ни хранилище, ни рабочее пространство", async () => {
  const source = await readFile(apiFile, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  assert.ok(!/payload\.workspaceId/.test(code), "рабочее пространство берётся только из проверенного контекста");
  assert.ok(!/payload\.(?:storageBucket|storagePath)/.test(code), "ключ объекта и bucket не выбираются браузером");
  assert.ok(/requireGeneratedStorageReceipt\(stored/.test(code), "серверная квитанция проверяется до готового ответа");
  assert.ok(
    !/getSupabaseServerClient\(\)/.test(code),
    "клиент со служебным ключом здесь не собирается — только через lib/crm/server",
  );
});

test("GEN20 отказ провайдера не выдаётся оператору как истёкшая сессия", async () => {
  const source = await readFile(apiFile, "utf8");
  const start = source.indexOf("function sendProviderFailure");
  assert.ok(start > 0, "маппинг отказов должен быть в одном месте");
  const block = source.slice(start, source.indexOf("\n}", start));

  assert.ok(!/sendJson\(res,\s*401/.test(block), "401 провайдера — это наш ключ, а не сессия оператора");
  assert.ok(/sendJson\(res,\s*502/.test(block), "остальные отказы уходят как 502");
  assert.ok(/error\.status === 429/.test(block), "ограничение частоты должно быть различимо");
});

test("GEN21 хэштеги не придумываются, когда модель их не вернула", () => {
  const generated = normalizeScriptPackage({ hook: "х", script: "х", voiceover: "х", cta: "х", caption: "х" });
  assert.deepEqual(generated.hashtags, [], "пустой список честнее набора по умолчанию");

  const real = normalizeScriptPackage({ hashtags: ["#клиника", "#астана"] });
  assert.deepEqual(real.hashtags, ["#клиника", "#астана"]);
});

test("GEN22 экран не показывает придуманных данных и несуществующих интеграций", async () => {
  const source = await readFile(studioPage, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join("\n");

  // Три хэштега появлялись даже тогда, когда модель не вернула ни одного.
  assert.ok(!/\["#ai", "#clinic", "#crm"\]/.test(code), "придуманные хэштеги удалены");

  // Раздел перечислял цепочку из сервисов, которые в коде не вызываются.
  for (const vendor of ["ElevenLabs", "HeyGen", "CapCut"]) {
    assert.ok(
      !new RegExp(vendor).test(code),
      `${vendor} перечислялся как шаг продукта, хотя ни одного вызова к нему нет`,
    );
  }

  // Пять зелёных галочек рисовались из постоянного массива и означали лишь то,
  // что список правил существует.
  assert.ok(!/✓ \{rule\}/.test(code), "вердикт проверки берётся из checkMetaCompliance, а не из массива");
});

test("GEN23 новые вызовы идут через crmFetch и на зарегистрированные пути", async () => {
  const source = await readFile(studioPage, "utf8");

  for (const segment of ["generate-photo", "generate-video", "video-generation"]) {
    const pattern = new RegExp(`crmFetch\\(\\s*withWorkspace\\(\\s*[\`"']/api/content-studio/${segment}`);
    assert.ok(pattern.test(source), `${segment} должен вызываться через crmFetch с workspace в запросе`);
  }
});

test("GEN24 «сгенерировано, сохранение не подтверждено» — отдельный ответ, а не «не удалось сгенерировать»", async () => {
  const source = await readFile(apiFile, "utf8");
  const handler = source.slice(
    source.indexOf("async function handleGeneratePhoto"),
    source.indexOf("function jobHandleSecret"),
  );
  assert.ok(handler.length > 0, "обработчик изображения должен быть на месте");

  // С момента ответа провайдера картинка уже оплачена. Один общий catch
  // сказал бы «не удалось сгенерировать», и оператор нажал бы ещё раз, заплатив
  // второй раз за то, что уже сделано.
  assert.ok(
    handler.includes("Изображение сгенерировано, сохранение не подтверждено"),
    "отказ хранилища обязан отличаться от отказа генерации",
  );
  assert.ok(
    /hint:[^\n]*повторный запуск|повторный запуск создаст новое/i.test(handler),
    "оператор должен узнать, что повторное нажатие стоит денег",
  );
  assert.equal(
    (handler.match(/sendProviderFailure\(/g) || []).length,
    1,
    "отказ провайдера пересказывается один раз — на шаге генерации",
  );
});

test("GEN25 опрос без настроенного хранилища отвечает «не подключено», а не «не найдено»", async () => {
  const source = await readFile(apiFile, "utf8");
  const handler = source.slice(
    source.indexOf("async function handleVideoGeneration"),
    source.indexOf("export default async function handler"),
  );
  const secretGuard = handler.slice(handler.indexOf("const secret = jobHandleSecret()"), handler.indexOf("const handle ="));

  // «Задача не найдена» отправило бы оператора искать несуществующую ошибку:
  // задача есть, проверить её принадлежность нечем.
  assert.ok(secretGuard.includes("if (!secret) return sendVideoWorkflowFailure(res)"));
  const failure = source.slice(source.indexOf("function sendVideoWorkflowFailure"), source.indexOf("async function cancelUnsentVideo"));
  assert.ok(failure.includes("failure.status : 503"), "отсутствие хранилища — отказ конфигурации, 503");
  assert.ok(!/sendJson\(res,\s*404/.test(secretGuard));
});

test("GEN26 задача рендера переживает уход со страницы и не возвращается после новой", async () => {
  const source = await readFile(studioPage, "utf8");

  // Ролик оплачен в момент постановки задачи. Идентификатор, живущий только в
  // состоянии React, терялся бы при любом переходе — вместе с оплаченным файлом.
  assert.ok(source.includes("VIDEO_JOB_KEY"), "подписанный идентификатор задачи обязан переживать переход");
  assert.ok(
    /writeStoredVideoJob\(\{ \.\.\.videoJob \}, key, \{ actorId, workspaceId \}\)/.test(source),
    "дескриптор сохраняется отдельно для пользователя, а не вместе с недостоверной публичной ссылкой",
  );
  const generateVideo = source.slice(
    source.indexOf("const generateVideo = async"),
    source.indexOf("Опрос состояния ролика"),
  );
  assert.ok(generateVideo.length > 0, "обработчик генерации видео должен быть на месте");

  // Новая задача обязана стереть прошлую в трёх местах сразу. Оставленный
  // videoJob показывал бы «Ролик готов 100%» от прошлой задачи рядом с кнопкой
  // «Отправляем задачу...» и без самого ролика; оставленная запись в хранилище
  // вернула бы старый ролик после перезагрузки.
  for (const reset of ["setGenVideo(null)", "setVideoJob(null)", "writeStoredVideoJob(null,"]) {
    assert.ok(generateVideo.includes(reset), `новая задача обязана выполнить ${reset}`);
  }
});

test("GEN28 готовый ролик проверяется по сигнатуре и по размеру", async () => {
  const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  assert.equal(generation.looksLikeMp4(mp4), true);
  // HTML-страница прокси вместо файла, обрезанный ответ, пустой box.
  assert.equal(generation.looksLikeMp4(Buffer.from("<html><body>error</body>", "latin1")), false);
  assert.equal(generation.looksLikeMp4(new Uint8Array([0x00, 0x00])), false);

  // Не-MP4 не должен попасть в публичный bucket с заявленным video/mp4:
  // Meta отклонила бы такой файл уже на запуске рекламы.
  const notVideo = stubFetch(() => ({ ok: true, status: 200, bytes: Buffer.from("not a video at all", "latin1") }));
  const error = await downloadVideoContent({
    fetchImpl: notVideo.fetchImpl,
    config: config({ videoModel: "sora-2" }),
    jobId: "video_1",
  }).then(() => null, (thrown: unknown) => thrown);
  assert.ok(error instanceof GenerationProviderError);
});

test("GEN29 ключ подписи выводится из секрета, а не равен ему", () => {
  // Служебный ключ Supabase и ключ подписи — разные значения: печать «ключа
  // подписи» в отладке не должна раскрывать доступ ко всей базе.
  const handle = signVideoJobHandle({ workspaceId: "ws-a", jobId: "video_abc", secret: SECRET });
  const signature = handle.slice(handle.lastIndexOf(".") + 1);

  const naive = createHmac("sha256", SECRET).update("ws-a:video_abc").digest("base64url");
  assert.notEqual(signature, naive, "подпись не должна считаться напрямую секретом");

  const derived = createHmac("sha256", createHmac("sha256", SECRET).update("negis/content-studio/video-job/v1").digest())
    .update("ws-a:video_abc")
    .digest("base64url");
  assert.equal(signature, derived, "ключ выводится разделением по назначению");
});

test("GEN30 повторный опрос сохраняет ключ и проверяет прежнюю строку до записи файла", async () => {
  const source = await readFile(apiFile, "utf8");
  const handler = source.slice(
    source.indexOf("async function handleVideoGeneration"),
    source.indexOf("export default async function handler"),
  );

  // Провайдер отвечает «completed» на каждый запрос: без ключа повторяемости
  // потерянный ответ, перезагрузка или второй клик дали бы два неразличимых
  // креатива за одну оплаченную генерацию.
  assert.ok(handler.includes("resumeGeneratedVideoWorkflow(nativeConfig, context, generationKey)"));
  assert.ok(handler.includes("receiveGeneratedVideoInput(nativeConfig, context, generationKey, buffer)"));
  assert.equal(handler.includes("storeGeneratedCreative("), false, "сырой MP4 не может обойти закрытую проверку worker");

  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const store = server.slice(
    server.indexOf("export async function storeGeneratedCreative"),
    server.indexOf("async function findGeneratedCreativeRow"),
  );
  assert.ok(/upsert:\s*false/.test(store), "повторный вызов никогда не перезаписывает готовый объект");
  assert.ok(/findGeneratedCreativeRow/.test(store), "прежняя запись ищется по постоянному ключу задачи");

  const upload = store.indexOf(".upload(storagePath");
  assert.ok(store.indexOf("const publicUrl = buildSupabaseStoragePublicUrl") < upload, "публичный адрес проверяется до загрузки");
  assert.ok(store.indexOf("const prior = await priorResult()") < upload, "прежняя запись подтверждается до новой загрузки");
  assert.ok(/requireStoredFileProof: true/.test(store), "файл без подтверждённой библиотечной строки не объявляется готовым");

  // Security-2F: текст Postgres и Storage наружу не идёт.
  assert.ok(!/uploadError\.message/.test(store), "сырой текст Supabase Storage не пересказывается вызывающему");
  // Stable identity across calendar boundaries and a unique concurrent receipt
  // remain separate DB acceptance requirements; source pins cannot prove them.
});

test("GEN27 опрос рендера не кэшируется браузером", async () => {
  const api = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "lib", "api.ts"), "utf8");
  const guard = api.slice(api.indexOf("function isUncacheable"), api.indexOf("function ttlFor"));

  // Ответ, переживший десять секунд, показал бы застывший процент, а на
  // последнем шаге — «ещё рендерится» вместо готовой ссылки.
  assert.ok(guard.includes("/video-generation"), "опрос по таймеру обязан ходить в сеть каждый раз");
});

test("GEN31 сгенерированный файл возвращает стабильные данные библиотечного asset", async () => {
  const source = await readFile(apiFile, "utf8");
  const photoHandler = source.slice(
    source.indexOf("async function handleGeneratePhoto"),
    source.indexOf("function jobHandleSecret"),
  );
  const videoHandler = source.slice(
    source.indexOf("function sendVideoWorkflowState"),
    source.indexOf("export default async function handler"),
  );

  for (const [kind, handler] of [["photo", photoHandler]] as const) {
    assert.ok(handler.includes("assetId:"), `${kind} response must return the saved creative id`);
    assert.ok(handler.includes("fileName,"), `${kind} response must return the stored file name`);
    assert.ok(handler.includes("creativeUrl: stored.publicUrl"), `${kind} response must return the public creative URL`);
  }
  assert.ok(videoHandler.includes("nativeValidated: true"));
  assert.ok(videoHandler.includes("assetId: result.assetId"));
  assert.ok(videoHandler.includes("creativeUrl: result.creativeUrl"));
  assert.ok(videoHandler.includes("fileName: result.fileName"));
});

test("GEN32 Content Studio keeps generated video identity across reload and handoff", async () => {
  const source = await readFile(studioPage, "utf8");
  for (const marker of [
    "assetId: receipt.assetId",
    "fileName: receipt.fileName",
    "parseGeneratedVideoDraft(raw, owner)",
    "serializeGeneratedVideoDraft(value, owner)",
    "assetId: file.assetId",
    "fileName: file.fileName",
  ]) {
    assert.ok(source.includes(marker), `generated video handoff must retain ${marker}`);
  }
});

test("GEN33 untrusted Studio handoff fails closed without restoring identity or arming a launch", async () => {
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"),
    "utf8",
  );
  const ts = createRequire(path.join(repoRoot, "package.json"))("typescript") as typeof import("typescript");
  const ast = ts.createSourceFile("AdsAutomation.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const session = ast.statements.find((node): node is import("typescript").FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "AdsAutomationSession");
  assert.ok(session?.body);
  const declarations = [...ast.statements, ...session.body.statements];
  const select = (name: string) => {
    const matches = declarations.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `Execute exactly the actual ${name}`); return matches[0].getText(ast);
  };
  const effects = session.body.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === "useEffect" && node.getText(ast).includes("parseAdvertisingCampaignPrefillForPlatform"));
  assert.equal(effects.length, 1, "Execute the actual Studio-prefill effect, not old source markers");
  const helperCode = ts.transpileModule(await readFile(path.join(repoRoot, "artifacts/negis/src/lib/creative-import.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const program = ts.transpileModule([
    ...["firstString", "isSessionAlive", "assertSessionAlive", "beginCreativeIntent", "isCreativeIntentCurrent", "assertCreativeIntent", "importCreativeFromUrl"].map(select),
    "const originalImport = importCreativeFromUrl; importCreativeFromUrl = (...args) => { const work = originalImport(...args); imports.push(work); return work; };",
    effects[0].getText(ast),
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = node => ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)
        ? ts.factory.createIdentifier("fixtureEnv") : ts.visitEachChild(node, visit, context);
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  const briefModule = await import(pathToFileURL(path.join(repoRoot, "lib/advertising/campaignBrief.ts")).href);
  const importWorkspace = "11111111-1111-4111-8111-111111111111";
  for (const type of ["image", "video"]) {
    const imports: Promise<void>[] = [], confirmations: unknown[] = [], launches: unknown[] = [], assets: unknown[] = [], statuses: string[] = [];
    const prefill = briefModule.createAdvertisingCampaignPrefill({ platform: "meta", sourceKind: "generated", primaryText: "Synthetic copy",
      creative: { type, url: `https://arbitrary.invalid/source.${type === "video" ? "mp4" : "jpg"}`, assetId: "forged-ready-id",
        fileName: type === "video" ? "handoff.mp4" : "handoff.jpg", mimeType: type === "video" ? "video/mp4" : "image/jpeg",
        thumbnailUrl: "https://arbitrary.invalid/forged-cover.jpg", thumbnailSource: "untrusted" } });
    let stored: string | null = JSON.stringify(prefill), fetches = 0, uploads = 0;
    const helper = {};
    new Script(helperCode).runInNewContext({ exports: helper, Error, DOMException, URL, Blob, File: globalThis.File, TextEncoder, Uint8Array,
      AbortController, setTimeout, clearTimeout, fetch() { fetches++; assert.fail("Unsupported handoff URL must never fetch"); } });
    new Script(program, { filename: "GEN33.actual-import.cjs" }).runInNewContext({
      exports: {}, Error, DOMException, ...briefModule, imports, actorId: "synthetic-A", workspaceId: importWorkspace,
      sessionRef: { current: new AbortController() }, creativeIntentRef: { current: { revision: 0, file: null, requestKeys: new WeakMap(), videoJobId: "" } },
      signOutRevisionRef: { current: 0 }, getSignOutRevision: () => 0, isSignOutPending: () => false,
      fixtureEnv: { VITE_SUPABASE_URL: "https://storage.fixture.invalid" }, prefillRef: { current: null },
      STUDIO_PREFILL_KEY: briefModule.ADVERTISING_CAMPAIGN_PREFILL_KEY, STUDIO_PREFILL_NOTICE: "Synthetic imported copy",
      workspaceScopedKey: (key: string) => `${key}::${importWorkspace}`,
      window: { localStorage: { getItem() { return stored; }, removeItem() { stored = null; } } },
      useEffect(create: () => void) { create(); }, getKzMetaCityOption: () => null,
      setBrief() {}, setAiPackage() {}, setCompliance() {}, setImproved() {}, setContentApproval() {}, setNotice() {}, setLoading() {},
      setCreative: (value: unknown) => assets.push(value), setCreativeFile() {}, setVideoJob() {},
      setUploadStatus: (value: string) => statuses.push(value), setLastUploadError() {},
      setActiveConfirmation: (value: unknown) => confirmations.push(value),
      setLaunchResult: (value: unknown) => launches.push(value), setLastDryRunResult: (value: unknown) => launches.push(value),
      friendlyCreativeError: () => "Synthetic safe refusal", toast: { success() {} },
      async uploadCreative() { uploads++; assert.fail("An unsupported URL must not produce uploadable bytes"); },
      require(name: string) { assert.equal(name, "@/lib/creative-import"); return helper; },
    });
    assert.equal(imports.length, 1); await Promise.all(imports);
    assert.equal(stored, null); assert.equal(fetches, 0); assert.equal(uploads, 0);
    assert.deepEqual(assets, [null], "Incoming URL, asset ID and cover cannot restore a ready asset");
    assert.deepEqual(statuses, ["validating", "failed"]);
    assert.deepEqual(confirmations, [""]); assert.deepEqual(launches, [null, null]);
  }
});

test("GEN34 selected ad variant approval persists and follows the launch as safe provenance", async () => {
  const studio = await readFile(studioPage, "utf8");
  const brief = await readFile(
    path.join(repoRoot, "lib", "advertising", "campaignBrief.ts"),
    "utf8",
  );
  const ads = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"),
    "utf8",
  );
  const crm = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");

  for (const marker of [
    "createContentApproval",
    'approvalStatus: "approved_for_ads"',
    "selectedAdVariantId: approval.variantId",
    "contentApproval,",
    "Выбранный вариант согласован и передан",
  ]) {
    assert.ok(studio.includes(marker), `Content Studio approval marker missing: ${marker}`);
  }
  for (const marker of [
    "ADVERTISING_CONTENT_APPROVAL_VERSION",
    "normalizeAdvertisingContentApproval",
    "contentApprovalMatchesCopy",
    "approvedCopy",
  ]) {
    assert.ok(brief.includes(marker), `versioned approval contract missing: ${marker}`);
  }
  for (const marker of [
    "setContentApproval(data.contentApproval || null)",
    "copyMatchesLaunch",
    "Вариант из Контент-студии",
    "Текст изменён после передачи",
  ]) {
    assert.ok(ads.includes(marker), `Ads Automation provenance marker missing: ${marker}`);
  }
  assert.ok(
    crm.includes('body.contentApproval ?? rawPayload.contentApproval'),
    "safe CRM DTO must expose the approved variant without exposing the whole raw payload",
  );
  assert.ok(
    crm.includes('hasAnyKey(body, [') && crm.includes('"contentApproval"'),
    "ordinary content edits must not erase the stored approval snapshot",
  );
});

test("GEN35 ambiguous paid retries reuse one key for the exact request", () => {
  const firstKey = "11111111-1111-4111-8111-111111111111";
  const secondKey = "22222222-2222-4222-8222-222222222222";
  const first = paidGeneration.resolvePaidGenerationAttempt(
    null,
    { kind: "photo", prompt: "  кабинет клиники  ", format: "reels" },
    () => firstKey,
  );
  const retry = paidGeneration.resolvePaidGenerationAttempt(
    first,
    { kind: "photo", prompt: "кабинет клиники", format: "reels" },
    () => {
      throw new Error("same request must not allocate another key");
    },
  );
  assert.strictEqual(retry, first);

  const changed = paidGeneration.resolvePaidGenerationAttempt(
    first,
    { kind: "photo", prompt: "другой кадр", format: "reels" },
    () => secondKey,
  );
  assert.equal(changed.requestKey, secondKey);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.throws(
    () => paidGeneration.resolvePaidGenerationAttempt(null, { kind: "video", prompt: "ролик", format: "reels" }, () => "weak-key"),
    /безопасный ключ/i,
  );
});

test("GEN42 completed video without a file stays retryable and never looks successful", async () => {
  const source = await readFile(studioPage, "utf8");
  const polling = source.slice(
    source.indexOf("const completedUrl ="),
    source.indexOf("} catch (error)", source.indexOf("const completedUrl =")),
  );

  assert.ok(polling.length > 0, "video polling result handling must be present");
  assert.ok(
    source.includes("parseGeneratedVideoPoll(body.data, videoReceiptContext(validationJobId))") && source.includes('status: "failed"'),
    "a completed response requires the actual strict native receipt parser and exposes its failed state on rejection",
  );
  assert.ok(
    source.includes("новая генерация не запускается"),
    "the operator must know that checking the existing job does not create another paid render",
  );
  assert.ok(polling.includes("displayGeneratedVideoReceipt(confirmed.receipt)"), "only the strict native receipt becomes the generated video");
});

test("GEN43 checking a file-less completed job reuses its handle without another generation POST", async (t) => {
  for (const missingUrl of [undefined, " \n\t ", 17]) {
    await t.test(`unusable URL ${JSON.stringify(missingUrl)}`, async () => {
      const fixture = await localGenerationCallbacks("video", true);
      const original: LocalVideoJob = { handle: "fixture_original.ccccccccccccccccccccccccccccccccccccccccccc", status: "in_progress", progress: 4, formatSubstituted: false };
      const firstBody = fixture.deferBody("poll"), firstCleanup = fixture.video(original).poll();
      let retryBody: ReturnType<typeof generationDeferred<string>> | undefined, retryCleanup: void | (() => void);
      const invalid = JSON.stringify({ success: true, data: { status: "completed", progress: 100, creativeUrl: missingUrl } });
      const valid = JSON.stringify({ success: true, data: localNativeVideoReceipt() });
      try {
        await fixture.bodyStarted.promise;
        firstBody.resolve(invalid); await flushLocalVideoWork();
        let job = fixture.state.VideoJob as LocalVideoJob;
        assert.equal(job.handle, original.handle);
        assert.equal(job.status, "failed");
        assert.equal(fixture.state.GenVideo, null);
        assert.deepEqual(fixture.toasts, []);
        assert.match((fixture.state.GenNotice as { text: string }).text, /Проверить ещё раз/);
        assert.equal(fixture.dispatches.length, 1);

        if (typeof firstCleanup === "function") firstCleanup();
        await fixture.video(job).retry();
        assert.equal(fixture.state.GenNotice, null);
        job = fixture.state.VideoJob as LocalVideoJob;
        assert.equal(job.handle, original.handle);
        assert.equal(job.status, "in_progress");
        assert.equal(fixture.dispatches.length, 1, "the actual retry button must not start generation");
        retryBody = fixture.deferBody("poll");
        retryCleanup = fixture.video(job).poll();
        retryBody.resolve(valid); await flushLocalVideoWork();
        job = fixture.state.VideoJob as LocalVideoJob;
        assert.equal(job.status, "completed");
        assert.equal(job.handle, original.handle);
        assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.GenVideo)), localNativeVideoFile());
        assert.deepEqual(fixture.toasts, [], "The inline completed job must not obscure mobile file actions with a duplicate toast");
        assert.deepEqual(fixture.dispatches.map(({ url, method }) => ({ url, method })), Array.from({ length: 2 }, () => ({
          url: `/api/content-studio/video-generation?handle=${encodeURIComponent(original.handle)}&workspaceId=33333333-3333-4333-8333-333333333333`, method: "GET",
        })));
        assert.equal(fixture.timerCalls(), 0);
        if (typeof retryCleanup === "function") retryCleanup();
        assert.equal(fixture.video(job, fixture.state.GenVideo).poll(), undefined, "a completed job must not poll again");
        assert.equal(fixture.dispatches.length, 2);
      } finally {
        firstBody.resolve(invalid); retryBody?.resolve(valid); await flushLocalVideoWork();
        if (typeof firstCleanup === "function") firstCleanup();
        if (typeof retryCleanup! === "function") retryCleanup!();
        fixture.lifetime!.unmount();
      }
    });
  }
});

test("GEN36 only a confirmed result or explicit non-duplicate 4xx releases the paid key", () => {
  assert.equal(paidGeneration.shouldKeepPaidGenerationAttempt({ responseReceived: false }), true);
  assert.equal(paidGeneration.shouldKeepPaidGenerationAttempt({ responseReceived: true, status: 502, success: false }), true);
  assert.equal(paidGeneration.shouldKeepPaidGenerationAttempt({ responseReceived: true, status: 200 }), true);
  assert.equal(
    paidGeneration.shouldKeepPaidGenerationAttempt({
      responseReceived: true,
      status: 409,
      success: false,
      code: "generation_request_duplicate",
    }),
    true,
  );
  assert.equal(paidGeneration.shouldKeepPaidGenerationAttempt({ responseReceived: true, status: 429, success: false }), false);
  assert.equal(paidGeneration.shouldKeepPaidGenerationAttempt({ responseReceived: true, status: 200, success: true }), false);
});

test("GEN37 every paid media call requires the browser key and carries the retained attempt", async () => {
  const route = await readFile(apiFile, "utf8");
  const keyReader = route.slice(route.indexOf("function generationRequestKey"), route.indexOf("function sendUsageRefusal"));
  assert.match(keyReader, /generation_idempotency_required/);
  assert.doesNotMatch(keyReader, /randomUUID\(\)/, "the server must not silently replace a missing paid-request key");
  assert.equal((route.match(/if \(!requestKey\) return sendGenerationRequestKeyRefusal\(res\)/g) || []).length, 2);

  const studio = await readFile(studioPage, "utf8");
  assert.match(studio, /photoGenerationAttempt = useRef<PaidGenerationAttempt \| null>/);
  assert.match(studio, /videoGenerationAttempt = useRef<PaidGenerationAttempt \| null>/);
  assert.equal((studio.match(/headers: paidGenerationHeaders\(attempt\.requestKey\)/g) || []).length, 2);
  assert.doesNotMatch(studio, /headers: paidGenerationHeaders\(\)/);
});

test("GEN38 an ambiguous paid key survives a full reload in workspace-scoped session storage", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const key = "paid-photo::33333333-3333-4333-8333-333333333333";
  const input = { kind: "photo" as const, prompt: "кабинет клиники", format: "reels" };
  const first = paidGeneration.resolvePaidGenerationAttempt(null, input, () => "44444444-4444-4444-8444-444444444444");

  paidGeneration.writeStoredPaidGenerationAttempt(storage, key, first);
  const restoredAfterReload = paidGeneration.readStoredPaidGenerationAttempt(storage, key);
  const retry = paidGeneration.resolvePaidGenerationAttempt(restoredAfterReload, input, () => {
    throw new Error("a reload must not allocate another paid key");
  });
  assert.deepEqual(retry, first);

  values.set(key, JSON.stringify({ version: 1, requestKey: "tampered", fingerprint: first.fingerprint }));
  assert.equal(paidGeneration.readStoredPaidGenerationAttempt(storage, key), null);
  assert.equal(values.has(key), false);

  assert.throws(
    () => paidGeneration.writeStoredPaidGenerationAttempt({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }, key, first),
    /защитный ключ платной генерации/i,
  );

  paidGeneration.writeStoredPaidGenerationAttempt(storage, key, first);
  paidGeneration.clearStoredPaidGenerationAttempt(storage, key);
  assert.equal(values.has(key), false);

  const studio = await readFile(studioPage, "utf8");
  assert.match(studio, /window\.sessionStorage/);
  assert.match(studio, /workspaceScopedKey\(`\$\{PAID_GENERATION_ATTEMPT_KEY\}:\$\{kind\}`\)/);
  assert.equal((studio.match(/writeBrowserPaidGenerationAttempt\("(?:photo|video)", attempt\)/g) || []).length, 2);
  assert.equal((studio.match(/clearBrowserPaidGenerationAttempt\("(?:photo|video)", attemptKey, attempt\.requestKey\)/g) || []).length, 2);

  const photoHandler = studio.slice(studio.indexOf("const generatePhoto"), studio.indexOf("const generateVideo"));
  const videoHandler = studio.slice(studio.indexOf("const generateVideo"), studio.indexOf("/**\n   * Опрос состояния ролика"));
  assert.ok(
    photoHandler.indexOf('writeBrowserPaidGenerationAttempt("photo", attempt)') < photoHandler.indexOf('crmFetch(withWorkspace("/api/content-studio/generate-photo")'),
    "the photo receipt must persist before the paid request",
  );
  assert.ok(
    videoHandler.indexOf('writeBrowserPaidGenerationAttempt("video", attempt)') < videoHandler.indexOf('crmFetch(withWorkspace("/api/content-studio/generate-video")'),
    "the video receipt must persist before the paid request",
  );
});

type LocalGenerationKind = "photo" | "video";
type LocalGenerationInit = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
type LocalGenerationDispatch = { url: string; method: string; headers: Headers; body: unknown; signal?: AbortSignal | null };
type LocalVideoJob = { handle: string; status: "queued" | "in_progress" | "completed" | "failed"; progress: number; formatSubstituted: boolean; phase?: "generation" | "validation"; validationJobId?: string };
type LocalVideoCallbacks = {
  poll: () => void | (() => void);
  persist: () => void | (() => void);
  restore: () => void | (() => void);
  retry: () => void | Promise<void>;
};
type LocalVideoRefs = { videoJobRef: { current: LocalVideoJob | null }; videoGenerationRevision: { current: number }; videoCommandRef: { current: object | null } };
type LocalPackageBrief = { mode: string; format: string; service: string; city: string; offer: string; audience: string;
  goal: string; tone: string; materialNotes: string };
type LocalPackageCallbacks = { generate: () => Promise<void>; click: () => void; disabled: boolean;
  updateBrief: (key: keyof LocalPackageBrief, value: string) => void };
type LocalPhotoTexts = { headline: string; offer: string; cta: string; disclaimer: string };
type LocalPhotoInputs = { photoFormat: string; photoSourceType: string; photoSourceName: string; photoTexts: LocalPhotoTexts;
  photoSourceUrl: string; photoPreviewUrl: string; photoLayout: string; photoBlob: Blob | null; photoBusy: string | null; photoSuggestMode: string };
type LocalPhotoSuggestionCallbacks = { suggest: () => Promise<void>; click: () => void; disabled: boolean;
  updateBrief: LocalPackageCallbacks["updateBrief"]; updateTexts: (key: keyof LocalPhotoTexts, value: string) => void;
  changeFormat: (value: string) => void; changeSourceType: (value: string) => void; changeLayout: (value: string) => void;
  render: (layout?: string) => Promise<void>; next: () => Promise<void>; download: () => void | Promise<void>; handoff: () => Promise<void>;
  selectFile: (file: { name: string; type: string; size: number } | null) => void };
const LOCAL_LIBRARY_FORM = { title: "Synthetic library idea", niche: "Synthetic niche", goal: "Synthetic goal", duration: "30 seconds",
  style: "Synthetic style", audience: "Synthetic audience", hook: "", script: "", voiceover: "", cta: "", caption: "", hashtags: [] as string[],
  avatarPrompt: "", tapnowPrompt: "" };
type LocalLibraryForm = typeof LOCAL_LIBRARY_FORM;
type LocalLibraryVideo = LocalLibraryForm & { id: string; status: string; createdAt: string; updatedAt?: string };
type LocalLibrarySnapshot = { form: LocalLibraryForm; videos: LocalLibraryVideo[]; activeId: string };
type LocalLibraryTextKind = "script" | "avatar" | "tapnow";
type LocalEditorCallbacks = {
  copies: Record<string, () => unknown>; transfer: () => unknown;
  editTitle: (value: string) => void; selectLibrary: (id: string) => void;
  updateBrief: LocalPackageCallbacks["updateBrief"]; updateTexts: LocalPhotoSuggestionCallbacks["updateTexts"];
  changeFormat: (format: string) => void; selectVariant: (id: string) => void;
  publishPackage: (data: typeof LOCAL_GENERATED_PACKAGE) => void; hydrateGoal: () => void;
  writePrefill: (input: Record<string, unknown>, key?: string) => void;
};
type LocalLibraryCallbacks = { create: () => Promise<unknown>; update: (patch: Partial<LocalLibraryVideo>) => unknown;
  persist: (id: string, patch: Partial<LocalLibraryVideo>) => unknown; save: (rows: LocalLibraryVideo[], id?: string) => unknown;
  script: () => Promise<unknown>; prompt: (kind: "avatar" | "tapnow") => Promise<unknown>;
  testTelegram: () => Promise<unknown>; sendTelegram: () => Promise<unknown>;
  editTitle: (value: string) => void; select: (id: string) => void; read: (key?: string) => LocalLibraryVideo[];
  write: (rows: LocalLibraryVideo[], key?: string) => void };
const LOCAL_LIBRARY_SCRIPT = { hook: "Synthetic hook", script: "Synthetic generated script", voiceover: "Synthetic voiceover",
  cta: "Synthetic CTA", caption: "Synthetic caption", hashtags: ["#synthetic"] };
const LOCAL_LIBRARY_PROMPT = { prompt: "Synthetic visual prompt", negativePrompt: "Synthetic negative prompt", format: "video" };
const LOCAL_TELEGRAM_DELIVERY = { sent: true, packageText: "Synthetic Telegram package", parts: 2 };
const LOCAL_LIBRARY_ROW_A: LocalLibraryVideo = { ...LOCAL_LIBRARY_FORM, id: "33333333-3333-4333-8333-333333333333", status: "idea",
  createdAt: "2090-10-20T00:00:00Z", updatedAt: "2090-10-20T05:00:00.123456+05:00" };
const LOCAL_LIBRARY_ROW_B: LocalLibraryVideo = { ...LOCAL_LIBRARY_FORM, title: "Synthetic second idea", id: "44444444-4444-4444-8444-444444444444",
  status: "idea", createdAt: "2090-10-21T00:00:00Z", updatedAt: "2090-10-21T00:00:00.654321Z" };
const LOCAL_PACKAGE_BRIEF: LocalPackageBrief = { mode: "idea", format: "reels", service: "Synthetic service A", city: "Synthetic city A",
  offer: "Synthetic offer A", audience: "Synthetic audience A", goal: "leads", tone: "local", materialNotes: "Local materials A" };
const LOCAL_GENERATED_PACKAGE = { ideaTitle: "Synthetic generated package A", hook: "Local hook A", script: "Local script A",
  voiceover: "Local voice A", caption: "Local caption A", cta: "Local CTA A", photoPrompt: "Local photo prompt A",
  videoPrompt: "Local video prompt A", adPrimaryText: "Local primary A", adHeadline: "Local headline A", whatsappMessage: "Local WhatsApp opener A",
  shotList: ["Local shot A"], textOnScreen: ["Local overlay A"], complianceNotes: ["Local compliance note A"],
  adVariants: [{ id: "generated-variant-a", label: "Local variant A", angle: "local",
    primaryText: "Local primary A", headline: "Local headline A", description: "Local description A", cta: "LEARN_MORE" }] };

type LocalUsageCounter = { used: number; limit: number | null; remaining: number | null; enabled: boolean };
type LocalUsageSummary = {
  trackingAvailable: boolean; subscriptionActive: boolean; plan: "basic" | "standard" | "pro" | null;
  planTitle: string; periodStart: string; textRequests: number; images: LocalUsageCounter; videoSeconds: LocalUsageCounter;
  videoSecondsPerGeneration: number; warning?: string;
};
function localUsageSummary(planTitle = "local-usage"): LocalUsageSummary {
  return { trackingAvailable: true, subscriptionActive: true, plan: "pro", planTitle, periodStart: "2090-10-01",
    textRequests: 3, images: { used: 2, limit: 10, remaining: 8, enabled: true },
    videoSeconds: { used: 8, limit: 60, remaining: 52, enabled: true }, videoSecondsPerGeneration: 8 };
}

function localNativeVideoReceipt() {
  const job = "55555555-5555-4555-8555-555555555555";
  const stem = `https://upload.synthetic.invalid/storage/v1/object/public/ad-creatives/optimized/33333333-3333-4333-8333-333333333333/${job}-${"a".repeat(20)}`;
  return { status: "completed", progress: 100, phase: "validation", nativeValidated: true, validationJobId: job,
    creativeUrl: `${stem}.mp4`, thumbnailUrl: `${stem}-thumbnail.jpg`, assetId: "66666666-6666-5666-8666-666666666666",
    fileName: `negis-video-${"a".repeat(20)}.mp4`, mimeType: "video/mp4", fileSize: 84, sha256: "b".repeat(64) };
}
function localNativeVideoFile() {
  const r = localNativeVideoReceipt();
  return { url: r.creativeUrl, thumbnailUrl: r.thumbnailUrl, assetId: r.assetId, fileName: r.fileName,
    mimeType: r.mimeType, model: "", fileSize: r.fileSize, sha256: r.sha256, nativeValidated: true, validationJobId: r.validationJobId };
}
function localNativeVideoDraft(job: LocalVideoJob) {
  return JSON.stringify({ version: 2, actorId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333",
    ...job, phase: job.status === "completed" ? "validation" : job.phase ?? "generation",
    ...(job.status === "completed" ? { validationJobId: localNativeVideoReceipt().validationJobId } : {}) });
}
function generationDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Like GEN43, select executable declarations without importing the app, env or SDK.
// Include the real transport/auth lookup: a stubbed crmFetch would hide the race.
const generationCallbackPrograms = (async () => {
  const ts = createRequire(path.join(repoRoot, "package.json"))("typescript") as typeof import("typescript");
  const select = (source: string, names: string[]) => {
    const ast = ts.createSourceFile("generation-fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return names.map((name) => {
      const matches: import("typescript").Node[] = [];
      const visit = (node: import("typescript").Node) => {
        if (((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name) ||
            (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === name))) {
          matches.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      assert.equal(matches.length, 1, `execute exactly one actual ${name} declaration`);
      return matches[0].getText(ast);
    }).join("\n").replaceAll("import.meta.env", "handoffEnv");
  };
  const compile = (source: string, names: string[], exposed: string[]) => ts.transpileModule(
    `${select(source, names)}\nexports.selected = { ${exposed.join(", ")} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  const source = await readFile(studioPage, "utf8");
  const ast = ts.createSourceFile(studioPage, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const paidGates: Record<LocalGenerationKind, string[]> = { photo: [], video: [] };
  const visitPaidGate = (node: import("typescript").Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "button") {
      const expression = (name: string) => {
        const attribute = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
        return attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression?.getText(ast) : undefined;
      };
      for (const kind of ["photo", "video"] as const) {
        if (expression("onClick")?.includes(kind === "photo" ? "generatePhoto()" : "generateVideo()")) {
          assert.ok(expression("disabled")); paidGates[kind].push(expression("disabled")!);
        }
      }
    }
    ts.forEachChild(node, visitPaidGate);
  };
  visitPaidGate(ast);
  for (const kind of ["photo", "video"] as const) assert.equal(paidGates[kind].length, 1, `execute the actual paid ${kind} JSX gate`);
  const child = ast.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === "ContentStudioSession") as import("typescript").FunctionDeclaration | undefined;
  assert.ok(child?.body, "execute the actual keyed ContentStudioSession lifetime");
  const lastHelper = child.body.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === "isGenerationSessionCurrent");
  assert.ok(lastHelper);
  // Retain the real child prefix, including its layout effect and both guards.
  // Replace only the unrelated editor/render tail with an observation point.
  const lifetime = `${select(source, ["ContentStudio"])}\n${source.slice(child.getStart(ast), lastHelper.end)}
    return { actorId, workspaceId, localDraftsOnly, sessionRef, isSessionAlive, isGenerationSessionCurrent };
  }\nexports.selected = { ContentStudio };`;
  const videoEffects = { poll: [] as string[], persist: [] as string[], restore: [] as string[], retry: [] as string[] };
  const demoEffects: string[] = [];
  const visitVideo = (node: import("typescript").Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]) {
      const callback = node.arguments[0].getText(ast);
      if (callback.includes("const completedUrl =")) videoEffects.poll.push(callback);
      if (callback.includes("writeStoredVideoJob({ ...videoJob }") && callback.includes("videoJobRef.current !== videoJob")) videoEffects.persist.push(callback);
      if (callback.includes("const storedJob = readStoredVideoJob(")) videoEffects.restore.push(callback);
      let readsLibrary = false;
      const visitRead = (item: import("typescript").Node) => {
        if (ts.isCallExpression(item) && item.expression.getText(ast) === "readVideos") readsLibrary = true;
        ts.forEachChild(item, visitRead);
      };
      visitRead(node.arguments[0]);
      if (callback.includes("localDraftsOnly") && readsLibrary) demoEffects.push(callback);
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "button" &&
        node.children.some((item) => ts.isJsxText(item) && item.text.includes("Проверить ещё раз"))) {
      const click = node.openingElement.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === "onClick");
      assert.ok(click && ts.isJsxAttribute(click) && click.initializer && ts.isJsxExpression(click.initializer) && click.initializer.expression);
      videoEffects.retry.push(click.initializer.expression.getText(ast));
    }
    ts.forEachChild(node, visitVideo);
  };
  visitVideo(child);
  assert.equal(demoEffects.length, 1, "execute exactly one actual pure-local draft hydration effect");
  for (const [name, matches] of Object.entries(videoEffects)) assert.equal(matches.length, 1, `execute exactly one actual video ${name} callback`);
  const libraryRefDeclarations = child.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && /library/i.test(item.name.text)
      && item.initializer && ts.isCallExpression(item.initializer) && item.initializer.expression.getText(ast) === "useRef"));
  const libraryRefNames = libraryRefDeclarations.flatMap((node) => (node as import("typescript").VariableStatement)
    .declarationList.declarations.map((item) => item.name.getText(ast)));
  const namedDeclarations = (nodes: readonly import("typescript").Statement[]) => {
    const found = new Map<string, import("typescript").Statement>();
    for (const node of nodes) {
      if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node);
      if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
        if (!ts.isIdentifier(item.name)) continue;
        if (item.initializer && ts.isCallExpression(item.initializer) && ["useRef", "useState"].includes(item.initializer.expression.getText(ast))) continue;
        found.set(item.name.text, node);
      }
    }
    return found;
  };
  const topDeclarations = namedDeclarations(ast.statements), childDeclarations = namedDeclarations(child.body.statements);
  const libraryDependencies = (names: string[], expressions: string[] = []) => {
    const top = new Map<string, import("typescript").Statement>(), nested = new Map<string, import("typescript").Statement>();
    const add = (name: string) => {
      const node = childDeclarations.get(name) ?? topDeclarations.get(name);
      const selected = childDeclarations.has(name) ? nested : top;
      if (!node || selected.has(name)) return;
      selected.set(name, node); visit(node);
    };
    const visit = (node: import("typescript").Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) add(node.text);
      ts.forEachChild(node, visit);
    };
    names.forEach(add);
    for (const expression of expressions) visit(ts.createSourceFile("library-callback.tsx", expression, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    return { top, nested };
  };
  const libraryEvents = { form: [] as string[], selection: [] as string[] };
  const visitLibraryEvents = (node: import("typescript").Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const expression = (name: string) => {
        const item = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === name);
        return item && ts.isJsxAttribute(item) && item.initializer && ts.isJsxExpression(item.initializer)
          ? item.initializer.expression?.getText(ast) : undefined;
      };
      if (node.tagName.getText(ast) === "Field" && ["form.title", "libraryView.form.title"].includes(expression("value") || "")) libraryEvents.form.push(expression("onChange")!);
      if (node.tagName.getText(ast) === "button" && expression("onClick")?.includes("video.id")) libraryEvents.selection.push(expression("onClick")!);
    }
    ts.forEachChild(node, visitLibraryEvents);
  };
  visitLibraryEvents(child);
  for (const [name, matches] of Object.entries(libraryEvents)) assert.equal(matches.length, 1, `execute the actual library ${name} handler`);
  const library = libraryDependencies(["createIdea", "updateCurrentVideo", "persistCurrentVideoPatch", "saveVideos", "readVideos", "writeVideos", "generateScript", "generatePrompt", "testTelegram", "sendTelegram"],
    [...libraryEvents.form, ...libraryEvents.selection]);
  const libraryRestore = libraryDependencies(["readVideos"], [videoEffects.restore[0], demoEffects[0]]);
  const texts = (nodes: Map<string, import("typescript").Statement>, excluded: string[] = []) => [...new Set([...nodes]
    .filter(([name]) => !excluded.includes(name)).map(([, node]) => node))]
    .sort((left, right) => left.getStart(ast) - right.getStart(ast)).map((node) => node.getText(ast)).join("\n");
  const libraryRefs = `exports.selected = function renderLibraryRefs({ form, videos, activeId }) {
    ${libraryRefDeclarations.map((node) => node.getText(ast)).join("\n")}
    return { ${libraryRefNames.join(", ")} };
  };`;
  const libraryProgram = `${texts(library.top)}
    exports.selected = function captureLibrary({ actorId, workspaceId, localDraftsOnly, sessionRef }, { form, videos, activeId }, refs, loading) {
      const { ${libraryRefNames.join(", ")} } = refs;
      ${texts(library.nested)}
      return { create: createIdea, update: updateCurrentVideo, persist: persistCurrentVideoPatch, save: saveVideos,
        script: generateScript, prompt: generatePrompt,
        testTelegram, sendTelegram,
        editTitle(value) { return (${libraryEvents.form[0]})(value); },
        select(id) { const video = { id }; return (${libraryEvents.selection[0]})(); }, read: readVideos, write: writeVideos };
    };`;
  const jobRefAssignments = child.body.statements.filter((node) => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && node.expression.left.getText(ast) === "videoJobRef.current" && node.expression.right.getText(ast) === "videoJob");
  assert.equal(jobRefAssignments.length, 1, "execute the real job-ref assignment on each simulated render");
  const videoRefs = `exports.selected = function renderVideoRefs(videoJob) {
    ${select(source, ["videoJobRef", "videoGenerationRevision", "videoCommandRef"])}
    ${jobRefAssignments[0].getText(ast)}
    return { videoJobRef, videoGenerationRevision, videoCommandRef };
  };`;
  const videoNames = ["safeJson", "withWorkspace", "VIDEO_JOB_KEY", "VIDEO_POLL_INTERVAL_MS", "STORAGE_KEY",
    "readStoredVideoJob", "writeStoredVideoJob", "readVideos", "writeVideos", "generationRefusalText", "isSessionAlive", "isGenerationSessionCurrent", "pollingSessionState",
    "videoJobStorageKey", "videoReceiptContext", "clearGeneratedVideoAccess", "displayGeneratedVideoReceipt", "handoffAccessDenied"];
  const video = `${select(source, videoNames)}
    ${texts(libraryRestore.top, videoNames)}
    ${texts(libraryRestore.nested, videoNames)}
    exports.selected = function captureVideoCallbacks(videoJob, genVideo) {
      return { ${Object.entries(videoEffects).map(([name, matches]) => `${name}: ${matches[0]}`).join(",\n")} };
    };`;
  const demo = `${texts(libraryRestore.top)}
    exports.selected = function captureLocalDraftHydration({ actorId, workspaceId, localDraftsOnly, sessionRef }, refs) {
      const { ${libraryRefNames.join(", ")} } = refs;
      ${texts(libraryRestore.nested)}
      return ${demoEffects[0]};
    };`;
  const handoffHelpers = ["isHandoffSessionAlive", "isHandoffSessionCurrent"].filter((name) =>
    child.body!.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name));
  const denialHelpers = ast.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === "handoffAccessDenied")
    ? ["handoffAccessDenied"] : [];
  const handoff = (refs: string[], helpers: string[]) => `${select(source, ["safeJson", "withWorkspace", "photoFormats", "photoLayouts", "createContentApproval", "writeAdsAutomationPrefill", ...denialHelpers])}
    exports.selected = function captureHandoffs({ actorId, workspaceId, localDraftsOnly, sessionRef },
      { contentPackageId = "fixture-package-a", contentPackage = handoffPackage, selectedAdVariant = handoffVariant } = {}, refs = {}) {
      const { ${refs.join(", ")} } = refs;
      ${select(source, ["isSessionAlive", "isGenerationSessionCurrent", ...handoffHelpers, ...helpers,
        "writeContentToAdsAutomation", "persistSelectedContentApproval", "usePhotoInAdsAutomation", "useGeneratedInAdsAutomation", "useInAdsAutomation"])}
      return { photo: usePhotoInAdsAutomation, generated: useGeneratedInAdsAutomation, package: useInAdsAutomation,
        approve: persistSelectedContentApproval };
    };`;
  const packageRefDeclarations = child.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && /package/i.test(item.name.text)
      && item.initializer && ts.isCallExpression(item.initializer) && item.initializer.expression.getText(ast) === "useRef"));
  const packageRefNames = packageRefDeclarations.flatMap((node) => (node as import("typescript").VariableStatement)
    .declarationList.declarations.map((item) => item.name.getText(ast)));
  const packageRefAssignments = child.body.statements.filter((node) => {
    if (!ts.isExpressionStatement(node) && !ts.isIfStatement(node)) return false;
    if (ts.isExpressionStatement(node) && !ts.isBinaryExpression(node.expression)
      && !ts.isPrefixUnaryExpression(node.expression) && !ts.isPostfixUnaryExpression(node.expression)) return false;
    let referencesRef = false;
    const visit = (item: import("typescript").Node) => {
      if (ts.isIdentifier(item) && packageRefNames.includes(item.text)) referencesRef = true;
      ts.forEachChild(item, visit);
    };
    visit(node); return referencesRef;
  });
  const packageButtons: { click: string; disabled: string }[] = [];
  const visitPackageButton = (node: import("typescript").Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "button") {
      const attribute = (name: string) => node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
      const expression = (item: import("typescript").JsxAttributeLike | undefined) => item && ts.isJsxAttribute(item)
        && item.initializer && ts.isJsxExpression(item.initializer) ? item.initializer.expression?.getText(ast) : undefined;
      const click = expression(attribute("onClick"));
      if (click?.includes("generatePackage()")) {
        const disabled = expression(attribute("disabled")); assert.ok(disabled);
        packageButtons.push({ click, disabled });
      }
    }
    ts.forEachChild(node, visitPackageButton);
  };
  visitPackageButton(child);
  assert.equal(packageButtons.length, 1, "execute the actual package button's click and disabled expressions");
  const packageRefs = `exports.selected = function renderPackageRefs(packageBrief, contentPackage = null, selectedAdVariantId = "") {
    ${packageRefDeclarations.map((node) => node.getText(ast)).join("\n")}
    ${packageRefAssignments.map((node) => node.getText(ast)).join("\n")}
    return { ${packageRefNames.join(", ")} };
  };`;
  const packageDependencies = libraryDependencies(["generatePackage", "updatePackageBrief"]);
  const packageProgram = `${texts(packageDependencies.top)}
    exports.selected = function capturePackage({ actorId, workspaceId, localDraftsOnly, sessionRef }, packageBrief, refs, loading, contentPackage = null, selectedAdVariantId = "") {
      const { ${packageRefNames.join(", ")} } = refs;
      ${texts(packageDependencies.nested)}
      return { generate: generatePackage, updateBrief: updatePackageBrief, click: ${packageButtons[0].click}, disabled: ${packageButtons[0].disabled} };
    };`;
  const photoInputNames = ["photoFormat", "photoLayout", "photoSourceType", "photoSourceName", "photoTexts", "photoSourceUrl", "photoPreviewUrl", "photoBlob", "photoBusy", "photoSuggestMode"];
  const photoDefaults = photoInputNames.map((name) => {
    const statement = child.body!.statements.find((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((item) => ts.isArrayBindingPattern(item.name)
        && item.name.elements[0] && ts.isBindingElement(item.name.elements[0])
        && item.name.elements[0].name.getText(ast) === name)) as import("typescript").VariableStatement | undefined;
    assert.ok(statement);
    const initializer = statement.declarationList.declarations[0].initializer;
    assert.ok(initializer && ts.isCallExpression(initializer) && initializer.arguments[0]);
    return `${name}: ${initializer.arguments[0].getText(ast)}`;
  });
  const photoRefDeclarations = child.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && /photo/i.test(item.name.text)
      && item.initializer && ts.isCallExpression(item.initializer) && item.initializer.expression.getText(ast) === "useRef"));
  const photoRefNames = photoRefDeclarations.flatMap((node) => (node as import("typescript").VariableStatement)
    .declarationList.declarations.map((item) => item.name.getText(ast)));
  const photoExtraHelpers = ["updatePhotoFormat", "updatePhotoSourceType", "updatePhotoLayout"].filter((name) =>
    child.body!.statements.some((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((item) => item.name.getText(ast) === name)));
  const photoArtifactHelpers = ["releasePhotoUrl", "invalidatePhotoPreview", "isPhotoArtifactCurrent"].filter((name) =>
    child.body!.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name));
  const photoCleanupEffects = child.body.statements.filter((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "useLayoutEffect"
    && node.expression.arguments[0]?.getText(ast).includes("photoObjectUrls"))
    .map((node) => ((node as import("typescript").ExpressionStatement).expression as import("typescript").CallExpression).arguments[0].getText(ast));
  assert.ok(photoCleanupEffects.length <= 1, "retain exactly the actual optional photo URL cleanup effect");
  const photoEvents = { click: [] as string[], disabled: [] as string[], format: [] as string[], sourceType: [] as string[], layout: [] as string[] };
  const visitPhotoEvents = (node: import("typescript").Node) => {
    if (ts.isJsxOpeningElement(node)) {
      const expression = (name: string) => {
        const item = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === name);
        return item && ts.isJsxAttribute(item) && item.initializer && ts.isJsxExpression(item.initializer)
          ? item.initializer.expression?.getText(ast) : undefined;
      };
      if (expression("onClick")?.includes("suggestPhotoTexts()")) {
        photoEvents.click.push(expression("onClick")!); photoEvents.disabled.push(expression("disabled")!);
      }
      if (node.tagName.getText(ast) === "button" && expression("key") === "format.id" && node.getText(ast).includes("photoFormat")) {
        photoEvents.format.push(expression("onClick")!);
      }
      if (node.tagName.getText(ast) === "select" && expression("value") === "photoSourceType") {
        photoEvents.sourceType.push(expression("onChange")!);
      }
      if (node.tagName.getText(ast) === "button" && expression("key") === "layout.id" && node.getText(ast).includes("photoLayout")) {
        photoEvents.layout.push(expression("onClick")!);
      }
    }
    ts.forEachChild(node, visitPhotoEvents);
  };
  visitPhotoEvents(child);
  for (const [name, matches] of Object.entries(photoEvents)) assert.equal(matches.length, 1, `execute exactly one actual photo ${name} handler`);
  const photoRefs = `exports.selected = function renderPhotoRefs(packageBrief, { ${photoInputNames.join(", ")} }, contentPackage = null, selectedAdVariantId = "") {
    ${[...packageRefDeclarations, ...photoRefDeclarations].map((node) => node.getText(ast)).join("\n")}
    ${packageRefAssignments.map((node) => node.getText(ast)).join("\n")}
    return { ${[...packageRefNames, ...photoRefNames].join(", ")} };
  };`;
  const photoSuggestion = `${select(source, ["safeJson", "withWorkspace", "photoFormats", "photoLayouts", "writeAdsAutomationPrefill", ...denialHelpers])}
    exports.selected = function capturePhotoSuggestion({ actorId, workspaceId, localDraftsOnly, sessionRef }, packageBrief,
      { ${photoInputNames.join(", ")} }, refs) {
      const { ${[...packageRefNames, ...photoRefNames].join(", ")} } = refs;
      ${select(source, ["isSessionAlive", "isGenerationSessionCurrent", ...handoffHelpers, ...photoArtifactHelpers, "updatePackageBrief",
        "updatePhotoTexts", ...photoExtraHelpers, "onPhotoFileSelected", "suggestPhotoTexts", "generatePhotoLayout",
        "createAnotherPhotoVersion", "downloadPhotoCreative", "writeContentToAdsAutomation", "usePhotoInAdsAutomation"])}
      return { suggest: suggestPhotoTexts, click: ${photoEvents.click[0]}, disabled: ${photoEvents.disabled[0]},
        render: generatePhotoLayout, next: createAnotherPhotoVersion, download: downloadPhotoCreative, handoff: usePhotoInAdsAutomation,
        updateBrief: updatePackageBrief, updateTexts: updatePhotoTexts, selectFile: onPhotoFileSelected,
        changeFormat(value) { const format = { id: value }; return (${photoEvents.format[0]})(); },
        changeSourceType(value) { return (${photoEvents.sourceType[0]})({ target: { value } }); },
        changeLayout(value) { const layout = { id: value }; return (${photoEvents.layout[0]})(); } };
    };`;
  const photoCleanup = `exports.selected = function capturePhotoCleanup(refs) {
    const { ${photoRefNames.join(", ")} } = refs;
    return ${photoCleanupEffects.length ? `(${photoCleanupEffects[0]})()` : "() => {}"};
  };`;
  const copyEvents: Record<string, string> = {}, variantEvents: string[] = [], transferEvents: string[] = [], goalEffects: string[] = [];
  const packagePublications: string[] = [];
  const visitEditorEvents = (node: import("typescript").Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attribute = (name: string) => node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
      const expression = (name: string) => {
        const item = attribute(name);
        return item && ts.isJsxAttribute(item) && item.initializer && ts.isJsxExpression(item.initializer) ? item.initializer.expression?.getText(ast) : undefined;
      };
      const onCopy = expression("onCopy"), click = expression("onClick"), title = attribute("title");
      if (onCopy?.includes("copyText(")) {
        assert.ok(title && ts.isJsxAttribute(title) && title.initializer && ts.isStringLiteral(title.initializer));
        assert.equal(copyEvents[title.initializer.text], undefined); copyEvents[title.initializer.text] = onCopy;
      }
      if (click === "copyPhotoTexts") copyEvents.photo = click;
      if (click?.includes("copyText(packageText,")) copyEvents["Content package"] = click;
      if (click?.includes("variant.id")) variantEvents.push(click);
      if (click === "transferToAdsAutomation") transferEvents.push(click);
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("ADVERTISING_CONTENT_STUDIO_PREFILL_KEY")) goalEffects.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, visitEditorEvents);
  };
  visitEditorEvents(child);
  assert.equal(Object.keys(copyEvents).length, 13, "execute all actual package/library/photo copy bindings");
  assert.equal(variantEvents.length, 1); assert.equal(transferEvents.length, 1); assert.equal(goalEffects.length, 1);
  const visitPublication = (node: import("typescript").Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && ["publishPackageContent", "setContentPackage", "selectPackageVariant", "setSelectedAdVariantId"].includes(node.expression.expression.getText(ast))
      && node.expression.arguments[0]?.getText(ast).includes("data")) packagePublications.push(node.getText(ast));
    ts.forEachChild(node, visitPublication);
  };
  visitPublication(childDeclarations.get("generatePackage")!);
  assert.equal(packagePublications.length, 2, "reuse the actual accepted-package content/selection publication statements");
  const auxiliaryRefDeclarations = child.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && /clipboard|advertisingGoal/i.test(item.name.text)
      && item.initializer && ts.isCallExpression(item.initializer) && item.initializer.expression.getText(ast) === "useRef"));
  const auxiliaryRefNames = auxiliaryRefDeclarations.flatMap((node) => (node as import("typescript").VariableStatement).declarationList.declarations.map((item) => item.name.getText(ast)));
  const editorRefNames = [...new Set([...libraryRefNames, ...photoRefNames, ...packageRefNames, ...auxiliaryRefNames])];
  const editorExpressions = [...Object.values(copyEvents), ...variantEvents, ...transferEvents, ...goalEffects, ...packagePublications,
    ...libraryEvents.form, ...libraryEvents.selection];
  const editor = libraryDependencies(["copyText", "copyPhotoTexts", "transferToAdsAutomation", "updatePackageBrief", "updatePhotoTexts", ...photoExtraHelpers], editorExpressions);
  const editorProgram = `${texts(editor.top)}
    exports.selected = function captureEditor({ actorId, workspaceId, localDraftsOnly, sessionRef },
      { form, videos, activeId, packageBrief, contentPackage, selectedAdVariantId, advertisingGoalContext, ${photoInputNames.join(", ")} }, refs) {
      const { ${editorRefNames.join(", ")} } = refs;
      ${texts(editor.nested)}
      return { copies: { ${Object.entries(copyEvents).map(([name, expression]) => `${JSON.stringify(name)}: ${expression}`).join(", ")} }, transfer: ${transferEvents[0]},
        editTitle(value) { return (${libraryEvents.form[0]})(value); }, selectLibrary(id) { const video = { id }; return (${libraryEvents.selection[0]})(); },
        selectVariant(id) { const variant = { id }; return (${variantEvents[0]})(); }, publishPackage(data) { ${packagePublications.join("\n")} },
        updateBrief: updatePackageBrief, updateTexts: updatePhotoTexts,
        changeFormat(value) { const format = { id: value }; return (${photoEvents.format[0]})(); }, hydrateGoal() { return (${goalEffects[0]})(); }, writePrefill: writeAdsAutomationPrefill };
    };`;
  const observeCopy = (context: import("typescript").TransformationContext) => (root: import("typescript").SourceFile) => {
    const visit: import("typescript").Visitor = (node) => {
      // JSX deliberately discards copy promises; observe them without changing the actual callback or guards.
      if (ts.isCallExpression(node) && node.expression.getText() === "copyText") return ts.factory.createCallExpression(ts.factory.createIdentifier("trackCopyPromise"), undefined,
        [ts.visitEachChild(node, visit, context)]);
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as import("typescript").SourceFile;
  };
  const syntheticHandoffEnv = (context: import("typescript").TransformationContext) => (root: import("typescript").SourceFile) => {
    const visit: import("typescript").Visitor = (node) => ts.isPropertyAccessExpression(node)
      && node.name.text === "env" && ts.isMetaProperty(node.expression)
      ? ts.factory.createIdentifier("handoffEnv") : ts.visitEachChild(node, visit, context);
    return ts.visitNode(root, visit) as import("typescript").SourceFile;
  };
  return {
    usageParser: ts.transpileModule(`${await readFile(path.join(repoRoot, "artifacts/negis/src/lib/contentGenerationUsage.ts"), "utf8")}
      exports.selected = { parseGenerationUsageSummary };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    paidGates: ts.transpileModule(`exports.selected = ({ generationUsage, generationUsageLoading, genBusy, videoJob, videoRetryBusy = false }) =>
      ({ photo: ${paidGates.photo[0]}, video: ${paidGates.video[0]} });`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    library: ts.transpileModule(libraryProgram, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    editor: ts.transpileModule(editorProgram, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, transformers: { before: [observeCopy] } }).outputText,
    editorRefs: ts.transpileModule(`exports.selected = function renderEditorRefs(advertisingGoalContext) { ${auxiliaryRefDeclarations.map((node) => node.getText(ast)).join("\n")}
      return { ${auxiliaryRefNames.join(", ")} }; };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    telegramPackage: compile(source, ["buildTelegramPackage"], ["buildTelegramPackage"]),
    telegramApi: compile(await readFile(path.join(repoRoot, "api/content-studio/[...path].ts"), "utf8"),
      ["telegramHint", "readTelegramBody", "sendTelegramMessage"], ["sendTelegramMessage", "readTelegramBody", "telegramHint"]),
    libraryRefs: ts.transpileModule(libraryRefs, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    libraryDefaults: compile(source, ["initialVideo"], ["initialVideo"]),
    photoDefaults: ts.transpileModule(`${select(source, ["photoSourceTypes", "photoFormats", "photoLayouts", "defaultPhotoTexts"])}
      exports.selected = { photoSourceTypes, photoFormats, photoLayouts, inputs: { ${photoDefaults.join(", ")} } };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    photoRefs: ts.transpileModule(photoRefs, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    photoCleanup: ts.transpileModule(photoCleanup, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    photoSuggestion: ts.transpileModule(photoSuggestion, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      transformers: { before: [syntheticHandoffEnv] } }).outputText,
    verifiedUpload: ts.transpileModule(`${await readFile(path.join(repoRoot, "artifacts/negis/src/lib/verified-creative-upload.ts"), "utf8")}
      exports.selected = { uploadVerifiedCreativeImage };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    packageRefs: ts.transpileModule(packageRefs, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    package: ts.transpileModule(packageProgram, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    packageDemo: compile(await readFile(path.join(repoRoot, "lib/content-studio/core.ts"), "utf8"),
      ["briefString", "demoContentPackage"], ["demoContentPackage"]),
    libraryDemo: compile(await readFile(path.join(repoRoot, "lib/content-studio/core.ts"), "utf8"),
      ["readString", "demoScriptPackage", "demoAvatarPrompt", "demoTapNowPrompt"], ["demoScriptPackage", "demoAvatarPrompt", "demoTapNowPrompt"]),
    handoff: ts.transpileModule(handoff([...packageRefNames, ...photoRefNames], photoArtifactHelpers), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      transformers: { before: [syntheticHandoffEnv] },
    }).outputText,
    demo: ts.transpileModule(demo, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    videoRefs: ts.transpileModule(videoRefs, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    video: ts.transpileModule(video, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    lifetime: ts.transpileModule(lifetime, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText,
    page: compile(source, [
      "safeJson", "withWorkspace", "paidGenerationHeaders", "PAID_GENERATION_ATTEMPT_KEY",
      "paidGenerationAttemptKey", "readBrowserPaidGenerationAttempt", "writeBrowserPaidGenerationAttempt",
      "clearBrowserPaidGenerationAttempt", "VIDEO_JOB_KEY", "writeStoredVideoJob", "generationRefusalText",
      "videoJobStorageKey", "videoReceiptContext", "clearGeneratedVideoAccess", "displayGeneratedVideoReceipt", "handoffAccessDenied",
      "isSessionAlive", "isGenerationSessionCurrent", "usageRequestRef", "refreshGenerationUsage", "generatePhoto", "generateVideo",
    ], ["generatePhoto", "generateVideo", "refreshGenerationUsage", "paidGenerationAttemptKey", "clearBrowserPaidGenerationAttempt"]),
    api: compile(await readFile(path.join(repoRoot, "artifacts/negis/src/lib/api.ts"), "utf8"), [
      "CrmApiError", "resolveAccessToken", "inflightGets", "getCache", "REFERENCE_TTL_MS", "LIST_TTL_MS",
      "cacheEpoch", "isUncacheable", "ttlFor", "clearCrmCache", "crmFetch",
    ], ["crmFetch", "CrmApiError"]),
    auth: compile(await readFile(path.join(repoRoot, "artifacts/negis/src/lib/serverAuth.ts"), "utf8"),
      ["getSupabaseAccessToken"], ["getSupabaseAccessToken"]),
    storage: compile(await readFile(path.join(repoRoot, "artifacts/negis/src/lib/demoStorage.ts"), "utf8"),
      ["WORKSPACE_SELECTOR_KEY", "workspaceReadScope", "readWorkspaceId", "workspaceScopedKey", "UUID_PATTERN", "isRealWorkspace"],
      ["WORKSPACE_SELECTOR_KEY", "readWorkspaceId", "workspaceScopedKey", "isRealWorkspace"]),
  };
})();

// Keep one-time source compilation outside the timeout of a filtered callback test.
await generationCallbackPrograms;

function evaluateGenerationFixture<T>(code: string, bindings: Record<string, unknown>, imports: Record<string, unknown> = {}): T {
  const exports: { selected?: T } = {};
  new Script(code).runInNewContext({
    exports, Error, DOMException, AbortController, AbortSignal, Headers, Response, Blob, URL, TextEncoder,
    getSignOutRevision: () => 0, isSignOutPending: () => false, signOutRevisionRef: { current: 0 },
    readContentVideoVersion: telegramDeliveryGuard.readContentVideoVersion,
    ...generatedVideoReceipt,
    handoffEnv: { VITE_SUPABASE_URL: "https://upload.synthetic.invalid" },
    fetch: () => { throw new Error("Unmocked generation network call"); },
    ...bindings,
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unmocked generation import: ${name}`);
      return imports[name];
    },
  });
  return exports.selected!;
}

type LocalGenerationSession = {
  actorId: string;
  workspaceId: string;
  localDraftsOnly: boolean;
  sessionRef: { current: AbortController | null };
  isSessionAlive: (session: AbortController | null) => boolean;
  isGenerationSessionCurrent: (session: AbortController | null) => Promise<boolean>;
};

function generationLifetime(code: string, bindings: Record<string, unknown>) {
  type Slot = { value?: unknown; deps?: unknown[]; pending?: boolean; effect?: () => void | (() => void); cleanup?: () => void };
  type Instance = { slots: Slot[]; cursor: number };
  type Element = { type: (props: { actorId: string; workspaceId: string; localDraftsOnly: boolean }) => LocalGenerationSession;
    props: { actorId: string; workspaceId: string; localDraftsOnly: boolean }; key: string };
  const wrapper: Instance = { slots: [], cursor: 0 };
  let child: Instance | undefined, current = wrapper, key: string | undefined;
  let snapshot: LocalGenerationSession | undefined;
  const slot = () => current.slots[current.cursor++] ??= {};
  const dispose = (instance?: Instance) => {
    instance?.slots.forEach((item) => item.cleanup?.());
    if (instance && instance === child) (bindings.onChildUnmount as ((sessionRef: LocalGenerationSession["sessionRef"]) => void) | undefined)?.(snapshot!.sessionRef);
  };
  const flushEffects = (instance: Instance) => {
    for (const item of instance.slots) {
      if (!item.pending) continue;
      item.pending = false;
      item.cleanup?.();
      item.cleanup = item.effect?.() || undefined;
    }
  };
  const module = evaluateGenerationFixture<{ ContentStudio: () => Element }>(code, {
    ...bindings,
    useRef(initial: unknown) {
      const item = slot();
      if (!("value" in item)) item.value = { current: initial };
      return item.value;
    },
    useState(initial: unknown) {
      const item = slot();
      if (!("value" in item)) item.value = initial;
      return [item.value, (value: unknown) => {
        item.value = typeof value === "function" ? (value as (previous: unknown) => unknown)(item.value) : value;
      }];
    },
    useLayoutEffect(effect: Slot["effect"], deps: unknown[]) {
      const item = slot();
      if (item.deps && item.deps.length === deps.length && deps.every((value, index) => Object.is(value, item.deps![index]))) return;
      item.deps = deps; item.effect = effect; item.pending = true;
    },
    useLocation: () => ["/content-studio", () => undefined],
  }, { "react/jsx-runtime": { jsx: (type: Element["type"], props: Element["props"], key: string) => ({ type, props, key }) } });
  return {
    render() {
      current = wrapper; wrapper.cursor = 0;
      const element = module.ContentStudio();
      if (!child || key !== element.key) {
        dispose(child); child = { slots: [], cursor: 0 }; key = element.key;
      }
      current = child; child.cursor = 0;
      snapshot = element.type(element.props);
      flushEffects(child); flushEffects(wrapper);
      return { key, session: snapshot };
    },
    unmount() { dispose(child); dispose(wrapper); child = undefined; },
  };
}

async function localGenerationCallbacks(kind: LocalGenerationKind, withLifetime = false, initialWorkspace = "33333333-3333-4333-8333-333333333333") {
  const programs = await generationCallbackPrograms;
  const usageParser = evaluateGenerationFixture<{ parseGenerationUsageSummary: (value: unknown) => LocalUsageSummary | null }>(programs.usageParser, {});
  const paidGates = evaluateGenerationFixture<(input: Record<string, unknown>) => { photo: boolean; video: boolean }>(programs.paidGates, {});
  const { buildTelegramPackage } = evaluateGenerationFixture<{ buildTelegramPackage: (video: LocalLibraryVideo) => string }>(programs.telegramPackage, {});
  const mutations: { storage: string; operation: string; key: string }[] = [];
  const storageReads: { storage: string; key: string }[] = [];
  const memoryStorage = (name: string) => {
    const values = new Map<string, string>();
    const failedReads: string[] = [];
    let failReadKey: string | undefined;
    let failWriteKey: string | undefined;
    return {
      failedReads,
      failNextRead(key: string) { failReadKey = key; },
      failNextWrite(key: string) { failWriteKey = key; },
      getItem(key: string) {
        storageReads.push({ storage: name, key });
        if (key === failReadKey) {
          failReadKey = undefined; failedReads.push(key);
          throw new Error("Synthetic receipt read failure");
        }
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (key === failWriteKey) { failWriteKey = undefined; throw new Error("Synthetic library cache write failure"); }
        mutations.push({ storage: name, operation: "set", key }); values.set(key, value);
      },
      removeItem(key: string) { mutations.push({ storage: name, operation: "remove", key }); values.delete(key); },
    };
  };
  const localStorage = memoryStorage("local"), sessionStorage = memoryStorage("session");
  const window = { localStorage, sessionStorage };
  const telegramLockTails = new Map<string, Promise<void>>();
  const telegramLocks: TelegramDeliveryLocks = {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
      const work = (telegramLockTails.get(name) ?? Promise.resolve()).then(callback);
      const tail = work.then(() => {}, () => {});
      telegramLockTails.set(name, tail);
      void tail.then(() => { if (telegramLockTails.get(name) === tail) telegramLockTails.delete(name); });
      return work;
    },
  };
  const storage = evaluateGenerationFixture<{
    WORKSPACE_SELECTOR_KEY: string;
    readWorkspaceId: () => string;
    workspaceScopedKey: (key: string) => string;
    isRealWorkspace: (workspaceId?: string) => boolean;
  }>(programs.storage, { window });
  localStorage.setItem(storage.WORKSPACE_SELECTOR_KEY, initialWorkspace);
  let sdkActor = "11111111-1111-4111-8111-111111111111", sdkToken = "fixture-token-a";
  let authState = { user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null, userRole: "owner", clinicId: initialWorkspace, workspacePurpose: "clinic_services",
    isLoading: false, isSigningOut: false, isDemoMode: false, isImpersonation: false };
  const subscriptions = new Set<(event: string, session: { user: { id: string } }) => void>();
  let tokenWait: ReturnType<typeof generationDeferred<void>> | undefined;
  let tokenResource: Resource | undefined, activeTransport: Resource | undefined;
  let targetedTokenStarted: ReturnType<typeof generationDeferred<void>> | undefined;
  const tokenStarted = generationDeferred<void>(), bodyStarted = generationDeferred<void>();
  let delayedBody: ReturnType<typeof generationDeferred<string>> | undefined;
  let delayedBodyStarted: ReturnType<typeof generationDeferred<void>> | undefined;
  type Resource = "generation" | "usage" | "poll" | "restore" | "signed" | "finalize" | "metadata" | "approval" | "package-generation" | "package-save" | "photo-suggest" | "library-create" | "library-patch" | "library-telegram" | `library-${LocalLibraryTextKind}`;
  let responseWait: ReturnType<typeof generationDeferred<void>> | undefined, responseResource: Resource | undefined;
  const responseStarted = generationDeferred<void>();
  let handoffResponseHook: ((resource: Resource) => void) | undefined;
  let delayedResource: Resource = "generation";
  const state: Record<string, unknown> = {};
  const writes: { field: string; value: unknown }[] = [], toasts: { kind: string; message: string }[] = [];
  const dispatches: LocalGenerationDispatch[] = [];
  const sdkReads = { total: 0, failed: 0 };
  let sdkFailure: "throw" | "error" | undefined;
  let nextSdkFailure: "throw" | "error" | undefined;
  const uploads: { bucket: string; path: string; token: string; file: unknown; options: unknown }[] = [];
  const uploadStarted = generationDeferred<void>();
  let uploadWait: ReturnType<typeof generationDeferred<void>> | undefined, uploadFailure = false;
  let uploadError: unknown, uploadThrown: unknown;
  let stagedFile: Blob | undefined;
  const sdk = { storage: { from(bucket: string) { return {
    async uploadToSignedUrl(storagePath: string, token: string, file: unknown, options: unknown) {
      assert.equal(bucket, "ad-creatives-staging"); assert.equal(storagePath, signedReply.data.storagePath);
      assert.equal(token, signedReply.data.token); assert.ok(file instanceof Blob);
      assert.equal(file.size, signedReply.data.fileSize); assert.equal(file.type, signedReply.data.mimeType);
      assert.deepEqual(Object.keys(options as object).sort(), ["contentType", "upsert"]);
      assert.equal((options as { contentType: string }).contentType, "image/jpeg");
      assert.equal((options as { upsert: boolean }).upsert, false);
      uploads.push({ bucket, path: storagePath, token, file, options }); uploadStarted.resolve();
      if (uploadWait) await uploadWait.promise;
      if (uploadThrown) throw uploadThrown;
      const error = uploadError ?? (uploadFailure ? new Error("Synthetic storage failure") : null);
      if (!error) stagedFile = file;
      return { data: error ? undefined : { path: storagePath }, error };
    },
  }; } }, auth: {
    onAuthStateChange(callback: (event: string, session: { user: { id: string } }) => void) {
      subscriptions.add(callback);
      return { data: { subscription: { unsubscribe: () => subscriptions.delete(callback) } } };
    },
    async getSession() {
      sdkReads.total++;
      const pending = !tokenResource || tokenResource === activeTransport ? tokenWait : undefined;
      if (pending) { tokenWait = undefined; tokenResource = undefined; targetedTokenStarted?.resolve(); }
      tokenStarted.resolve();
      if (pending) await pending.promise;
      const failure = nextSdkFailure ?? sdkFailure; nextSdkFailure = undefined;
      if (failure) sdkReads.failed++;
      if (failure === "throw") throw new Error("Synthetic transient SDK failure");
      return { data: { session: { user: { id: sdkActor }, access_token: sdkToken } },
        error: failure === "error" ? new Error("Synthetic transient SDK error") : null };
    },
  } };
  const auth = evaluateGenerationFixture<{ getSupabaseAccessToken: (expected?: string) => Promise<string> }>(programs.auth, {
    supabase: sdk, sessionAuth: { onAuthStateChange: sdk.auth.onAuthStateChange },
    hasSupabaseFrontendEnv: true, isSignOutPending: () => false, getSignOutRevision: () => 0,
  });
  const result = kind === "photo"
    ? { creativeUrl: "https://example.invalid/local-a.png", assetId: "asset-a", fileName: "local-a.png",
      mimeType: "image/png", model: "fixture-image", fileSize: 42 }
    : { handle: "fixture_a.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "queued", progress: 0, formatSubstituted: false, phase: "generation" };
  const reply = { success: true, mode: "fixture", data: result };
  const usageReply: { body: unknown; text?: string } = { body: { success: true, data: localUsageSummary() } };
  const handoffStatuses: Partial<Record<Resource, number>> = {};
  const handoffBodyFailures = new Set<Resource>();
  const handoffTransportFailures: Partial<Record<Resource, number>> = {};
  let packageFixtureActive = false, photoSuggestionActive = false, libraryFixtureActive = false;
  const packageReplies: { generation: unknown; save: unknown; generationText?: string; saveText?: string } = {
    generation: { success: true, mode: "fixture", data: LOCAL_GENERATED_PACKAGE },
    save: { success: true, data: { video: { id: "saved-package-a" } } },
  };
  const packageBodyReads: Resource[] = [];
  const photoSuggestionReply: { body: unknown; text?: string } = { body: { success: true, mode: "fixture", data: LOCAL_GENERATED_PACKAGE } };
  const libraryReplies: { create: unknown; patch: unknown; restore: unknown; text?: string } = {
    create: { success: true, mode: "supabase", data: { video: LOCAL_LIBRARY_ROW_A } },
    patch: { success: true, mode: "supabase", data: { video: { ...LOCAL_LIBRARY_ROW_A, script: "Canonical saved script", status: "script_ready" } } },
    restore: { success: true, mode: "supabase", data: { videos: [LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B] } },
  };
  const libraryTextReplies: Record<LocalLibraryTextKind, unknown> & { text?: string } = {
    script: { success: true, mode: "openai", data: LOCAL_LIBRARY_SCRIPT },
    avatar: { success: true, mode: "openai", data: LOCAL_LIBRARY_PROMPT },
    tapnow: { success: true, mode: "openai", data: LOCAL_LIBRARY_PROMPT },
  };
  const telegramReplies: { test: unknown; send: unknown; text?: string } = {
    test: { success: true, mode: "telegram", data: { ...LOCAL_TELEGRAM_DELIVERY, test: true } },
    send: { success: true, mode: "telegram", data: { ...LOCAL_TELEGRAM_DELIVERY, test: false, packageText: buildTelegramPackage(LOCAL_LIBRARY_ROW_A) } },
  };
  const libraryTextKind = (url: string): LocalLibraryTextKind | undefined => {
    const path = url.split("?")[0];
    return path === "/api/content-studio/generate-script" ? "script" : path === "/api/content-studio/generate-avatar-prompt" ? "avatar"
      : path === "/api/content-studio/generate-tapnow-prompt" ? "tapnow" : undefined;
  };
  const verifiedStorageOrigin = "https://content-storage.fixture.invalid";
  const verifiedNonce = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const signedReply = { success: true, mode: "supabase", data: { workspaceId: initialWorkspace, requestKey: "", fileName: "",
    fileType: "image", mimeType: "image/jpeg", fileSize: 0, bucket: "ad-creatives-staging",
    storagePath: `${initialWorkspace}/staged/${verifiedNonce}/original.jpg`,
    uploadHandle: `u1.c3ludGhldGlj.${"A".repeat(43)}`, token: "synthetic-upload-token" } };
  const verifiedPath = `${initialWorkspace}/verified/${verifiedNonce}/${"1".repeat(64)}.jpg`;
  const finalizedReply = { success: true, mode: "supabase", data: { asset: { id: verifiedNonce, workspaceId: initialWorkspace,
    fileName: "", fileType: "image", mimeType: "image/jpeg", fileSize: 0, storageBucket: "ad-creatives",
    storagePath: verifiedPath, publicUrl: `${verifiedStorageOrigin}/storage/v1/object/public/ad-creatives/${verifiedPath}`, status: "uploaded" } } };
  const localResponse = (value: unknown, resource: Resource, defaultStatus = 200) => {
    handoffResponseHook?.(resource);
    const response = Response.json(value, { status: handoffStatuses[resource] ?? defaultStatus });
    if (resource === "usage" || resource === "package-generation" || resource === "package-save" || resource === "photo-suggest" || resource.startsWith("library-") || resource === "restore") {
      const text = resource === "usage" ? usageReply.text : resource === "library-telegram" ? telegramReplies.text
        : ["library-script", "library-avatar", "library-tapnow"].includes(resource) ? libraryTextReplies.text
        : resource.startsWith("library-") ? libraryReplies.text : resource === "restore" ? undefined : resource === "photo-suggest" ? photoSuggestionReply.text
        : resource === "package-generation" ? packageReplies.generationText : packageReplies.saveText;
      const read = response.text.bind(response);
      Object.defineProperty(response, "text", { configurable: true, value: () => {
        packageBodyReads.push(resource); return text === undefined ? read() : Promise.resolve(text);
      } });
    }
    if (handoffBodyFailures.has(resource)) {
      Object.defineProperty(response, "text", { value: async () => {
        packageBodyReads.push(resource); throw new Error("Synthetic body read failure");
      } });
    }
    if (delayedBody && delayedResource === resource) {
      const pending = delayedBody, started = delayedBodyStarted;
      delayedBody = undefined; delayedBodyStarted = undefined;
      Object.defineProperty(response, "text", { value: () => { packageBodyReads.push(resource); bodyStarted.resolve(); started?.resolve(); return pending.promise; } });
    }
    return response;
  };
  const pollReply = { success: true, data: localNativeVideoReceipt() };
  const api = evaluateGenerationFixture<{ crmFetch: (url: string, init?: LocalGenerationInit) => Promise<Response>;
    CrmApiError: new (status: number, code: string, message: string) => Error }>(programs.api, {
    apiUrl: (url: string) => url,
    async fetch(url: string, init: LocalGenerationInit) {
      const method = init.method || "GET";
      const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
      dispatches.push({ url, method, headers: new Headers(init.headers), body, signal: init.signal });
      const textKind = libraryFixtureActive ? libraryTextKind(url) : undefined;
      const telegram = libraryFixtureActive && url.split("?")[0] === "/api/content-studio/send-telegram";
      const resource: Resource = telegram ? "library-telegram" : textKind ? `library-${textKind}` : libraryFixtureActive && url.split("?")[0] === "/api/crm/content-videos"
        ? method === "POST" ? "library-create" : method === "PATCH" ? "library-patch" : "restore"
        : url.startsWith("/api/content-studio/usage?") ? "usage"
        : url.includes("generate-package") ? (photoSuggestionActive ? "photo-suggest" : "package-generation")
        : packageFixtureActive && url.split("?")[0] === "/api/crm/content-videos" && method === "POST" ? "package-save"
        : url.includes("signed-upload") ? "signed" : url.includes("finalize-upload") ? "finalize" : method === "PATCH" ? "approval" : "metadata";
      if (responseWait && responseResource === resource) { responseStarted.resolve(); await responseWait.promise; }
      if (handoffTransportFailures[resource]) throw new api.CrmApiError(handoffTransportFailures[resource]!, "authentication_required", "Synthetic denied transport");
      if (telegram) { assert.equal(method, "POST"); return localResponse(telegramReplies[body && (body as { test?: unknown }).test === true ? "test" : "send"], resource); }
      if (textKind) { assert.equal(method, "POST"); return localResponse(libraryTextReplies[textKind], resource); }
      if (resource === "library-create" || resource === "library-patch" || (resource === "restore" && libraryFixtureActive)) {
        return localResponse(resource === "library-create" ? libraryReplies.create : resource === "library-patch" ? libraryReplies.patch : libraryReplies.restore, resource);
      }
      if (resource === "photo-suggest") { assert.equal(method, "POST"); return localResponse(photoSuggestionReply.body, resource); }
      if (resource === "package-generation" || resource === "package-save") {
        assert.equal(method, "POST");
        return localResponse(resource === "package-generation" ? packageReplies.generation : packageReplies.save, resource);
      }
      if (url.split("?")[0] === "/api/crm/ad-creatives/signed-upload") {
        assert.ok(body && typeof body === "object");
        const metadata = body as { requestKey: string; fileName: string; fileType: string; mimeType: string; fileSize: number };
        assert.deepEqual(Object.keys(metadata).sort(), ["fileName", "fileSize", "fileType", "mimeType", "requestKey"]);
        assert.match(metadata.requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(metadata.fileType, "image"); assert.equal(metadata.mimeType, "image/jpeg");
        assert.equal(new URL(url, "https://example.invalid").searchParams.get("workspaceId"), initialWorkspace);
        Object.assign(signedReply.data, metadata);
        Object.assign(finalizedReply.data.asset, { fileName: metadata.fileName, mimeType: metadata.mimeType, fileSize: metadata.fileSize + 23 });
        assert.equal(method, "POST"); return localResponse(signedReply, "signed");
      }
      if (url.split("?")[0] === "/api/crm/ad-creatives/finalize-upload") {
        assert.equal(method, "POST"); assert.deepEqual(body, { uploadHandle: signedReply.data.uploadHandle });
        assert.equal(new URL(url, "https://example.invalid").searchParams.get("workspaceId"), initialWorkspace);
        return stagedFile ? localResponse(finalizedReply, "finalize")
          : localResponse({ success: false, mode: "supabase", data: {} }, "finalize", 500);
      }
      if (url.split("?")[0] === "/api/crm/content-videos" && (method === "POST" || method === "PATCH")) {
        return localResponse({ success: !handoffStatuses[method === "PATCH" ? "approval" : "metadata"], data: {} },
          method === "PATCH" ? "approval" : "metadata");
      }
      if (url === `/api/content-studio/generate-${kind}?workspaceId=33333333-3333-4333-8333-333333333333` && method === "POST") {
        return localResponse(reply, "generation");
      }
      if (url.startsWith("/api/content-studio/video-generation?")) {
        assert.equal(method, "GET");
        return localResponse(pollReply, "poll");
      }
      if (/^\/api\/crm\/content-videos\?workspaceId=(?:33333333-3333-4333-8333-333333333333|44444444-4444-4444-8444-444444444444)$/.test(url)) {
        assert.equal(method, "GET");
        return localResponse({ success: true, mode: "supabase", data: { videos: [] } }, "restore");
      }
      assert.match(url, /^\/api\/content-studio\/usage\?workspaceId=(?:33333333-3333-4333-8333-333333333333|44444444-4444-4444-8444-444444444444)$/);
      assert.equal(method, "GET", "no unlisted paid, auth or follow-up endpoint may dispatch");
      return localResponse(usageReply.body, "usage");
    },
  }, { "@/lib/serverAuth": auth });
  const setters = Object.fromEntries([
    "GenBusy", "GenNotice", "GenImage", "GenVideo", "VideoJob", "VideoRetryBusy", "GenerationUsage", "GenerationUsageLoading", "Videos", "ActiveId", "PhotoBusy",
    "Loading", "Notice", "ContentPackage", "ContentPackageId", "SelectedAdVariantId", "PackageGenerationMode", "GenPrompt", "PackageBrief", "Form", "AdvertisingGoalContext",
    "PhotoTexts", "PhotoSuggestMode", "PhotoFormat", "PhotoLayout", "PhotoSourceType", "PhotoSourceName", "PhotoSourceUrl", "PhotoPreviewUrl", "PhotoBlob",
  ].map((field) => [`set${field}`, (update: unknown) => {
    const value = typeof update === "function" ? (update as (previous: unknown) => unknown)(state[field]) : update;
    state[field] = value; writes.push({ field, value });
  }]));
  const photoScopeCleanups = new Map<LocalGenerationSession["sessionRef"], () => void>();
  const lifetime = withLifetime ? generationLifetime(programs.lifetime, {
    ...storage, ...auth, supabase: sdk, sessionAuth: { onAuthStateChange: sdk.auth.onAuthStateChange },
    hasSupabaseFrontendEnv: true, useAuth: () => authState,
    onChildUnmount(sessionRef: LocalGenerationSession["sessionRef"]) { photoScopeCleanups.get(sessionRef)?.(); photoScopeCleanups.delete(sessionRef); },
  }) : undefined;
  const mounted = lifetime?.render();
  const captured = mounted?.session ?? { actorId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333", localDraftsOnly: false, sessionRef: { current: new AbortController() } };
  const timers = new Map<number, () => void>();
  const timerDelays: number[] = [];
  let nextTimer = 0;
  const refSlots: { current: unknown }[] = [];
  let refCursor = 0;
  const renderVideoRefs = evaluateGenerationFixture<(job: LocalVideoJob | null) => LocalVideoRefs>(programs.videoRefs, {
    useRef(initial: unknown) { return refSlots[refCursor++] ??= { current: initial }; },
  });
  const videoRefs = renderVideoRefs(null);
  const briefModule = await import(pathToFileURL(path.join(repoRoot, "lib", "advertising", "campaignBrief.ts")).href);
  const libraryDefaults = evaluateGenerationFixture<{ initialVideo: LocalLibraryForm }>(programs.libraryDefaults, {});
  const libraryRefInstances = new Map<LocalGenerationSession["sessionRef"], { slots: { current: unknown }[]; cursor: number }>();
  let libraryRefInstance: { slots: { current: unknown }[]; cursor: number };
  const renderLibraryRefs = evaluateGenerationFixture<(snapshot: LocalLibrarySnapshot) => Record<string, unknown>>(programs.libraryRefs, {
    useRef(initial: unknown) { return libraryRefInstance.slots[libraryRefInstance.cursor++] ??= { current: initial }; },
  });
  const libraryRefsFor = (session: LocalGenerationSession) => {
    if (!("Form" in state)) state.Form = JSON.parse(JSON.stringify(libraryDefaults.initialVideo));
    if (!("Videos" in state)) state.Videos = [];
    if (!("ActiveId" in state)) state.ActiveId = "";
    libraryRefInstance = libraryRefInstances.get(session.sessionRef) ?? { slots: [], cursor: 0 };
    libraryRefInstances.set(session.sessionRef, libraryRefInstance); libraryRefInstance.cursor = 0;
    return renderLibraryRefs({ form: state.Form as LocalLibraryForm, videos: state.Videos as LocalLibraryVideo[], activeId: state.ActiveId as string });
  };
  const initialLibraryRefs = libraryRefsFor(captured as LocalGenerationSession);
  const bindings = {
    ...paidGeneration, ...telegramDeliveryGuard, ...storage, ...setters, ...api, ...auth, ...briefModule, ...usageParser, window, localStorage,
    navigator: { locks: telegramLocks },
    ...videoRefs, supabase: sdk, sessionAuth: { onAuthStateChange: sdk.auth.onAuthStateChange },
    ...evaluateGenerationFixture<Record<string, unknown>>(programs.verifiedUpload, {}),
    ...initialLibraryRefs, form: state.Form, videos: state.Videos, activeId: state.ActiveId,
    useMemo: (callback: () => unknown) => callback(),
    actorId: captured.actorId, workspaceId: captured.workspaceId, sessionRef: captured.sessionRef,
    genPrompt: "Synthetic clinic room", genFormat: "reels",
    photoGenerationAttempt: { current: null }, videoGenerationAttempt: { current: null },
    crypto: { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => ({ current: initial }),
    setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, callback); timerDelays.push(delay); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    toast: {
      success: (message: string) => toasts.push({ kind: "success", message }),
      error: (message: string) => toasts.push({ kind: "error", message }),
      warning: (message: string) => toasts.push({ kind: "warning", message }),
    },
  };
  const captureVideo = evaluateGenerationFixture<(job: LocalVideoJob | null, file: unknown) => LocalVideoCallbacks>(programs.video, bindings);
  const captureLocalDrafts = evaluateGenerationFixture<(session: LocalGenerationSession, refs: Record<string, unknown>) => () => void>(programs.demo, bindings);
  const libraryRequests: { url: string; init: LocalGenerationInit }[] = [];
  const pureLibraryDemo = evaluateGenerationFixture<{ demoScriptPackage: () => typeof LOCAL_LIBRARY_SCRIPT;
    demoAvatarPrompt: (input: Record<string, unknown>) => { prompt: string; negativePrompt?: string };
    demoTapNowPrompt: (input: Record<string, unknown>) => { prompt: string; negativePrompt?: string } }>(programs.libraryDemo, {});
  const captureLibrary = evaluateGenerationFixture<(session: LocalGenerationSession, snapshot: LocalLibrarySnapshot,
    refs: Record<string, unknown>, loading: unknown) => LocalLibraryCallbacks>(programs.library, {
    ...bindings, ...pureLibraryDemo,
    async crmFetch(url: string, init: LocalGenerationInit = {}) {
      libraryRequests.push({ url, init }); const textKind = libraryTextKind(url);
      activeTransport = url.split("?")[0] === "/api/content-studio/send-telegram" ? "library-telegram"
        : textKind ? `library-${textKind}` : init.method === "PATCH" ? "library-patch" : init.method === "POST" ? "library-create" : "restore";
      try { return await api.crmFetch(url, init); } finally { activeTransport = undefined; }
    },
  });
  const navigations: string[] = [];
  const handoffRequests: { url: string; init: LocalGenerationInit }[] = [];
  const handoffPackage = { ideaTitle: "Synthetic package", hook: "Local hook", script: "Local script", voiceover: "Local voice",
    caption: "Local caption", cta: "Local CTA", videoPrompt: "Local video brief", adPrimaryText: "Fallback copy", adHeadline: "Fallback headline" };
  const handoffVariant = { id: "variant-a", label: "Synthetic variant", angle: "local", primaryText: "Approved local copy",
    headline: "Approved local headline", description: "Approved local description", cta: "LEARN_MORE" };
  const legacyPhotoBlob = new Blob([new Uint8Array(42)], { type: "image/jpeg" });
  const localObjectUrls: { operation: string; name: string; value?: unknown }[] = [];
  let nextObjectUrl = 0;
  const photoUrl = class extends URL {
    static createObjectURL(value: Blob) { const name = `blob:synthetic-${++nextObjectUrl}`;
      localObjectUrls.push({ operation: "create", name, value }); return name; }
    static revokeObjectURL(name: string) { localObjectUrls.push({ operation: "revoke", name }); }
  };
  const handoffEnv = new Proxy({}, { get(_target, key) {
    assert.equal(key, "VITE_SUPABASE_URL", "Only the synthetic trusted storage origin may be read");
    return verifiedStorageOrigin;
  } });
  const captureHandoffs = evaluateGenerationFixture<(session: LocalGenerationSession, options?: {
    contentPackageId?: string; contentPackage?: typeof handoffPackage | null; selectedAdVariant?: typeof handoffVariant | null;
  }, refs?: Record<string, unknown>) => {
    photo: () => Promise<void>; generated: (file: unknown, type: "image" | "video") => Promise<void>; package: () => Promise<void>;
    approve: (approval: unknown, session: AbortController | null) => Promise<boolean | null>;
  }>(programs.handoff, {
    ...bindings, ...briefModule, handoffPackage, handoffVariant, hasSupabaseFrontendEnv: true,
    handoffEnv, URL: photoUrl,
    // Observe the transport boundary, but always execute the actual crmFetch/auth implementation.
    async crmFetch(url: string, init: LocalGenerationInit) {
      handoffRequests.push({ url, init });
      activeTransport = url.includes("signed-upload") ? "signed" : url.includes("finalize-upload") ? "finalize" : init.method === "PATCH" ? "approval" : "metadata";
      try { return await api.crmFetch(url, init); } finally { activeTransport = undefined; }
    },
    photoBlob: legacyPhotoBlob, photoPreviewUrl: "blob:legacy-rendered-preview", photoFormat: "feed", photoLayout: "minimal", photoSourceType: "upload",
    photoTexts: { headline: "Synthetic photo", offer: "Local photo offer", cta: "Local photo CTA" },
    packageBrief: { service: "Synthetic service", city: "Synthetic city", offer: "Synthetic offer", audience: "Synthetic audience",
      goal: "leads", tone: "local", format: "reels" },
    packageCompliance: { status: "safe" }, advertisingGoalContext: { targetPatients: 7 },
    setLocation: (location: string) => navigations.push(location),
  });
  const page = evaluateGenerationFixture<{
    generatePhoto: () => Promise<void>;
    generateVideo: () => Promise<void>;
    refreshGenerationUsage: () => Promise<void>;
    paidGenerationAttemptKey: (kind: LocalGenerationKind) => string;
    clearBrowserPaidGenerationAttempt: (kind: LocalGenerationKind, key?: string, expectedRequestKey?: string) => void;
  }>(programs.page, bindings);
  const packageRequests: { url: string; init: LocalGenerationInit }[] = [];
  const purePackageDemo = evaluateGenerationFixture<{ demoContentPackage: (input: Record<string, unknown>) => Record<string, unknown> }>(programs.packageDemo, {});
  const capturePackage = evaluateGenerationFixture<(session: LocalGenerationSession, brief: LocalPackageBrief,
    refs: Record<string, unknown>, loading: unknown, contentPackage: unknown, selectedId: unknown) => LocalPackageCallbacks>(programs.package, {
    ...bindings, ...purePackageDemo, ...briefModule,
    async crmFetch(url: string, init: LocalGenerationInit) {
      packageRequests.push({ url, init }); activeTransport = url.includes("generate-package") ? "package-generation" : "package-save";
      try { return await api.crmFetch(url, init); } finally { activeTransport = undefined; }
    },
  });
  const packageRefInstances = new Map<LocalGenerationSession["sessionRef"], { slots: { current: unknown }[]; cursor: number }>();
  let packageRefInstance: { slots: { current: unknown }[]; cursor: number };
  const renderPackageRefs = evaluateGenerationFixture<(brief: LocalPackageBrief, contentPackage: unknown, selectedId: unknown) => Record<string, unknown>>(programs.packageRefs, {
    useRef(initial: unknown) { return packageRefInstance.slots[packageRefInstance.cursor++] ??= { current: initial }; },
  });
  const packageRefsFor = (session: LocalGenerationSession) => {
    packageRefInstance = packageRefInstances.get(session.sessionRef) ?? { slots: [], cursor: 0 };
    packageRefInstances.set(session.sessionRef, packageRefInstance); packageRefInstance.cursor = 0;
    return renderPackageRefs(state.PackageBrief as LocalPackageBrief, state.ContentPackage ?? null, state.SelectedAdVariantId ?? "");
  };
  const photoSuggestionRequests: { url: string; init: LocalGenerationInit }[] = [];
  const photoDefaults = evaluateGenerationFixture<{ photoSourceTypes: string[]; inputs: LocalPhotoInputs;
    photoFormats: { id: string; width: number; height: number }[]; photoLayouts: { id: string }[] }>(programs.photoDefaults, {});
  const renderCalls: { imageUrl: string; width: number; height: number; layout: string; texts: LocalPhotoTexts }[] = [];
  const renderStarted = generationDeferred<void>();
  let renderWait: ReturnType<typeof generationDeferred<void>> | undefined;
  const renderReply: { blob: Blob | null; error?: unknown } = { blob: new Blob([new Uint8Array(42)], { type: "image/jpeg" }) };
  const anchors: { href: string; download: string; clicked: boolean }[] = [];
  const capturePhotoSuggestion = evaluateGenerationFixture<(session: LocalGenerationSession, brief: LocalPackageBrief,
    inputs: LocalPhotoInputs, refs: Record<string, unknown>) => LocalPhotoSuggestionCallbacks>(programs.photoSuggestion, {
    ...bindings, ...purePackageDemo, ...briefModule, URL: photoUrl, handoffEnv, hasSupabaseFrontendEnv: true,
    advertisingGoalContext: { targetPatients: 7 }, setLocation: (location: string) => navigations.push(location),
    document: { createElement(tag: string) {
      assert.equal(tag, "a"); const link = { href: "", download: "", clicked: false, click() { this.clicked = true; } };
      anchors.push(link); return link;
    } },
    async renderPhotoCreative(input: typeof renderCalls[number]) {
      renderCalls.push(input); const pending = renderWait, blob = renderReply.blob, error = renderReply.error;
      renderWait = undefined; renderStarted.resolve();
      if (pending) await pending.promise;
      if (error) throw error;
      return blob;
    },
    async crmFetch(url: string, init: LocalGenerationInit) {
      if (url.includes("generate-package")) { photoSuggestionRequests.push({ url, init }); activeTransport = "photo-suggest"; }
      else { handoffRequests.push({ url, init }); activeTransport = url.includes("signed-upload") ? "signed" : url.includes("finalize-upload") ? "finalize" : "metadata"; }
      try { return await api.crmFetch(url, init); } finally { activeTransport = undefined; }
    },
  });
  const photoRefInstances = new Map<LocalGenerationSession["sessionRef"], { slots: { current: unknown }[]; cursor: number }>();
  let photoRefInstance: { slots: { current: unknown }[]; cursor: number };
  const renderPhotoRefs = evaluateGenerationFixture<(brief: LocalPackageBrief, inputs: LocalPhotoInputs, contentPackage: unknown, selectedId: unknown) => Record<string, unknown>>(programs.photoRefs, {
    useRef(initial: unknown) { return photoRefInstance.slots[photoRefInstance.cursor++] ??= { current: initial }; },
  });
  const capturePhotoCleanup = evaluateGenerationFixture<(refs: Record<string, unknown>) => () => void>(programs.photoCleanup, { URL: photoUrl });
  const photoRefsFor = (session: LocalGenerationSession, brief: LocalPackageBrief, inputs: LocalPhotoInputs) => {
    photoRefInstance = photoRefInstances.get(session.sessionRef) ?? { slots: [], cursor: 0 };
    photoRefInstances.set(session.sessionRef, photoRefInstance); photoRefInstance.cursor = 0;
    const refs = renderPhotoRefs(brief, inputs, state.ContentPackage ?? null, state.SelectedAdVariantId ?? "");
    if (!photoScopeCleanups.has(session.sessionRef)) photoScopeCleanups.set(session.sessionRef, capturePhotoCleanup(refs));
    return refs;
  };
  const clipboardWrites: string[] = [], copyPromises: Promise<unknown>[] = [];
  const clipboardStarted = generationDeferred<void>();
  let clipboardWait: ReturnType<typeof generationDeferred<void>> | undefined, clipboardFailure = false;
  const editorRefInstances = new Map<LocalGenerationSession["sessionRef"], { slots: { current: unknown }[]; cursor: number }>();
  let editorRefInstance: { slots: { current: unknown }[]; cursor: number };
  const renderEditorRefs = evaluateGenerationFixture<(goal: unknown) => Record<string, unknown>>(programs.editorRefs, {
    useRef(initial: unknown) { return editorRefInstance.slots[editorRefInstance.cursor++] ??= { current: initial }; },
  });
  const captureEditor = evaluateGenerationFixture<(session: LocalGenerationSession, snapshot: Record<string, unknown>, refs: Record<string, unknown>) => LocalEditorCallbacks>(programs.editor, {
    ...bindings, ...briefModule, URL: photoUrl, setLocation: (location: string) => navigations.push(location),
    trackCopyPromise(work: Promise<unknown>) { copyPromises.push(work); void work.catch(() => {}); return work; },
    navigator: { clipboard: { async writeText(text: string) {
      clipboardWrites.push(text); clipboardStarted.resolve(); const wait = clipboardWait; clipboardWait = undefined;
      if (wait) await wait.promise;
      if (clipboardFailure) throw new Error("Synthetic clipboard write failure");
    } } },
  });
  return {
    editor() {
      assert.ok(lifetime, "copy and library transfer must use the actual keyed wrapper");
      if (!("PackageBrief" in state)) state.PackageBrief = { ...LOCAL_PACKAGE_BRIEF };
      if (!("ContentPackage" in state)) state.ContentPackage = null;
      if (!("SelectedAdVariantId" in state)) state.SelectedAdVariantId = "";
      if (!("AdvertisingGoalContext" in state)) state.AdvertisingGoalContext = {};
      if (!("PhotoTexts" in state)) Object.assign(state, Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(photoDefaults.inputs)))
        .map(([key, value]) => [key[0].toUpperCase() + key.slice(1), value])));
      const next = lifetime.render(), inputs = Object.fromEntries(Object.keys(photoDefaults.inputs).map((key) => [key, state[key[0].toUpperCase() + key.slice(1)]]));
      editorRefInstance = editorRefInstances.get(next.session.sessionRef) ?? { slots: [], cursor: 0 };
      editorRefInstances.set(next.session.sessionRef, editorRefInstance); editorRefInstance.cursor = 0;
      const refs = { ...photoRefsFor(next.session, state.PackageBrief as LocalPackageBrief, inputs as LocalPhotoInputs),
        ...packageRefsFor(next.session), ...libraryRefsFor(next.session), ...renderEditorRefs(state.AdvertisingGoalContext) };
      return { ...next, refs, callbacks: captureEditor(next.session, { form: state.Form, videos: state.Videos, activeId: state.ActiveId,
        packageBrief: state.PackageBrief, contentPackage: state.ContentPackage, selectedAdVariantId: state.SelectedAdVariantId,
        advertisingGoalContext: state.AdvertisingGoalContext, ...inputs }, refs) };
    },
    clipboardWrites, clipboardStarted, copyPromises,
    startCopy(editor: { callbacks: LocalEditorCallbacks }, title: string) {
      const previous = copyPromises.length; assert.equal(typeof editor.callbacks.copies[title], "function", `actual JSX copy binding: ${title}`);
      editor.callbacks.copies[title](); assert.equal(copyPromises.length, previous + 1); return copyPromises.at(-1)!;
    },
    deferClipboard() { clipboardWait = generationDeferred<void>(); return clipboardWait; },
    clipboardFailure(value = true) { clipboardFailure = value; },
    goalPrefill(context: Record<string, unknown>) {
      const incoming = briefModule.createAdvertisingCampaignPrefill({ platform: "meta", sourceModule: "advertising-hub", sourceKind: "goal", service: LOCAL_PACKAGE_BRIEF.service, city: LOCAL_PACKAGE_BRIEF.city,
        offer: LOCAL_PACKAGE_BRIEF.offer, audience: LOCAL_PACKAGE_BRIEF.audience, ...context });
      localStorage.setItem(storage.workspaceScopedKey(briefModule.ADVERTISING_CONTENT_STUDIO_PREFILL_KEY), JSON.stringify(incoming));
    },
    library() {
      assert.ok(lifetime, "library callbacks must use the actual keyed wrapper session"); libraryFixtureActive = true;
      const next = lifetime.render(), refs = libraryRefsFor(next.session);
      return { ...next, refs, callbacks: captureLibrary(next.session, { form: state.Form as LocalLibraryForm,
        videos: state.Videos as LocalLibraryVideo[], activeId: state.ActiveId as string }, refs, state.Loading) };
    },
    seedLibrary(rows: LocalLibraryVideo[], selectedId = rows[0]?.id || "", form: LocalLibraryForm = { ...LOCAL_LIBRARY_FORM }) {
      assert.ok(lifetime); const next = lifetime.render();
      Object.assign(state, { Form: form, Videos: rows, ActiveId: selectedId });
      const refs = libraryRefsFor(next.session), snapshot = refs.librarySnapshotRef as { current: LocalLibrarySnapshot } | undefined;
      if (snapshot) snapshot.current = { form, videos: rows, activeId: selectedId };
    },
    libraryReplies, libraryTextReplies, telegramReplies, libraryRequests, libraryDefaults, pureLibraryDemo, buildTelegramPackage, telegramLocks,
    libraryKey: (workspaceId = storage.readWorkspaceId()) => `negis_content_studio_videos::${workspaceId}`,
    photoSuggestions() {
      assert.ok(lifetime, "photo suggestions must receive actual wrapper-computed session props");
      photoSuggestionActive = true;
      if (!("PackageBrief" in state)) state.PackageBrief = { ...LOCAL_PACKAGE_BRIEF };
      if (!("PhotoTexts" in state)) Object.assign(state, Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(photoDefaults.inputs)))
        .map(([key, value]) => [key[0].toUpperCase() + key.slice(1), value])));
      const inputs = Object.fromEntries(Object.keys(photoDefaults.inputs).map((key) => [key, state[key[0].toUpperCase() + key.slice(1)]])) as LocalPhotoInputs;
      const next = lifetime.render();
      const refs = photoRefsFor(next.session, state.PackageBrief as LocalPackageBrief, inputs);
      return { ...next, inputs, refs, callbacks: capturePhotoSuggestion(next.session, state.PackageBrief as LocalPackageBrief, inputs, refs) };
    },
    photoSuggestionReply, photoSuggestionRequests, photoDefaults, localObjectUrls,
    renderCalls, renderStarted, renderReply, anchors,
    deferRender() { renderWait = generationDeferred<void>(); return renderWait; },
    packages() {
      assert.ok(lifetime, "package generation must receive actual wrapper-computed session props");
      packageFixtureActive = true;
      if (!("PackageBrief" in state)) Object.assign(state, { PackageBrief: { ...LOCAL_PACKAGE_BRIEF }, ContentPackage: null,
        ContentPackageId: "", SelectedAdVariantId: "", PackageGenerationMode: "", GenPrompt: "", Loading: null, Notice: "" });
      const next = lifetime.render();
      const refs = packageRefsFor(next.session);
      return { ...next, refs, callbacks: capturePackage(next.session, state.PackageBrief as LocalPackageBrief, refs, state.Loading, state.ContentPackage ?? null, state.SelectedAdVariantId ?? "") };
    },
    packageReplies, packageRequests, packageBodyReads, purePackageDemo: purePackageDemo.demoContentPackage,
    handoffs(options?: Parameters<typeof captureHandoffs>[1]) {
      assert.ok(lifetime, "handoffs must use the actual wrapper session");
      const next = lifetime.render();
      const inputs: LocalPhotoInputs = { ...photoDefaults.inputs, photoFormat: "feed", photoLayout: "minimal", photoSourceType: "upload",
        photoTexts: { headline: "Synthetic photo", offer: "Local photo offer", cta: "Local photo CTA", disclaimer: "" },
        photoBlob: legacyPhotoBlob, photoPreviewUrl: "blob:legacy-rendered-preview" };
      const refs = photoRefsFor(next.session, { ...LOCAL_PACKAGE_BRIEF, service: "Synthetic service", city: "Synthetic city", offer: "Synthetic offer",
        audience: "Synthetic audience" }, inputs);
      const artifact = refs.photoArtifactRef as { current: unknown } | undefined;
      if (artifact && !artifact.current) {
        // The C8 fixture starts with a legitimately rendered, matching artifact; the real guard still executes.
        artifact.current = { blob: legacyPhotoBlob, previewUrl: inputs.photoPreviewUrl,
          inputs: (refs.photoTextInputsRef as { current: unknown }).current,
          revision: (refs.photoTextRevision as { current: number }).current, session: next.session.sessionRef.current };
        (refs.photoObjectUrls as { current: Set<string> }).current.add(inputs.photoPreviewUrl);
      }
      return { ...next, callbacks: captureHandoffs(next.session, options, refs) };
    },
    handoffStatuses, handoffBodyFailures, handoffTransportFailures, handoffRequests, signedReply, finalizedReply, uploads, uploadStarted, navigations,
    onHandoffResponse(callback?: (resource: Resource) => void) { handoffResponseHook = callback; },
    deferResponse(resource: Resource) { responseResource = resource; responseWait = generationDeferred<void>();
      return Object.assign(responseWait, { started: responseStarted.promise }); },
    uploadError(value: unknown) { uploadError = value; },
    uploadThrown(value: unknown) { uploadThrown = value; },
    uploadFailure(value = true) { uploadFailure = value; },
    deferUpload() { uploadWait = generationDeferred<void>(); return uploadWait; },
    localDrafts() {
      assert.ok(lifetime, "local drafts must receive their actual wrapper-computed session props");
      const next = lifetime.render();
      return { ...next, hydrate: captureLocalDrafts(next.session, libraryRefsFor(next.session)) };
    },
    video(job: LocalVideoJob | null, file: unknown = null) {
      if (job) job.phase ??= "generation";
      state.VideoJob = job; state.GenVideo = file;
      refCursor = 0; renderVideoRefs(job);
      return captureVideo(job, file);
    },
    // This seeding helper also names deliberately invalid demo keys, which production must never read.
    videoKey: (workspaceId = storage.readWorkspaceId()) => `negis_content_studio_video_job::${workspaceId}::${captured.actorId}`,
    localStorage, timers, timerDelays, pollReply, videoRefs, timerCalls: () => nextTimer, storageReads,
    videoGenerationAttempt: bindings.videoGenerationAttempt,
    generate: kind === "photo" ? page.generatePhoto : page.generateVideo,
    refresh: page.refreshGenerationUsage,
    usageReply,
    paidDisabled: () => paidGates({ generationUsage: state.GenerationUsage ?? null,
      generationUsageLoading: state.GenerationUsageLoading ?? false, genBusy: state.GenBusy ?? null, videoJob: state.VideoJob ?? null }),
    clearReceipt: (key: string, expectedRequestKey: string) => page.clearBrowserPaidGenerationAttempt(kind, key, expectedRequestKey),
    lifetime, mounted, subscriptions, captured, sdkReads,
    sdkFailure(mode?: "throw" | "error") { sdkFailure = mode; },
    sdkFailureOnce(mode: "throw" | "error") { nextSdkFailure = mode; },
    dispatches, mutations, sessionStorage, state, writes, toasts, reply, tokenStarted, bodyStarted,
    pendingKey: () => page.paidGenerationAttemptKey(kind),
    workspace(id: string) { localStorage.setItem(storage.WORKSPACE_SELECTOR_KEY, id); authState = { ...authState, clinicId: id }; },
    auth(patch: Partial<typeof authState>) { authState = { ...authState, ...patch }; },
    sdkSession(actor: string, token = "fixture-token-b", event: string | null = "SIGNED_IN") {
      sdkActor = actor; sdkToken = token;
      if (event) for (const callback of [...subscriptions]) callback(event, { user: { id: actor } });
    },
    deferToken(resource?: Resource) {
      tokenResource = resource; tokenWait = generationDeferred<void>(); targetedTokenStarted = generationDeferred<void>();
      return Object.assign(tokenWait, { started: targetedTokenStarted.promise });
    },
    deferBody(resource: Resource = "generation") {
      delayedResource = resource; delayedBody = generationDeferred<string>(); delayedBodyStarted = generationDeferred<void>();
      return Object.assign(delayedBody, { started: delayedBodyStarted.promise });
    },
  };
}

for (const kind of ["photo", "video"] as const) {
  for (const boundary of ["workspace", "account"] as const) {
    test(`GEN44 ${kind} late A body cannot clear B's receipt or publish after ${boundary} change`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks(kind, boundary === "account"), body = fixture.deferBody();
      const work = fixture.generate();
      try {
        await fixture.bodyStarted.promise;
        assert.equal(fixture.dispatches.length, 1, "defer the body of an already dispatched A request");
        assert.equal(fixture.dispatches[0].method, "POST");
        assert.equal(fixture.dispatches[0].headers.get("Authorization"), "Bearer fixture-token-a");
        const receiptA = paidGeneration.readStoredPaidGenerationAttempt(fixture.sessionStorage, fixture.pendingKey());
        assert.ok(receiptA, "A's real callback must persist its paid receipt before dispatch");

        if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
        else fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", null); // No auth event: only the spinner may finish locally.
        if (boundary === "account") {
          assert.equal(fixture.lifetime!.render().key, fixture.mounted!.key);
          assert.equal(fixture.mounted!.session.isSessionAlive(fixture.captured.sessionRef.current), true);
        }
        const keyB = fixture.pendingKey();
        const receiptB = paidGeneration.resolvePaidGenerationAttempt(null,
          { kind, prompt: "Synthetic B pending retry", format: "reels" },
          () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        paidGeneration.writeStoredPaidGenerationAttempt(fixture.sessionStorage, keyB, receiptB);
        const storedB = fixture.sessionStorage.getItem(keyB);
        assert.ok(storedB);
        fixture.state.GenBusy = kind;
        fixture.state.GenNotice = { tone: "info", text: "B pending retry" };
        const writeStart = fixture.writes.length, toastStart = fixture.toasts.length, mutationStart = fixture.mutations.length;
        body.resolve(JSON.stringify(fixture.reply));
        await work;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual({
          pendingBIntact: fixture.sessionStorage.getItem(keyB) === storedB,
          mutationsOfB: fixture.mutations.slice(mutationStart).filter((mutation) => mutation.storage === "session" && mutation.key === keyB),
          stateWrites: fixture.writes.slice(writeStart),
          toasts: fixture.toasts.slice(toastStart),
          followups: fixture.dispatches.slice(1).map(({ url, method }) => ({ url, method })),
        }, { pendingBIntact: true, mutationsOfB: [],
          stateWrites: boundary === "account" ? [{ field: "GenBusy", value: null }] : [], toasts: [], followups: [] },
        "stale data, receipt cleanup, toasts and follow-ups are forbidden; only a live local spinner may reset");
      } finally { body.resolve(JSON.stringify(fixture.reply)); await work; fixture.lifetime?.unmount(); }
    });
  }

  test(`GEN45 ${kind} SDK actor change during token lookup dispatches zero POSTs`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks(kind), token = fixture.deferToken();
    const work = fixture.generate();
    try {
      await fixture.tokenStarted.promise;
      assert.equal(fixture.dispatches.length, 0, "the SDK lookup must still be pending");
      fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      token.resolve();
      await work;
      assert.deepEqual(fixture.dispatches.filter((call) => call.method === "POST").map(({ url, headers }) => ({
        url, authorization: headers.get("Authorization"),
      })), [], "A's paid request must never use B's token, even in the same workspace");
    } finally { token.resolve(); await work; }
  });

  test(`GEN46 ${kind} same-actor token refresh permits exactly one paid POST`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks(kind), token = fixture.deferToken();
    const work = fixture.generate();
    try {
      await fixture.tokenStarted.promise;
      assert.equal(fixture.dispatches.length, 0);
      const receipt = paidGeneration.readStoredPaidGenerationAttempt(fixture.sessionStorage, fixture.pendingKey());
      assert.ok(receipt);
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
      token.resolve();
      await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const posts = fixture.dispatches.filter((call) => call.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, `/api/content-studio/generate-${kind}?workspaceId=33333333-3333-4333-8333-333333333333`);
      assert.equal(posts[0].headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
      assert.equal(posts[0].headers.get("X-Idempotency-Key"), receipt.requestKey);
      assert.deepEqual(posts[0].body, { prompt: "Synthetic clinic room", format: "reels" });
      assert.equal(fixture.sessionStorage.getItem(fixture.pendingKey()), null);
      assert.equal(fixture.state.GenBusy, null);
      assert.equal(fixture.state.GenNotice, null);
      const { creativeUrl, ...file } = fixture.reply.data;
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.state[kind === "photo" ? "GenImage" : "VideoJob"])),
        kind === "photo" ? { ...file, url: creativeUrl } : fixture.reply.data);
      assert.equal(fixture.toasts.length, kind === "photo" ? 1 : 0);
      assert.deepEqual(fixture.dispatches.filter((call) => call.method === "GET").map((call) => call.url),
        ["/api/content-studio/usage?workspaceId=33333333-3333-4333-8333-333333333333"]);
      assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "local-usage");
    } finally { token.resolve(); await work; }
  });

  for (const boundary of ["workspace", "role", "purpose", "unmount", "account", "A-B-A"] as const) {
    for (const phase of ["token", "body"] as const) {
      test(`GEN47 ${kind} actual wrapper invalidates ${phase}-pending work on ${boundary}`, { timeout: 5000 }, async () => {
        const fixture = await localGenerationCallbacks(kind, true);
        const lifetime = fixture.lifetime!, mounted = fixture.mounted!, oldSession = mounted.session;
        const controller = oldSession.sessionRef.current!;
        assert.equal(fixture.subscriptions.size, 2, "the real wrapper and child must subscribe");
        assert.equal(oldSession.isSessionAlive(controller), true);
        const token = phase === "token" ? fixture.deferToken() : undefined;
        const body = phase === "body" ? fixture.deferBody() : undefined;
        const work = fixture.generate();
        try {
          await (token ? fixture.tokenStarted.promise : fixture.bodyStarted.promise);
          const dispatchCount = phase === "token" ? 0 : 1;
          assert.equal(fixture.dispatches.length, dispatchCount);
          if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
          if (boundary === "role") fixture.auth({ userRole: "admin" });
          if (boundary === "purpose") fixture.auth({ workspacePurpose: "marketing" });
          if (boundary === "account") {
            fixture.sdkSession("22222222-2222-4222-8222-222222222222");
            assert.equal(controller.signal.aborted, true, "an SDK auth event forbids even spinner cleanup");
          }
          if (boundary === "A-B-A") {
            fixture.sdkSession("22222222-2222-4222-8222-222222222222");
            fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-returned");
            assert.equal(controller.signal.aborted, true, "SDK abort must precede the batched wrapper render");
          }
          if (boundary === "unmount") lifetime.unmount();
          else {
            const next = lifetime.render();
            assert.notEqual(next.key, mounted.key, "the actual wrapper key must invalidate this lifetime");
            assert.notEqual(next.session.sessionRef.current, controller);
            assert.equal(next.session.isSessionAlive(next.session.sessionRef.current), true);
          }
          assert.equal(controller.signal.aborted, true);
          assert.equal(oldSession.sessionRef.current, null, "the real layout cleanup must release its ref");
          assert.equal(await oldSession.isGenerationSessionCurrent(controller), false);

          const keyB = fixture.pendingKey();
          const pendingB = paidGeneration.resolvePaidGenerationAttempt(null,
            { kind, prompt: "Synthetic new lifetime pending retry", format: "reels" },
            () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
          paidGeneration.writeStoredPaidGenerationAttempt(fixture.sessionStorage, keyB, pendingB);
          const storedB = fixture.sessionStorage.getItem(keyB);
          assert.ok(storedB);
          const writes = fixture.writes.length, mutations = fixture.mutations.length;
          token?.resolve(); body?.resolve(JSON.stringify(fixture.reply));
          await work;
          await fixture.generate();
          await fixture.refresh(); // A retained callback cannot restart work after cleanup either.
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(fixture.dispatches.length, dispatchCount, "no stale paid POST or follow-up may dispatch");
          assert.equal(fixture.sessionStorage.getItem(keyB), storedB);
          assert.deepEqual(fixture.mutations.slice(mutations), []);
          assert.deepEqual(fixture.writes.slice(writes), [], "stale catch/finally must not write");
          assert.deepEqual(fixture.toasts, []);
        } finally {
          token?.resolve(); body?.resolve(JSON.stringify(fixture.reply)); await work;
          lifetime.unmount();
          assert.equal(fixture.subscriptions.size, 0);
        }
      });
    }
  }

  test(`GEN48 ${kind} actual wrapper preserves its lifetime on same-actor refresh`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks(kind, true), token = fixture.deferToken();
    const lifetime = fixture.lifetime!, mounted = fixture.mounted!, controller = mounted.session.sessionRef.current!;
    const work = fixture.generate();
    try {
      await fixture.tokenStarted.promise;
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
      const refreshed = lifetime.render();
      assert.equal(refreshed.key, mounted.key);
      assert.equal(refreshed.session.sessionRef.current, controller);
      assert.equal(refreshed.session.isSessionAlive(controller), true);
      assert.equal(fixture.subscriptions.size, 2);
      token.resolve(); await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const posts = fixture.dispatches.filter((call) => call.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
      assert.ok(fixture.state[kind === "photo" ? "GenImage" : "VideoJob"]);
      assert.equal(fixture.state.GenBusy, null);
      assert.equal(fixture.sessionStorage.getItem(fixture.pendingKey()), null);
      assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "local-usage");
    } finally { token.resolve(); await work; lifetime.unmount(); assert.equal(fixture.subscriptions.size, 0); }
  });

  test(`GEN49 ${kind} actual cleanup uses the captured key and matches the stored request`, async () => {
    const fixture = await localGenerationCallbacks(kind);
    const attempt = (requestKey: string) => paidGeneration.resolvePaidGenerationAttempt(null,
      { kind, prompt: "Synthetic receipt comparison", format: "reels" }, () => requestKey);
    const original = attempt("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const replacement = attempt("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const keyA = fixture.pendingKey();
    paidGeneration.writeStoredPaidGenerationAttempt(fixture.sessionStorage, keyA, original);
    paidGeneration.writeStoredPaidGenerationAttempt(fixture.sessionStorage, keyA, replacement);
    const replacementRaw = fixture.sessionStorage.getItem(keyA);
    fixture.workspace("44444444-4444-4444-8444-444444444444");
    const keyB = fixture.pendingKey();
    paidGeneration.writeStoredPaidGenerationAttempt(fixture.sessionStorage, keyB, replacement);
    fixture.clearReceipt(keyA, original.requestKey);
    assert.equal(fixture.sessionStorage.getItem(keyA), replacementRaw, "a replaced same-workspace receipt must survive");
    assert.equal(fixture.sessionStorage.getItem(keyB), replacementRaw);
    fixture.clearReceipt(keyA, replacement.requestKey);
    assert.equal(fixture.sessionStorage.getItem(keyA), null, "a matching receipt is cleared at the captured old key");
    assert.equal(fixture.sessionStorage.getItem(keyB), replacementRaw, "current workspace must never select the cleanup target");
    assert.deepEqual(fixture.dispatches, []);
  });
}

for (const boundary of ["workspace", "account", "account-event"] as const) {
  test(`GEN50 actual usage refresh isolates late data and local spinner cleanup after ${boundary} change`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", boundary !== "workspace"), body = fixture.deferBody("usage");
    const reply = JSON.stringify({ success: true, data: localUsageSummary("stale-a-usage") });
    const work = fixture.refresh();
    try {
      await fixture.bodyStarted.promise;
      assert.equal(fixture.dispatches.length, 1);
      assert.equal(fixture.dispatches[0].method, "GET");
      if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
      else fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", boundary === "account-event" ? "SIGNED_IN" : null);
      if (boundary === "account") {
        assert.equal(fixture.lifetime!.render().key, fixture.mounted!.key);
        assert.equal(fixture.mounted!.session.isSessionAlive(fixture.captured.sessionRef.current), true);
      }
      const currentUsage = localUsageSummary("current-b-usage");
      fixture.state.GenerationUsage = currentUsage;
      fixture.state.GenerationUsageLoading = true;
      const writes = fixture.writes.length;
      body.resolve(reply); await work;
      assert.deepEqual(fixture.writes.slice(writes), boundary === "account"
        ? [{ field: "GenerationUsageLoading", value: false }] : []);
      assert.deepEqual(fixture.state.GenerationUsage, currentUsage);
      assert.equal(fixture.state.GenerationUsageLoading, boundary !== "account");
      assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(fixture.toasts, []);
    } finally { body.resolve(reply); await work; fixture.lifetime?.unmount(); }
  });
}

for (const kind of ["photo", "video"] as const) {
  test(`GEN51 ${kind} accepted result survives a throwing receipt comparison read`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks(kind), body = fixture.deferBody();
    const work = fixture.generate();
    try {
      await fixture.bodyStarted.promise;
      const key = fixture.pendingKey(), stored = fixture.sessionStorage.getItem(key);
      assert.ok(stored, "the paid receipt must already be persisted");
      const mutations = fixture.mutations.length;
      fixture.sessionStorage.failNextRead(key);
      body.resolve(JSON.stringify(fixture.reply));
      await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(fixture.sessionStorage.failedReads, [key], "exercise the actual cleanup comparison, not the initial receipt write");
      assert.deepEqual(fixture.mutations.slice(mutations), kind === "video"
        ? [{ storage: "local", operation: "set", key: fixture.videoKey("33333333-3333-4333-8333-333333333333") }] : [],
        "failed receipt cleanup may only cache the accepted video handle at its own workspace key");
      assert.equal(fixture.sessionStorage.getItem(key), stored);
      if (kind === "video") assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.videoKey())!), JSON.parse(localNativeVideoDraft(fixture.reply.data as LocalVideoJob)));
      const { creativeUrl, ...file } = fixture.reply.data;
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.state[kind === "photo" ? "GenImage" : "VideoJob"])),
        kind === "photo" ? { ...file, url: creativeUrl } : fixture.reply.data,
        "cleanup must not discard the accepted image or signed video handle");
      assert.equal(fixture.state.GenNotice, null, "a cleanup failure is not a failed paid generation");
      assert.equal(fixture.state.GenBusy, null);
      assert.equal(fixture.toasts.length, kind === "photo" ? 1 : 0);
      assert.deepEqual(fixture.dispatches.map(({ method, url }) => ({ method, url })), [
        { method: "POST", url: `/api/content-studio/generate-${kind}?workspaceId=33333333-3333-4333-8333-333333333333` },
        { method: "GET", url: "/api/content-studio/usage?workspaceId=33333333-3333-4333-8333-333333333333" },
      ]);
      const retained = paidGeneration.readStoredPaidGenerationAttempt(fixture.sessionStorage, key);
      assert.ok(retained);
      const retry = paidGeneration.resolvePaidGenerationAttempt(retained,
        { kind, prompt: "Synthetic clinic room", format: "reels" },
        () => { throw new Error("a retained receipt must never allocate a second paid request key"); });
      assert.equal(retry.requestKey, fixture.dispatches[0].headers.get("X-Idempotency-Key"));
    } finally { body.resolve(JSON.stringify(fixture.reply)); await work; }
  });
}

for (const resource of ["photo", "video", "usage"] as const) {
  for (const mode of ["throw", "error"] as const) {
    for (const phase of ["token", "body"] as const) {
      test(`GEN52 ${resource} ${phase}-pending SDK ${mode} permits only live spinner cleanup`, { timeout: 5000 }, async () => {
        const fixture = await localGenerationCallbacks(resource === "usage" ? "photo" : resource, true);
        const token = phase === "token" ? fixture.deferToken() : undefined;
        const body = phase === "body" ? fixture.deferBody(resource === "usage" ? "usage" : "generation") : undefined;
        const reply = JSON.stringify(resource === "usage" ? { success: true, data: localUsageSummary("unverified-usage") } : fixture.reply);
        const work = resource === "usage" ? fixture.refresh() : fixture.generate();
        try {
          await (token ? fixture.tokenStarted.promise : fixture.bodyStarted.promise);
          const session = fixture.mounted!.session, controller = session.sessionRef.current!;
          assert.equal(session.isSessionAlive(controller), true);
          const dispatchCount = phase === "token" ? 0 : 1;
          assert.equal(fixture.dispatches.length, dispatchCount);
          const key = fixture.pendingKey(), stored = fixture.sessionStorage.getItem(key);
          if (resource !== "usage") assert.ok(stored);
          const previous = resource === "usage" ? localUsageSummary("previous-local-result") : { marker: "previous-local-result" };
          const dataField = resource === "usage" ? "GenerationUsage" : resource === "photo" ? "GenImage" : "VideoJob";
          fixture.state[dataField] = previous;
          const writes = fixture.writes.length, mutations = fixture.mutations.length, sdkReads = fixture.sdkReads.total;
          fixture.sdkFailure(mode);
          token?.resolve(); body?.resolve(reply);
          await work;
          await new Promise<void>((resolve) => setImmediate(resolve));
          const spinnerField = resource === "usage" ? "GenerationUsageLoading" : "GenBusy";
          const spinnerValue = resource === "usage" ? false : null;
          assert.deepEqual(fixture.writes.slice(writes), [{ field: spinnerField, value: spinnerValue }],
            "a transient SDK failure must release only the current lifetime's spinner");
          assert.equal(fixture.state[dataField], previous, "unverified data must never publish");
          assert.equal(fixture.state[spinnerField], spinnerValue);
          assert.deepEqual(fixture.mutations.slice(mutations), []);
          assert.equal(fixture.sessionStorage.getItem(key), stored);
          assert.deepEqual(fixture.toasts, []);
          assert.equal(fixture.dispatches.length, dispatchCount, "failed validation cannot trigger a follow-up");
          const validationLookups = resource === "usage" && phase === "token" ? 0 : 1;
          assert.equal(fixture.sdkReads.total - sdkReads, validationLookups, "finally must not perform another token lookup");
          assert.equal(fixture.sdkReads.failed, phase === "token" && resource !== "usage" ? 2 : 1);
          assert.equal(session.isSessionAlive(controller), true, "SDK failure alone does not invalidate the local lifetime");

          fixture.sdkFailure();
          await fixture.refresh();
          assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "local-usage", "the same lifetime recovers after the transient failure");
          assert.equal(fixture.state.GenerationUsageLoading, false);
          assert.equal(fixture.dispatches.length, dispatchCount + 1);
          assert.equal(fixture.dispatches.at(-1)?.method, "GET");
        } finally {
          fixture.sdkFailure(); token?.resolve(); body?.resolve(reply); await work;
          fixture.lifetime!.unmount();
          assert.equal(fixture.subscriptions.size, 0);
        }
      });
    }
  }
}

test("GEN75 actual usage parser accepts complete finite, exhausted, inactive and unavailable summaries", async () => {
  const { usageParser } = await generationCallbackPrograms;
  const { parseGenerationUsageSummary: parse } = evaluateGenerationFixture<{
    parseGenerationUsageSummary: (value: unknown) => LocalUsageSummary | null;
  }>(usageParser, {});
  const valid = localUsageSummary();
  const cases: LocalUsageSummary[] = [valid,
    { ...valid, plan: "basic", warning: "Synthetic local warning", images: { used: 15, limit: 10, remaining: 0, enabled: true } },
    { ...valid, plan: "standard", videoSeconds: { used: 60, limit: 60, remaining: 0, enabled: true } },
    { ...valid, plan: null, subscriptionActive: false, planTitle: "No local subscription",
      images: { used: 0, limit: 0, remaining: 0, enabled: false }, videoSeconds: { used: 0, limit: 0, remaining: 0, enabled: false } },
    { ...valid, trackingAvailable: false, images: { used: 0, limit: null, remaining: null, enabled: true },
      videoSeconds: { used: 0, limit: null, remaining: null, enabled: true }, warning: "Synthetic tracking unavailable" },
  ];
  for (const value of cases) {
    const parsed = parse(value);
    assert.ok(parsed, `accept full ${value.planTitle} summary`);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), value);
    assert.notEqual(parsed, value, "publish a parsed summary rather than the untrusted response object");
    assert.notEqual(parsed.images, value.images);
    assert.notEqual(parsed.videoSeconds, value.videoSeconds);
  }
});

function malformedUsageCases(): Array<[string, unknown]> {
  const valid = localUsageSummary();
  const cases: Array<[string, unknown]> = [
    ["null", null], ["undefined", undefined], ["array", []], ["string", "quota"], ["boolean", true], ["number", 1],
    ["marker-only body", { marker: "not-a-summary" }], ["envelope instead of summary", { success: true, data: valid }],
  ];
  for (const field of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid }; delete missing[field]; cases.push([`missing ${field}`, missing]);
  }
  for (const [field, values] of [
    ["trackingAvailable", [null, "true", 1]], ["subscriptionActive", [null, "true", 1]],
    ["plan", ["enterprise", "", 1]], ["planTitle", [null, "", "   ", "x".repeat(161)]],
    ["periodStart", [null, "2090-13-01", "2090-00-01", "2090-10-02", "2090-10-01T00:00:00Z", "0000-10-01"]],
    ["textRequests", [-1, 0.5, "3", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]],
    ["videoSecondsPerGeneration", [0, -1, 1.5, "8", 61, Number.NaN, Number.POSITIVE_INFINITY]],
    ["warning", [null, false, "x".repeat(2001)]],
  ] as const) {
    values.forEach((value, index) => cases.push([`${field} invalid ${index}`, { ...valid, [field]: value }]));
  }
  cases.push(["active without plan", { ...valid, plan: null }], ["inactive with plan", { ...valid, subscriptionActive: false }]);
  for (const field of ["images", "videoSeconds"] as const) {
    for (const [name, value] of [
      ["null", null], ["array", []], ["empty", {}], ["missing enabled", { used: 2, limit: 10, remaining: 8 }],
      ["negative used", { used: -1, limit: 10, remaining: 11, enabled: true }],
      ["fractional used", { used: 0.5, limit: 10, remaining: 9.5, enabled: true }],
      ["non-finite used", { used: Number.POSITIVE_INFINITY, limit: 10, remaining: 0, enabled: true }],
      ["negative limit", { used: 0, limit: -1, remaining: 0, enabled: false }],
      ["string limit", { used: 2, limit: "10", remaining: 8, enabled: true }],
      ["negative remaining", { used: 2, limit: 10, remaining: -1, enabled: true }],
      ["string remaining", { used: 2, limit: 10, remaining: "8", enabled: true }],
      ["inconsistent remaining", { used: 2, limit: 10, remaining: 10, enabled: true }],
      ["null finite remaining", { used: 2, limit: 10, remaining: null, enabled: true }],
      ["string enabled", { used: 2, limit: 10, remaining: 8, enabled: "true" }],
      ["disabled positive limit", { used: 2, limit: 10, remaining: 8, enabled: false }],
      ["enabled zero limit", { used: 0, limit: 0, remaining: 0, enabled: true }],
      ["tracked unlimited", { used: 0, limit: null, remaining: null, enabled: true }],
    ] as Array<[string, unknown]>) cases.push([`${field} ${name}`, { ...valid, [field]: value }]);
    cases.push([`${field} unlimited with finite remaining`, { ...valid, trackingAvailable: false,
      [field]: { used: 0, limit: null, remaining: 1, enabled: true } }]);
  }
  return cases;
}

for (const [name, value] of malformedUsageCases()) {
  test(`GEN75 actual usage parser rejects ${name}`, async () => {
    const { usageParser } = await generationCallbackPrograms;
    const parser = evaluateGenerationFixture<{ parseGenerationUsageSummary: (value: unknown) => LocalUsageSummary | null }>(usageParser, {});
    assert.equal(parser.parseGenerationUsageSummary(value), null, "malformed quota must never become paid-control state");
  });
}

function assertPaidDisabled(fixture: Awaited<ReturnType<typeof localGenerationCallbacks>>, disabled: boolean) {
  const gates = fixture.paidDisabled();
  assert.equal(gates.photo, disabled, "actual paid photo JSX gate");
  assert.equal(gates.video, disabled, "actual paid video JSX gate");
}

for (const order of ["newest-first", "oldest-first"] as const) {
  test(`GEN76 same-session overlapping usage bodies commit only the newest request (${order})`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true), oldBody = fixture.deferBody("usage"), oldWork = fixture.refresh();
    let newWork: Promise<void> | undefined, newBody: ReturnType<typeof fixture.deferBody> | undefined;
    try {
      await oldBody.started;
      newBody = fixture.deferBody("usage"); newWork = fixture.refresh(); await newBody.started;
      assert.equal(fixture.dispatches.length, 2, "two actual no-store GETs must overlap in one session");
      const writes = fixture.writes.length;
      if (order === "oldest-first") {
        oldBody.resolve(JSON.stringify({ success: true, data: localUsageSummary("old-usage") })); await oldWork;
        assert.deepEqual(fixture.writes.slice(writes), [], "old body and old finally must both remain silent");
        assert.equal(fixture.state.GenerationUsage, null);
        assert.equal(fixture.state.GenerationUsageLoading, true, "old finally cannot clear the newer loading state");
        assertPaidDisabled(fixture, true);
      }
      newBody.resolve(JSON.stringify({ success: true, data: localUsageSummary("new-usage") })); await newWork;
      assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "new-usage");
      assert.equal(fixture.state.GenerationUsageLoading, false); assertPaidDisabled(fixture, false);
      const acceptedWrites = fixture.writes.length;
      oldBody.resolve(JSON.stringify({ success: true, data: localUsageSummary("old-usage") })); await oldWork;
      assert.deepEqual(fixture.writes.slice(acceptedWrites), [], "a late old response cannot replace the newest quota or loading state");
      assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "new-usage");
      assert.equal(fixture.state.GenerationUsageLoading, false);
      assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.uploads, []);
      assert.ok(fixture.dispatches.every((call) => call.method === "GET" && call.url === "/api/content-studio/usage?workspaceId=33333333-3333-4333-8333-333333333333"));
    } finally {
      oldBody.resolve("{}"); newBody?.resolve("{}"); await Promise.allSettled([oldWork, newWork]); fixture.lifetime!.unmount();
    }
  });
}

test("GEN76 newer usage request wins even while the older response awaits fresh session validation", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true), body = fixture.deferBody("usage"), work = fixture.refresh();
  let token: ReturnType<typeof fixture.deferToken> | undefined;
  try {
    await body.started; token = fixture.deferToken();
    body.resolve(JSON.stringify({ success: true, data: localUsageSummary("old-validation") })); await token.started;
    fixture.usageReply.body = { success: true, data: localUsageSummary("new-validation") }; await fixture.refresh();
    assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "new-validation");
    const writes = fixture.writes.length; token.resolve(); await work;
    assert.deepEqual(fixture.writes.slice(writes), [], "request equality must be checked after the asynchronous session guard");
    assert.equal((fixture.state.GenerationUsage as LocalUsageSummary).planTitle, "new-validation");
    assertPaidDisabled(fixture, false); assert.equal(fixture.dispatches.length, 2);
  } finally { body.resolve("{}"); token?.resolve(); await work; fixture.lifetime!.unmount(); }
});

test("GEN76 an older unsuccessful body's finally cannot clear a newer request's loading state", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true), oldBody = fixture.deferBody("usage"), oldWork = fixture.refresh();
  let newBody: ReturnType<typeof fixture.deferBody> | undefined, newWork: Promise<void> | undefined;
  try {
    await oldBody.started; newBody = fixture.deferBody("usage"); newWork = fixture.refresh(); await newBody.started;
    const writes = fixture.writes.length;
    oldBody.resolve(JSON.stringify({ success: false })); await oldWork;
    assert.equal(fixture.state.GenerationUsageLoading, true, "old finally must not release the latest request's spinner");
    assert.deepEqual(fixture.writes.slice(writes), [], "even an old non-committing response may not clear newer loading");
    assert.equal(fixture.state.GenerationUsage, null); assertPaidDisabled(fixture, true);
    newBody.resolve(JSON.stringify({ success: true, data: localUsageSummary("new-after-old-finally") })); await newWork;
    assert.equal((fixture.state.GenerationUsage as LocalUsageSummary | null)?.planTitle, "new-after-old-finally");
    assert.equal(fixture.state.GenerationUsageLoading, false); assertPaidDisabled(fixture, false);
  } finally { oldBody.resolve("{}"); newBody?.resolve("{}"); await Promise.allSettled([oldWork, newWork]); fixture.lifetime!.unmount(); }
});

test("GEN76 starting a fresh usage request immediately removes previously enabling quota", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true); await fixture.refresh(); assertPaidDisabled(fixture, false);
  const body = fixture.deferBody("usage"), work = fixture.refresh();
  try {
    await body.started; assert.equal(fixture.state.GenerationUsage, null); assert.equal(fixture.state.GenerationUsageLoading, true);
    assertPaidDisabled(fixture, true);
    body.resolve(JSON.stringify({ success: true, data: localUsageSummary("refreshed-usage") })); await work;
    assert.equal((fixture.state.GenerationUsage as LocalUsageSummary | null)?.planTitle, "refreshed-usage"); assertPaidDisabled(fixture, false);
  } finally { body.resolve("{}"); await work; fixture.lifetime!.unmount(); }
});

const USAGE_FAILURES = ["403", "401", "500", "malformed-json", "malformed-summary", "missing-data", "unsuccessful", "body-read", "transport-403"] as const;
for (const failure of USAGE_FAILURES) {
  test(`GEN76 latest usage ${failure} clears stale quota and an older success cannot reopen paid controls`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true); await fixture.refresh(); assertPaidDisabled(fixture, false);
    const oldBody = fixture.deferBody("usage"), oldWork = fixture.refresh();
    try {
      await oldBody.started;
      if (["403", "401", "500"].includes(failure)) fixture.handoffStatuses.usage = Number(failure);
      if (failure === "malformed-json") fixture.usageReply.text = "{not-json";
      if (failure === "malformed-summary") fixture.usageReply.body = { success: true, data: { marker: "not-quota" } };
      if (failure === "missing-data") fixture.usageReply.body = { success: true };
      if (failure === "unsuccessful") fixture.usageReply.body = { success: false, data: localUsageSummary("denied-quota") };
      if (failure === "body-read") fixture.handoffBodyFailures.add("usage");
      if (failure === "transport-403") fixture.handoffTransportFailures.usage = 403;
      const mutations = fixture.mutations.length; await fixture.refresh();
      assert.equal(fixture.state.GenerationUsage, null, "a latest failure must leave no stale paid quota");
      assert.equal(fixture.state.GenerationUsageLoading, false); assertPaidDisabled(fixture, true);
      const writes = fixture.writes.length;
      oldBody.resolve(JSON.stringify({ success: true, data: localUsageSummary("late-old-success") })); await oldWork;
      assert.deepEqual(fixture.writes.slice(writes), [], "old success and finally cannot undo the latest failure");
      assert.equal(fixture.state.GenerationUsage, null); assertPaidDisabled(fixture, true);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.dispatches.length, 3); assert.ok(fixture.dispatches.every((call) => call.method === "GET"));
      delete fixture.handoffStatuses.usage; delete fixture.handoffTransportFailures.usage; fixture.handoffBodyFailures.delete("usage");
      delete fixture.usageReply.text; fixture.usageReply.body = { success: true, data: localUsageSummary("recovered-usage") };
      await fixture.refresh(); assert.equal((fixture.state.GenerationUsage as LocalUsageSummary | null)?.planTitle, "recovered-usage");
      assertPaidDisabled(fixture, false);
    } finally { oldBody.resolve("{}"); await oldWork; fixture.lifetime!.unmount(); }
  });
}

for (const boundary of ["workspace", "account", "role", "purpose", "unmount", "A-B-A"] as const) {
  for (const phase of ["token", "body"] as const) {
    test(`GEN77 usage ${phase}-pending scope guards survive ${boundary} invalidation`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("photo", true), mounted = fixture.mounted!, controller = fixture.captured.sessionRef.current!;
      const token = phase === "token" ? fixture.deferToken() : undefined, body = phase === "body" ? fixture.deferBody("usage") : undefined;
      const work = fixture.refresh();
      try {
        await (token ? token.started : body!.started);
        const dispatchCount = phase === "token" ? 0 : 1; assert.equal(fixture.dispatches.length, dispatchCount);
        if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
        if (boundary === "role") fixture.auth({ userRole: "admin" });
        if (boundary === "purpose") fixture.auth({ workspacePurpose: "marketing" });
        if (boundary === "account" || boundary === "A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
        if (boundary === "A-B-A") fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-returned-token");
        if (boundary === "unmount") fixture.lifetime!.unmount();
        else assert.notEqual(fixture.lifetime!.render().key, mounted.key);
        assert.equal(controller.signal.aborted, true); assert.equal(fixture.captured.sessionRef.current, null);
        const current = localUsageSummary("new-scope-quota");
        fixture.state.GenerationUsage = current; fixture.state.GenerationUsageLoading = true;
        const writes = fixture.writes.length, mutations = fixture.mutations.length;
        token?.resolve(); body?.resolve(JSON.stringify({ success: true, data: localUsageSummary("old-scope-quota") })); await work;
        await fixture.refresh();
        assert.deepEqual(fixture.writes.slice(writes), [], "old commit, catch, finally and retained callback may not write across scope");
        assert.equal(fixture.state.GenerationUsage, current); assert.equal(fixture.state.GenerationUsageLoading, true);
        assert.equal(fixture.dispatches.length, dispatchCount); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.uploads, []);
      } finally { token?.resolve(); body?.resolve("{}"); await work; fixture.lifetime!.unmount(); assert.equal(fixture.subscriptions.size, 0); }
    });
  }
}

test("GEN78 actual paid JSX gates reject inactive or untracked quota and preserve independent image/video limits", async () => {
  const fixture = await localGenerationCallbacks("photo", true); await fixture.refresh(); assertPaidDisabled(fixture, false);
  try {
    fixture.state.GenerationUsage = { ...localUsageSummary(), plan: null, subscriptionActive: false }; assertPaidDisabled(fixture, true);
    fixture.state.GenerationUsage = { ...localUsageSummary(), trackingAvailable: false }; assertPaidDisabled(fixture, true);
    fixture.state.GenerationUsage = { ...localUsageSummary(), images: { used: 10, limit: 10, remaining: 0, enabled: true } };
    assert.equal(fixture.paidDisabled().photo, true); assert.equal(fixture.paidDisabled().video, false);
    fixture.state.GenerationUsage = { ...localUsageSummary(), videoSeconds: { used: 53, limit: 60, remaining: 7, enabled: true } };
    assert.equal(fixture.paidDisabled().photo, false); assert.equal(fixture.paidDisabled().video, true);
    fixture.state.GenerationUsage = localUsageSummary(); fixture.state.GenerationUsageLoading = true; assertPaidDisabled(fixture, true);
    fixture.state.GenerationUsageLoading = false; fixture.state.GenBusy = "photo"; assertPaidDisabled(fixture, true);
    fixture.state.GenBusy = null;
    for (const status of ["queued", "in_progress"]) {
      fixture.state.VideoJob = { status }; assert.equal(fixture.paidDisabled().photo, false); assert.equal(fixture.paidDisabled().video, true);
    }
  } finally { fixture.lifetime!.unmount(); }
});

const LOCAL_POLL_JOB: LocalVideoJob = {
  handle: "fixture_poll.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "in_progress", progress: 7, formatSubstituted: false, phase: "generation",
};
const LOCAL_POLL_FILE = localNativeVideoFile();
const flushLocalVideoWork = () => new Promise<void>((resolve) => setImmediate(resolve));
type LocalVideoBoundary = "account-no-event" | "account-event" | "A-B-A" | "workspace" | "unmount";
function changeLocalVideoScope(fixture: Awaited<ReturnType<typeof localGenerationCallbacks>>, boundary: LocalVideoBoundary) {
  if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
  else if (boundary === "unmount") fixture.lifetime!.unmount();
  else {
    fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", boundary === "account-no-event" ? null : "SIGNED_IN");
    if (boundary === "A-B-A") fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-returned");
  }
}

for (const boundary of ["account-no-event", "account-event", "A-B-A", "workspace"] as const) {
  test(`GEN53 actual poll token wait cannot dispatch across ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true), token = fixture.deferToken();
    const callbacks = fixture.video({ ...LOCAL_POLL_JOB }), cleanup = callbacks.poll();
    try {
      await fixture.tokenStarted.promise;
      assert.equal(fixture.dispatches.length, 0);
      changeLocalVideoScope(fixture, boundary);
      const writes = fixture.writes.length, mutations = fixture.mutations.length;
      token.resolve(); await flushLocalVideoWork();
      assert.deepEqual({
        dispatches: fixture.dispatches.map(({ url, method, headers }) => ({ url, method, authorization: headers.get("Authorization") })),
        writes: fixture.writes.slice(writes), mutations: fixture.mutations.slice(mutations), toasts: fixture.toasts, timers: fixture.timers.size,
      }, { dispatches: [], writes: [], mutations: [], toasts: [], timers: 0 },
      "the real poll must retain its actor and live workspace through the transport token wait");
    } finally {
      token.resolve(); await flushLocalVideoWork();
      if (typeof cleanup === "function") cleanup();
      fixture.lifetime!.unmount();
    }
  });
}

for (const boundary of ["account-no-event", "account-event", "workspace", "unmount"] as const) {
  test(`GEN54 actual poll late body cannot publish or persist after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true), body = fixture.deferBody("poll");
    const callbacks = fixture.video({ ...LOCAL_POLL_JOB }), cleanup = callbacks.poll();
    const response = JSON.stringify({ ...fixture.pollReply, warning: "Synthetic A library warning" });
    try {
      await fixture.bodyStarted.promise;
      assert.equal(fixture.dispatches.length, 1);
      changeLocalVideoScope(fixture, boundary);
      const nextJob = { ...LOCAL_POLL_JOB, handle: "local-poll-b-handle", progress: 31 };
      const nextFile = { ...LOCAL_POLL_FILE, url: "https://example.invalid/poll-b.mp4" };
      fixture.video(nextJob, nextFile);
      fixture.state.GenNotice = { tone: "info", text: "Current B notice" };
      const keyB = fixture.videoKey(), storedB = JSON.stringify({ ...nextJob, ...nextFile });
      fixture.localStorage.setItem(keyB, storedB);
      const writes = fixture.writes.length, mutations = fixture.mutations.length;
      body.resolve(response); await flushLocalVideoWork();
      if (fixture.writes.slice(writes).some((write) => write.field === "VideoJob" || write.field === "GenVideo")) {
        // Run the real persistence effect for the render caused by a late setter.
        fixture.video(fixture.state.VideoJob as LocalVideoJob, fixture.state.GenVideo).persist();
      }
      assert.deepEqual({
        writes: fixture.writes.slice(writes), toasts: fixture.toasts, mutations: fixture.mutations.slice(mutations),
        storedB: fixture.localStorage.getItem(keyB), dispatches: fixture.dispatches.length, timers: fixture.timers.size,
      }, { writes: [], toasts: [], mutations: [], storedB, dispatches: 1, timers: 0 },
      "a completed A poll cannot publish its file, warning, success toast or persistence into the new scope");
    } finally {
      body.resolve(response); await flushLocalVideoWork();
      if (typeof cleanup === "function") cleanup();
      fixture.lifetime!.unmount();
    }
  });
}

for (const phase of ["token", "body"] as const) {
  test(`GEN55 actual poll cleanup aborts ${phase}-pending transport work`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const token = phase === "token" ? fixture.deferToken() : undefined;
    const body = phase === "body" ? fixture.deferBody("poll") : undefined;
    const cleanup = fixture.video({ ...LOCAL_POLL_JOB }).poll();
    try {
      await (token ? fixture.tokenStarted.promise : fixture.bodyStarted.promise);
      assert.equal(typeof cleanup, "function");
      const writes = fixture.writes.length;
      (cleanup as () => void)();
      token?.resolve(); body?.resolve(JSON.stringify(fixture.pollReply));
      await flushLocalVideoWork();
      assert.deepEqual({
        dispatches: fixture.dispatches.length,
        aborted: phase === "body" ? fixture.dispatches[0].signal?.aborted === true : true,
        writes: fixture.writes.slice(writes), toasts: fixture.toasts, timers: fixture.timers.size,
      }, { dispatches: phase === "body" ? 1 : 0, aborted: true, writes: [], toasts: [], timers: 0 },
      "effect cleanup must cancel the in-flight poll, including a transport still waiting for its token");
    } finally {
      token?.resolve(); body?.resolve(JSON.stringify(fixture.pollReply)); await flushLocalVideoWork();
      if (typeof cleanup === "function") cleanup();
      fixture.lifetime!.unmount();
    }
  });
}

test("GEN56 actual poll allows same-actor refresh and completes one original-handle GET", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true), token = fixture.deferToken();
  const cleanup = fixture.video({ ...LOCAL_POLL_JOB }).poll();
  try {
    await fixture.tokenStarted.promise;
    fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
    assert.equal(fixture.lifetime!.render().key, fixture.mounted!.key);
    token.resolve(); await flushLocalVideoWork();
    assert.equal(fixture.dispatches.length, 1);
    assert.equal(fixture.dispatches[0].method, "GET");
    assert.equal(fixture.dispatches[0].url,
      `/api/content-studio/video-generation?handle=${encodeURIComponent(LOCAL_POLL_JOB.handle)}&workspaceId=33333333-3333-4333-8333-333333333333`);
    assert.equal(fixture.dispatches[0].headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.VideoJob)), { ...LOCAL_POLL_JOB, status: "completed", progress: 100, phase: "validation", validationJobId: localNativeVideoReceipt().validationJobId });
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.GenVideo)), LOCAL_POLL_FILE);
    assert.equal(fixture.toasts.length, 0, "Completion is announced by the live job card, not an overlapping toast");
    assert.equal(fixture.timers.size, 0);
  } finally { token.resolve(); await flushLocalVideoWork(); if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

for (const boundary of ["different-handle", "workspace", "account-event", "unmount"] as const) {
  test(`GEN57 actual retained retry cannot change ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const retry = fixture.video({ ...LOCAL_POLL_JOB, status: "failed" }).retry;
    try {
      if (boundary !== "different-handle") changeLocalVideoScope(fixture, boundary);
      const current = { ...LOCAL_POLL_JOB, handle: "current-b-different-handle", status: "failed" as const };
      fixture.video(current);
      const notice = { tone: "warning", text: "Current B warning" };
      fixture.state.GenNotice = notice;
      const writes = fixture.writes.length;
      await retry();
      assert.deepEqual({ job: fixture.state.VideoJob, notice: fixture.state.GenNotice,
        writes: fixture.writes.slice(writes), dispatches: fixture.dispatches, toasts: fixture.toasts },
      { job: current, notice, writes: [], dispatches: [], toasts: [] },
      "an old retry must retain its handle and lifetime instead of restarting a different current job");
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("GEN57 actual retry for the same handle survives token refresh without a generation POST", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  const callbacks = fixture.video({ ...LOCAL_POLL_JOB, status: "failed" });
  try {
    fixture.state.GenNotice = { tone: "error", text: "Synthetic previous poll failure" };
    fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
    await callbacks.retry();
    assert.equal(fixture.state.GenNotice, null);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.VideoJob)), LOCAL_POLL_JOB);
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["workspace", "account-event", "unmount"] as const) {
  test(`GEN58 actual old persistence effect cannot write after ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const persist = fixture.video({ ...LOCAL_POLL_JOB }, { ...LOCAL_POLL_FILE }).persist;
    try {
      changeLocalVideoScope(fixture, boundary);
      const keyB = fixture.videoKey(), storedB = JSON.stringify({ ...LOCAL_POLL_JOB, handle: "current-b-persisted-handle" });
      fixture.localStorage.setItem(keyB, storedB);
      const mutations = fixture.mutations.length;
      const cleanup = persist(); await flushLocalVideoWork();
      assert.deepEqual({ storedB: fixture.localStorage.getItem(keyB), mutations: fixture.mutations.slice(mutations) },
        { storedB, mutations: [] }, "the effect must use its captured workspace and live session, never current B's key");
      if (typeof cleanup === "function") cleanup();
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("GEN58 actual same-studio persistence keeps the original handle and generated file identity", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  try {
    const cleanup = fixture.video({ ...LOCAL_POLL_JOB }, { ...LOCAL_POLL_FILE }).persist(); await flushLocalVideoWork();
    const stored = JSON.parse(fixture.localStorage.getItem(fixture.videoKey("33333333-3333-4333-8333-333333333333"))!);
    assert.deepEqual(stored, JSON.parse(localNativeVideoDraft(LOCAL_POLL_JOB)));
    for (const field of ["url", "creativeUrl", "thumbnailUrl", "sha256", "assetId"]) assert.equal(stored[field], undefined);
    assert.equal(fixture.localStorage.getItem(fixture.videoKey("44444444-4444-4444-8444-444444444444")), null);
    assert.deepEqual(fixture.dispatches, []);
    if (typeof cleanup === "function") cleanup();
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["workspace", "account-event", "unmount"] as const) {
  test(`GEN59 actual retained restore effect stays silent after ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const restore = fixture.video({ ...LOCAL_POLL_JOB }).restore;
    let cleanup: void | (() => void);
    try {
      changeLocalVideoScope(fixture, boundary);
      fixture.localStorage.setItem(fixture.videoKey(), JSON.stringify({ ...LOCAL_POLL_JOB, ...LOCAL_POLL_FILE,
        handle: "current-b-restored-handle", status: "completed" }));
      const writes = fixture.writes.length, mutations = fixture.mutations.length;
      cleanup = restore(); await flushLocalVideoWork();
      assert.deepEqual({ writes: fixture.writes.slice(writes), mutations: fixture.mutations.slice(mutations),
        dispatches: fixture.dispatches.map(({ url, method }) => ({ url, method })), toasts: fixture.toasts },
      { writes: [], mutations: [], dispatches: [], toasts: [] }, "an expired restore cannot load B's job or start an old-session follow-up");
    } finally { if (typeof cleanup! === "function") cleanup!(); fixture.lifetime!.unmount(); }
  });
}

test("GEN59 actual same-studio restore retains only the handle and rechecks completed files without a paid POST", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  let cleanup: void | (() => void);
  try {
    fixture.localStorage.setItem(fixture.videoKey(), localNativeVideoDraft({ ...LOCAL_POLL_JOB, status: "completed" }));
    cleanup = fixture.video({ ...LOCAL_POLL_JOB }).restore(); await flushLocalVideoWork();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.VideoJob)), { ...LOCAL_POLL_JOB, status: "in_progress", phase: "validation", validationJobId: localNativeVideoReceipt().validationJobId });
    assert.equal(fixture.state.GenVideo, null, "Local storage cannot authorize an old public URL");
    assert.equal(fixture.dispatches.filter((call) => call.method === "POST").length, 0);
    assert.deepEqual(fixture.toasts, []);
  } finally { if (typeof cleanup! === "function") cleanup!(); fixture.lifetime!.unmount(); }
});

for (const mode of ["throw", "error"] as const) {
  for (const phase of ["token", "body"] as const) {
    test(`GEN60 actual poll recovers from a ${phase}-phase SDK ${mode} with one bounded retry chain`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("video", true);
      const token = phase === "token" ? fixture.deferToken() : undefined;
      const body = phase === "body" ? fixture.deferBody("poll") : undefined;
      const cleanup = fixture.video({ ...LOCAL_POLL_JOB }).poll();
      const controller = fixture.captured.sessionRef.current!;
      const fireOnlyTimer = async () => {
        assert.equal(fixture.timers.size, 1, "the poll must keep only one local retry timer");
        const [id, tick] = [...fixture.timers][0];
        fixture.timers.delete(id); tick(); await flushLocalVideoWork();
      };
      try {
        await (token ? fixture.tokenStarted.promise : fixture.bodyStarted.promise);
        const writes = fixture.writes.length, mutations = fixture.mutations.length;
        fixture.sdkFailure(mode);
        token?.resolve(); body?.resolve(JSON.stringify(fixture.pollReply));
        await flushLocalVideoWork();
        const initialGets = phase === "body" ? 1 : 0;
        assert.equal(fixture.dispatches.length, initialGets);
        assert.deepEqual(fixture.writes.slice(writes), []);
        assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.deepEqual(fixture.toasts, []);
        assert.equal(controller.signal.aborted, false, "an SDK outage is unverified, not a known actor replacement");
        assert.ok(fixture.sdkReads.failed > 0);
        assert.equal(fixture.timers.size, 1);
        assert.equal(fixture.timerCalls(), 1);

        await fireOnlyTimer();
        assert.equal(fixture.dispatches.length, initialGets, "a still-unverified retry cannot dispatch with no valid token");
        assert.equal(fixture.timers.size, 1);
        assert.equal(fixture.timerCalls(), 2);
        assert.deepEqual(fixture.writes.slice(writes), []);
        assert.deepEqual(fixture.toasts, []);
        assert.equal(controller.signal.aborted, false);

        fixture.sdkFailure();
        await fireOnlyTimer();
        assert.equal(fixture.dispatches.length, initialGets + 1);
        assert.ok(fixture.dispatches.every((call) => call.method === "GET" && call.url ===
          `/api/content-studio/video-generation?handle=${encodeURIComponent(LOCAL_POLL_JOB.handle)}&workspaceId=33333333-3333-4333-8333-333333333333`));
        assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.VideoJob)), { ...LOCAL_POLL_JOB, status: "completed", progress: 100, phase: "validation", validationJobId: localNativeVideoReceipt().validationJobId });
        assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.GenVideo)), LOCAL_POLL_FILE);
        assert.deepEqual(fixture.toasts, [], "The confirmed file and completed state remain without an overlapping toast");
        assert.equal(fixture.timers.size, 0);
        assert.equal(fixture.timerCalls(), 2, "the completed job must end the existing retry chain");
      } finally {
        fixture.sdkFailure(); token?.resolve(); body?.resolve(JSON.stringify(fixture.pollReply)); await flushLocalVideoWork();
        if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount();
        assert.equal(fixture.timers.size, 0);
      }
    });
  }
}

test("GEN61 delayed restore cannot replace a newer accepted generation before commit or lose its cache on SDK failure", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true), token = fixture.deferToken();
  const original = { ...LOCAL_POLL_JOB };
  fixture.localStorage.setItem(fixture.videoKey(), localNativeVideoDraft({ ...original, status: "completed" }));
  const restoreCleanup = fixture.video(original).restore();
  let persistenceCleanup: void | (() => void);
  try {
    await fixture.tokenStarted.promise;
    assert.equal(fixture.videoRefs.videoGenerationRevision.current, 0);
    assert.equal(fixture.videoGenerationAttempt.current, null);
    await fixture.generate(); await flushLocalVideoWork();
    const accepted = fixture.state.VideoJob as LocalVideoJob;
    assert.deepEqual(JSON.parse(JSON.stringify(accepted)), fixture.reply.data);
    assert.equal(fixture.videoRefs.videoGenerationRevision.current, 1, "the actual paid callback must advance the monotonic revision");
    assert.equal(fixture.videoGenerationAttempt.current, null, "the attempt has already gone null -> new -> null");
    assert.equal(fixture.videoRefs.videoJobRef.current, original, "do not simulate a React commit before resuming the old initializer");
    const cached = fixture.localStorage.getItem(fixture.videoKey());
    assert.ok(cached);
    assert.deepEqual(JSON.parse(cached), JSON.parse(localNativeVideoDraft(accepted)), "the accepted handle must cache immediately before any persistence effect");
    const writes = fixture.writes.length;
    token.resolve(); await flushLocalVideoWork();
    assert.deepEqual(fixture.writes.slice(writes), [], "the generation revision must block old restore even before the job ref changes");
    assert.equal(fixture.state.VideoJob, accepted);
    assert.equal(fixture.state.GenVideo, null, "the old stored file must not accompany the new paid handle");
    assert.equal(fixture.localStorage.getItem(fixture.videoKey()), cached);

    fixture.sdkFailure("throw");
    const mutations = fixture.mutations.length;
    persistenceCleanup = fixture.video(accepted).persist(); await flushLocalVideoWork();
    assert.equal(fixture.videoRefs.videoJobRef.current, accepted, "the next render must run the actual ref assignment");
    assert.ok(fixture.sdkReads.failed > 0, "exercise the real persistence auth check");
    assert.deepEqual(fixture.mutations.slice(mutations), []);
    assert.deepEqual(fixture.writes.slice(writes), []);
    assert.equal(fixture.localStorage.getItem(fixture.videoKey()), cached, "a transient persistence failure must not erase the accepted paid handle");
    assert.equal(fixture.state.VideoJob, accepted);
    assert.equal(fixture.state.GenBusy, null);
    assert.deepEqual(fixture.toasts, []);
    assert.equal(fixture.dispatches.filter((call) => call.method === "POST").length, 1);
    assert.equal(fixture.dispatches.filter((call) => call.url.includes("/video-generation?")).length, 0);
  } finally {
    fixture.sdkFailure(); token.resolve(); await flushLocalVideoWork();
    if (typeof persistenceCleanup! === "function") persistenceCleanup!();
    if (typeof restoreCleanup === "function") restoreCleanup(); fixture.lifetime!.unmount();
  }
});

for (const boundary of ["workspace", "cleanup", "new-render"] as const) {
  test(`GEN62 actual pending persistence suppresses its captured write after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true), token = fixture.deferToken();
    const cleanup = fixture.video({ ...LOCAL_POLL_JOB }, { ...LOCAL_POLL_FILE }).persist();
    try {
      await fixture.tokenStarted.promise;
      if (boundary === "workspace") fixture.workspace("44444444-4444-4444-8444-444444444444");
      if (boundary === "cleanup" && typeof cleanup === "function") cleanup();
      if (boundary === "new-render") fixture.video({ ...LOCAL_POLL_JOB, handle: "newer-render-handle" });
      const key = fixture.videoKey(), stored = JSON.stringify({ ...LOCAL_POLL_JOB, handle: "current-persisted-handle" });
      fixture.localStorage.setItem(key, stored);
      const mutations = fixture.mutations.length;
      token.resolve(); await flushLocalVideoWork();
      assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.equal(fixture.localStorage.getItem(key), stored);
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.dispatches, []);
    } finally {
      token.resolve(); await flushLocalVideoWork(); if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount();
    }
  });
}

for (const mode of ["throw", "error"] as const) {
  test(`GEN63 unverified restore retries SDK ${mode} and recovers on same-actor refresh without remount`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const key = fixture.videoKey(), stored = localNativeVideoDraft({ ...LOCAL_POLL_JOB, status: "completed" });
    fixture.localStorage.setItem(key, stored);
    fixture.sdkFailure(mode);
    const reads = fixture.storageReads.length;
    const cleanup = fixture.video(null).restore();
    const controller = fixture.captured.sessionRef.current!;
    const fireOnlyTimer = async () => {
      assert.equal(fixture.timers.size, 1);
      const [id, initialize] = [...fixture.timers][0];
      fixture.timers.delete(id); initialize(); await flushLocalVideoWork();
    };
    try {
      await flushLocalVideoWork();
      assert.equal(fixture.timers.size, 1, "initial auth uncertainty must not permanently skip restore");
      assert.deepEqual(fixture.timerDelays, [12000]);
      assert.equal(fixture.dispatches.length, 0);
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.toasts, []);
      assert.equal(fixture.storageReads.slice(reads).filter((read) => read.key === key).length, 0, "unverified restore cannot read a paid job");
      assert.equal(controller.signal.aborted, false);

      await fireOnlyTimer();
      assert.equal(fixture.timers.size, 1, "continued uncertainty must keep one retry, not fan out");
      assert.deepEqual(fixture.timerDelays, [12000, 12000]);
      assert.deepEqual(fixture.writes, []);
      assert.equal(fixture.dispatches.length, 0);
      fixture.sdkFailure();
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
      const refreshed = fixture.lifetime!.render();
      assert.equal(refreshed.key, fixture.mounted!.key);
      assert.equal(refreshed.session.sessionRef.current, controller);
      await fireOnlyTimer();
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.VideoJob)), { ...LOCAL_POLL_JOB, status: "in_progress", phase: "validation", validationJobId: localNativeVideoReceipt().validationJobId });
      assert.equal(fixture.state.GenVideo, null, "A recovered local descriptor still requires fresh server file proof");
      assert.equal(fixture.storageReads.slice(reads).filter((read) => read.key === key).length, 1);
      assert.equal(fixture.localStorage.getItem(key), stored);
      assert.equal(fixture.dispatches.length, 1);
      assert.equal(fixture.dispatches[0].method, "GET");
      assert.equal(fixture.dispatches[0].url, "/api/crm/content-videos?workspaceId=33333333-3333-4333-8333-333333333333");
      assert.equal(fixture.dispatches[0].headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
      assert.equal(fixture.timers.size, 0);
      assert.equal(fixture.timerCalls(), 2);
      assert.deepEqual(fixture.toasts, []);
    } finally {
      fixture.sdkFailure(); if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount();
      assert.equal(fixture.timers.size, 0);
    }
  });
}

for (const phase of ["timer", "token", "body"] as const) {
  test(`GEN64 restore cleanup stops ${phase}-pending work without ending the studio lifetime`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    const token = phase === "token" ? fixture.deferToken() : undefined;
    const body = phase === "body" ? fixture.deferBody("restore") : undefined;
    const reply = JSON.stringify({ success: true, mode: "supabase", data: { videos: [
      { id: "late-library-row", title: "Expired library response", createdAt: "2090-10-20T00:00:00Z" },
    ] } });
    fixture.localStorage.setItem(fixture.videoKey(), localNativeVideoDraft({ ...LOCAL_POLL_JOB, status: "completed" }));
    if (phase === "timer") fixture.sdkFailure("throw");
    const cleanup = fixture.video(null).restore();
    const sessionController = fixture.captured.sessionRef.current!;
    try {
      if (token) await fixture.tokenStarted.promise;
      else if (body) await fixture.bodyStarted.promise;
      else await flushLocalVideoWork();
      assert.equal(typeof cleanup, "function");
      const queued = phase === "timer" ? [...fixture.timers.values()][0] : undefined;
      if (phase === "timer") { assert.equal(fixture.timers.size, 1); assert.deepEqual(fixture.timerDelays, [12000]); }
      const writes = fixture.writes.length, mutations = fixture.mutations.length, reads = fixture.storageReads.length;
      const dispatches = fixture.dispatches.length;
      const ownSignal = fixture.dispatches[0]?.signal;
      if (phase === "body") assert.equal(ownSignal?.aborted, false);
      (cleanup as () => void)();
      assert.equal(fixture.timers.size, 0);
      if (phase === "body") assert.equal(ownSignal?.aborted, true, "cleanup must abort the restore's own in-flight request");
      assert.equal(sessionController.signal.aborted, false, "effect cleanup must not end an unchanged studio session");
      fixture.sdkFailure(); token?.resolve(); body?.resolve(reply);
      queued?.(); // Even a timer callback already dequeued before cleanup must stay inert.
      await flushLocalVideoWork();
      assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.equal(fixture.dispatches.length, dispatches);
      assert.equal(fixture.storageReads.slice(reads).filter((read) => read.key.includes("negis_content_studio_video_job")).length, 0);
      assert.deepEqual(fixture.toasts, []);
      assert.equal(fixture.timers.size, 0);
    } finally {
      fixture.sdkFailure(); token?.resolve(); body?.resolve(reply); await flushLocalVideoWork();
      if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount();
    }
  });
}

const LOCAL_DEMO_DRAFTS = [{ ...LOCAL_LIBRARY_FORM, id: "local-demo-idea", title: "Synthetic local idea", status: "idea", createdAt: "2090-10-20T00:00:00Z" }];
const REAL_DEMO_TEST_WORKSPACE = "11111111-1111-4111-8111-111111111111";

test("GEN65 explicitly allowed local demo hydrates only idea drafts without API, SDK or paid-cache access", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  try {
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    const draftKey = "negis_content_studio_videos::demo-local-a";
    fixture.localStorage.setItem(draftKey, JSON.stringify(LOCAL_DEMO_DRAFTS));
    const paidKey = fixture.videoKey(), paidRaw = localNativeVideoDraft({ ...LOCAL_POLL_JOB, status: "completed" });
    fixture.localStorage.setItem(paidKey, paidRaw);
    const attemptKey = fixture.pendingKey(), attemptRaw = JSON.stringify({ version: 1,
      requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fingerprint: JSON.stringify(["video", "Synthetic local idea", "reels"]) });
    fixture.sessionStorage.setItem(attemptKey, attemptRaw);
    const demo = fixture.localDrafts();
    assert.equal(demo.session.localDraftsOnly, true);
    assert.equal(demo.session.actorId, "");
    assert.notEqual(demo.session.sessionRef, fixture.captured.sessionRef, "the demo remount must use its own current session, not the retired fixture binding");
    assert.equal(demo.session.sessionRef.current?.signal.aborted, false);
    const reads = fixture.storageReads.length, mutations = fixture.mutations.length, sdkReads = fixture.sdkReads.total;
    demo.hydrate();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.writes)), [
      { field: "Videos", value: LOCAL_DEMO_DRAFTS }, { field: "ActiveId", value: LOCAL_DEMO_DRAFTS[0].id },
    ]);
    assert.deepEqual(fixture.storageReads.slice(reads).filter((read) => read.storage === "session" || read.key === paidKey || read.key === attemptKey), []);
    assert.deepEqual(fixture.mutations.slice(mutations), []);
    assert.equal(fixture.sdkReads.total, sdkReads);
    assert.deepEqual(fixture.dispatches, []);
    assert.deepEqual(fixture.toasts, []);
    assert.equal(fixture.localStorage.getItem(paidKey), paidRaw);
    assert.equal(fixture.sessionStorage.getItem(attemptKey), attemptRaw);
    assert.equal(fixture.timers.size, 0);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["UUID-demo", "UUID-selector-fallback", "selector-mismatch", "unauth-not-demo", "loading", "signout", "impersonation"] as const) {
  test(`GEN65 actual wrapper denies local hydration for ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("video", true);
    try {
      fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
      if (boundary === "UUID-demo" || boundary === "UUID-selector-fallback") fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
      if (boundary === "UUID-selector-fallback") fixture.auth({ clinicId: "" });
      if (boundary === "selector-mismatch") { fixture.workspace("demo-selected-b"); fixture.auth({ clinicId: "demo-local-a" }); }
      if (boundary === "unauth-not-demo") fixture.auth({ isDemoMode: false });
      if (boundary === "loading") fixture.auth({ isLoading: true });
      if (boundary === "signout") fixture.auth({ isSigningOut: true });
      if (boundary === "impersonation") fixture.auth({ isImpersonation: true });
      for (const workspace of ["demo-local-a", "demo-selected-b", REAL_DEMO_TEST_WORKSPACE]) {
        fixture.localStorage.setItem(`negis_content_studio_videos::${workspace}`, JSON.stringify(LOCAL_DEMO_DRAFTS));
        fixture.localStorage.setItem(fixture.videoKey(workspace), JSON.stringify({ ...LOCAL_POLL_JOB, ...LOCAL_POLL_FILE }));
      }
      const demo = fixture.localDrafts();
      assert.equal(demo.session.localDraftsOnly, false, "eligibility must come from the actual wrapper, not a test-supplied guard");
      const reads = fixture.storageReads.length, mutations = fixture.mutations.length, sdkReads = fixture.sdkReads.total;
      demo.hydrate();
      assert.deepEqual(fixture.writes, []);
      assert.deepEqual(fixture.storageReads.slice(reads).filter((read) => read.storage === "session" || read.key.startsWith("negis_content_studio_")), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.equal(fixture.sdkReads.total, sdkReads);
      assert.deepEqual(fixture.dispatches, []);
      assert.deepEqual(fixture.toasts, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("GEN66 demo eligibility alone changes the actual wrapper key", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  try {
    fixture.workspace("demo-local-a"); fixture.auth({ user: null });
    const denied = fixture.localDrafts(), oldController = denied.session.sessionRef.current!;
    assert.equal(denied.session.localDraftsOnly, false);
    fixture.auth({ isDemoMode: true });
    const allowed = fixture.localDrafts();
    assert.equal(allowed.session.localDraftsOnly, true);
    assert.equal(allowed.session.actorId, denied.session.actorId);
    assert.equal(allowed.session.workspaceId, denied.session.workspaceId);
    const oldKey = JSON.parse(denied.key!), newKey = JSON.parse(allowed.key!);
    assert.deepEqual(oldKey.slice(0, -1), newKey.slice(0, -1));
    assert.equal(oldKey.at(-1), false); assert.equal(newKey.at(-1), true);
    assert.notEqual(allowed.key, denied.key);
    assert.equal(oldController.signal.aborted, true);
    assert.notEqual(allowed.session.sessionRef.current, oldController);
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

test("GEN66 retained allowed-demo hydration rechecks a changed raw workspace selector", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  try {
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    const demo = fixture.localDrafts();
    assert.equal(demo.session.localDraftsOnly, true);
    fixture.workspace("demo-local-b");
    fixture.localStorage.setItem("negis_content_studio_videos::demo-local-b", JSON.stringify(LOCAL_DEMO_DRAFTS));
    const reads = fixture.storageReads.length;
    demo.hydrate();
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.storageReads.slice(reads).filter((read) => read.key.startsWith("negis_content_studio_")), []);
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

type LocalHandoffKind = "photo" | "image" | "video" | "package";
type LocalHandoffFixture = Awaited<ReturnType<typeof localGenerationCallbacks>>;
type LocalHandoff = ReturnType<LocalHandoffFixture["handoffs"]>;
type LocalHandoffPrefill = {
  sourceKind: string; targetPatients: number; service: string; primaryText: string;
  platform?: string; sourceId?: string; campaignName?: string; city?: string; offer?: string; audience?: string;
  headline?: string; description?: string; cta?: string; durationDays?: number; maxBudget?: number; dailyBudget?: number; budgetCurrency?: string;
  contentApproval?: { packageId?: string; variantId: string; approvedCopy: { primaryText: string } };
  creative?: { type: string; url?: string; fileName?: string; assetId?: string; thumbnailUrl?: string; fileSize?: number; mimeType?: string };
};
const HANDOFF_WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const HANDOFF_FILE = { url: "https://example.invalid/generated.png", assetId: "fixture-generated-asset", fileName: "generated.png",
  mimeType: "image/png", model: "fixture", fileSize: 42 };

function invokeLocalHandoff(handoff: LocalHandoff, kind: LocalHandoffKind) {
  if (kind === "photo") return handoff.callbacks.photo();
  if (kind === "package") return handoff.callbacks.package();
  return handoff.callbacks.generated(kind === "image" ? HANDOFF_FILE : {
    ...HANDOFF_FILE, url: "https://example.invalid/generated.mp4", fileName: "generated.mp4", mimeType: "video/mp4",
    thumbnailUrl: "https://example.invalid/thumbnail.jpg", thumbnailSource: "fixture-thumbnail",
  }, kind);
}

function readLocalHandoff(fixture: LocalHandoffFixture, workspace = REAL_DEMO_TEST_WORKSPACE) {
  const raw = fixture.localStorage.getItem(`negis_ads_automation_prefill::${workspace}`);
  assert.ok(raw, "the actual prefill writer must persist the handoff in the captured workspace");
  return JSON.parse(raw) as LocalHandoffPrefill;
}

async function waitForLocalHandoffBoundary(work: Promise<void>, started: Promise<void>) {
  await Promise.race([started, work.then(() => assert.fail("The actual handoff finished before reaching the requested boundary"))]);
}

function assertNoPrivateHandoffHistory(fixture: LocalHandoffFixture) {
  const persisted = JSON.stringify({ mutations: fixture.mutations, metadata: fixture.dispatches.filter((call) =>
    call.url.split("?")[0] === "/api/crm/content-videos"), toasts: fixture.toasts });
  for (const privateValue of [fixture.signedReply.data.token, fixture.signedReply.data.uploadHandle,
    fixture.signedReply.data.storagePath, "ad-creatives-staging", "blob:"]) {
    assert.equal(persisted.includes(privateValue), false, "Private upload receipts must never become draft/history metadata");
  }
}

const handoffStages = [
  { kind: "photo", resource: "signed", phase: "token" },
  { kind: "photo", resource: "signed", phase: "body" },
  { kind: "photo", resource: "signed", phase: "upload" },
  { kind: "photo", resource: "finalize", phase: "token" },
  { kind: "photo", resource: "finalize", phase: "response" },
  { kind: "photo", resource: "finalize", phase: "body" },
  { kind: "photo", resource: "metadata", phase: "token" },
  { kind: "photo", resource: "metadata", phase: "response" },
  ...(["image", "video", "package"] as const).flatMap((kind) => ([
    { kind, resource: "approval", phase: "token" }, { kind, resource: "approval", phase: "body" },
  ] as const)),
] as const;

for (const stage of handoffStages) {
  for (const boundary of ["account", "silent-account", "workspace", "workspace-remount", "A-B-A", "unmount"] as const) {
    test(`GEN67 actual ${stage.kind} handoff stops ${stage.resource}-${stage.phase} after ${boundary}`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      const handoff = fixture.handoffs(), controller = handoff.session.sessionRef.current!;
      const token = stage.phase === "token" ? fixture.deferToken(stage.resource) : undefined;
      const body = stage.phase === "body" ? fixture.deferBody(stage.resource) : undefined;
      const upload = stage.phase === "upload" ? fixture.deferUpload() : undefined;
      const response = stage.phase === "response" ? fixture.deferResponse(stage.resource) : undefined;
      const bodyValue = () => JSON.stringify(stage.resource === "signed" ? fixture.signedReply
        : stage.resource === "finalize" ? fixture.finalizedReply : { success: true, data: {} });
      const work = invokeLocalHandoff(handoff, stage.kind);
      try {
        if (token) await waitForLocalHandoffBoundary(work, token.started);
        if (body) await waitForLocalHandoffBoundary(work, fixture.bodyStarted.promise);
        if (upload) await waitForLocalHandoffBoundary(work, fixture.uploadStarted.promise);
        if (response) await waitForLocalHandoffBoundary(work, response.started);
        const expectedDispatches = stage.resource === "signed" ? (stage.phase === "token" ? 0 : 1)
          : stage.resource === "finalize" ? (stage.phase === "token" ? 1 : 2)
          : stage.resource === "metadata" ? (stage.phase === "token" ? 2 : 3) : (stage.phase === "token" ? 0 : 1);
        assert.equal(fixture.dispatches.length, expectedDispatches, "pause the actual requested boundary, not an earlier auth guard");
        if (boundary === "account" || boundary === "A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
        if (boundary === "silent-account") fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", null);
        if (boundary === "workspace" || boundary === "workspace-remount") fixture.workspace(HANDOFF_WORKSPACE_B);
        if (boundary === "workspace-remount" || boundary === "A-B-A") fixture.lifetime!.render();
        if (boundary === "A-B-A") { fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
        if (boundary === "unmount") fixture.lifetime!.unmount();
        if (!["silent-account", "workspace"].includes(boundary)) assert.equal(controller.signal.aborted, true);
        const mutations = fixture.mutations.length, writes = fixture.writes.length, uploads = fixture.uploads.length;
        token?.resolve(); body?.resolve(bodyValue()); upload?.resolve(); response?.resolve(); await work; await flushLocalVideoWork();
        assert.equal(fixture.dispatches.length, expectedDispatches, "an expired callback cannot issue a follow-up request");
        assert.equal(fixture.uploads.length, uploads, "a signed response cannot begin storage upload under an expired actor/workspace");
        assert.deepEqual(fixture.mutations.slice(mutations), [], "no prefill can leak into the new workspace");
        assert.deepEqual(fixture.writes.slice(writes), (boundary === "silent-account" || boundary === "workspace") && stage.kind === "photo"
          ? [{ field: "PhotoBusy", value: null }] : []);
        assert.deepEqual(fixture.toasts, []);
        assert.deepEqual(fixture.navigations, []);
        assert.equal(fixture.dispatches.some((call) => call.url.includes("/generate-")), false);
        assertNoPrivateHandoffHistory(fixture);
      } finally {
        token?.resolve(); body?.resolve(bodyValue()); upload?.resolve(); response?.resolve(); await work; fixture.lifetime!.unmount();
      }
    });
  }
}

for (const kind of ["photo", "image", "video", "package"] as const) {
  test(`GEN68 actual ${kind} handoff survives same-actor refresh and preserves its payload`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const handoff = fixture.handoffs(), controller = handoff.session.sessionRef.current!;
    const token = fixture.deferToken(kind === "photo" ? "signed" : "approval");
    const work = invokeLocalHandoff(handoff, kind);
    try {
      await waitForLocalHandoffBoundary(work, token.started);
      if (kind === "photo") assert.ok(fixture.handoffRequests.every(({ init }) => init.dispatchGuard?.() === true), "the artifact-bound guard is live while handoff is pending");
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
      assert.equal(fixture.lifetime!.render().key, handoff.key);
      assert.equal(controller.signal.aborted, false);
      token.resolve(); await work;
      assert.equal(fixture.dispatches.length, kind === "photo" ? 3 : 1);
      for (const call of fixture.dispatches) {
        assert.equal(new URL(call.url, "https://example.invalid").searchParams.get("workspaceId"), REAL_DEMO_TEST_WORKSPACE);
        assert.equal(call.headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
        assert.equal(call.signal, controller.signal);
      }
      for (const { init } of fixture.handoffRequests) {
        assert.equal(init.expectedUserId, "11111111-1111-4111-8111-111111111111"); assert.equal(init.signal, controller.signal);
        assert.equal(init.dispatchGuard?.(), kind !== "photo", "the completed photo attempt must no longer authorize dispatch");
      }
      const prefill = readLocalHandoff(fixture);
      assert.equal(prefill.sourceKind, kind === "image" || kind === "video" ? "generated" : kind);
      assert.equal(prefill.targetPatients, 7);
      assert.equal(prefill.service, "Synthetic service");
      assert.equal(prefill.primaryText, kind === "photo" ? "Local photo offer. Local photo CTA." : "Approved local copy");
      assert.ok(prefill.creative);
      assert.equal(prefill.creative.type, kind === "photo" || kind === "image" ? "image" : "video");
      if (kind === "photo") {
        assert.equal(fixture.uploads.length, 1); assert.equal(fixture.uploads[0].bucket, "ad-creatives-staging");
        assert.equal(Object.hasOwn(fixture.signedReply.data, "publicUrl"), false);
        assert.deepEqual(fixture.dispatches.map((call) => call.url.split("?")[0]), [
          "/api/crm/ad-creatives/signed-upload", "/api/crm/ad-creatives/finalize-upload", "/api/crm/content-videos",
        ]);
        assert.deepEqual(fixture.dispatches[1].body, { uploadHandle: fixture.signedReply.data.uploadHandle });
        assert.equal(prefill.creative.url, fixture.finalizedReply.data.asset.publicUrl);
        assert.equal(prefill.creative.assetId, fixture.finalizedReply.data.asset.id);
        assert.equal(prefill.creative.fileSize, fixture.finalizedReply.data.asset.fileSize);
        assert.notEqual(prefill.creative.fileSize, fixture.signedReply.data.fileSize, "Use the finalized encoding metadata, not the private input size");
        assert.equal((fixture.dispatches[2].body as { photoCreative: { creativeUrl: string } }).photoCreative.creativeUrl, prefill.creative.url);
        assert.equal(fixture.state.PhotoBusy, null);
        assertNoPrivateHandoffHistory(fixture);
      } else {
        assert.equal(fixture.uploads.length, 0);
        const approval = (fixture.dispatches[0].body as { contentApproval: NonNullable<LocalHandoffPrefill["contentApproval"]> }).contentApproval;
        assert.deepEqual(prefill.contentApproval, approval);
        assert.equal(approval.packageId, "fixture-package-a"); assert.equal(approval.variantId, "variant-a");
        assert.equal(approval.approvedCopy.primaryText, "Approved local copy");
        if (kind !== "package") assert.equal(prefill.creative.assetId, HANDOFF_FILE.assetId);
        if (kind === "video") assert.equal(prefill.creative.thumbnailUrl, "https://example.invalid/thumbnail.jpg");
      }
      assert.deepEqual(fixture.navigations, ["/ads-automation"]);
      assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "success");
      assert.equal(fixture.dispatches.some((call) => call.url.includes("/generate-")), false);
    } finally { token.resolve(); await work; fixture.lifetime!.unmount(); }
  });
}

for (const status of [401, 403] as const) {
  for (const resource of ["signed", "finalize", "metadata", "approval"] as const) {
    for (const failure of ["response", "body-reject", "transport"] as const) {
      test(`GEN69 actual ${resource} ${status} ${failure} denies handoff despite a valid same-actor token`, async () => {
        const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
        if (failure === "transport") fixture.handoffTransportFailures[resource] = status;
        else fixture.handoffStatuses[resource] = status;
        if (failure === "body-reject") fixture.handoffBodyFailures.add(resource);
        try {
          await invokeLocalHandoff(fixture.handoffs(), resource === "approval" ? "package" : "photo");
          assert.equal(fixture.dispatches.length, resource === "metadata" ? 3 : resource === "finalize" ? 2 : 1);
          assert.equal(fixture.uploads.length, resource === "metadata" || resource === "finalize" ? 1 : 0);
          assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
          assert.deepEqual(fixture.navigations, []);
          assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
          assert.ok(fixture.sdkReads.total > 0, "same actor remains genuinely authenticated; rights denial must remain distinct");
          assertNoPrivateHandoffHistory(fixture);
        } finally { fixture.lifetime!.unmount(); }
      });
    }
  }
  for (const field of ["status", "statusCode"] as const) {
    for (const value of [status, String(status)]) {
      for (const mode of ["returned", "thrown"] as const) {
        test(`GEN69 actual ${mode} upload ${field}=${JSON.stringify(value)} denies the complete photo handoff`, async () => {
          const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
          const error = { [field]: value, message: "Synthetic upload denial" };
          if (mode === "returned") fixture.uploadError(error); else fixture.uploadThrown(error);
          try {
            await fixture.handoffs().callbacks.photo();
            assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.uploads.length, 1);
            assert.deepEqual(fixture.navigations, []);
            assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
            assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
          } finally { fixture.lifetime!.unmount(); }
        });
      }
    }
  }
  for (const kind of ["image", "video"] as const) {
    test(`GEN69 actual generated ${kind} approval ${status} stops prefill and navigation`, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      fixture.handoffStatuses.approval = status;
      try {
        await invokeLocalHandoff(fixture.handoffs(), kind);
        assert.equal(fixture.dispatches.length, 1); assert.deepEqual(fixture.uploads, []);
        assert.deepEqual(fixture.navigations, []);
        assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
        assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const failure of ["signed-500", "storage-500", "storage-unavailable", "finalize-500", "finalize-body-reject", "metadata-500", "metadata-transport-500"] as const) {
  test(`GEN70 actual photo ${failure} preserves current-scope local handoff behavior`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    if (failure === "signed-500") fixture.handoffStatuses.signed = 500;
    if (failure === "storage-500") fixture.uploadError({ statusCode: "500", message: "Synthetic upload unavailable" });
    if (failure === "storage-unavailable") fixture.uploadFailure();
    if (failure === "finalize-500") fixture.handoffStatuses.finalize = 500;
    if (failure === "finalize-body-reject") fixture.handoffBodyFailures.add("finalize");
    if (failure === "metadata-500") fixture.handoffStatuses.metadata = 500;
    if (failure === "metadata-transport-500") fixture.handoffTransportFailures.metadata = 500;
    try {
      await fixture.handoffs().callbacks.photo();
      const prefill = readLocalHandoff(fixture);
      assert.equal(prefill.sourceKind, "photo");
      if (!failure.startsWith("metadata")) {
        assert.equal(prefill.creative, undefined, "A failed verification must not fabricate an image asset");
        assert.ok(fixture.toasts.some((toast) => toast.kind === "warning" && toast.message.includes("только тексты")));
        assert.ok(fixture.toasts.every((toast) => !toast.message.includes("Фото-креатив передан")));
      } else {
        assert.ok(prefill.creative); assert.equal(prefill.creative.url, fixture.finalizedReply.data.asset.publicUrl);
        assert.deepEqual(fixture.toasts, [{ kind: "success", message: "Фото-креатив передан в AI запуск рекламы" }]);
      }
      assert.deepEqual(fixture.navigations, ["/ads-automation"]);
      assert.equal(fixture.state.PhotoBusy, null);
      assert.ok(fixture.toasts.every((toast) => toast.kind !== "error"));
      assertNoPrivateHandoffHistory(fixture);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["image", "video", "package"] as const) {
  test(`GEN70 actual ${kind} approval 500 preserves local prefill and the existing warning`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.handoffStatuses.approval = 500;
    try {
      await invokeLocalHandoff(fixture.handoffs(), kind);
      assert.ok(readLocalHandoff(fixture).contentApproval);
      assert.deepEqual(fixture.navigations, ["/ads-automation"]);
      assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "warning");
      assert.ok(fixture.toasts[0].message.includes("отметка согласования не сохранилась"));
      assert.equal(fixture.dispatches.length, 1); assert.deepEqual(fixture.uploads, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["photo", "image", "video", "package"] as const) {
  test(`GEN71 explicit synthetic demo ${kind} handoff is local-only without SDK or paid-cache access`, async () => {
    const fixture = await localGenerationCallbacks("photo", true);
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    const handoff = fixture.handoffs();
    const reads = fixture.sdkReads.total, storageReads = fixture.storageReads.length;
    try {
      assert.equal(handoff.session.localDraftsOnly, true); assert.equal(handoff.session.actorId, "");
      await invokeLocalHandoff(handoff, kind);
      assert.equal(readLocalHandoff(fixture, "demo-local-a").sourceKind, kind === "image" || kind === "video" ? "generated" : kind);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.sdkReads.total, reads);
      assert.deepEqual(fixture.storageReads.slice(storageReads).filter((item) => /paid_generation|video_job/.test(item.key)), []);
      assert.deepEqual(fixture.navigations, ["/ads-automation"]);
    } finally { fixture.lifetime!.unmount(); }
  });
  for (const boundary of ["account", "workspace", "unmount", "UUID-demo", "anonymous-not-demo"] as const) {
    test(`GEN71 actual ${kind} local handoff cannot outlive ${boundary}`, async () => {
      const fixture = await localGenerationCallbacks("photo", true);
      fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
      let handoff = fixture.handoffs();
      if (boundary === "account") { fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" }, isDemoMode: false }); fixture.lifetime!.render(); }
      if (boundary === "workspace") fixture.workspace("demo-local-b");
      if (boundary === "unmount") fixture.lifetime!.unmount();
      if (boundary === "UUID-demo") { fixture.workspace(REAL_DEMO_TEST_WORKSPACE); handoff = fixture.handoffs(); }
      if (boundary === "anonymous-not-demo") { fixture.auth({ isDemoMode: false }); handoff = fixture.handoffs(); }
      const mutations = fixture.mutations.length, reads = fixture.sdkReads.total;
      try {
        await invokeLocalHandoff(handoff, kind);
        assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
        assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts, []);
        assert.equal(fixture.sdkReads.total, reads);
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const status of [401, 403] as const) {
  test(`GEN72 nested approval ${status} returns null before a transient SDK failure can downgrade denial`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.handoffStatuses.approval = status;
    fixture.handoffBodyFailures.add("approval");
    fixture.onHandoffResponse((resource) => { if (resource === "approval") fixture.sdkFailureOnce("error"); });
    const handoff = fixture.handoffs();
    try {
      const result = await handoff.callbacks.approve({ variantId: "variant-a", version: 1 }, handoff.session.sessionRef.current);
      assert.equal(result, null, "known denial must survive both an unreadable body and a pending transient auth error");
      assert.equal(fixture.sdkReads.failed, 0, "classify the known response before probing auth again");
      assert.equal(fixture.dispatches.length, 1); assert.deepEqual(fixture.uploads, []);
      assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts, []);
      assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
    } finally { fixture.lifetime!.unmount(); }
  });
  for (const kind of ["image", "video", "package"] as const) {
    test(`GEN72 actual ${kind} approval ${status} cannot become fallback when one auth probe fails then recovers`, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      fixture.handoffStatuses.approval = status;
      fixture.onHandoffResponse((resource) => { if (resource === "approval") fixture.sdkFailureOnce("error"); });
      try {
        const handoff = fixture.handoffs();
        await invokeLocalHandoff(handoff, kind);
        assert.equal(fixture.sdkReads.failed, 1, "exercise the real one-shot SDK outage after receiving a known denial");
        assert.equal(fixture.dispatches.length, 1);
        assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts.slice(), []);
        assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
        fixture.onHandoffResponse();
        await invokeLocalHandoff(handoff, kind);
        assert.equal(fixture.dispatches.length, 2, "auth must actually recover in the same unchanged session");
        assert.deepEqual(fixture.navigations, []);
        assert.deepEqual(fixture.mutations.filter((item) => item.key.includes("ads_automation_prefill")), []);
        assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const kind of ["photo", "image", "video", "package"] as const) {
  for (const failure of ["actor-mismatch", "missing-token", "SDK-error", "SDK-throw"] as const) {
    test(`GEN73 actual ${kind} handoff rejects ${failure} before any effect`, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      const handoff = fixture.handoffs();
      if (failure === "actor-mismatch") fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", null);
      if (failure === "missing-token") fixture.sdkSession("11111111-1111-4111-8111-111111111111", "", null);
      if (failure === "SDK-error") fixture.sdkFailure("error");
      if (failure === "SDK-throw") fixture.sdkFailure("throw");
      const mutations = fixture.mutations.length;
      try {
        await invokeLocalHandoff(handoff, kind);
        assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
        assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts, []);
        assert.deepEqual(fixture.writes, []); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.ok(fixture.sdkReads.total > 0);
      } finally { fixture.lifetime!.unmount(); }
    });
  }
  for (const boundary of ["account", "workspace", "unmount"] as const) {
    test(`GEN73 pending local demo ${kind} handoff rechecks ${boundary} after its async guard`, async () => {
      const fixture = await localGenerationCallbacks("photo", true);
      fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
      const handoff = fixture.handoffs(), reads = fixture.sdkReads.total;
      const work = invokeLocalHandoff(handoff, kind);
      if (boundary === "account") { fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" }, isDemoMode: false }); fixture.lifetime!.render(); }
      if (boundary === "workspace") fixture.workspace("demo-local-b");
      if (boundary === "unmount") fixture.lifetime!.unmount();
      const mutations = fixture.mutations.length;
      try {
        await work;
        assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
        assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts, []);
        assert.deepEqual(fixture.writes, []); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.equal(fixture.sdkReads.total, reads);
      } finally { await work; fixture.lifetime!.unmount(); }
    });
  }
}

for (const mode of ["no-package-id", "no-package", "local-demo", "unavailable"] as const) {
  test(`GEN74 actual nested approval returns false without unauthorized side effects for ${mode}`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    if (mode === "local-demo") { fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true }); }
    if (mode === "unavailable") fixture.handoffStatuses.approval = 500;
    const handoff = fixture.handoffs(mode === "no-package-id" ? { contentPackageId: "" }
      : mode === "no-package" ? { contentPackage: null } : undefined);
    const mutations = fixture.mutations.length;
    try {
      assert.equal(await handoff.callbacks.approve({ variantId: "variant-a", version: 1 }, handoff.session.sessionRef.current), false);
      assert.equal(fixture.dispatches.length, mode === "unavailable" ? 1 : 0);
      assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts, []);
      assert.deepEqual(fixture.mutations.slice(mutations), []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["image", "video"] as const) {
  test(`GEN74 generated ${kind} without a selected package variant still hands off in the same current scope`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    try {
      await invokeLocalHandoff(fixture.handoffs({ contentPackageId: "", contentPackage: null, selectedAdVariant: null }), kind);
      const prefill = readLocalHandoff(fixture);
      assert.equal(prefill.sourceKind, "generated"); assert.equal(prefill.primaryText, "Synthetic offer");
      assert.ok(!prefill.contentApproval); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
      assert.deepEqual(fixture.navigations, ["/ads-automation"]);
      assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "success");
    } finally { fixture.lifetime!.unmount(); }
  });
}

const PACKAGE_STAGES = [
  { resource: "package-generation", phase: "token" }, { resource: "package-generation", phase: "response" },
  { resource: "package-generation", phase: "body" }, { resource: "package-save", phase: "token" },
  { resource: "package-save", phase: "response" }, { resource: "package-save", phase: "body" },
] as const;
type PackageStage = typeof PACKAGE_STAGES[number];

async function pausePackage(fixture: LocalHandoffFixture, stage: PackageStage) {
  const token = stage.phase === "token" ? fixture.deferToken(stage.resource) : undefined;
  const body = stage.phase === "body" ? fixture.deferBody(stage.resource) : undefined;
  const response = stage.phase === "response" ? fixture.deferResponse(stage.resource) : undefined;
  const captured = fixture.packages(), work = captured.callbacks.generate();
  const resume = (bodyValue?: string) => {
    token?.resolve(); response?.resolve();
    body?.resolve(bodyValue ?? JSON.stringify(stage.resource === "package-generation" ? fixture.packageReplies.generation : fixture.packageReplies.save));
  };
  try {
    if (token) await token.started;
    if (body) await fixture.bodyStarted.promise;
    if (response) await response.started;
    const expectedRequests = stage.resource === "package-generation" ? (stage.phase === "token" ? 0 : 1)
      : stage.phase === "token" ? 1 : 2;
    assert.equal(fixture.dispatches.length, expectedRequests, "pause the actual requested transport stage, not an earlier auth guard");
    return { captured, work, resume, expectedRequests };
  } catch (error) { resume(); await work; throw error; }
}

function packageSnapshot(fixture: LocalHandoffFixture) {
  return JSON.parse(JSON.stringify(Object.fromEntries(["ContentPackage", "ContentPackageId", "SelectedAdVariantId", "PackageGenerationMode", "GenPrompt", "Notice"]
    .map((field) => [field, fixture.state[field]]))));
}

for (const stage of PACKAGE_STAGES) {
  for (const boundary of ["account", "silent-account", "workspace", "A-B-A", "unmount"] as const) {
    test(`G5C9 ${stage.resource}-${stage.phase} cannot publish or follow up after ${boundary}`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      const paused = await pausePackage(fixture, stage);
      try {
        if (boundary === "account" || boundary === "A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
        if (boundary === "silent-account") fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", null);
        if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
        if (boundary === "A-B-A") {
          fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render();
        }
        if (boundary === "unmount") fixture.lifetime!.unmount();
        Object.assign(fixture.state, { ContentPackage: { ...LOCAL_GENERATED_PACKAGE, ideaTitle: "Current package B" },
          ContentPackageId: "current-package-b", GenPrompt: "Current prompt B", Notice: "Current notice B", Loading: "package" });
        const before = packageSnapshot(fixture), writes = fixture.writes.length, toasts = fixture.toasts.length, mutations = fixture.mutations.length;
        paused.resume(); await paused.work; await flushLocalVideoWork();
        assert.equal(fixture.dispatches.length, paused.expectedRequests, "expired generation must not save; expired save must not continue");
        assert.deepEqual(packageSnapshot(fixture), before, "late A must not replace B's package, receipt, variant, prompt or notice");
        assert.deepEqual(fixture.writes.slice(writes), boundary === "silent-account" || boundary === "workspace"
          ? [{ field: "Loading", value: null }] : []);
        assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []);
      } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
    });
  }
}

for (const resource of ["package-generation", "package-save"] as const) {
  for (const outcome of ["error", "auth", "unreadable"] as const) {
    test(`G5C9 late ${resource} ${outcome} body remains silent after account replacement`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      const paused = await pausePackage(fixture, { resource, phase: "body" });
      try {
        fixture.sdkSession("22222222-2222-4222-8222-222222222222"); fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" } }); fixture.lifetime!.render();
        fixture.state.Notice = "Current notice B";
        const writes = fixture.writes.length, toasts = fixture.toasts.length;
        paused.resume(outcome === "unreadable" ? "{not-json" : JSON.stringify({ success: false,
          error: outcome === "auth" ? "Synthetic authorization body" : "Synthetic late error", code: outcome === "auth" ? "authentication_required" : "fixture_error" }));
        await paused.work;
        assert.equal(fixture.state.Notice, "Current notice B");
        assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "Loading"), []);
        assert.deepEqual(fixture.toasts.slice(toasts), []);
        assert.equal(fixture.dispatches.length, paused.expectedRequests);
      } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
    });
  }
}

for (const stage of PACKAGE_STAGES) {
  test(`G5C9 brief ABA revision expires ${stage.resource}-${stage.phase} even when values return to A`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePackage(fixture, stage);
    try {
      paused.captured.callbacks.updateBrief("service", "Synthetic service B");
      const edited = fixture.packages();
      edited.callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service);
      const restored = fixture.packages();
      assert.equal(restored.key, paused.captured.key, "a brief edit must not masquerade as a new actor lifetime");
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.PackageBrief)), LOCAL_PACKAGE_BRIEF);
      const before = packageSnapshot(fixture), writes = fixture.writes.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work;
      assert.deepEqual(packageSnapshot(fixture), before, "ABA values cannot revive a superseded form revision");
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "Loading"), []);
      assert.deepEqual(fixture.toasts.slice(toasts), []);
      assert.equal(fixture.dispatches.length, paused.expectedRequests);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const resource of ["package-generation", "package-save"] as const) {
  test(`G5C9 same-account refresh during ${resource} token lookup completes one scoped generation and save`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePackage(fixture, { resource, phase: "token" });
    try {
      const controller = paused.captured.session.sessionRef.current;
      assert.ok(fixture.packageRequests.every((request) => request.init.dispatchGuard?.() === true));
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
      assert.equal(fixture.packages().key, paused.captured.key);
      paused.resume(); await paused.work;
      assert.equal(fixture.dispatches.length, 2); assert.equal(fixture.state.ContentPackageId, "saved-package-a");
      assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.ContentPackage)), LOCAL_GENERATED_PACKAGE);
      assert.equal(fixture.state.SelectedAdVariantId, "generated-variant-a"); assert.equal(fixture.state.GenPrompt, LOCAL_GENERATED_PACKAGE.photoPrompt);
      assert.equal(fixture.state.Loading, null); assert.equal(fixture.state.Notice, "");
      assert.deepEqual(fixture.dispatches[0].body, LOCAL_PACKAGE_BRIEF);
      const saved = fixture.dispatches[1].body as { packageBrief: unknown; packageData: unknown };
      assert.deepEqual(saved.packageBrief, LOCAL_PACKAGE_BRIEF); assert.deepEqual(saved.packageData, LOCAL_GENERATED_PACKAGE);
      for (const call of fixture.dispatches) {
        assert.equal(new URL(call.url, "https://example.invalid").searchParams.get("workspaceId"), REAL_DEMO_TEST_WORKSPACE);
        assert.equal(call.signal, controller!.signal);
      }
      for (const request of fixture.packageRequests) {
        assert.equal(request.init.expectedUserId, "11111111-1111-4111-8111-111111111111"); assert.equal(typeof request.init.dispatchGuard, "function");
      }
      const refreshedCalls = fixture.dispatches.slice(resource === "package-generation" ? 0 : 1);
      assert.ok(refreshedCalls.every((call) => call.headers.get("Authorization") === "Bearer fixture-token-a-refreshed"));
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
      assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const resource of ["package-generation", "package-save"] as const) {
  for (const status of [401, 403] as const) {
    test(`G5C9 ${resource} ${status} is denied before reading an unreadable body`, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      fixture.handoffStatuses[resource] = status; fixture.handoffBodyFailures.add(resource);
      try {
        await fixture.packages().callbacks.generate();
        assert.equal(fixture.packageBodyReads.includes(resource), false, "known HTTP authorization denial must be classified before text()");
        assert.equal(fixture.dispatches.length, resource === "package-generation" ? 1 : 2);
        assert.ok(!fixture.state.ContentPackageId);
        assert.ok(fixture.toasts.some((toast) => toast.kind === "error"));
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

const PACKAGE_INVALID_RECEIPTS: { name: string; status?: number; body?: unknown; text?: string; transport?: number }[] = [
  { name: "HTTP 500 with success and ID", status: 500, body: { success: true, data: { video: { id: "unconfirmed-id" } } } },
  { name: "HTTP 201 success false", status: 201, body: { success: false, data: { video: { id: "unconfirmed-id" } } } },
  { name: "malformed JSON", text: "{invalid-json" }, { name: "missing ID", body: { success: true, data: { video: {} } } },
  { name: "missing data", body: { success: true } }, { name: "null receipt", body: null },
  ...[0, 42, {}, [], "", " \n\t "].map((id) => ({ name: `invalid ID ${JSON.stringify(id)}`, body: { success: true, data: { video: { id } } } })),
  { name: "transport 500", transport: 500 },
];

for (const receipt of PACKAGE_INVALID_RECEIPTS) {
  test(`G5C9 accepted new package cannot retain an old or invalid ID after ${receipt.name}`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    try {
      await fixture.packages().callbacks.generate(); assert.equal(fixture.state.ContentPackageId, "saved-package-a");
      const nextPackage = { ...LOCAL_GENERATED_PACKAGE, ideaTitle: "Synthetic generated package B" };
      fixture.packageReplies.generation = { success: true, mode: "fixture", data: nextPackage };
      fixture.packageReplies.save = receipt.body ?? (receipt.name === "null receipt" ? null : { success: true, data: {} });
      fixture.packageReplies.saveText = receipt.text;
      if (receipt.status) fixture.handoffStatuses["package-save"] = receipt.status;
      if (receipt.transport) fixture.handoffTransportFailures["package-save"] = receipt.transport;
      await fixture.packages().callbacks.generate();
      assert.equal((fixture.state.ContentPackage as { ideaTitle: string }).ideaTitle, nextPackage.ideaTitle);
      assert.equal(fixture.state.ContentPackageId, "", "an accepted new package cannot inherit a prior package's receipt");
      assert.equal(fixture.dispatches.length, 4); assert.equal(fixture.state.Loading, null);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const key of ["video", "item"] as const) {
  test(`G5C9 OK save retains a valid string ${key} receipt and preserves an edited photo prompt`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.packages(); fixture.state.GenPrompt = "Operator's edited prompt";
    fixture.packageReplies.save = { success: true, data: { [key]: { id: "valid-package-receipt" } } };
    const body = fixture.deferBody("package-save"), work = fixture.packages().callbacks.generate();
    const savedBody = JSON.stringify(fixture.packageReplies.save);
    try {
      await fixture.bodyStarted.promise;
      fixture.state.Loading = "video";
      body.resolve(savedBody); await work;
      assert.equal(fixture.state.ContentPackageId, "valid-package-receipt");
      assert.equal(fixture.state.GenPrompt, "Operator's edited prompt"); assert.equal(fixture.dispatches.length, 2);
      assert.equal(fixture.state.Loading, "video", "package finally must not clear a different current loading operation");
    } finally { body.resolve(savedBody); await work; fixture.lifetime!.unmount(); }
  });
}

for (const stage of PACKAGE_STAGES.filter((item) => item.phase !== "response")) {
  test(`G5C9 pending lock survives ${stage.resource}-${stage.phase}, disabled click and edited-brief render`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePackage(fixture, stage);
    try {
      const disabled = fixture.packages(); assert.equal(disabled.callbacks.disabled, true);
      paused.captured.callbacks.click(); disabled.callbacks.click();
      disabled.callbacks.updateBrief("service", "Synthetic edited brief B");
      const next = fixture.packages(); next.callbacks.click();
      await flushLocalVideoWork();
      assert.equal(fixture.dispatches.length, paused.expectedRequests, "the pending ref, not a rendered disabled attribute, must block duplicate POSTs");
      paused.resume(); await paused.work; await flushLocalVideoWork();
      assert.equal(fixture.dispatches.length, paused.expectedRequests, "editing the brief must not release the pending lock before old save/generation settles");
      await fixture.packages().callbacks.generate();
      assert.equal(fixture.dispatches.length, paused.expectedRequests + 2, "settled obsolete work must release the lock for the current brief");
      assert.equal((fixture.dispatches.at(-2)!.body as LocalPackageBrief).service, "Synthetic edited brief B");
    } finally { paused.resume(); await paused.work; await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
  });
}

for (const resource of ["package-generation", "package-save"] as const) {
  test(`G5C9 late ${resource} A cannot overwrite a newer actor B package or receipt`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePackage(fixture, { resource, phase: "body" });
    const oldBody = JSON.stringify(resource === "package-generation" ? fixture.packageReplies.generation : fixture.packageReplies.save);
    try {
      fixture.sdkSession("22222222-2222-4222-8222-222222222222"); fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" } });
      fixture.packageReplies.generation = { success: true, mode: "fixture", data: { ...LOCAL_GENERATED_PACKAGE, ideaTitle: "Accepted package B" } };
      fixture.packageReplies.save = { success: true, data: { item: { id: "accepted-package-b" } } };
      await fixture.packages().callbacks.generate();
      assert.equal(fixture.state.ContentPackageId, "accepted-package-b");
      const before = packageSnapshot(fixture), requests = fixture.dispatches.length, toasts = fixture.toasts.length;
      paused.resume(oldBody); await paused.work;
      assert.deepEqual(packageSnapshot(fixture), before); assert.equal(fixture.dispatches.length, requests);
      assert.deepEqual(fixture.toasts.slice(toasts), []);
    } finally { paused.resume(oldBody); await paused.work; fixture.lifetime!.unmount(); }
  });
}

test("G5C9 explicit synthetic local demo uses the real shared demo package with zero transport or SDK reads", async () => {
  const fixture = await localGenerationCallbacks("photo", true);
  fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
  const captured = fixture.packages(), reads = fixture.sdkReads.total, mutations = fixture.mutations.length;
  try {
    assert.equal(captured.session.localDraftsOnly, true);
    await captured.callbacks.generate();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.ContentPackage)), JSON.parse(JSON.stringify(fixture.purePackageDemo(LOCAL_PACKAGE_BRIEF))));
    assert.equal(fixture.state.PackageGenerationMode, "demo"); assert.equal(fixture.state.ContentPackageId, "");
    assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.packageRequests, []); assert.deepEqual(fixture.uploads, []);
    assert.equal(fixture.sdkReads.total, reads); assert.deepEqual(fixture.mutations.slice(mutations), []);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["UUID-demo", "anonymous-not-demo", "account", "workspace", "unmount"] as const) {
  test(`G5C9 local package demo cannot run under ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("photo", true);
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    let captured = fixture.packages();
    if (boundary === "UUID-demo") { fixture.workspace(REAL_DEMO_TEST_WORKSPACE); captured = fixture.packages(); }
    if (boundary === "anonymous-not-demo") { fixture.auth({ isDemoMode: false }); captured = fixture.packages(); }
    if (boundary === "account") { fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" }, isDemoMode: false }); fixture.lifetime!.render(); }
    if (boundary === "workspace") fixture.workspace("demo-local-b");
    if (boundary === "unmount") fixture.lifetime!.unmount();
    const writes = fixture.writes.length, reads = fixture.sdkReads.total, mutations = fixture.mutations.length;
    try {
      await captured.callbacks.generate();
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.toasts, []);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.sdkReads.total, reads); assert.deepEqual(fixture.mutations.slice(mutations), []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C9 review mounted workspace mismatch releases loading and permits retry after selector restoration", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePackage(fixture, { resource: "package-save", phase: "body" });
  try {
    fixture.workspace(HANDOFF_WORKSPACE_B);
    assert.equal(paused.captured.session.sessionRef.current!.signal.aborted, false, "keep the original child mounted during selector mismatch");
    const before = packageSnapshot(fixture), writes = fixture.writes.length, toasts = fixture.toasts.length;
    paused.resume(); await paused.work;
    assert.equal(fixture.state.Loading, null, "mounted spinner cleanup must not require the selector still to match");
    assert.deepEqual(packageSnapshot(fixture), before, "spinner cleanup cannot authorize publishing the expired save receipt");
    assert.deepEqual(fixture.writes.slice(writes), [{ field: "Loading", value: null }]);
    assert.deepEqual(fixture.toasts.slice(toasts), []); assert.equal(fixture.dispatches.length, 2);
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
    const restored = fixture.packages();
    assert.equal(restored.key, paused.captured.key); assert.equal(restored.callbacks.disabled, false);
    await restored.callbacks.generate();
    assert.equal(fixture.dispatches.length, 4); assert.equal(fixture.state.ContentPackageId, "saved-package-a");
    assert.equal(fixture.state.Loading, null);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C9 review no-op brief update preserves the pending generation revision and receipt", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePackage(fixture, { resource: "package-generation", phase: "body" });
  try {
    const brief = fixture.state.PackageBrief, writes = fixture.writes.length;
    paused.captured.callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service);
    assert.equal(fixture.state.PackageBrief, brief, "a no-op must neither clone the brief nor invalidate its revision");
    assert.deepEqual(fixture.writes.slice(writes), []);
    const rendered = fixture.packages(); assert.equal(rendered.key, paused.captured.key);
    paused.resume(); await paused.work;
    assert.equal(fixture.dispatches.length, 2); assert.equal(fixture.state.ContentPackageId, "saved-package-a");
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.ContentPackage)), LOCAL_GENERATED_PACKAGE);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

const PACKAGE_REJECTED_GENERATIONS: { name: string; data: unknown; mode?: unknown; status?: number; success?: boolean }[] = [
  { name: "empty object", data: {} }, { name: "null", data: null },
  { name: "malformed variant", data: { ...LOCAL_GENERATED_PACKAGE, adVariants: [{ ...LOCAL_GENERATED_PACKAGE.adVariants[0], id: 42 }] } },
  { name: "malformed string list", data: { ...LOCAL_GENERATED_PACKAGE, shotList: ["Valid shot", 42] } },
  { name: "malformed required string", data: { ...LOCAL_GENERATED_PACKAGE, ideaTitle: null } },
  { name: "empty variant list", data: { ...LOCAL_GENERATED_PACKAGE, adVariants: [] } },
  { name: "non-string mode", data: LOCAL_GENERATED_PACKAGE, mode: 42 },
  { name: "failed generation HTTP 503", data: LOCAL_GENERATED_PACKAGE, status: 503, success: false },
];

for (const rejected of PACKAGE_REJECTED_GENERATIONS) {
  test(`G5C9 review ${rejected.name} generation preserves the prior valid package and ID before any publication`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    try {
      await fixture.packages().callbacks.generate();
      assert.equal(fixture.state.ContentPackageId, "saved-package-a");
      const prior = packageSnapshot(fixture), writes = fixture.writes.length, toasts = fixture.toasts.length;
      fixture.packageReplies.generation = { success: rejected.success ?? true, mode: rejected.mode ?? "fixture", data: rejected.data,
        error: "Synthetic generation unavailable" };
      fixture.handoffStatuses["package-generation"] = rejected.status ?? 200;
      await fixture.packages().callbacks.generate();
      const current = packageSnapshot(fixture);
      assert.deepEqual({ ...current, Notice: prior.Notice }, prior, "failed or malformed generation must preserve the complete prior valid package provenance");
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => !["Loading", "Notice"].includes(write.field)), [],
        "never queue malformed data, clear the old receipt, or publish a normalized replacement before validation");
      assert.equal(fixture.dispatches.length, 3, "rejected generation must not dispatch a save");
      assert.equal(fixture.state.Loading, null); assert.ok(fixture.state.Notice);
      assert.equal(fixture.toasts.slice(toasts).filter((toast) => toast.kind === "error").length, 1);
      assert.equal(fixture.toasts.slice(toasts).some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

type LocalPhotoSuggestion = ReturnType<LocalHandoffFixture["photoSuggestions"]>;
const LOCAL_PHOTO_FILE = { name: "synthetic-clinic-a.png", type: "image/png", size: 42 };

function photoSuggestionSnapshot(fixture: LocalHandoffFixture) {
  return JSON.parse(JSON.stringify({ texts: fixture.state.PhotoTexts, mode: fixture.state.PhotoSuggestMode }));
}

async function pausePhotoSuggestion(fixture: LocalHandoffFixture, phase: "token" | "body") {
  const token = phase === "token" ? fixture.deferToken("photo-suggest") : undefined;
  const body = phase === "body" ? fixture.deferBody("photo-suggest") : undefined;
  const captured = fixture.photoSuggestions(), work = captured.callbacks.suggest();
  const resume = (value?: string) => { token?.resolve(); body?.resolve(value ?? JSON.stringify(fixture.photoSuggestionReply.body)); };
  try {
    if (token) await token.started; else await fixture.bodyStarted.promise;
    assert.equal(fixture.dispatches.length, phase === "token" ? 0 : 1, "pause actual suggestion transport/auth or response text");
    return { captured, work, resume };
  } catch (error) { resume(); await work; throw error; }
}

for (const phase of ["token", "body"] as const) {
  for (const boundary of ["account", "silent-account", "workspace", "actor-A-B-A", "unmount"] as const) {
    test(`G5C10 ${phase}-pending suggestion remains silent after ${boundary}`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      const paused = await pausePhotoSuggestion(fixture, phase);
      try {
        if (boundary === "account" || boundary === "actor-A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
        if (boundary === "silent-account") fixture.sdkSession("22222222-2222-4222-8222-222222222222", "fixture-token-b", null);
        if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
        if (boundary === "actor-A-B-A") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
        if (boundary === "unmount") fixture.lifetime!.unmount();
        fixture.state.PhotoTexts = { headline: "Current B headline", offer: "Current B offer", cta: "Current B CTA", disclaimer: "Current B disclaimer" };
        fixture.state.PhotoSuggestMode = "current-b-mode";
        const before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
        paused.resume(); await paused.work;
        assert.deepEqual(photoSuggestionSnapshot(fixture), before);
        assert.deepEqual(fixture.writes.slice(writes), boundary === "workspace" || boundary === "silent-account"
          ? [{ field: "PhotoBusy", value: null }] : []);
        assert.equal(fixture.dispatches.length, phase === "token" ? 0 : 1);
        assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []);
      } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
    });
  }
}

test("G5C10 workspace A-B-A remount cannot revive an old suggestion body", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "body");
  try {
    fixture.workspace(HANDOFF_WORKSPACE_B); fixture.lifetime!.render();
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE); const returned = fixture.photoSuggestions();
    assert.equal(returned.key, paused.captured.key);
    assert.notEqual(returned.session.sessionRef, paused.captured.session.sessionRef);
    const before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
    paused.resume(); await paused.work;
    assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
    assert.deepEqual(fixture.toasts, []); assert.equal(fixture.dispatches.length, 1);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

const PHOTO_INPUT_CHANGES: { name: string; edit: (fixture: LocalHandoffFixture, captured: LocalPhotoSuggestion) => void }[] = [
  { name: "brief ABA", edit: (_fixture, captured) => {
    captured.callbacks.updateBrief("service", "Temporary service B"); captured.callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service);
  } },
  { name: "format ABA", edit: (_fixture, captured) => {
    captured.callbacks.changeFormat("feed"); captured.callbacks.changeFormat(captured.inputs.photoFormat);
  } },
  { name: "source type ABA", edit: (fixture, captured) => {
    captured.callbacks.changeSourceType(fixture.photoDefaults.photoSourceTypes[1]); captured.callbacks.changeSourceType(captured.inputs.photoSourceType);
  } },
  { name: "same-name photo replacement", edit: (_fixture, captured) => { captured.callbacks.selectFile({ ...LOCAL_PHOTO_FILE }); } },
  { name: "manual headline edit", edit: (_fixture, captured) => { captured.callbacks.updateTexts("headline", "New manual headline"); } },
  { name: "editable text ABA", edit: (_fixture, captured) => {
    captured.callbacks.updateTexts("cta", "Temporary CTA B"); captured.callbacks.updateTexts("cta", captured.inputs.photoTexts.cta);
  } },
];

for (const change of PHOTO_INPUT_CHANGES) {
  test(`G5C10 ${change.name} expires an already parsed suggestion intent synchronously`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    if (change.name === "same-name photo replacement") fixture.photoSuggestions().callbacks.selectFile(LOCAL_PHOTO_FILE);
    const paused = await pausePhotoSuggestion(fixture, "body");
    try {
      change.edit(fixture, paused.captured);
      const before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
      // Resume before another render: revision invalidation must happen inside the input handler.
      paused.resume(); await paused.work;
      assert.deepEqual(photoSuggestionSnapshot(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes), [{ field: "PhotoBusy", value: null }]);
      assert.deepEqual(fixture.toasts, []); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(fixture.uploads, []);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

test("G5C10 brief edit during actual token lookup prevents any suggestion POST", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "token");
  try {
    paused.captured.callbacks.updateBrief("city", "Changed city B");
    const before = photoSuggestionSnapshot(fixture);
    paused.resume(); await paused.work;
    assert.equal(fixture.dispatches.length, 0); assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.deepEqual(fixture.toasts, []);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const outcome of ["error", "auth", "unreadable"] as const) {
  test(`G5C10 late ${outcome} suggestion body cannot emit a notice under a replaced actor`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePhotoSuggestion(fixture, "body");
    try {
      fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      const before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
      paused.resume(outcome === "unreadable" ? "{invalid" : JSON.stringify({ success: false, error: "Synthetic late refusal",
        code: outcome === "auth" ? "authentication_required" : "fixture_failure" }));
      await paused.work;
      assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.toasts, []); assert.equal(fixture.dispatches.length, 1);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

test("G5C10 same-actor refresh sends one exact scoped payload and retains the manual disclaimer", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const initial = fixture.photoSuggestions(); initial.callbacks.selectFile(LOCAL_PHOTO_FILE);
  initial.callbacks.updateTexts("disclaimer", "Operator's retained disclaimer");
  const paused = await pausePhotoSuggestion(fixture, "token");
  try {
    fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
    assert.equal(fixture.photoSuggestions().key, paused.captured.key);
    paused.resume(); await paused.work;
    assert.equal(fixture.dispatches.length, 1);
    const call = fixture.dispatches[0];
    assert.equal(call.url, `/api/content-studio/generate-package?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`);
    assert.equal(call.method, "POST"); assert.equal(call.headers.get("Authorization"), "Bearer fixture-token-a-refreshed");
    assert.equal(call.headers.get("Content-Type"), "application/json"); assert.equal(call.signal, paused.captured.session.sessionRef.current!.signal);
    assert.deepEqual(call.body, { mode: "ads", format: fixture.photoDefaults.inputs.photoFormat, service: LOCAL_PACKAGE_BRIEF.service,
      city: LOCAL_PACKAGE_BRIEF.city, offer: LOCAL_PACKAGE_BRIEF.offer, audience: LOCAL_PACKAGE_BRIEF.audience,
      goal: LOCAL_PACKAGE_BRIEF.goal, tone: LOCAL_PACKAGE_BRIEF.tone,
      materialNotes: `${fixture.photoDefaults.inputs.photoSourceType}: ${LOCAL_PHOTO_FILE.name}` });
    assert.equal(fixture.photoSuggestionRequests[0].init.expectedUserId, "11111111-1111-4111-8111-111111111111");
    assert.equal(typeof fixture.photoSuggestionRequests[0].init.dispatchGuard, "function");
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.PhotoTexts)), { headline: LOCAL_GENERATED_PACKAGE.adHeadline,
      offer: LOCAL_PACKAGE_BRIEF.offer, cta: LOCAL_GENERATED_PACKAGE.cta, disclaimer: "Operator's retained disclaimer" });
    assert.equal(fixture.state.PhotoSuggestMode, "fixture"); assert.equal(fixture.state.PhotoBusy, null);
    assert.deepEqual(fixture.toasts, [{ kind: "success", message: "Тексты готовы" }]);
    assert.deepEqual(fixture.writes.filter((write) => /^(ContentPackage|Gen|PackageGeneration)/.test(write.field)), []);
    assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C10 valid three-field response preserves manual fallbacks and ignores unused package fields", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const initial = fixture.photoSuggestions();
  initial.callbacks.updateBrief("offer", ""); initial.callbacks.updateTexts("headline", "Manual headline"); initial.callbacks.updateTexts("cta", "Manual CTA");
  fixture.photoSuggestionReply.body = { success: true, mode: "fixture", data: { adHeadline: "", adPrimaryText: "First sentence. Second sentence.", cta: "", shotList: 42 } };
  try {
    await fixture.photoSuggestions().callbacks.suggest();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.PhotoTexts)), { headline: "Manual headline", offer: "First sentence", cta: "Manual CTA",
      disclaimer: fixture.photoDefaults.inputs.photoTexts.disclaimer });
    assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.toasts[0].kind, "success");
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C10 no-op input handlers do not expire a pending suggestion", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "body");
  try {
    const writes = fixture.writes.length;
    paused.captured.callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service);
    paused.captured.callbacks.changeFormat(paused.captured.inputs.photoFormat);
    paused.captured.callbacks.changeSourceType(paused.captured.inputs.photoSourceType);
    paused.captured.callbacks.updateTexts("headline", paused.captured.inputs.photoTexts.headline);
    assert.deepEqual(fixture.writes.slice(writes), []);
    paused.resume(); await paused.work;
    assert.equal(fixture.state.PhotoSuggestMode, "fixture"); assert.equal(fixture.dispatches.length, 1);
    assert.equal(fixture.toasts[0].kind, "success");
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C10 pending lock is set before the first auth await and blocks old or disabled click callbacks", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), token = fixture.deferToken();
  const initial = fixture.photoSuggestions(), work = initial.callbacks.suggest();
  try {
    initial.callbacks.click(); const disabled = fixture.photoSuggestions(); assert.equal(disabled.callbacks.disabled, true); disabled.callbacks.click();
    await token.started; await flushLocalVideoWork();
    assert.equal(fixture.sdkReads.total, 1, "duplicate callbacks cannot begin a second auth/transport chain");
    assert.equal(fixture.photoSuggestionRequests.length, 0); assert.equal(fixture.dispatches.length, 0);
    token.resolve(); await work; await flushLocalVideoWork();
    assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.toasts.length, 1);
  } finally { token.resolve(); await work; await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
});

test("G5C10 pending body stays locked after photo edits until settlement then permits the current retry", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "body");
  try {
    paused.captured.callbacks.changeFormat("feed");
    const edited = fixture.photoSuggestions(); edited.callbacks.click(); paused.captured.callbacks.click(); await flushLocalVideoWork();
    assert.equal(fixture.dispatches.length, 1);
    const before = photoSuggestionSnapshot(fixture);
    paused.resume(); await paused.work; await flushLocalVideoWork();
    assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.deepEqual(fixture.toasts, []);
    await fixture.photoSuggestions().callbacks.suggest();
    assert.equal(fixture.dispatches.length, 2); assert.equal((fixture.dispatches[1].body as { format: string }).format, "feed");
    assert.equal(fixture.toasts.length, 1);
  } finally { paused.resume(); await paused.work; await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
});

for (const status of [401, 403] as const) {
  for (const source of ["HTTP-before-body", "transport"] as const) {
    test(`G5C10 ${status} ${source} denies suggestion without fallback or reading a denied body`, async () => {
      const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
      if (source === "transport") fixture.handoffTransportFailures["photo-suggest"] = status;
      else { fixture.handoffStatuses["photo-suggest"] = status; fixture.handoffBodyFailures.add("photo-suggest"); }
      const captured = fixture.photoSuggestions(), before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
      try {
        await captured.callbacks.suggest();
        assert.deepEqual(photoSuggestionSnapshot(fixture), before);
        assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "PhotoBusy"), []);
        assert.equal(fixture.packageBodyReads.includes("photo-suggest"), false);
        assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
        assert.deepEqual(fixture.uploads, []);
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const failure of ["HTTP-500", "success-false", "invalid-JSON", "body-reject", "transport-500"] as const) {
  test(`G5C10 ordinary ${failure} preserves manual fields and reports error without success`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    if (failure === "HTTP-500") fixture.handoffStatuses["photo-suggest"] = 500;
    if (failure === "success-false") fixture.photoSuggestionReply.body = { success: false, error: "Synthetic provider unavailable" };
    if (failure === "invalid-JSON") fixture.photoSuggestionReply.text = "{invalid";
    if (failure === "body-reject") fixture.handoffBodyFailures.add("photo-suggest");
    if (failure === "transport-500") fixture.handoffTransportFailures["photo-suggest"] = 500;
    const captured = fixture.photoSuggestions(), before = photoSuggestionSnapshot(fixture);
    try {
      await captured.callbacks.suggest();
      assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.equal(fixture.state.PhotoBusy, null);
      assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const malformed of [
  { name: "empty data", data: {} }, { name: "null data", data: null },
  { name: "headline object", data: { ...LOCAL_GENERATED_PACKAGE, adHeadline: {} } },
  { name: "primary text number", data: { ...LOCAL_GENERATED_PACKAGE, adPrimaryText: 42 } },
  { name: "CTA array", data: { ...LOCAL_GENERATED_PACKAGE, cta: [] } },
  { name: "mode object", data: LOCAL_GENERATED_PACKAGE, mode: {} },
]) {
  test(`G5C10 malformed ${malformed.name} is rejected before any text or mode setter`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.photoSuggestionReply.body = { success: true, mode: malformed.mode ?? "fixture", data: malformed.data };
    const captured = fixture.photoSuggestions(), before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
    try {
      await captured.callbacks.suggest();
      assert.deepEqual(photoSuggestionSnapshot(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "PhotoBusy"), [], "malformed responses must never be queued for React publication");
      assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error"); assert.equal(fixture.dispatches.length, 1);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C10 explicit matching local demo maps the actual pure demo package without API or SDK access", async () => {
  const fixture = await localGenerationCallbacks("photo", true);
  fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
  const captured = fixture.photoSuggestions(), reads = fixture.sdkReads.total, mutations = fixture.mutations.length;
  const payload = { ...LOCAL_PACKAGE_BRIEF, mode: "ads", format: captured.inputs.photoFormat, materialNotes: captured.inputs.photoSourceType };
  const demo = fixture.purePackageDemo(payload);
  try {
    await captured.callbacks.suggest();
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.PhotoTexts)), { ...captured.inputs.photoTexts,
      headline: demo.adHeadline, offer: LOCAL_PACKAGE_BRIEF.offer, cta: demo.cta });
    assert.equal(fixture.state.PhotoSuggestMode, "demo"); assert.equal(fixture.sdkReads.total, reads);
    assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.photoSuggestionRequests, []); assert.deepEqual(fixture.uploads, []);
    assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, [{ kind: "success", message: "Образец текстов готов" }]);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["UUID-demo", "anonymous-not-demo", "selector-mismatch"] as const) {
  test(`G5C10 ${boundary} is not eligible for a local demo suggestion`, async () => {
    const fixture = await localGenerationCallbacks("photo", true);
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    if (boundary === "UUID-demo") fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
    if (boundary === "anonymous-not-demo") fixture.auth({ isDemoMode: false });
    if (boundary === "selector-mismatch") fixture.auth({ clinicId: "demo-selected-b" });
    const captured = fixture.photoSuggestions(), reads = fixture.sdkReads.total, writes = fixture.writes.length;
    try {
      assert.equal(captured.session.localDraftsOnly, false); await captured.callbacks.suggest();
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.toasts, []);
      assert.deepEqual(fixture.dispatches, []); assert.equal(fixture.sdkReads.total, reads);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C10 mounted selector mismatch releases its suggestion tag and permits retry after restoration", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "body");
  try {
    fixture.workspace(HANDOFF_WORKSPACE_B);
    const before = photoSuggestionSnapshot(fixture), writes = fixture.writes.length;
    paused.resume(); await paused.work;
    assert.deepEqual(photoSuggestionSnapshot(fixture), before); assert.deepEqual(fixture.toasts, []);
    assert.deepEqual(fixture.writes.slice(writes), [{ field: "PhotoBusy", value: null }]);
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
    const restored = fixture.photoSuggestions(); assert.equal(restored.key, paused.captured.key); assert.equal(restored.callbacks.disabled, false);
    await restored.callbacks.suggest(); assert.equal(fixture.dispatches.length, 2); assert.equal(fixture.state.PhotoSuggestMode, "fixture");
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C10 settled suggestion cannot clear a different current photo busy tag", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const paused = await pausePhotoSuggestion(fixture, "body");
  try {
    fixture.state.PhotoBusy = "render";
    paused.resume(); await paused.work;
    assert.equal(fixture.state.PhotoBusy, "render"); assert.equal(fixture.state.PhotoSuggestMode, "fixture");
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

function photoWithSource(fixture: LocalHandoffFixture) {
  fixture.photoSuggestions().callbacks.selectFile(LOCAL_PHOTO_FILE);
  return fixture.photoSuggestions();
}

async function renderedPhoto(fixture: LocalHandoffFixture) {
  await photoWithSource(fixture).callbacks.render();
  return fixture.photoSuggestions();
}

function renderedPhotoState(fixture: LocalHandoffFixture) {
  return { blob: fixture.state.PhotoBlob, preview: fixture.state.PhotoPreviewUrl, texts: JSON.parse(JSON.stringify(fixture.state.PhotoTexts)) };
}

async function pausePhotoRender(fixture: LocalHandoffFixture, phase: "token" | "renderer") {
  const token = phase === "token" ? fixture.deferToken() : undefined;
  const renderer = phase === "renderer" ? fixture.deferRender() : undefined;
  const captured = photoWithSource(fixture), work = captured.callbacks.render();
  const resume = () => { token?.resolve(); renderer?.resolve(); };
  try {
    if (token) {
      await flushLocalVideoWork();
      assert.ok(fixture.sdkReads.total > 0, "the actual render callback must verify its captured actor before canvas work");
      await token.started; assert.equal(fixture.renderCalls.length, 0);
    } else await fixture.renderStarted.promise;
    return { captured, work, resume };
  } catch (error) { resume(); await work; throw error; }
}

test("G5C11 fresh render preserves exact dimensions, layout, text and blob through download and handoff", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    const source = photoWithSource(fixture);
    source.callbacks.changeFormat("feed"); source.callbacks.changeLayout("minimal_premium");
    source.callbacks.updateTexts("headline", "Rendered exact headline");
    const current = fixture.photoSuggestions(); await current.callbacks.render();
    const photo = fixture.photoSuggestions(), blob = fixture.renderReply.blob;
    assert.equal(fixture.renderCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.renderCalls[0])), { imageUrl: current.inputs.photoSourceUrl, width: 1080, height: 1080,
      layout: "minimal_premium", texts: JSON.parse(JSON.stringify(current.inputs.photoTexts)) });
    assert.equal(fixture.state.PhotoBlob, blob);
    const artifactRef = photo.refs.photoArtifactRef as { current: { blob: Blob; previewUrl: string; inputs: unknown; session: AbortController; revision: number } } | undefined;
    assert.ok(artifactRef?.current, "the actual render callback must retain an artifact bound to its inputs and lifetime");
    const artifact = artifactRef.current;
    assert.equal(artifact.blob, blob); assert.equal(artifact.previewUrl, fixture.state.PhotoPreviewUrl);
    assert.equal(artifact.inputs, (photo.refs.photoTextInputsRef as { current: unknown }).current);
    assert.equal(artifact.session, photo.session.sessionRef.current);
    assert.equal(artifact.revision, (photo.refs.photoTextRevision as { current: number }).current);
    assert.ok(fixture.localObjectUrls.some((event) => event.operation === "create" && event.name === artifact.previewUrl && event.value === blob));
    await photo.callbacks.download();
    assert.equal(fixture.anchors.length, 1); assert.equal(fixture.anchors[0].href, artifact.previewUrl);
    assert.equal(fixture.anchors[0].download, "medina-os-photo-creative-feed.jpg"); assert.equal(fixture.anchors[0].clicked, true);
    await photo.callbacks.handoff();
    assert.equal(fixture.dispatches.length, 3); assert.equal(fixture.uploads.length, 1); assert.equal(fixture.uploads[0].file, blob);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.uploads[0].options)), { contentType: "image/jpeg", upsert: false });
    assert.equal((fixture.dispatches[0].body as { fileSize: number }).fileSize, blob!.size);
    assert.deepEqual(fixture.dispatches[1].body, { uploadHandle: fixture.signedReply.data.uploadHandle });
    const metadata = fixture.dispatches[2].body as { photoCreative: { texts: LocalPhotoTexts; format: string; layout: string } };
    assert.deepEqual(metadata.photoCreative.texts, JSON.parse(JSON.stringify(current.inputs.photoTexts)));
    assert.equal(metadata.photoCreative.format, "feed"); assert.equal(metadata.photoCreative.layout, "minimal_premium");
    assert.equal(readLocalHandoff(fixture).primaryText, `${current.inputs.photoTexts.offer}. ${current.inputs.photoTexts.cta}.`);
    assert.deepEqual(fixture.navigations, ["/ads-automation"]);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C11 another-version reads the current layout through retained callbacks", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    const photo = photoWithSource(fixture), index = fixture.photoDefaults.photoLayouts.findIndex((item) => item.id === photo.inputs.photoLayout);
    await photo.callbacks.next(); await photo.callbacks.next();
    const count = fixture.photoDefaults.photoLayouts.length;
    assert.deepEqual(fixture.renderCalls.map((call) => call.layout), [fixture.photoDefaults.photoLayouts[(index + 1) % count].id,
      fixture.photoDefaults.photoLayouts[(index + 2) % count].id]);
    assert.equal(fixture.state.PhotoLayout, fixture.renderCalls[1].layout); assert.equal(fixture.dispatches.length, 0);
  } finally { fixture.lifetime!.unmount(); }
});

for (const phase of ["token", "renderer"] as const) {
  test(`G5C11 render mutex blocks duplicate render and next-version during ${phase}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePhotoRender(fixture, phase);
    const duplicate = paused.captured.callbacks.render(), next = fixture.photoSuggestions().callbacks.next();
    try {
      await flushLocalVideoWork(); assert.equal(fixture.renderCalls.length, phase === "token" ? 0 : 1);
      paused.resume(); await Promise.all([paused.work, duplicate, next]);
      assert.equal(fixture.renderCalls.length, 1); assert.equal(fixture.toasts.filter((item) => item.kind === "success").length, 1);
    } finally { paused.resume(); await Promise.all([paused.work, duplicate, next]); fixture.lifetime!.unmount(); }
  });
}

const PHOTO_STALE_RENDERS = [
  { phase: "token", boundary: "account" }, { phase: "token", boundary: "workspace" }, { phase: "token", boundary: "input-ABA" },
  { phase: "renderer", boundary: "account" }, { phase: "renderer", boundary: "workspace" }, { phase: "renderer", boundary: "A-B-A" },
  { phase: "renderer", boundary: "input-ABA" }, { phase: "renderer", boundary: "unmount" },
] as const;

for (const { phase, boundary } of PHOTO_STALE_RENDERS) {
  test(`G5C11 ${phase}-pending render cannot publish or revoke URLs after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const paused = await pausePhotoRender(fixture, phase);
    try {
      if (boundary === "account" || boundary === "A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
      if (boundary === "A-B-A") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.photoSuggestions(); }
      if (boundary === "input-ABA") { paused.captured.callbacks.changeFormat("feed"); paused.captured.callbacks.changeFormat(paused.captured.inputs.photoFormat); }
      if (boundary === "unmount") fixture.lifetime!.unmount();
      const before = renderedPhotoState(fixture), writes = fixture.writes.length, urls = fixture.localObjectUrls.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work;
      assert.deepEqual(renderedPhotoState(fixture), before); assert.deepEqual(fixture.localObjectUrls.slice(urls), []);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "PhotoBusy"), []);
      assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.dispatches, []);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const input of ["file", "format", "layout", "source-type", "text", "accepted-AI-text"] as const) {
  test(`G5C11 changing ${input} invalidates its rendered artifact and revokes that preview exactly once`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    try {
      const photo = await renderedPhoto(fixture), preview = fixture.state.PhotoPreviewUrl;
      if (input === "file") photo.callbacks.selectFile({ ...LOCAL_PHOTO_FILE, name: "replacement.png" });
      if (input === "format") photo.callbacks.changeFormat("feed");
      if (input === "layout") photo.callbacks.changeLayout("minimal_premium");
      if (input === "source-type") photo.callbacks.changeSourceType(fixture.photoDefaults.photoSourceTypes[1]);
      if (input === "text") photo.callbacks.updateTexts("disclaimer", "Changed manual disclaimer");
      if (input === "accepted-AI-text") await photo.callbacks.suggest();
      assert.equal(fixture.state.PhotoBlob, null); assert.equal(fixture.state.PhotoPreviewUrl, "");
      assert.equal((photo.refs.photoArtifactRef as { current: unknown }).current, null);
      assert.equal(fixture.localObjectUrls.filter((event) => event.operation === "revoke" && event.name === preview).length, 1);
      fixture.lifetime!.unmount();
      assert.equal(fixture.localObjectUrls.filter((event) => event.operation === "revoke" && event.name === preview).length, 1);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C11 actual photo cleanup revokes only its owned live source and preview once on unmount", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  const photo = await renderedPhoto(fixture), source = fixture.state.PhotoSourceUrl, preview = fixture.state.PhotoPreviewUrl;
  fixture.lifetime!.unmount(); fixture.lifetime!.unmount();
  assert.equal(fixture.localObjectUrls.filter((item) => item.operation === "revoke" && item.name === source).length, 1);
  assert.equal(fixture.localObjectUrls.filter((item) => item.operation === "revoke" && item.name === preview).length, 1);
  assert.equal((photo.refs.photoObjectUrls as { current: Set<string> }).current.size, 0);
  assert.equal((photo.refs.photoArtifactRef as { current: unknown }).current, null);
});

test("G5C11 late A canvas completion cannot revoke or replace B's accepted artifact", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), paused = await pausePhotoRender(fixture, "renderer");
  try {
    fixture.sdkSession("22222222-2222-4222-8222-222222222222"); fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" } }); fixture.photoSuggestions();
    fixture.renderReply.blob = new Blob(["accepted B"], { type: "image/jpeg" });
    const current = await renderedPhoto(fixture), before = renderedPhotoState(fixture), urls = fixture.localObjectUrls.length, toasts = fixture.toasts.length;
    paused.resume(); await paused.work;
    assert.deepEqual(renderedPhotoState(fixture), before); assert.deepEqual(fixture.localObjectUrls.slice(urls), []);
    assert.deepEqual(fixture.toasts.slice(toasts), []);
    await current.callbacks.download(); assert.equal(fixture.anchors[0].href, before.preview);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C11 no-op format, layout, type and text updates retain the exact artifact without URL churn", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    const photo = await renderedPhoto(fixture), before = renderedPhotoState(fixture), urls = fixture.localObjectUrls.length, writes = fixture.writes.length;
    photo.callbacks.changeFormat(photo.inputs.photoFormat); photo.callbacks.changeLayout(photo.inputs.photoLayout);
    photo.callbacks.changeSourceType(photo.inputs.photoSourceType); photo.callbacks.updateTexts("headline", photo.inputs.photoTexts.headline);
    assert.deepEqual(renderedPhotoState(fixture), before); assert.deepEqual(fixture.localObjectUrls.slice(urls), []);
    assert.deepEqual(fixture.writes.slice(writes), []);
    await photo.callbacks.download(); assert.equal(fixture.anchors[0].href, before.preview);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C11 render finally cannot clear another current photo busy tag", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), paused = await pausePhotoRender(fixture, "renderer");
  try { fixture.state.PhotoBusy = "handoff"; paused.resume(); await paused.work; assert.equal(fixture.state.PhotoBusy, "handoff"); }
  finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C11 mounted workspace mismatch releases only render loading and permits a restored-scope retry", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), paused = await pausePhotoRender(fixture, "renderer");
  try {
    fixture.workspace(HANDOFF_WORKSPACE_B); const before = renderedPhotoState(fixture), urls = fixture.localObjectUrls.length;
    paused.resume(); await paused.work;
    assert.deepEqual(renderedPhotoState(fixture), before); assert.deepEqual(fixture.localObjectUrls.slice(urls), []);
    assert.equal(fixture.state.PhotoBusy, null); assert.deepEqual(fixture.toasts, []);
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE); await fixture.photoSuggestions().callbacks.render();
    assert.equal(fixture.renderCalls.length, 2); assert.equal(fixture.state.PhotoBlob, fixture.renderReply.blob);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const result of ["null", "error"] as const) {
  test(`G5C11 renderer ${result} is honest and never creates an artifact or success notice`, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
    const photo = photoWithSource(fixture), urls = fixture.localObjectUrls.length;
    if (result === "null") fixture.renderReply.blob = null; else fixture.renderReply.error = new Error("Synthetic canvas failure");
    try {
      await photo.callbacks.render(); assert.equal(fixture.state.PhotoBlob, null); assert.equal(fixture.state.PhotoPreviewUrl, "");
      assert.deepEqual(fixture.localObjectUrls.slice(urls), []); assert.equal(fixture.toasts.length, 1); assert.equal(fixture.toasts[0].kind, "error");
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C11 explicit local demo renders and downloads locally with zero auth or provider transport", async () => {
  const fixture = await localGenerationCallbacks("photo", true);
  fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true }); const reads = fixture.sdkReads.total;
  try {
    const photo = await renderedPhoto(fixture); await photo.callbacks.download();
    assert.equal(fixture.renderCalls.length, 1); assert.equal(fixture.anchors.length, 1);
    assert.equal(fixture.sdkReads.total, reads); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C11 failed same-input rerender preserves the prior valid blob, preview and owned URLs", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    const photo = await renderedPhoto(fixture), before = renderedPhotoState(fixture), urls = fixture.localObjectUrls.length, toasts = fixture.toasts.length;
    fixture.renderReply.blob = null;
    await photo.callbacks.render();
    assert.equal(fixture.state.PhotoBlob, before.blob); assert.equal(fixture.state.PhotoPreviewUrl, before.preview);
    assert.deepEqual(fixture.localObjectUrls.slice(urls), []);
    assert.deepEqual(fixture.toasts.slice(toasts).map((item) => item.kind), ["error"]);
    await fixture.photoSuggestions().callbacks.download();
    assert.equal(fixture.anchors.length, 1); assert.equal(fixture.anchors[0].href, before.preview);
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

const PHOTO_ARTIFACT_HANDOFF_STAGES = [
  { phase: "signed-token", change: "format" }, { phase: "signed-body", change: "brief" },
  { phase: "finalize-token", change: "format" }, { phase: "finalize-response", change: "file" }, { phase: "finalize-body", change: "brief" },
  { phase: "upload", change: "text" }, { phase: "metadata-token", change: "layout" }, { phase: "metadata-response", change: "file" },
] as const;

for (const { phase, change } of PHOTO_ARTIFACT_HANDOFF_STAGES) {
  test(`G5C11 handoff ${phase} rechecks captured artifact and brief before further effects`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), photo = await renderedPhoto(fixture);
    const token = phase.endsWith("token") ? fixture.deferToken(phase === "signed-token" ? "signed" : phase === "finalize-token" ? "finalize" : "metadata") : undefined;
    const body = phase.endsWith("body") ? fixture.deferBody(phase === "signed-body" ? "signed" : "finalize") : undefined;
    const upload = phase === "upload" ? fixture.deferUpload() : undefined;
    const response = phase.endsWith("response") ? fixture.deferResponse(phase === "finalize-response" ? "finalize" : "metadata") : undefined;
    const work = photo.callbacks.handoff(), resume = () => { token?.resolve();
      body?.resolve(JSON.stringify(phase === "finalize-body" ? fixture.finalizedReply : fixture.signedReply)); upload?.resolve(); response?.resolve(); };
    try {
      if (token) await waitForLocalHandoffBoundary(work, token.started); if (body) await waitForLocalHandoffBoundary(work, fixture.bodyStarted.promise);
      if (upload) await waitForLocalHandoffBoundary(work, fixture.uploadStarted.promise); if (response) await waitForLocalHandoffBoundary(work, response.started);
      const expectedRequests = phase === "signed-token" ? 0 : phase.startsWith("signed") || phase === "upload" || phase === "finalize-token" ? 1
        : phase.startsWith("finalize") || phase === "metadata-token" ? 2 : 3;
      assert.equal(fixture.dispatches.length, expectedRequests, "Pause exactly the requested upload/finalization boundary");
      if (change === "format") { photo.callbacks.changeFormat("feed"); photo.callbacks.changeFormat(photo.inputs.photoFormat); }
      if (change === "brief") { photo.callbacks.updateBrief("service", "Temporary service B"); photo.callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service); }
      if (change === "text") photo.callbacks.updateTexts("headline", "Edited after render");
      if (change === "layout") { photo.callbacks.changeLayout("minimal_premium"); photo.callbacks.changeLayout(photo.inputs.photoLayout); }
      if (change === "file") photo.callbacks.selectFile({ ...LOCAL_PHOTO_FILE, name: "new-after-render.png" });
      const requests = fixture.dispatches.length, uploads = fixture.uploads.length, mutations = fixture.mutations.length, toasts = fixture.toasts.length;
      resume(); await work;
      assert.equal(fixture.dispatches.length, requests); assert.equal(fixture.uploads.length, uploads);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.toasts.slice(toasts), []);
    } finally { resume(); await work; fixture.lifetime!.unmount(); }
  });
}

test("G5C11 artifact handoff pending lock precedes auth and suppresses duplicate callbacks", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), photo = await renderedPhoto(fixture);
  const token = fixture.deferToken(), reads = fixture.sdkReads.total;
  const work = photo.callbacks.handoff(), duplicate = photo.callbacks.handoff();
  try {
    await token.started; await flushLocalVideoWork(); assert.equal(fixture.sdkReads.total - reads, 1); assert.equal(fixture.dispatches.length, 0);
    token.resolve(); await Promise.all([work, duplicate]);
    assert.equal(fixture.dispatches.length, 3); assert.equal(fixture.uploads.length, 1); assert.equal(fixture.uploads[0].file, fixture.renderReply.blob);
    assert.deepEqual(fixture.navigations, ["/ads-automation"]);
  } finally { token.resolve(); await Promise.all([work, duplicate]); fixture.lifetime!.unmount(); }
});

test("G5C11 download rechecks the artifact after token wait before creating any anchor", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE), photo = await renderedPhoto(fixture), token = fixture.deferToken();
  const work = photo.callbacks.download();
  try {
    await flushLocalVideoWork(); assert.equal(fixture.anchors.length, 0, "anchor creation requires a fresh actor check");
    photo.callbacks.updateTexts("headline", "New manual title"); token.resolve(); await work;
    assert.deepEqual(fixture.anchors, []); assert.deepEqual(fixture.dispatches, []);
  } finally { token.resolve(); await work; fixture.lifetime!.unmount(); }
});

test("G5C11 edited artifact is rejected by both retained download and handoff callbacks without external effects", async () => {
  const fixture = await localGenerationCallbacks("photo", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    const rendered = await renderedPhoto(fixture); rendered.callbacks.updateTexts("offer", "Edited offer after render");
    const mutated = fixture.mutations.length;
    await rendered.callbacks.download(); await rendered.callbacks.handoff();
    assert.deepEqual(fixture.anchors, []); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
    assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.mutations.slice(mutated), []);
  } finally { fixture.lifetime!.unmount(); }
});

type LocalLibrary = ReturnType<LocalHandoffFixture["library"]>;
const LOCAL_LIBRARY_PATCH = { script: "Requested local script", status: "script_ready" };
function libraryState(fixture: LocalHandoffFixture) {
  return JSON.parse(JSON.stringify({ form: fixture.state.Form, videos: fixture.state.Videos, activeId: fixture.state.ActiveId }));
}
function libraryRows(fixture: LocalHandoffFixture) { return fixture.state.Videos as LocalLibraryVideo[]; }
test("G5C12 retained create callback cannot submit a newer form after form ABA", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  const captured = fixture.library();
  try {
    captured.callbacks.editTitle("Temporary idea B");
    fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title);
    const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
    await captured.callbacks.create();
    assert.deepEqual(libraryState(fixture), before);
    assert.deepEqual(fixture.dispatches, []);
    assert.deepEqual(fixture.writes.slice(writes), []);
    assert.deepEqual(fixture.mutations.slice(mutations), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.lifetime!.unmount(); }
});
async function pauseLibraryWrite(fixture: LocalHandoffFixture, kind: "create" | "patch", phase: "token" | "body") {
  const resource = kind === "create" ? "library-create" : "library-patch";
  const token = phase === "token" ? fixture.deferToken(resource) : undefined;
  const body = phase === "body" ? fixture.deferBody(resource) : undefined;
  const captured = fixture.library(), before = libraryState(fixture);
  const work = Promise.resolve(kind === "create" ? captured.callbacks.create() : captured.callbacks.update(LOCAL_LIBRARY_PATCH));
  const resume = (value?: string) => { token?.resolve(); body?.resolve(value ?? JSON.stringify(kind === "create" ? fixture.libraryReplies.create : fixture.libraryReplies.patch)); };
  try {
    await flushLocalVideoWork();
    if (kind === "patch") assert.deepEqual(libraryState(fixture), before, "PATCH receipt must be awaited before any local apply or cache update");
    if (token) await token.started; else await fixture.bodyStarted.promise;
    assert.equal(fixture.dispatches.length, phase === "token" ? 0 : 1);
    return { captured, work, resume };
  } catch (error) { resume(); await work; await flushLocalVideoWork(); throw error; }
}

const LIBRARY_STALE_WRITES = [
  { kind: "create", phase: "token", boundary: "account" }, { kind: "create", phase: "body", boundary: "workspace" },
  { kind: "create", phase: "body", boundary: "A-B-A" }, { kind: "create", phase: "body", boundary: "unmount" },
  { kind: "create", phase: "body", boundary: "form-ABA" },
  { kind: "patch", phase: "token", boundary: "workspace" }, { kind: "patch", phase: "body", boundary: "account" },
  { kind: "patch", phase: "body", boundary: "A-B-A" }, { kind: "patch", phase: "body", boundary: "unmount" },
  { kind: "patch", phase: "body", boundary: "selection-ABA" }, { kind: "patch", phase: "body", boundary: "form-ABA" },
] as const;
for (const { kind, phase, boundary } of LIBRARY_STALE_WRITES) {
  test(`G5C12 ${kind} ${phase} suppresses late UI, cache and notices after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id);
    const paused = await pauseLibraryWrite(fixture, kind, phase);
    try {
      if (boundary === "account" || boundary === "A-B-A") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
      if (boundary === "A-B-A") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
      if (boundary === "unmount") fixture.lifetime!.unmount();
      if (boundary === "form-ABA") {
        paused.captured.callbacks.editTitle("Temporary title B"); fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title);
      }
      if (boundary === "selection-ABA") {
        paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id);
      }
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work; await flushLocalVideoWork();
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "Loading"), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts.slice(toasts), []);
      assert.equal(fixture.dispatches.length, phase === "token" ? 0 : 1);
      assert.equal(fixture.localStorage.getItem(fixture.libraryKey(HANDOFF_WORKSPACE_B)), null);
    } finally { paused.resume(); await paused.work; await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["create", "patch"] as const) {
  test(`G5C12 late ${kind} error body remains silent after account replacement`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const paused = await pauseLibraryWrite(fixture, kind, "body");
    try {
      fixture.sdkSession("22222222-2222-4222-8222-222222222222"); const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      paused.resume(JSON.stringify({ success: false, error: "Synthetic late refusal" })); await paused.work; await flushLocalVideoWork();
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "Loading"), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []);
    } finally { paused.resume(); await paused.work; await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
  });
}

test("G5C12 same-actor refresh creates one scoped idea with an exact form payload and confirmed receipt", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  fixture.library().callbacks.editTitle("Edited idea title");
  const paused = await pauseLibraryWrite(fixture, "create", "token");
  try {
    const form = JSON.parse(JSON.stringify(fixture.state.Form));
    fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a-refreshed", "TOKEN_REFRESHED");
    assert.equal(fixture.library().key, paused.captured.key); paused.resume(); await paused.work;
    assert.equal(fixture.dispatches.length, 1); const call = fixture.dispatches[0];
    assert.equal(call.method, "POST"); assert.equal(call.url, `/api/crm/content-videos?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`);
    assert.equal(call.headers.get("Authorization"), "Bearer fixture-token-a-refreshed"); assert.equal(call.signal, paused.captured.session.sessionRef.current!.signal);
    assert.deepEqual(call.body, form); assert.equal(fixture.libraryRequests[0].init.expectedUserId, "11111111-1111-4111-8111-111111111111");
    assert.equal(typeof fixture.libraryRequests[0].init.dispatchGuard, "function");
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [LOCAL_LIBRARY_ROW_A]); assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_A.id);
    assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [LOCAL_LIBRARY_ROW_A]);
    assert.deepEqual(fixture.toasts, [{ kind: "success", message: "Идея ролика создана" }]);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C12 PATCH waits for the exact target receipt and applies canonical server fields", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_B.id);
  fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id);
  const paused = await pauseLibraryWrite(fixture, "patch", "body");
  try {
    assert.equal(libraryRows(fixture).find((row) => row.id === LOCAL_LIBRARY_ROW_A.id)!.script, "");
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null, "no optimistic cache write precedes acknowledgment");
    paused.resume(); assert.equal(await paused.work, true);
    const call = fixture.dispatches[0]; assert.equal(call.method, "PATCH");
    assert.equal(call.url, `/api/crm/content-videos?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`);
    assert.deepEqual(call.body, { ...LOCAL_LIBRARY_PATCH, id: LOCAL_LIBRARY_ROW_A.id });
    assert.equal(fixture.libraryRequests[0].init.expectedUserId, "11111111-1111-4111-8111-111111111111");
    assert.equal(libraryRows(fixture).find((row) => row.id === LOCAL_LIBRARY_ROW_A.id)!.script, "Canonical saved script");
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture).find((row) => row.id === LOCAL_LIBRARY_ROW_B.id))), LOCAL_LIBRARY_ROW_B);
    assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_A.id);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const kind of ["create", "patch"] as const) {
  for (const status of [401, 403] as const) {
    test(`G5C12 ${kind} ${status} denies before body parsing and never writes fallback`, async () => {
      const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
      fixture.seedLibrary(kind === "patch" ? [LOCAL_LIBRARY_ROW_A] : []);
      const resource = kind === "create" ? "library-create" : "library-patch";
      fixture.handoffStatuses[resource] = status; fixture.handoffBodyFailures.add(resource);
      const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
      try {
        await (kind === "create" ? captured.callbacks.create() : captured.callbacks.update(LOCAL_LIBRARY_PATCH)); await flushLocalVideoWork();
        assert.equal(fixture.packageBodyReads.includes(resource), false);
        assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
        assert.equal(fixture.dispatches.length, 1); assert.ok(fixture.state.Notice);
        assert.ok(fixture.toasts.every((toast) => toast.kind !== "success" && toast.kind !== "warning"));
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const kind of ["create", "patch"] as const) {
  test(`G5C12 shared write mutex blocks create and PATCH duplicates while ${kind} is pending`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const gate = fixture.deferToken(), captured = fixture.library(), reads = fixture.sdkReads.total;
    const work = Promise.resolve(kind === "create" ? captured.callbacks.create() : captured.callbacks.update(LOCAL_LIBRARY_PATCH));
    const duplicate = captured.callbacks.create(), patch = Promise.resolve(captured.callbacks.update(LOCAL_LIBRARY_PATCH));
    try {
      await gate.started; await flushLocalVideoWork();
      assert.equal(fixture.sdkReads.total - reads, 1); assert.equal(fixture.dispatches.length, 0);
      gate.resolve(); await Promise.all([work, duplicate, patch]); await flushLocalVideoWork();
      assert.equal(fixture.dispatches.length, 1);
    } finally { gate.resolve(); await Promise.all([work, duplicate, patch]); await flushLocalVideoWork(); fixture.lifetime!.unmount(); }
  });
}

const LIBRARY_UNCONFIRMED_RECEIPTS: { name: string; body: unknown; status?: number }[] = [
  { name: "HTTP 500", status: 500, body: { success: true, mode: "supabase", data: { video: LOCAL_LIBRARY_ROW_A } } },
  { name: "success false", body: { success: false, error: "Synthetic unavailable", data: { video: LOCAL_LIBRARY_ROW_A } } },
  { name: "demo mode", body: { success: true, mode: "demo", data: { video: LOCAL_LIBRARY_ROW_A } } },
  { name: "blank ID", body: { success: true, mode: "supabase", data: { video: { ...LOCAL_LIBRARY_ROW_A, id: " " } } } },
  { name: "missing title", body: { success: true, mode: "supabase", data: { video: { ...LOCAL_LIBRARY_ROW_A, title: undefined } } } },
  { name: "invalid status", body: { success: true, mode: "supabase", data: { video: { ...LOCAL_LIBRARY_ROW_A, status: "unrecognized" } } } },
  { name: "corrupt optional script", body: { success: true, mode: "supabase", data: { video: { ...LOCAL_LIBRARY_ROW_A, script: {} } } } },
];
for (const receipt of LIBRARY_UNCONFIRMED_RECEIPTS) {
  test(`G5C12 create ${receipt.name} keeps only a valid local draft and never claims server success`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.libraryReplies.create = receipt.body; fixture.handoffStatuses["library-create"] = receipt.status ?? 200;
    const captured = fixture.library();
    try {
      await captured.callbacks.create();
      assert.equal(libraryRows(fixture).length, 1); const row = libraryRows(fixture)[0];
      assert.match(row.id, /^content-/); assert.equal(row.title, (fixture.state.Form as LocalLibraryForm).title); assert.equal(row.status, "idea");
      assert.equal(typeof row.script, "string"); assert.ok(Number.isFinite(Date.parse(row.createdAt)));
      assert.ok(fixture.state.Notice); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1);
      assert.equal(fixture.dispatches.length, 1);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const receipt of ["wrong-ID", "wrong-mode", "outage"] as const) {
  test(`G5C12 PATCH ${receipt} keeps only the requested local edit with an explicit unsaved notice`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id);
    fixture.libraryReplies.patch = { success: true, mode: receipt === "wrong-mode" ? "demo" : "supabase",
      data: { video: receipt === "wrong-ID" ? LOCAL_LIBRARY_ROW_B : { ...LOCAL_LIBRARY_ROW_A, script: "Unconfirmed remote script" } } };
    if (receipt === "outage") fixture.handoffTransportFailures["library-patch"] = 500;
    try {
      assert.equal(await fixture.library().callbacks.update(LOCAL_LIBRARY_PATCH), true);
      assert.equal(libraryRows(fixture).find((row) => row.id === LOCAL_LIBRARY_ROW_A.id)!.script, LOCAL_LIBRARY_PATCH.script);
      assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture).find((row) => row.id === LOCAL_LIBRARY_ROW_B.id))), LOCAL_LIBRARY_ROW_B);
      assert.ok(fixture.state.Notice); assert.equal(fixture.dispatches.length, 1);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const demo of [false, true]) {
  test(`G5C12 ${demo ? "explicit demo" : "real-workspace content-* draft"} edit skips PATCH and retains an honest local notice`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    if (demo) { fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true }); }
    fixture.seedLibrary([{ ...LOCAL_LIBRARY_ROW_A, id: "content-local-fixture" }]);
    const captured = fixture.library(), reads = fixture.sdkReads.total;
    try {
      assert.equal(await captured.callbacks.update(LOCAL_LIBRARY_PATCH), true);
      assert.equal(libraryRows(fixture)[0].script, LOCAL_LIBRARY_PATCH.script);
      assert.deepEqual(fixture.dispatches, []); assert.ok(fixture.state.Notice);
      if (demo) assert.equal(fixture.sdkReads.total, reads);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C12 explicit local demo creates only a local idea without API or SDK access", async () => {
  const fixture = await localGenerationCallbacks("video", true);
  fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true }); const captured = fixture.library(), reads = fixture.sdkReads.total;
  try {
    await captured.callbacks.create();
    assert.equal(libraryRows(fixture).length, 1); assert.match(libraryRows(fixture)[0].id, /^content-/);
    assert.ok(fixture.state.Notice); assert.deepEqual(fixture.dispatches, []); assert.equal(fixture.sdkReads.total, reads);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["UUID-demo", "anonymous-not-demo"] as const) {
  test(`G5C12 ${boundary} cannot create a local demo idea or perform any UI/cache write`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.auth({ user: null, isDemoMode: boundary === "UUID-demo" }); const captured = fixture.library(), mutations = fixture.mutations.length, writes = fixture.writes.length;
    try {
      await captured.callbacks.create(); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.dispatches, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C12 no-op form and selection events preserve an in-flight PATCH snapshot", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const paused = await pauseLibraryWrite(fixture, "patch", "body");
  try {
    const writes = fixture.writes.length;
    paused.captured.callbacks.editTitle(LOCAL_LIBRARY_FORM.title); paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_A.id);
    assert.deepEqual(fixture.writes.slice(writes), []); paused.resume(); assert.equal(await paused.work, true);
    assert.equal(libraryRows(fixture)[0].script, "Canonical saved script");
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C12 saveVideos validates, sorts and caches to the captured workspace before publishing selection", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  try {
    assert.equal(await fixture.library().callbacks.save([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id), true);
    assert.deepEqual(Array.from(libraryRows(fixture), (row) => row.id), [LOCAL_LIBRARY_ROW_B.id, LOCAL_LIBRARY_ROW_A.id]);
    assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_A.id);
    assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!).map((row: LocalLibraryVideo) => row.id), [LOCAL_LIBRARY_ROW_B.id, LOCAL_LIBRARY_ROW_A.id]);
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

for (const boundary of ["workspace", "unmount"] as const) {
  test(`G5C12 retained saveVideos cannot publish or cache after ${boundary}`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE), captured = fixture.library();
    if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B); else fixture.lifetime!.unmount();
    const writes = fixture.writes.length, mutations = fixture.mutations.length;
    try {
      assert.equal(await captured.callbacks.save([LOCAL_LIBRARY_ROW_A], LOCAL_LIBRARY_ROW_A.id), false);
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.mutations.slice(mutations), []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C12 fixed-key cache helpers never reinterpret an explicitly captured key through the live selector", () => localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE).then((fixture) => {
  try {
    const captured = fixture.library(), key = fixture.libraryKey(REAL_DEMO_TEST_WORKSPACE); fixture.workspace(HANDOFF_WORKSPACE_B);
    captured.callbacks.write([LOCAL_LIBRARY_ROW_A], key);
    assert.deepEqual(JSON.parse(fixture.localStorage.getItem(key)!), [LOCAL_LIBRARY_ROW_A]);
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey(HANDOFF_WORKSPACE_B)), null);
    assert.deepEqual(JSON.parse(JSON.stringify(captured.callbacks.read(key))), [LOCAL_LIBRARY_ROW_A]);
  } finally { fixture.lifetime!.unmount(); }
}));

test("G5C12 cache write failure returns false without publishing an unsaved list", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE), captured = fixture.library(), before = libraryState(fixture);
  fixture.localStorage.failNextWrite(fixture.libraryKey());
  try {
    assert.equal(await captured.callbacks.save([LOCAL_LIBRARY_ROW_A], LOCAL_LIBRARY_ROW_A.id), false);
    assert.deepEqual(libraryState(fixture), before); assert.ok(fixture.state.Notice); assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C12 current library GET validates rows and hydrates sorted receipt data without changing the form", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  fixture.library().callbacks.editTitle("Current unsaved form"); const form = fixture.state.Form;
  const cleanup = fixture.video(null).restore();
  try {
    await flushLocalVideoWork();
    assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.dispatches[0].method, "GET");
    assert.deepEqual(Array.from(libraryRows(fixture), (row) => row.id), [LOCAL_LIBRARY_ROW_B.id, LOCAL_LIBRARY_ROW_A.id]);
    assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_B.id); assert.equal(fixture.state.Form, form);
    assert.ok(fixture.localStorage.getItem(fixture.libraryKey()));
  } finally { if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

for (const edit of ["form", "selection-ABA"] as const) {
  test(`G5C12 pending library GET cannot overwrite a synchronous ${edit} edit`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id);
    const captured = fixture.library(), body = fixture.deferBody("restore"), cleanup = fixture.video(null).restore();
    try {
      await fixture.bodyStarted.promise;
      if (edit === "form") captured.callbacks.editTitle("Edited while loading");
      else { captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id); }
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      body.resolve(JSON.stringify(fixture.libraryReplies.restore)); await flushLocalVideoWork();
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []);
    } finally { body.resolve(JSON.stringify(fixture.libraryReplies.restore)); await flushLocalVideoWork(); if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
  });
}

test("G5C12 malformed library GET rows never reach state or cache", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); fixture.library();
  fixture.libraryReplies.restore = { success: true, mode: "supabase", data: { videos: [{ ...LOCAL_LIBRARY_ROW_B, title: {} }] } };
  const before = libraryState(fixture), mutations = fixture.mutations.length, cleanup = fixture.video(null).restore();
  try { await flushLocalVideoWork(); assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []); }
  finally { if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

test("G5C12 current GET 403 hides server rows without reading its body or deleting the cache", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); fixture.library();
  const key = fixture.libraryKey(), cache = JSON.stringify([LOCAL_LIBRARY_ROW_A]); fixture.localStorage.setItem(key, cache);
  fixture.handoffStatuses.restore = 403; fixture.handoffBodyFailures.add("restore"); const cleanup = fixture.video(null).restore();
  try {
    await flushLocalVideoWork(); assert.equal(fixture.packageBodyReads.includes("restore"), false);
    assert.equal(libraryRows(fixture).length, 0); assert.equal(fixture.state.ActiveId, ""); assert.ok(fixture.state.Notice);
    assert.equal(fixture.localStorage.getItem(key), cache);
  } finally { if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

test("G5C12 a later denied create intent expires a pending GET even without a snapshot change", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const captured = fixture.library(), body = fixture.deferBody("restore"), cleanup = fixture.video(null).restore();
  try {
    await fixture.bodyStarted.promise; fixture.handoffStatuses["library-create"] = 403;
    const before = libraryState(fixture); await captured.callbacks.create();
    assert.deepEqual(libraryState(fixture), before); const writes = fixture.writes.length, mutations = fixture.mutations.length;
    body.resolve(JSON.stringify(fixture.libraryReplies.restore)); await flushLocalVideoWork();
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
    assert.deepEqual(fixture.mutations.slice(mutations), []);
  } finally { body.resolve(JSON.stringify(fixture.libraryReplies.restore)); await flushLocalVideoWork(); if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

test("G5C12 confirmed empty GET drops cached server rows while retaining local drafts and their selection", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  const draft = { ...LOCAL_LIBRARY_ROW_A, id: "content-owned-local", title: "Local-only idea" };
  fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, draft], draft.id); fixture.library();
  fixture.localStorage.setItem(fixture.libraryKey(), JSON.stringify([LOCAL_LIBRARY_ROW_A, draft]));
  fixture.libraryReplies.restore = { success: true, mode: "supabase", data: { videos: [] } };
  const cleanup = fixture.video(null).restore();
  try {
    await flushLocalVideoWork(); assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [draft]);
    assert.equal(fixture.state.ActiveId, draft.id); assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [draft]);
  } finally { if (typeof cleanup === "function") cleanup(); fixture.lifetime!.unmount(); }
});

function invokeLibraryText(captured: LocalLibrary, kind: LocalLibraryTextKind) {
  return kind === "script" ? captured.callbacks.script() : captured.callbacks.prompt(kind);
}
function libraryTextPatch(kind: LocalLibraryTextKind) {
  return kind === "script" ? { ...LOCAL_LIBRARY_SCRIPT, status: "script_ready" }
    : { [kind === "avatar" ? "avatarPrompt" : "tapnowPrompt"]: `${LOCAL_LIBRARY_PROMPT.prompt}\n\nNegative prompt: ${LOCAL_LIBRARY_PROMPT.negativePrompt}`, status: "avatar_ready" };
}
function libraryTextReceipt(fixture: LocalHandoffFixture, kind: LocalLibraryTextKind) {
  const canonical = { ...LOCAL_LIBRARY_ROW_A, ...libraryTextPatch(kind),
    [kind === "script" ? "script" : kind === "avatar" ? "avatarPrompt" : "tapnowPrompt"]: `Canonical ${kind} receipt` };
  fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
  return canonical;
}
async function pauseLibraryText(fixture: LocalHandoffFixture, kind: LocalLibraryTextKind, phase: "token" | "body" | "response" | "patch-body") {
  const resource = `library-${kind}` as const;
  const token = phase === "token" ? fixture.deferToken(resource) : undefined;
  const body = phase === "body" || phase === "patch-body" ? fixture.deferBody(phase === "patch-body" ? "library-patch" : resource) : undefined;
  const response = phase === "response" ? fixture.deferResponse(resource) : undefined;
  const captured = fixture.library(), work = invokeLibraryText(captured, kind);
  const resume = (value?: unknown) => {
    token?.resolve(); response?.resolve();
    body?.resolve(JSON.stringify(value ?? (phase === "patch-body" ? fixture.libraryReplies.patch : fixture.libraryTextReplies[kind])));
  };
  try {
    await flushLocalVideoWork();
    assert.equal(fixture.dispatches.length, phase === "token" ? 0 : phase === "patch-body" ? 2 : 1, "reach the actual deferred provider/save boundary");
    if (token) await token.started;
    else if (response) await response.started;
    else await fixture.bodyStarted.promise;
    return { captured, work, resume };
  } catch (error) { resume(); await work; throw error; }
}

const LIBRARY_TEXT_STALE_CASES = [
  { kind: "script", phase: "token", boundary: "account" },
  { kind: "script", phase: "body", boundary: "workspace" },
  { kind: "script", phase: "response", boundary: "unmount" },
  { kind: "script", phase: "body", boundary: "session-ABA" },
  { kind: "script", phase: "body", boundary: "form-ABA" },
  { kind: "avatar", phase: "token", boundary: "workspace" },
  { kind: "avatar", phase: "body", boundary: "account" },
  { kind: "avatar", phase: "body", boundary: "selection-ABA" },
  { kind: "tapnow", phase: "body", boundary: "unmount" },
  { kind: "tapnow", phase: "body", boundary: "session-ABA" },
  { kind: "tapnow", phase: "body", boundary: "form-ABA" },
  { kind: "script", phase: "patch-body", boundary: "account" },
  { kind: "tapnow", phase: "patch-body", boundary: "workspace" },
] as const;
for (const { kind, phase, boundary } of LIBRARY_TEXT_STALE_CASES) {
  test(`G5C13 ${kind} ${phase} cannot publish, save or notify after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id);
    const paused = await pauseLibraryText(fixture, kind, phase), controller = paused.captured.session.sessionRef.current!;
    try {
      if (boundary === "account" || boundary === "session-ABA") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      if (boundary === "session-ABA") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
      if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
      if (boundary === "unmount") fixture.lifetime!.unmount();
      if (boundary === "form-ABA") {
        paused.captured.callbacks.editTitle("Temporary form B"); fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title);
      }
      if (boundary === "selection-ABA") {
        paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id);
      }
      if (boundary === "workspace") fixture.state.Loading = "telegram";
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      const requests = fixture.dispatches.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work; await flushLocalVideoWork();
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => controller.signal.aborted || write.field !== "Loading"), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts.slice(toasts), []);
      assert.equal(fixture.dispatches.length, requests); assert.equal(fixture.localStorage.getItem(fixture.libraryKey(HANDOFF_WORKSPACE_B)), null);
      if (boundary === "workspace") assert.equal(fixture.state.Loading, "telegram", "only this operation's loading tag may be released");
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["script", "avatar", "tapnow"] as const) {
  test(`G5C13 retained ${kind} callback refuses an obsolete form/selection/session snapshot before provider POST`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id);
    const captured = fixture.library();
    try {
      if (kind === "script") { captured.callbacks.editTitle("Temporary form B"); fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title); }
      if (kind === "avatar") { captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id); }
      if (kind === "tapnow") { fixture.sdkSession("22222222-2222-4222-8222-222222222222"); fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      await invokeLibraryText(captured, kind);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []);
    } finally { fixture.lifetime!.unmount(); }
  });

  test(`G5C13 same-actor refresh ${kind} sends the captured payload and accepts only canonical PATCH fields`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); const canonical = libraryTextReceipt(fixture, kind);
    const paused = await pauseLibraryText(fixture, kind, "token");
    try {
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-text-refreshed", "TOKEN_REFRESHED");
      assert.equal(fixture.library().key, paused.captured.key); paused.resume(); await paused.work;
      assert.equal(fixture.dispatches.length, 2);
      const [provider, patch] = fixture.dispatches;
      const endpoint = kind === "script" ? "generate-script" : `generate-${kind}-prompt`;
      assert.equal(provider.url, `/api/content-studio/${endpoint}?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`); assert.equal(provider.method, "POST");
      assert.deepEqual(provider.body, { ...LOCAL_LIBRARY_FORM, ...LOCAL_LIBRARY_ROW_A, videoId: LOCAL_LIBRARY_ROW_A.id });
      assert.equal(patch.url, `/api/crm/content-videos?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`); assert.equal(patch.method, "PATCH");
      assert.deepEqual(patch.body, { ...libraryTextPatch(kind), id: LOCAL_LIBRARY_ROW_A.id });
      for (let index = 0; index < 2; index++) {
        assert.equal(fixture.dispatches[index].headers.get("Authorization"), "Bearer fixture-token-text-refreshed");
        assert.equal(fixture.dispatches[index].signal, paused.captured.session.sessionRef.current!.signal);
        assert.equal(fixture.libraryRequests[index].init.expectedUserId, "11111111-1111-4111-8111-111111111111");
        assert.equal(typeof fixture.libraryRequests[index].init.dispatchGuard, "function");
      }
      assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
      assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [canonical]);
      assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_A.id); assert.equal(fixture.state.Loading, null);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "error").length, 0);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const { kind, phase } of [
  { kind: "script", phase: "token" }, { kind: "avatar", phase: "body" }, { kind: "tapnow", phase: "patch-body" },
] as const) {
  test(`G5C13 ${kind} ${phase} owns the shared mutex across provider, create and PATCH callbacks`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const paused = await pauseLibraryText(fixture, kind, phase);
    const duplicate = [paused.captured.callbacks.script(), paused.captured.callbacks.prompt("avatar"), paused.captured.callbacks.prompt("tapnow"),
      paused.captured.callbacks.create(), Promise.resolve(paused.captured.callbacks.update(LOCAL_LIBRARY_PATCH))];
    const calls = phase === "token" ? 0 : phase === "patch-body" ? 2 : 1;
    try {
      await flushLocalVideoWork(); assert.equal(fixture.dispatches.length, calls, "old-render handlers must not issue extra provider/create/PATCH requests");
      paused.resume(); await Promise.all([paused.work, ...duplicate]);
      assert.equal(fixture.dispatches.length, 2); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { paused.resume(); await Promise.all([paused.work, ...duplicate]); fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["script", "avatar", "tapnow"] as const) {
  for (const status of [401, 403] as const) {
    test(`G5C13 ${kind} ${status} stops before an unreadable provider body with no PATCH or fallback`, async () => {
      const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
      const resource = `library-${kind}` as const; fixture.handoffStatuses[resource] = status; fixture.handoffBodyFailures.add(resource);
      const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
      try {
        await invokeLibraryText(captured, kind); assert.equal(fixture.dispatches.length, 1);
        assert.equal(fixture.packageBodyReads.includes(resource), false); assert.deepEqual(libraryState(fixture), before);
        assert.deepEqual(fixture.mutations.slice(mutations), []); assert.ok(fixture.state.Notice);
        assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

for (const { kind, status } of [{ kind: "script", status: 401 }, { kind: "tapnow", status: 403 }] as const) {
  test(`G5C13 valid ${kind} provider output cannot hide PATCH ${status} behind a body failure`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    fixture.handoffStatuses["library-patch"] = status; fixture.handoffBodyFailures.add("library-patch");
    const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryText(captured, kind); assert.equal(fixture.dispatches.length, 2);
      assert.equal(fixture.packageBodyReads.includes("library-patch"), false); assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.ok(fixture.state.Notice);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C13 structured provider transport denial remains denied despite later successful fresh auth", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  fixture.handoffTransportFailures["library-avatar"] = 401;
  const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
  try {
    await captured.callbacks.prompt("avatar"); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.ok(fixture.state.Notice);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
  } finally { fixture.lifetime!.unmount(); }
});

const LIBRARY_TEXT_MALFORMED: { kind: LocalLibraryTextKind; name: string; data: unknown }[] = [
  { kind: "script", name: "null", data: null }, { kind: "script", name: "missing fields", data: {} },
  { kind: "script", name: "nonstring script", data: { ...LOCAL_LIBRARY_SCRIPT, script: {} } },
  { kind: "script", name: "malformed hashtags", data: { ...LOCAL_LIBRARY_SCRIPT, hashtags: ["#synthetic", {}] } },
  { kind: "avatar", name: "null", data: null },
  { kind: "avatar", name: "nonstring prompt", data: { ...LOCAL_LIBRARY_PROMPT, prompt: {} } },
  { kind: "tapnow", name: "malformed negative prompt", data: { ...LOCAL_LIBRARY_PROMPT, negativePrompt: {} } },
  { kind: "tapnow", name: "malformed format", data: { ...LOCAL_LIBRARY_PROMPT, format: "unrecognized" } },
];
for (const { kind, name, data } of LIBRARY_TEXT_MALFORMED) {
  test(`G5C13 ${kind} rejects ${name} provider data before any PATCH/cache or success`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    fixture.libraryTextReplies[kind] = { success: true, mode: "openai", data };
    const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryText(captured, kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.ok(fixture.state.Notice); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["script", "avatar", "tapnow"] as const) {
  test(`G5C13 ${kind} valid output for content-* stays local with an explicit unsaved notice`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    const draft = { ...LOCAL_LIBRARY_ROW_A, id: "content-synthetic-text-target" }; fixture.seedLibrary([draft]);
    try {
      await invokeLibraryText(fixture.library(), kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [{ ...draft, ...libraryTextPatch(kind) }]);
      assert.ok(fixture.state.Notice); assert.match(String(fixture.state.Notice), /браузер|локаль/i);
      assert.equal(fixture.state.ActiveId, draft.id); assert.ok(fixture.localStorage.getItem(fixture.libraryKey()));
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["avatar", "tapnow"] as const) {
  test(`G5C13 ${kind} without an active idea refuses before any external POST`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([]);
    try {
      await fixture.library().callbacks.prompt(kind); assert.deepEqual(fixture.dispatches, []); assert.equal(libraryRows(fixture).length, 0);
      assert.ok(fixture.state.Notice); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C13 script without an idea creates a local draft only after valid provider data", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([]);
  const paused = await pauseLibraryText(fixture, "script", "body");
  try {
    assert.equal(libraryRows(fixture).length, 0); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
    paused.resume(); await paused.work; assert.equal(fixture.dispatches.length, 1);
    const [draft] = libraryRows(fixture); assert.match(draft.id, /^content-/);
    assert.deepEqual(JSON.parse(JSON.stringify({ ...draft, id: undefined, createdAt: undefined })), { ...LOCAL_LIBRARY_FORM, ...libraryTextPatch("script") });
    assert.equal(fixture.state.ActiveId, draft.id); assert.ok(fixture.state.Notice);
    assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), JSON.parse(JSON.stringify([draft])));
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const { kind, mode } of [{ kind: "script", mode: "throw" }, { kind: "tapnow", mode: "error" }] as const) {
  test(`G5C13 ${kind} fresh SDK ${mode} stops before provider transport and releases its pending lock`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const captured = fixture.library(), before = libraryState(fixture); fixture.sdkFailure(mode);
    try {
      await invokeLibraryText(captured, kind); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(libraryState(fixture), before);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      fixture.sdkFailure(); libraryTextReceipt(fixture, kind); await invokeLibraryText(fixture.library(), kind);
      assert.equal(fixture.dispatches.length, 2, "a failed auth probe must not strand the pending owner");
    } finally { fixture.sdkFailure(); fixture.lifetime!.unmount(); }
  });
}

for (const { kind, failure } of [{ kind: "script", failure: "HTTP" }, { kind: "avatar", failure: "transport" }] as const) {
  test(`G5C13 current ${kind} ${failure} error is visible without a fabricated result`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const resource = `library-${kind}` as const;
    if (failure === "HTTP") { fixture.handoffStatuses[resource] = 500; fixture.libraryTextReplies[kind] = { success: false, error: "Synthetic provider unavailable" }; }
    else fixture.handoffTransportFailures[resource] = 500;
    const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryText(captured, kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.ok(fixture.state.Notice); assert.equal(fixture.toasts.filter((toast) => toast.kind === "error").length, 1);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["script", "tapnow"] as const) {
  test(`G5C13 late ${kind} provider error body is silent after account/workspace replacement`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const paused = await pauseLibraryText(fixture, kind, "body");
    try {
      if (kind === "script") fixture.sdkSession("22222222-2222-4222-8222-222222222222"); else fixture.workspace(HANDOFF_WORKSPACE_B);
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      paused.resume({ success: false, error: "Synthetic late provider refusal" }); await paused.work;
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => kind === "script" || write.field !== "Loading"), []);
      assert.equal(fixture.dispatches.length, 1);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

test("G5C13 no-op form and selection input preserves the owned provider-to-PATCH operation", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const canonical = libraryTextReceipt(fixture, "script"), paused = await pauseLibraryText(fixture, "script", "body");
  try {
    paused.captured.callbacks.editTitle(LOCAL_LIBRARY_FORM.title); paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_A.id);
    paused.resume(); await paused.work; assert.equal(fixture.dispatches.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C13 provider and PATCH success cannot claim completion when the local cache commit fails", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  libraryTextReceipt(fixture, "script"); const captured = fixture.library(), before = libraryState(fixture);
  fixture.localStorage.failNextWrite(fixture.libraryKey());
  try {
    await captured.callbacks.script(); assert.equal(fixture.dispatches.length, 2); assert.deepEqual(libraryState(fixture), before);
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null); assert.ok(fixture.state.Notice);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { fixture.lifetime!.unmount(); }
});

for (const kind of ["script", "avatar", "tapnow"] as const) {
  test(`G5C13 explicit demo ${kind} uses the real pure core function with zero API, SDK or uploads`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    const draft = { ...LOCAL_LIBRARY_ROW_A, id: "content-local-demo-text" }; fixture.seedLibrary([draft]);
    const captured = fixture.library(); assert.equal(captured.session.localDraftsOnly, true);
    const prompt = kind === "script" ? null : kind === "avatar" ? fixture.pureLibraryDemo.demoAvatarPrompt(draft) : fixture.pureLibraryDemo.demoTapNowPrompt(draft);
    const patch = kind === "script" ? { ...fixture.pureLibraryDemo.demoScriptPackage(), status: "script_ready" }
      : { [kind === "avatar" ? "avatarPrompt" : "tapnowPrompt"]: `${prompt!.prompt}\n\nNegative prompt: ${prompt!.negativePrompt}`, status: "avatar_ready" };
    try {
      await invokeLibraryText(captured, kind);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.libraryRequests, []); assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.sdkReads.total, 0); assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), JSON.parse(JSON.stringify([{ ...draft, ...patch }])));
      assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), JSON.parse(JSON.stringify([{ ...draft, ...patch }])));
      assert.equal(fixture.state.ActiveId, draft.id); assert.ok(fixture.state.Notice);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C13 unknown provider mode rejects otherwise valid script data before PATCH or cache", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  fixture.libraryTextReplies.script = { success: true, mode: "unrecognized-provider", data: LOCAL_LIBRARY_SCRIPT };
  const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
  try {
    await captured.callbacks.script(); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.ok(fixture.state.Notice);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C13 empty script hashtags are valid and preserve the exact provider-to-canonical-PATCH mapping", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const script = { ...LOCAL_LIBRARY_SCRIPT, hashtags: [] }, patch = { ...script, status: "script_ready" };
  const canonical = { ...LOCAL_LIBRARY_ROW_A, ...patch, script: "Canonical empty-tags script" };
  fixture.libraryTextReplies.script = { success: true, mode: "anthropic", data: script };
  fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
  try {
    await fixture.library().callbacks.script(); assert.equal(fixture.dispatches.length, 2);
    assert.deepEqual(fixture.dispatches[1].body, { ...patch, id: LOCAL_LIBRARY_ROW_A.id });
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C13 a prompt without optional format or negative text is valid without fabricated defaults", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const patch = { avatarPrompt: "Synthetic prompt without optional fields", status: "avatar_ready" };
  const canonical = { ...LOCAL_LIBRARY_ROW_A, ...patch };
  fixture.libraryTextReplies.avatar = { success: true, mode: "anthropic", data: { prompt: patch.avatarPrompt } };
  fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
  try {
    await fixture.library().callbacks.prompt("avatar"); assert.equal(fixture.dispatches.length, 2);
    assert.deepEqual(fixture.dispatches[1].body, { ...patch, id: LOCAL_LIBRARY_ROW_A.id });
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C13 a live selector mismatch releases its own spinner and permits a fresh callback after restoration", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const canonical = libraryTextReceipt(fixture, "script"), paused = await pauseLibraryText(fixture, "script", "body");
  try {
    assert.equal(fixture.state.Loading, "script"); fixture.workspace(HANDOFF_WORKSPACE_B);
    const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
    paused.resume(); await paused.work;
    assert.equal(fixture.state.Loading, null); assert.equal(paused.captured.session.sessionRef.current!.signal.aborted, false);
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.writes.slice(writes).filter((write) => write.field !== "Loading"), []);
    assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual([...fixture.toasts], []); assert.equal(fixture.dispatches.length, 1);
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE); const fresh = fixture.library(); assert.equal(fresh.key, paused.captured.key);
    await fresh.callbacks.script(); assert.equal(fixture.dispatches.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
    assert.equal(fixture.state.Loading, null); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

type LocalTelegramKind = "test" | "send";
function telegramDeliveryKey(fixture: LocalHandoffFixture, row = LOCAL_LIBRARY_ROW_A, actorId = "11111111-1111-4111-8111-111111111111", workspaceId = REAL_DEMO_TEST_WORKSPACE) {
  const fingerprint = createHash("sha256").update(fixture.buildTelegramPackage(row)).digest("hex");
  return `negis_telegram_delivery_v1::${JSON.stringify([actorId, workspaceId, row.id, fingerprint])}`;
}
function telegramFenceMutations(fixture: LocalHandoffFixture, operations: Array<"set" | "remove">) {
  return operations.map((operation) => ({ storage: "local", operation, key: telegramDeliveryKey(fixture) }));
}
function assertTelegramFence(fixture: LocalHandoffFixture, state: "uncertain" | "sent" | null,
  row = LOCAL_LIBRARY_ROW_A, actorId = "11111111-1111-4111-8111-111111111111", workspaceId = REAL_DEMO_TEST_WORKSPACE) {
  const raw = fixture.localStorage.getItem(telegramDeliveryKey(fixture, row, actorId, workspaceId));
  if (state === null) { assert.equal(raw, null); return raw; }
  assert.ok(raw, `persist the ${state} Telegram fence`);
  const receipt = JSON.parse(raw) as { version: number; attemptId: string; state: string };
  assert.deepEqual(Object.keys(receipt).sort(), ["attemptId", "state", "version"]);
  assert.equal(receipt.version, 1); assert.equal(receipt.state, state);
  assert.match(receipt.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return raw;
}
function invokeLibraryTelegram(captured: LocalLibrary, kind: LocalTelegramKind) {
  return kind === "test" ? captured.callbacks.testTelegram() : captured.callbacks.sendTelegram();
}
function telegramStatusReceipt(fixture: LocalHandoffFixture) {
  const canonical = { ...LOCAL_LIBRARY_ROW_A, status: "telegram_ready", updatedAt: "2090-10-20T00:00:01.654321+00:00" };
  fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
  return canonical;
}

test("G5C14 CAS library parsing preserves exact offset microseconds and rejects untrusted versions without adding a form field", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE), captured = fixture.library();
  try {
    assert.equal(Object.hasOwn(fixture.libraryDefaults.initialVideo, "updatedAt"), false);
    for (const updatedAt of [LOCAL_LIBRARY_ROW_A.updatedAt, "2090-10-20T00:00:00Z", "2090-10-20T00:00:00.000001-04:00"]) {
      captured.callbacks.write([{ ...LOCAL_LIBRARY_ROW_A, updatedAt }]);
      assert.equal(captured.callbacks.read()[0]?.updatedAt, updatedAt);
    }
    captured.callbacks.write([{ ...LOCAL_LIBRARY_ROW_A, updatedAt: undefined }]);
    assert.equal(captured.callbacks.read().length, 1, "legacy/local rows remain readable without a server version");
    assert.equal(Object.hasOwn(captured.callbacks.read()[0], "updatedAt"), false);
    for (const updatedAt of [null, 42, "", "bad-version", "2090-10-20T00:00:00", "2090-10-20T00:00:00.1234567Z",
      " 2090-10-20T00:00:00Z", "2090-02-30T00:00:00Z"]) {
      fixture.localStorage.setItem(fixture.libraryKey(), JSON.stringify([{ ...LOCAL_LIBRARY_ROW_A, updatedAt }]));
      assert.equal(captured.callbacks.read().length, 0, `reject an untrusted stored version: ${String(updatedAt)}`);
    }
    assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

for (const updatedAt of [undefined, "bad-version", "2090-10-20T00:00:00", "2090-10-20T00:00:00.1234567Z"]) {
  test(`G5C14 CAS real send refuses ${updatedAt ?? "missing version"} before Telegram dispatch or reservation`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([{ ...LOCAL_LIBRARY_ROW_A, updatedAt }]);
    const before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await fixture.library().callbacks.sendTelegram();
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assertTelegramFence(fixture, null);
      assert.match(String(fixture.state.Notice), /версия контента.*не подтверждена.*обновите библиотеку.*не отправлялось/i);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      assert.equal(fixture.writes.some((write) => write.field === "Loading"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C14 CAS test delivery and content-* draft send do not require a server version", async () => {
  for (const testOnly of [true, false]) {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    const row = { ...LOCAL_LIBRARY_ROW_A, id: testOnly ? LOCAL_LIBRARY_ROW_A.id : "content-local-versionless", updatedAt: undefined };
    fixture.seedLibrary([row]);
    const before = libraryState(fixture);
    try {
      await invokeLibraryTelegram(fixture.library(), testOnly ? "test" : "send");
      assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.dispatches[0].method, "POST");
      assert.deepEqual(fixture.dispatches[0].body, testOnly ? { test: true, testRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : JSON.parse(JSON.stringify(row)));
      if (testOnly) { assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null); }
      else { assert.equal(libraryRows(fixture)[0].status, "telegram_ready"); assertTelegramFence(fixture, "sent", row); }
      assert.equal(fixture.toasts.filter((toast) => toast.kind === (testOnly ? "success" : "warning")).length, 1);
    } finally { fixture.lifetime!.unmount(); }
  }
});

test("G5C14 CAS readiness sends the original unrounded version and accepts an unchanged valid receipt version", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const canonical = { ...LOCAL_LIBRARY_ROW_A, status: "telegram_ready" };
  fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
  try {
    await fixture.library().callbacks.sendTelegram();
    assert.deepEqual(fixture.dispatches.map((call) => call.method), ["POST", "PATCH"]);
    assert.deepEqual(fixture.dispatches[1].body, { id: LOCAL_LIBRARY_ROW_A.id, status: "telegram_ready", expectedUpdatedAt: LOCAL_LIBRARY_ROW_A.updatedAt });
    assert.notEqual((fixture.dispatches[1].body as { expectedUpdatedAt: string }).expectedUpdatedAt, new Date(LOCAL_LIBRARY_ROW_A.updatedAt!).toISOString());
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
    assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [canonical]);
    assertTelegramFence(fixture, "sent");
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

for (const outcome of ["safe canonical metadata", "changed approval package", "changed approved copy"] as const) {
  test(`G5C14 CAS readiness checks ${outcome} against the original parsed content`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    const contentApproval = { packageId: "synthetic-approved-package", variantId: "synthetic-approved-variant", variantLabel: "Synthetic variant",
      variantAngle: "Synthetic angle", version: 1, approvedAt: "2090-10-20T00:00:00Z", copyMatchesLaunch: true,
      approvedCopy: { primaryText: "Synthetic primary", headline: "Synthetic headline", description: "Synthetic description" } };
    const row = { ...LOCAL_LIBRARY_ROW_A, contentApproval };
    fixture.seedLibrary([row]);
    const canonical = { ...row, status: "telegram_ready", updatedAt: "2090-10-20T00:00:01.654321Z" };
    const receipt = { ...canonical, serverOnlyMetadata: "not content", contentApproval: { ...contentApproval,
      variantLabel: " Synthetic variant ", approvedCopy: { ...contentApproval.approvedCopy, headline: " Synthetic headline " } } };
    if (outcome === "changed approval package") receipt.contentApproval.packageId = "different-approved-package";
    if (outcome === "changed approved copy") receipt.contentApproval.approvedCopy.primaryText = "Different approved primary";
    fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: Object.fromEntries(Object.entries(receipt).reverse()) } };
    const before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      assert.equal(fixture.buildTelegramPackage(row), fixture.buildTelegramPackage(receipt), "metadata is checked beyond the package text");
      await fixture.library().callbacks.sendTelegram();
      assert.deepEqual(fixture.dispatches.map((call) => call.method), ["POST", "PATCH"]);
      assert.deepEqual(fixture.dispatches[1].body, { id: row.id, status: "telegram_ready", expectedUpdatedAt: row.updatedAt });
      assertTelegramFence(fixture, "sent", row);
      if (outcome === "safe canonical metadata") {
        assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
        assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [canonical]);
        assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
      } else {
        assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
        assert.deepEqual(fixture.mutations.slice(mutations), telegramFenceMutations(fixture, ["set", "set"]));
        assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      }
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const outcome of ["stale 409", "network error", "missing receipt version", "malformed receipt version", "changed caption"] as const) {
  test(`G5C14 CAS apply ${outcome} returns false without local promotion or a cache write`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const canonical = telegramStatusReceipt(fixture), before = libraryState(fixture), mutations = fixture.mutations.length;
    if (outcome === "stale 409") {
      fixture.handoffStatuses["library-patch"] = 409;
      fixture.libraryReplies.patch = { success: false, code: "content_version_conflict" };
    } else if (outcome === "network error") {
      fixture.handoffTransportFailures["library-patch"] = 500;
    } else {
      const changed = outcome === "missing receipt version" ? { updatedAt: undefined }
        : outcome === "malformed receipt version" ? { updatedAt: "invalid-version" } : { caption: "Different readiness caption" };
      fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: { ...canonical, ...changed } } };
    }
    try {
      assert.equal(await fixture.library().callbacks.update({ status: "telegram_ready" }), false);
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.dispatches[0].method, "PATCH");
      assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
      assert.match(String(fixture.state.Notice), /версия контента.*обновите библиотеку/i);
    } finally { fixture.lifetime!.unmount(); }
  });
}

async function pauseLibraryTelegram(fixture: LocalHandoffFixture, kind: LocalTelegramKind, phase: "token" | "body" | "response" | "patch-body") {
  const token = phase === "token" ? fixture.deferToken("library-telegram") : undefined;
  const body = phase === "body" || phase === "patch-body" ? fixture.deferBody(phase === "patch-body" ? "library-patch" : "library-telegram") : undefined;
  const response = phase === "response" ? fixture.deferResponse("library-telegram") : undefined;
  const captured = fixture.library(), work = invokeLibraryTelegram(captured, kind);
  const resume = (value?: unknown) => { token?.resolve(); response?.resolve();
    body?.resolve(JSON.stringify(value ?? (phase === "patch-body" ? fixture.libraryReplies.patch : fixture.telegramReplies[kind]))); };
  try {
    const reached = token?.started ?? response?.started ?? body!.started;
    await Promise.race([reached, work.then(() => assert.fail("Telegram operation settled before its requested hold"))]);
    assert.equal(fixture.dispatches.length, phase === "token" ? 0 : phase === "patch-body" ? 2 : 1, "reach the actual Telegram transport/body or status-PATCH wait");
    return { captured, work, resume };
  } catch (error) { resume(); await work; throw error; }
}

const TELEGRAM_STALE_CASES = [
  { kind: "test", phase: "token", boundary: "account" }, { kind: "test", phase: "body", boundary: "workspace" },
  { kind: "test", phase: "body", boundary: "form-ABA" }, { kind: "test", phase: "body", boundary: "unmount" },
  { kind: "send", phase: "token", boundary: "workspace" }, { kind: "send", phase: "body", boundary: "account" },
  { kind: "send", phase: "body", boundary: "session-ABA" }, { kind: "send", phase: "body", boundary: "form-ABA" },
  { kind: "send", phase: "body", boundary: "selection-ABA" }, { kind: "send", phase: "response", boundary: "unmount" },
  { kind: "send", phase: "patch-body", boundary: "account" }, { kind: "send", phase: "patch-body", boundary: "workspace" },
] as const;
for (const { kind, phase, boundary } of TELEGRAM_STALE_CASES) {
  test(`G5C14 ${kind} ${phase} has no late request, library/cache or notice effects after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id); telegramStatusReceipt(fixture);
    const paused = await pauseLibraryTelegram(fixture, kind, phase), controller = paused.captured.session.sessionRef.current!;
    try {
      if (boundary === "account" || boundary === "session-ABA") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      if (boundary === "session-ABA") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
      if (boundary === "workspace") { fixture.workspace(HANDOFF_WORKSPACE_B); fixture.state.Loading = "avatar"; }
      if (boundary === "unmount") fixture.lifetime!.unmount();
      if (boundary === "form-ABA") { paused.captured.callbacks.editTitle("Temporary Telegram form B"); fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title); }
      if (boundary === "selection-ABA") { paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id); }
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      const requests = fixture.dispatches.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work;
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.deepEqual(fixture.writes.slice(writes).filter((write) => controller.signal.aborted || write.field !== "Loading"), []);
      assert.deepEqual(fixture.toasts.slice(toasts), []); assert.equal(fixture.dispatches.length, requests);
      assert.equal(fixture.localStorage.getItem(fixture.libraryKey(HANDOFF_WORKSPACE_B)), null);
      if (boundary === "workspace") assert.equal(fixture.state.Loading, "avatar");
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["test", "send"] as const) {
  test(`G5C14 retained ${kind} callback refuses its obsolete form or selection before POST`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary([LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], LOCAL_LIBRARY_ROW_A.id); const captured = fixture.library();
    try {
      if (kind === "test") { captured.callbacks.editTitle("Temporary Telegram form B"); fixture.library().callbacks.editTitle(LOCAL_LIBRARY_FORM.title); }
      else { captured.callbacks.select(LOCAL_LIBRARY_ROW_B.id); fixture.library().callbacks.select(LOCAL_LIBRARY_ROW_A.id); }
      const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      await invokeLibraryTelegram(captured, kind); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []);
    } finally { fixture.lifetime!.unmount(); }
  });

  test(`G5C14 same-actor refresh ${kind} binds the original actor, workspace, signal and exact payload`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.seedLibrary(kind === "test" ? [] : [LOCAL_LIBRARY_ROW_A, LOCAL_LIBRARY_ROW_B], kind === "test" ? "" : LOCAL_LIBRARY_ROW_A.id);
    const canonical = telegramStatusReceipt(fixture), before = libraryState(fixture), paused = await pauseLibraryTelegram(fixture, kind, "token");
    try {
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-telegram-refreshed", "TOKEN_REFRESHED");
      assert.equal(fixture.library().key, paused.captured.key); paused.resume(); await paused.work;
      assert.equal(fixture.dispatches.length, kind === "test" ? 1 : 2);
      const call = fixture.dispatches[0]; assert.equal(call.url, `/api/content-studio/send-telegram?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`);
      assert.equal(call.method, "POST"); assert.deepEqual(call.body, kind === "test" ? { test: true, testRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : LOCAL_LIBRARY_ROW_A);
      for (let index = 0; index < fixture.dispatches.length; index++) {
        assert.equal(fixture.dispatches[index].headers.get("Authorization"), "Bearer fixture-token-telegram-refreshed");
        assert.equal(fixture.dispatches[index].signal, paused.captured.session.sessionRef.current!.signal);
        assert.equal(fixture.libraryRequests[index].init.expectedUserId, "11111111-1111-4111-8111-111111111111"); assert.equal(typeof fixture.libraryRequests[index].init.dispatchGuard, "function");
      }
      if (kind === "test") { assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null); }
      else {
        assert.equal(fixture.dispatches[1].method, "PATCH"); assert.equal(fixture.dispatches[1].url, `/api/crm/content-videos?workspaceId=${REAL_DEMO_TEST_WORKSPACE}`);
        assert.deepEqual(fixture.dispatches[1].body, { id: LOCAL_LIBRARY_ROW_A.id, status: "telegram_ready", expectedUpdatedAt: LOCAL_LIBRARY_ROW_A.updatedAt });
        assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [LOCAL_LIBRARY_ROW_B, canonical]);
        assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey())!), [LOCAL_LIBRARY_ROW_B, canonical]);
        assert.equal(fixture.state.ActiveId, LOCAL_LIBRARY_ROW_A.id); assert.match(String(fixture.state.Notice), /2/);
      }
      assert.equal(fixture.state.Loading, null); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

for (const { kind, phase } of [{ kind: "test", phase: "token" }, { kind: "send", phase: "body" }, { kind: "send", phase: "patch-body" }] as const) {
  test(`G5C14 ${kind} ${phase} owns the mutex against Telegram, create, generation and PATCH duplicates`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); telegramStatusReceipt(fixture);
    const paused = await pauseLibraryTelegram(fixture, kind, phase);
    const duplicate = [paused.captured.callbacks.testTelegram(), paused.captured.callbacks.sendTelegram(), paused.captured.callbacks.create(),
      paused.captured.callbacks.script(), paused.captured.callbacks.prompt("avatar"), Promise.resolve(paused.captured.callbacks.update(LOCAL_LIBRARY_PATCH))];
    const count = phase === "token" ? 0 : phase === "patch-body" ? 2 : 1;
    try {
      await flushLocalVideoWork(); assert.equal(fixture.dispatches.length, count);
      paused.resume(); await Promise.all([paused.work, ...duplicate]); assert.equal(fixture.dispatches.length, kind === "test" ? 1 : 2);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { paused.resume(); await Promise.all([paused.work, ...duplicate]); fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["test", "send"] as const) {
  for (const status of [401, 403] as const) {
    test(`G5C14 ${kind} ${status} denies before an unreadable body and never writes status or fallback`, async () => {
      const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
      fixture.handoffStatuses["library-telegram"] = status; fixture.handoffBodyFailures.add("library-telegram");
      const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
      try {
        await invokeLibraryTelegram(captured, kind); assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.packageBodyReads.includes("library-telegram"), false);
        assert.deepEqual(libraryState(fixture), before);
        assert.deepEqual(fixture.mutations.slice(mutations), kind === "send" ? telegramFenceMutations(fixture, ["set", "remove"]) : []);
        assertTelegramFence(fixture, null); assert.ok(fixture.state.Notice);
        assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
      } finally { fixture.lifetime!.unmount(); }
    });
  }
}

test("G5C14 structured Telegram transport 403 stays denied after fresh same-actor auth succeeds", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  fixture.handoffTransportFailures["library-telegram"] = 403; const before = libraryState(fixture);
  try {
    await fixture.library().callbacks.sendTelegram(); assert.equal(fixture.dispatches.length, 1); assert.deepEqual(libraryState(fixture), before);
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null); assert.ok(fixture.state.Notice);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "warning"), false);
  } finally { fixture.lifetime!.unmount(); }
});

const TELEGRAM_INVALID_RESPONSES: { name: string; kind: LocalTelegramKind; mode?: string; data: unknown }[] = [
  { name: "null data", kind: "test", data: null },
  { name: "nonboolean sent", kind: "send", data: { sent: "true", test: false, parts: 1 } },
  { name: "nonstring package", kind: "send", data: { sent: true, packageText: {}, test: false, parts: 1 } },
  { name: "mismatched test flag", kind: "test", data: { ...LOCAL_TELEGRAM_DELIVERY, test: false } },
  { name: "zero parts", kind: "send", data: { sent: true, test: false, parts: 0 } },
  { name: "fractional parts", kind: "test", data: { ...LOCAL_TELEGRAM_DELIVERY, test: true, parts: 1.5 } },
  { name: "sent in demo mode", kind: "send", mode: "demo", data: { sent: true, test: false, parts: 1 } },
  { name: "unsent in telegram mode", kind: "test", data: { ...LOCAL_TELEGRAM_DELIVERY, sent: false, test: true, parts: undefined } },
  { name: "unknown mode", kind: "send", mode: "mock", data: { sent: true, test: false, parts: 1 } },
  { name: "wrong package echo", kind: "send", data: { ...LOCAL_TELEGRAM_DELIVERY, test: false } },
  { name: "unsent with parts", kind: "send", mode: "demo", data: { sent: false, test: false, parts: 1 } },
];
for (const { name, kind, mode, data } of TELEGRAM_INVALID_RESPONSES) {
  test(`G5C14 ${kind} rejects ${name} without PATCH, status mutation, cache or success`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const payload = data && typeof data === "object" ? { packageText: fixture.buildTelegramPackage(LOCAL_LIBRARY_ROW_A), ...data } : data;
    fixture.telegramReplies[kind] = { success: true, mode: mode ?? "telegram", data: payload };
    const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryTelegram(captured, kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), kind === "send" ? telegramFenceMutations(fixture, ["set"]) : []);
      assertTelegramFence(fixture, kind === "send" ? "uncertain" : null); assert.ok(fixture.state.Notice);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["test", "send"] as const) {
  test(`G5C14 ${kind} sent=false is copy-ready warning only and never writes telegram_ready`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const warning = "Synthetic Telegram is not connected; package is ready to copy.";
    fixture.telegramReplies[kind] = { success: true, mode: "demo", warning,
      data: { sent: false, test: kind === "test", packageText: fixture.buildTelegramPackage(LOCAL_LIBRARY_ROW_A) } };
    const captured = fixture.library(), before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryTelegram(captured, kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), kind === "send" ? telegramFenceMutations(fixture, ["set", "remove"]) : []);
      assertTelegramFence(fixture, null);
      assert.equal(fixture.state.Notice, warning); assert.deepEqual(fixture.toasts, [{ kind: "warning", message: warning }]);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C14 confirmed test delivery with an active idea never patches or changes its status", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const before = libraryState(fixture), mutations = fixture.mutations.length;
  try {
    await fixture.library().callbacks.testTelegram(); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(fixture.dispatches[0].body, { test: true, testRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

for (const failure of ["PATCH 403", "PATCH outage", "cache failure", "wrong canonical status", "PATCH 409", "unreadable PATCH 409",
  "missing receipt version", "invalid receipt version", "changed caption", "changed brief", "malformed receipt"] as const) {
  test(`G5C14 delivered send with ${failure} preserves delivery proof but warns status is not server-confirmed`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const canonical = telegramStatusReceipt(fixture), before = libraryState(fixture), mutations = fixture.mutations.length;
    if (failure === "PATCH 403") { fixture.handoffStatuses["library-patch"] = 403; fixture.handoffBodyFailures.add("library-patch"); }
    if (failure === "PATCH outage") fixture.handoffTransportFailures["library-patch"] = 500;
    if (failure === "cache failure") fixture.localStorage.failNextWrite(fixture.libraryKey());
    if (failure === "wrong canonical status") fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: { ...canonical, status: "idea" } } };
    const conflict = !["PATCH 403", "cache failure"].includes(failure);
    if (failure === "PATCH 409" || failure === "unreadable PATCH 409") {
      fixture.handoffStatuses["library-patch"] = 409;
      fixture.libraryReplies.patch = { success: false, code: "content_version_conflict", error: "Synthetic stale content version" };
      if (failure === "unreadable PATCH 409") fixture.handoffBodyFailures.add("library-patch");
    }
    const changed = failure === "missing receipt version" ? { updatedAt: undefined }
      : failure === "invalid receipt version" ? { updatedAt: "2090-10-20T00:00:01.6543217Z" }
      : failure === "changed caption" ? { caption: "Canonical Telegram status receipt" }
      : failure === "changed brief" ? { audience: "Different server audience" }
      : failure === "malformed receipt" ? { script: {} } : null;
    if (changed) fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: { ...canonical, ...changed } } };
    try {
      await fixture.library().callbacks.sendTelegram(); assert.equal(fixture.dispatches.length, 2);
      const notice = String(fixture.state.Notice); assert.match(notice, /Telegram.*подтвердил.*отправ/i); assert.match(notice, /статус.*не подтвержд/i);
      assert.doesNotMatch(notice, /не удалось отправить|сообщение не отправлено/i);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1); assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "error"), false);
      assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
      if (failure === "PATCH 403" || failure === "PATCH 409" || failure === "unreadable PATCH 409") assert.equal(fixture.packageBodyReads.includes("library-patch"), false);
      if (conflict) assert.deepEqual(fixture.mutations.slice(mutations), telegramFenceMutations(fixture, ["set", "set"]), "a readiness conflict must never cache a local status fallback");
      assert.equal(fixture.dispatches.filter((call) => call.url.includes("send-telegram")).length, 1, "never repeat delivery just to recover its status write");
      const fence = assertTelegramFence(fixture, "sent");
      for (const remount of [false, true]) {
        if (remount) fixture.lifetime!.unmount();
        fixture.seedLibrary([{ ...LOCAL_LIBRARY_ROW_A, updatedAt: remount ? canonical.updatedAt : LOCAL_LIBRARY_ROW_A.updatedAt }]);
        const retryBefore = libraryState(fixture), retryMutations = fixture.mutations.length;
        await fixture.library().callbacks.sendTelegram();
        assert.equal(fixture.dispatches.length, 2, "manual retry or reload with a refreshed version must not resend to recover the status");
        assert.deepEqual(libraryState(fixture), retryBefore); assert.deepEqual(fixture.mutations.slice(retryMutations), []);
        assert.equal(assertTelegramFence(fixture, "sent"), fence);
        assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
        assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      }
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C14 a malformed optional warning cannot erase strict delivery proof or fabricate full success", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  fixture.telegramReplies.send = { success: true, mode: "telegram", warning: {},
    data: { ...LOCAL_TELEGRAM_DELIVERY, test: false, packageText: fixture.buildTelegramPackage(LOCAL_LIBRARY_ROW_A) } };
  const before = libraryState(fixture), mutations = fixture.mutations.length;
  try {
    await fixture.library().callbacks.sendTelegram(); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), telegramFenceMutations(fixture, ["set"]));
    assertTelegramFence(fixture, "uncertain");
    assert.match(String(fixture.state.Notice), /Telegram.*подтвердил.*отправ/i);
    assert.doesNotMatch(String(fixture.state.Notice), /часть сообщения могла|не удалось отправить/i);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1); assert.equal(fixture.toasts.some((toast) => toast.kind === "success" || toast.kind === "error"), false);
  } finally { fixture.lifetime!.unmount(); }
});

for (const { kind, failure } of [{ kind: "test", failure: "HTTP" }, { kind: "send", failure: "network" }] as const) {
  test(`G5C14 current ${kind} ${failure} failure warns to check Telegram before retrying`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    if (failure === "HTTP") { fixture.handoffStatuses["library-telegram"] = 502; fixture.telegramReplies.test = { success: false, error: "Synthetic upstream failure" }; }
    else fixture.handoffTransportFailures["library-telegram"] = 502;
    const before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await invokeLibraryTelegram(fixture.library(), kind); assert.equal(fixture.dispatches.length, 1);
      assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), kind === "send" ? telegramFenceMutations(fixture, ["set"]) : []);
      assertTelegramFence(fixture, kind === "send" ? "uncertain" : null);
      assert.match(String(fixture.state.Notice), /проверьте Telegram.*перед повтор/i); assert.equal(fixture.toasts.filter((toast) => toast.kind === "error").length, 1);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["test", "send"] as const) {
  test(`G5C14 late ${kind} error body remains silent after the original scope expires`, { timeout: 5000 }, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    const paused = await pauseLibraryTelegram(fixture, kind, "body");
    try {
      fixture.sdkSession("22222222-2222-4222-8222-222222222222"); const before = libraryState(fixture), writes = fixture.writes.length, mutations = fixture.mutations.length;
      paused.resume({ success: false, error: "Synthetic late Telegram failure" }); await paused.work;
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts, []); assert.equal(fixture.dispatches.length, 1);
    } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
  });
}

test("G5C14 send without an idea refuses before Telegram POST or any status mutation", async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([]);
  try {
    await fixture.library().callbacks.sendTelegram(); assert.deepEqual(fixture.dispatches, []); assert.equal(libraryRows(fixture).length, 0);
    assert.ok(fixture.state.Notice); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { fixture.lifetime!.unmount(); }
});

for (const { kind, mode } of [{ kind: "test", mode: "throw" }, { kind: "send", mode: "error" }] as const) {
  test(`G5C14 ${kind} fresh SDK ${mode} stops before external transport and frees the mutex for retry`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); telegramStatusReceipt(fixture);
    const before = libraryState(fixture); fixture.sdkFailure(mode);
    try {
      await invokeLibraryTelegram(fixture.library(), kind); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(libraryState(fixture), before);
      fixture.sdkFailure(); await invokeLibraryTelegram(fixture.library(), kind); assert.equal(fixture.dispatches.length, kind === "test" ? 1 : 2);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { fixture.sdkFailure(); fixture.lifetime!.unmount(); }
  });
}

for (const kind of ["test", "send"] as const) {
  test(`G5C14 explicit local demo ${kind} never sends, checks auth or changes the local idea status`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
    fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true });
    fixture.seedLibrary([{ ...LOCAL_LIBRARY_ROW_A, id: "content-local-telegram" }]); const captured = fixture.library();
    const before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      assert.equal(captured.session.localDraftsOnly, true); await invokeLibraryTelegram(captured, kind);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.libraryRequests, []); assert.deepEqual(fixture.uploads, []); assert.equal(fixture.sdkReads.total, 0);
      assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.match(String(fixture.state.Notice), /не отправ|не подключ/i); assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C14 no-op input preserves a pending Telegram send and its canonical status commit", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const canonical = telegramStatusReceipt(fixture), paused = await pauseLibraryTelegram(fixture, "send", "body");
  try {
    paused.captured.callbacks.editTitle(LOCAL_LIBRARY_FORM.title); paused.captured.callbacks.select(LOCAL_LIBRARY_ROW_A.id);
    paused.resume(); await paused.work; assert.equal(fixture.dispatches.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

test("G5C14 a live selector mismatch clears only its own Telegram spinner and blocks a restored-scope duplicate", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  telegramStatusReceipt(fixture); const paused = await pauseLibraryTelegram(fixture, "send", "body");
  try {
    assert.equal(fixture.state.Loading, "telegram"); fixture.workspace(HANDOFF_WORKSPACE_B); const before = libraryState(fixture), mutations = fixture.mutations.length;
    paused.resume(); await paused.work; assert.equal(fixture.state.Loading, null); assert.deepEqual(libraryState(fixture), before);
    assert.deepEqual(fixture.mutations.slice(mutations), []); assert.equal(fixture.toasts.length, 0); assert.equal(fixture.dispatches.length, 1);
    const fence = assertTelegramFence(fixture, "uncertain");
    fixture.workspace(REAL_DEMO_TEST_WORKSPACE); const fresh = fixture.library(); assert.equal(fresh.key, paused.captured.key);
    const retryMutations = fixture.mutations.length;
    await fresh.callbacks.sendTelegram(); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.state.Loading, null);
    assert.equal(assertTelegramFence(fixture, "uncertain"), fence); assert.deepEqual(fixture.mutations.slice(retryMutations), []);
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
    assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const boundary of ["actor", "workspace", "SDK-error", "SDK-throw"] as const) {
  test(`G5C34 zero-dispatch ${boundary} after reservation releases only its fence and allows retry`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    telegramStatusReceipt(fixture);
    const key = telegramDeliveryKey(fixture), setItem = fixture.localStorage.setItem;
    let armed = true;
    fixture.localStorage.setItem = (storedKey, value) => {
      setItem(storedKey, value);
      if (!armed || storedKey !== key) return;
      armed = false;
      if (boundary === "actor") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
      else if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
      else fixture.sdkFailureOnce(boundary === "SDK-error" ? "error" : "throw");
    };
    try {
      await fixture.library().callbacks.sendTelegram();
      assert.equal(armed, false); assert.equal(fixture.dispatches.length, 0);
      assertTelegramFence(fixture, null);
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      fixture.lifetime!.unmount();
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-token-a"); fixture.auth({ user: { id: "11111111-1111-4111-8111-111111111111" } });
      fixture.workspace(REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
      await fixture.library().callbacks.sendTelegram();
      assert.equal(fixture.dispatches.length, 2); assertTelegramFence(fixture, "sent");
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { fixture.localStorage.setItem = setItem; fixture.lifetime!.unmount(); }
  });
}

for (const details of [undefined, "malformed details", [null, "synthetic refusal", 123]] as const) {
  test(`G5C34 malformed Telegram details (${typeof details}) preserve the partial-delivery warning`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    fixture.handoffStatuses["library-telegram"] = 502;
    fixture.telegramReplies.send = { success: false, error: "Telegram API request failed", details,
      telegramDescription: "synthetic refusal", part: 2, totalParts: 3, hint: "TEST check delivery" };
    try {
      await fixture.library().callbacks.sendTelegram();
      assert.match(String(fixture.state.Notice), /Часть 2\/3.*synthetic refusal.*TEST check delivery/);
      assert.doesNotMatch(String(fixture.state.Notice), /filter is not a function/);
      assert.equal(fixture.dispatches.length, 1); assertTelegramFence(fixture, "uncertain");
      assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const failure of ["partial", "network"] as const) {
  test(`G5C14 non-test ${failure} retains its fence across settled clicks and reload without another Telegram POST`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    if (failure === "partial") {
      fixture.handoffStatuses["library-telegram"] = 502;
      fixture.telegramReplies.send = { success: false, error: "Telegram API request failed", details: ["Part 2/3: synthetic refusal"],
        telegramDescription: "synthetic refusal", telegramErrorCode: 429, status: 429, part: 2, totalParts: 3, hint: "TEST check delivery" };
    } else fixture.handoffTransportFailures["library-telegram"] = 502;
    const before = libraryState(fixture), mutations = fixture.mutations.length;
    try {
      await fixture.library().callbacks.sendTelegram();
      assert.equal(fixture.dispatches.length, 1); assert.equal(fixture.dispatches[0].method, "POST");
      assert.deepEqual(fixture.dispatches[0].body, LOCAL_LIBRARY_ROW_A);
      assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
      assert.deepEqual(fixture.mutations.slice(mutations), telegramFenceMutations(fixture, ["set"]));
      if (failure === "partial") assert.match(String(fixture.state.Notice), /Part 2\/3: synthetic refusal.*TEST check delivery/);
      assert.match(String(fixture.state.Notice), /проверьте Telegram.*перед повтор/i);
      const fence = assertTelegramFence(fixture, "uncertain");
      for (const remount of [false, true]) {
        if (remount) { fixture.lifetime!.unmount(); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); }
        const retryMutations = fixture.mutations.length;
        await fixture.library().callbacks.sendTelegram();
        assert.equal(fixture.dispatches.length, 1, "same payload must not restart part 1 after an ambiguous delivery");
        assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.mutations.slice(retryMutations), []);
        assert.equal(assertTelegramFence(fixture, "uncertain"), fence);
        assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
        assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
      }
      assert.equal(fixture.state.Loading, null); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C14 pending same-browser double calls and remount share one durable Telegram reservation", { timeout: 5000 }, async () => {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
  const paused = await pauseLibraryTelegram(fixture, "send", "body");
  try {
    const fence = assertTelegramFence(fixture, "uncertain"), mutations = fixture.mutations.length;
    await Promise.all([paused.captured.callbacks.sendTelegram(), fixture.library().callbacks.sendTelegram()]);
    assert.equal(fixture.dispatches.length, 1); assert.deepEqual(fixture.mutations.slice(mutations), []);
    fixture.lifetime!.unmount(); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    await fixture.library().callbacks.sendTelegram();
    assert.equal(fixture.dispatches.length, 1); assert.deepEqual(fixture.mutations.slice(mutations), []);
    assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
    const before = libraryState(fixture), writes = fixture.writes.length, toasts = fixture.toasts.length;
    paused.resume(); await paused.work;
    assert.deepEqual(libraryState(fixture), before); assert.deepEqual(fixture.writes.slice(writes), []);
    assert.deepEqual(fixture.toasts.slice(toasts), []); assert.equal(fixture.dispatches.length, 1);
    assert.deepEqual(fixture.mutations.slice(mutations), []); assert.equal(assertTelegramFence(fixture, "uncertain"), fence);
    assert.equal(fixture.localStorage.getItem(fixture.libraryKey()), null);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
});

for (const boundary of ["actor", "workspace"] as const) {
  for (const phase of ["response", "body", "patch-body"] as const) {
    test(`G5C14 ${boundary} switch during ${phase} suppresses old effects and blocks the original payload on return`, { timeout: 5000 }, async () => {
      const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); telegramStatusReceipt(fixture);
      const paused = await pauseLibraryTelegram(fixture, "send", phase);
      try {
        const fenceState = phase === "patch-body" ? "sent" : "uncertain", fence = assertTelegramFence(fixture, fenceState);
        if (boundary === "actor") { fixture.sdkSession("22222222-2222-4222-8222-222222222222"); fixture.auth({ user: { id: "22222222-2222-4222-8222-222222222222" } }); }
        else fixture.workspace(HANDOFF_WORKSPACE_B);
        fixture.seedLibrary([LOCAL_LIBRARY_ROW_B]); fixture.state.Notice = "TEST current scope notice"; fixture.state.Loading = "avatar";
        const before = libraryState(fixture), mutations = fixture.mutations.length, writes = fixture.writes.length;
        const requests = fixture.dispatches.length, toasts = fixture.toasts.length;
        paused.resume(); await paused.work;
        assert.deepEqual(libraryState(fixture), before); assert.equal(fixture.state.Notice, "TEST current scope notice");
        assert.equal(fixture.state.Loading, "avatar"); assert.deepEqual(fixture.writes.slice(writes), []);
        assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts.slice(toasts), []);
        assert.equal(fixture.dispatches.length, requests); assert.equal(assertTelegramFence(fixture, fenceState), fence);
        assert.equal(fixture.localStorage.getItem(fixture.libraryKey(REAL_DEMO_TEST_WORKSPACE)), null);
        assert.equal(fixture.localStorage.getItem(fixture.libraryKey(HANDOFF_WORKSPACE_B)), null);
        if (boundary === "actor") { fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.auth({ user: { id: "11111111-1111-4111-8111-111111111111" } }); }
        else fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
        fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); const restored = libraryState(fixture), retryMutations = fixture.mutations.length;
        await fixture.library().callbacks.sendTelegram();
        assert.equal(fixture.dispatches.length, requests); assert.deepEqual(libraryState(fixture), restored);
        assert.deepEqual(fixture.mutations.slice(retryMutations), []); assert.equal(assertTelegramFence(fixture, fenceState), fence);
        assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
        assert.equal(fixture.state.Loading, null); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
      } finally { paused.resume(); await paused.work; fixture.lifetime!.unmount(); }
    });
  }
}

for (const dimension of ["package", "actor", "workspace"] as const) {
  test(`G5C14 a new ${dimension} is independently allowed without releasing the original ambiguous fence`, async () => {
    const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE); fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]);
    fixture.handoffTransportFailures["library-telegram"] = 502;
    try {
      await fixture.library().callbacks.sendTelegram(); assert.equal(fixture.dispatches.length, 1);
      const originalFence = assertTelegramFence(fixture, "uncertain");
      const row = dimension === "package" ? { ...LOCAL_LIBRARY_ROW_A, caption: "TEST independently allowed package" } : LOCAL_LIBRARY_ROW_A;
      const actorId = dimension === "actor" ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111", workspaceId = dimension === "workspace" ? HANDOFF_WORKSPACE_B : REAL_DEMO_TEST_WORKSPACE;
      if (dimension === "actor") { fixture.sdkSession(actorId); fixture.auth({ user: { id: actorId } }); }
      if (dimension === "workspace") fixture.workspace(workspaceId);
      fixture.seedLibrary([row]); delete fixture.handoffTransportFailures["library-telegram"];
      fixture.telegramReplies.send = { success: true, mode: "telegram", data: { sent: true, test: false, parts: 1, packageText: fixture.buildTelegramPackage(row) } };
      const canonical = { ...row, status: "telegram_ready" };
      fixture.libraryReplies.patch = { success: true, mode: "supabase", data: { video: canonical } };
      const current = fixture.library(); await current.callbacks.sendTelegram();
      assert.equal(fixture.dispatches.length, 3); assert.deepEqual(fixture.dispatches.map((call) => call.method), ["POST", "POST", "PATCH"]);
      assert.equal(fixture.dispatches[1].url, `/api/content-studio/send-telegram?workspaceId=${workspaceId}`);
      assert.deepEqual(fixture.dispatches[1].body, row); assert.equal(fixture.libraryRequests[1].init.expectedUserId, actorId);
      assert.equal(fixture.dispatches[1].signal, current.session.sessionRef.current!.signal);
      assert.equal(fixture.dispatches[1].headers.get("Authorization"), dimension === "actor" ? "Bearer fixture-token-b" : "Bearer fixture-token-a");
      assert.deepEqual(fixture.dispatches[2].body, { id: row.id, status: "telegram_ready", expectedUpdatedAt: row.updatedAt });
      assert.deepEqual(JSON.parse(JSON.stringify(libraryRows(fixture))), [canonical]);
      assert.deepEqual(JSON.parse(fixture.localStorage.getItem(fixture.libraryKey(workspaceId))!), [canonical]);
      assertTelegramFence(fixture, "sent", row, actorId, workspaceId); assert.equal(assertTelegramFence(fixture, "uncertain"), originalFence);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
      if (dimension === "actor") { fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.auth({ user: { id: "11111111-1111-4111-8111-111111111111" } }); }
      if (dimension === "workspace") fixture.workspace(REAL_DEMO_TEST_WORKSPACE);
      fixture.seedLibrary([LOCAL_LIBRARY_ROW_A]); const mutations = fixture.mutations.length, before = libraryState(fixture);
      await fixture.library().callbacks.sendTelegram();
      assert.equal(fixture.dispatches.length, 3); assert.deepEqual(libraryState(fixture), before);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.equal(assertTelegramFence(fixture, "uncertain"), originalFence);
      assert.match(String(fixture.state.Notice), /повторная отправка заблокирована/i);
    } finally { fixture.lifetime!.unmount(); }
  });
}

type LocalTelegramUpstream = {
  sendTelegramMessage(input: { token: string; chatId: string; text: string;
    safeFetch: (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  }): Promise<{ success: boolean; status: number; acknowledgement?: string; telegramDescription?: string; telegramErrorCode?: number; hint?: string }>;
};
const LOCAL_TELEGRAM_MESSAGE = { message_id: 17, date: 0, chat: { id: 12345 }, text: "Synthetic message: Қазақша, русский, plain text." };
async function actualTelegramUpstream(raw: string, status = 200, chatId = String(LOCAL_TELEGRAM_MESSAGE.chat.id)) {
  const programs = await generationCallbackPrograms, api = evaluateGenerationFixture<LocalTelegramUpstream>(programs.telegramApi, {
    telegramDeliveryHash: (value: string) => createHash("sha256").update(value).digest("hex"),
  });
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  let bodyReads = 0;
  const input = { token: "synthetic-not-a-bot-token", chatId, text: LOCAL_TELEGRAM_MESSAGE.text,
    callerChatId: "synthetic-untrusted-caller", payload: { chatId: "synthetic-untrusted-caller", chat_id: "synthetic-untrusted-caller" },
    async safeFetch(url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
      calls.push({ url: String(url), init });
      return { ok: status >= 200 && status < 300, status, text: async () => { bodyReads++; return raw; } };
    },
  };
  const result = await api.sendTelegramMessage(input);
  assert.equal(calls.length, 1); assert.equal(bodyReads, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botsynthetic-not-a-bot-token/sendMessage"); assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual({ ...calls[0].init?.headers }, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init!.body!), { chat_id: input.chatId, text: input.text }, "the actual helper forwards only the platform destination and plain text");
  return result;
}

const TELEGRAM_INVALID_UPSTREAM_ACKS: { name: string; raw: string }[] = [
  { name: "empty 200", raw: "" }, { name: "non-JSON 200", raw: "<html>Synthetic proxy response</html>" },
  { name: "null body", raw: "null" }, { name: "array body", raw: "[]" },
  { name: "missing ok", raw: JSON.stringify({ result: LOCAL_TELEGRAM_MESSAGE }) },
  { name: "ok false", raw: JSON.stringify({ ok: false, result: LOCAL_TELEGRAM_MESSAGE }) },
  { name: "string true", raw: JSON.stringify({ ok: "true", result: LOCAL_TELEGRAM_MESSAGE }) },
  { name: "missing Message", raw: JSON.stringify({ ok: true }) },
  { name: "array Message", raw: JSON.stringify({ ok: true, result: [] }) },
  { name: "zero message ID", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, message_id: 0 } }) },
  { name: "unsafe message ID", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, message_id: Number.MAX_SAFE_INTEGER + 1 } }) },
  { name: "negative date", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, date: -1 } }) },
  { name: "fractional date", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, date: 1.5 } }) },
  { name: "array chat", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, chat: [] } }) },
  { name: "zero chat ID", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, chat: { id: 0 } } }) },
  { name: "unsafe chat ID", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, chat: { id: Number.MAX_SAFE_INTEGER + 1 } } }) },
  { name: "nonstring message text", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, text: {} } }) },
  { name: "blank message text", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, text: "  " } }) },
  { name: "different recipient", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, chat: { id: 67890 } } }) },
  { name: "different message text", raw: JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, text: `${LOCAL_TELEGRAM_MESSAGE.text} changed` } }) },
];
for (const { name, raw } of TELEGRAM_INVALID_UPSTREAM_ACKS) {
  test(`G5C14 upstream ${name} cannot acknowledge delivery`, async () => {
    const result = await actualTelegramUpstream(raw);
    assert.equal(result.success, false); assert.equal(result.status, 200);
    assert.equal(typeof result.telegramDescription, "string"); assert.ok(result.telegramDescription); assert.ok(result.hint);
  });
}

for (const chatId of [12345, -1007654321]) {
  test(`G5C14 upstream valid ${chatId > 0 ? "private" : "group"} Message acknowledges Unicode plain-text delivery`, async () => {
    const result = await actualTelegramUpstream(JSON.stringify({ ok: true, result: { ...LOCAL_TELEGRAM_MESSAGE, chat: { id: chatId } } }), 200, String(chatId));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true, status: 200,
      acknowledgement: createHash("sha256").update(JSON.stringify(["telegram-ack-v1", chatId, LOCAL_TELEGRAM_MESSAGE.message_id])).digest("hex") });
  });
}

for (const { status, description, expectedHint } of [
  { status: 401, description: "Unauthorized", expectedHint: /TELEGRAM_BOT_TOKEN/ },
  { status: 400, description: "Bad Request: chat not found", expectedHint: /TELEGRAM_CHAT_ID.*\/start/ },
]) {
  test(`G5C14 upstream HTTP ${status} preserves the Telegram status and actionable hint without echoing provider text`, async () => {
    const result = await actualTelegramUpstream(JSON.stringify({ ok: false, error_code: status, description }), status);
    assert.equal(result.success, false); assert.equal(result.status, status); assert.equal(result.telegramErrorCode, status);
    assert.equal(result.telegramDescription, "Telegram не подтвердил доставку сообщения.");
    assert.ok(!JSON.stringify(result).includes(description)); assert.match(result.hint!, expectedHint);
  });
}

const LOCAL_COPY_ROW = { ...LOCAL_LIBRARY_ROW_A, hook: "Library hook", script: "Library script", voiceover: "Library voiceover",
  cta: "Library CTA", caption: "Library caption", hashtags: ["#library"], avatarPrompt: "Library avatar", tapnowPrompt: "Library TapNow" };
const LOCAL_COPY_PACKAGE = { ...LOCAL_GENERATED_PACKAGE, adVariants: [...LOCAL_GENERATED_PACKAGE.adVariants,
  { ...LOCAL_GENERATED_PACKAGE.adVariants[0], id: "copy-variant-b", primaryText: "Copy variant B" }] };
const COPY_GOAL = { targetPatients: 9, durationDays: 14, maxBudget: 70000, dailyBudget: 5000, budgetCurrency: "KZT" };
const COPY_CASES = [
  { source: "package", title: "Сценарий Reels/TikTok", text: LOCAL_COPY_PACKAGE.script, label: "Сценарий" },
  { source: "package", title: "Shot list", text: LOCAL_COPY_PACKAGE.shotList.join("\n"), label: "Shot list" },
  { source: "package", title: "Текст на экране", text: LOCAL_COPY_PACKAGE.textOnScreen.join("\n"), label: "Текст на экране" },
  { source: "package", title: "Voiceover", text: LOCAL_COPY_PACKAGE.voiceover, label: "Voiceover" },
  { source: "package", title: "Caption для соцсетей", text: LOCAL_COPY_PACKAGE.caption, label: "Caption" },
  { source: "package", title: "Текст объявления Meta", text: LOCAL_COPY_PACKAGE.adVariants[0].primaryText, label: "Текст объявления" },
  { source: "package", title: "Photo prompt", text: LOCAL_COPY_PACKAGE.photoPrompt, label: "Photo prompt" },
  { source: "package", title: "Video prompt", text: LOCAL_COPY_PACKAGE.videoPrompt, label: "Video prompt" },
  { source: "package", title: "WhatsApp сообщение", text: LOCAL_COPY_PACKAGE.whatsappMessage, label: "WhatsApp сообщение" },
  { source: "library", title: "Avatar prompt", text: LOCAL_COPY_ROW.avatarPrompt, label: "Avatar prompt" },
  { source: "library", title: "TapNow prompt", text: LOCAL_COPY_ROW.tapnowPrompt, label: "TapNow prompt" },
  { source: "library", title: "Content package", text: "", label: "Content package" },
  { source: "photo", title: "photo", text: "Copy photo headline\nCopy photo offer\nCopy photo CTA", label: "Тексты креатива" },
] as const;
type LocalCopySource = typeof COPY_CASES[number]["source"];
type LocalEditor = ReturnType<LocalHandoffFixture["editor"]>;
async function copyFixture(demo = false) {
  const fixture = await localGenerationCallbacks("video", true, REAL_DEMO_TEST_WORKSPACE);
  if (demo) { fixture.workspace("demo-local-a"); fixture.auth({ user: null, isDemoMode: true }); }
  fixture.seedLibrary([LOCAL_COPY_ROW, LOCAL_LIBRARY_ROW_B], LOCAL_COPY_ROW.id);
  const editor = fixture.editor(); editor.callbacks.publishPackage(LOCAL_COPY_PACKAGE);
  editor.callbacks.updateTexts("headline", "Copy photo headline"); editor.callbacks.updateTexts("offer", "Copy photo offer"); editor.callbacks.updateTexts("cta", "Copy photo CTA");
  return fixture;
}
function copyCase(source: LocalCopySource) { return COPY_CASES.find((item) => item.source === source)!; }
function expectedCopy(fixture: LocalHandoffFixture, item: typeof COPY_CASES[number]) {
  return item.title === "Content package" ? fixture.buildTelegramPackage(LOCAL_COPY_ROW) : item.text;
}
async function pauseActualCopy(fixture: LocalHandoffFixture, source: LocalCopySource, phase: "token" | "clipboard") {
  const token = phase === "token" ? fixture.deferToken() : undefined;
  const clipboard = phase === "clipboard" ? fixture.deferClipboard() : undefined;
  const captured = fixture.editor(), item = copyCase(source), work = fixture.startCopy(captured, item.title);
  const resume = () => { token?.resolve(); clipboard?.resolve(); };
  try {
    await flushLocalVideoWork(); assert.equal(fixture.clipboardWrites.length, phase === "token" ? 0 : 1);
    if (token) await token.started; else await fixture.clipboardStarted.promise;
    return { captured, item, work, resume };
  } catch (error) { resume(); await Promise.allSettled([work]); throw error; }
}
function editCopySource(fixture: LocalHandoffFixture, captured: LocalEditor, boundary: string) {
  if (boundary === "account" || boundary === "session-ABA") fixture.sdkSession("22222222-2222-4222-8222-222222222222");
  if (boundary === "session-ABA") { fixture.lifetime!.render(); fixture.sdkSession("11111111-1111-4111-8111-111111111111"); fixture.lifetime!.render(); }
  if (boundary === "workspace") fixture.workspace(HANDOFF_WORKSPACE_B);
  if (boundary === "unmount") fixture.lifetime!.unmount();
  if (boundary === "form-ABA") { captured.callbacks.editTitle("Temporary copy form B"); fixture.editor().callbacks.editTitle(LOCAL_LIBRARY_FORM.title); }
  if (boundary === "selection-ABA") { captured.callbacks.selectLibrary(LOCAL_LIBRARY_ROW_B.id); fixture.editor().callbacks.selectLibrary(LOCAL_COPY_ROW.id); }
  if (boundary === "package-ABA") {
    captured.callbacks.publishPackage({ ...LOCAL_COPY_PACKAGE, script: "Replacement package B" }); fixture.editor().callbacks.publishPackage(LOCAL_COPY_PACKAGE);
  }
  if (boundary === "variant-ABA") { captured.callbacks.selectVariant("copy-variant-b"); fixture.editor().callbacks.selectVariant(LOCAL_COPY_PACKAGE.adVariants[0].id); }
  if (boundary === "photo-ABA") { captured.callbacks.updateTexts("headline", "Temporary photo B"); fixture.editor().callbacks.updateTexts("headline", "Copy photo headline"); }
  if (boundary === "format-ABA") { const original = String(fixture.state.PhotoFormat); captured.callbacks.changeFormat(original === "feed" ? "story" : "feed"); fixture.editor().callbacks.changeFormat(original); }
}

for (const item of COPY_CASES) {
  test(`G5C15 actual ${item.source} JSX copy ${item.title} writes exactly its text and label once`, async () => {
    const fixture = await copyFixture();
    try {
      const captured = fixture.editor(); await fixture.startCopy(captured, item.title);
      assert.deepEqual(fixture.clipboardWrites, [expectedCopy(fixture, item)]);
      assert.deepEqual(fixture.toasts, [{ kind: "success", message: `${item.label} скопирован` }]);
      assert.ok(fixture.sdkReads.total > 0); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.navigations, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

const COPY_STALE_CASES = [
  { source: "library", phase: "token", boundary: "account" }, { source: "library", phase: "token", boundary: "workspace" },
  { source: "library", phase: "clipboard", boundary: "unmount" }, { source: "library", phase: "clipboard", boundary: "session-ABA" },
  { source: "library", phase: "clipboard", boundary: "form-ABA" }, { source: "library", phase: "clipboard", boundary: "selection-ABA" },
  { source: "package", phase: "token", boundary: "package-ABA" }, { source: "package", phase: "clipboard", boundary: "package-ABA" },
  { source: "package", phase: "clipboard", boundary: "variant-ABA" }, { source: "package", phase: "clipboard", boundary: "account" },
  { source: "photo", phase: "token", boundary: "photo-ABA" }, { source: "photo", phase: "clipboard", boundary: "photo-ABA" },
  { source: "photo", phase: "clipboard", boundary: "format-ABA" }, { source: "photo", phase: "clipboard", boundary: "workspace" },
] as const;
for (const { source, phase, boundary } of COPY_STALE_CASES) {
  test(`G5C15 ${source} copy ${phase} stays silent after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseActualCopy(fixture, source, phase);
    try {
      editCopySource(fixture, paused.captured, boundary);
      const writes = fixture.writes.length, mutations = fixture.mutations.length, toasts = fixture.toasts.length;
      paused.resume(); await paused.work;
      assert.equal(fixture.clipboardWrites.length, phase === "token" ? 0 : 1); assert.deepEqual(fixture.toasts.slice(toasts), []);
      assert.deepEqual(fixture.writes.slice(writes), []); assert.deepEqual(fixture.mutations.slice(mutations), []);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.navigations, []);
    } finally { paused.resume(); await Promise.allSettled([paused.work]); fixture.lifetime!.unmount(); }
  });
}

for (const { source, boundary } of [{ source: "library", boundary: "form-ABA" }, { source: "package", boundary: "variant-ABA" }, { source: "photo", boundary: "photo-ABA" }] as const) {
  test(`G5C15 retained ${source} JSX callback cannot copy after ${boundary}`, async () => {
    const fixture = await copyFixture(), captured = fixture.editor();
    try {
      editCopySource(fixture, captured, boundary); const writes = fixture.writes.length, toasts = fixture.toasts.length;
      await fixture.startCopy(captured, copyCase(source).title);
      assert.deepEqual(fixture.clipboardWrites, []); assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.writes.slice(writes), []);
    } finally { fixture.lifetime!.unmount(); }
  });

  test(`G5C15 stale ${source} clipboard failure remains silent after ${boundary}`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseActualCopy(fixture, source, "clipboard");
    try {
      fixture.clipboardFailure(); editCopySource(fixture, paused.captured, boundary); const writes = fixture.writes.length, toasts = fixture.toasts.length;
      paused.resume(); await Promise.allSettled([paused.work]);
      assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.writes.slice(writes), []); assert.equal(fixture.clipboardWrites.length, 1);
    } finally { paused.resume(); await Promise.allSettled([paused.work]); fixture.lifetime!.unmount(); }
  });
}

for (const source of ["library", "package", "photo"] as const) {
  test(`G5C15 ${source} copy survives same-actor token refresh without losing its text`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseActualCopy(fixture, source, source === "library" ? "token" : "clipboard");
    try {
      fixture.sdkSession("11111111-1111-4111-8111-111111111111", "fixture-copy-refreshed", "TOKEN_REFRESHED"); assert.equal(fixture.editor().key, paused.captured.key);
      paused.resume(); await paused.work; assert.deepEqual(fixture.clipboardWrites, [expectedCopy(fixture, paused.item)]);
      assert.deepEqual(fixture.toasts, [{ kind: "success", message: `${paused.item.label} скопирован` }]); assert.deepEqual(fixture.dispatches, []);
    } finally { paused.resume(); await Promise.allSettled([paused.work]); fixture.lifetime!.unmount(); }
  });

  test(`G5C15 ${source} no-op input preserves a pending actual JSX copy`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseActualCopy(fixture, source, "clipboard");
    try {
      if (source === "library") { paused.captured.callbacks.editTitle(LOCAL_LIBRARY_FORM.title); paused.captured.callbacks.selectLibrary(LOCAL_COPY_ROW.id); }
      if (source === "package") { paused.captured.callbacks.publishPackage(LOCAL_COPY_PACKAGE); paused.captured.callbacks.selectVariant(LOCAL_COPY_PACKAGE.adVariants[0].id); }
      if (source === "photo") { paused.captured.callbacks.updateTexts("headline", "Copy photo headline"); paused.captured.callbacks.changeFormat(String(fixture.state.PhotoFormat)); }
      paused.resume(); await paused.work; assert.equal(fixture.clipboardWrites.length, 1); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { paused.resume(); await Promise.allSettled([paused.work]); fixture.lifetime!.unmount(); }
  });

  test(`G5C15 explicit local demo ${source} copies locally with zero SDK, API or storage uploads`, async () => {
    const fixture = await copyFixture(true);
    try {
      await fixture.startCopy(fixture.editor(), copyCase(source).title); assert.deepEqual(fixture.clipboardWrites, [expectedCopy(fixture, copyCase(source))]);
      assert.equal(fixture.sdkReads.total, 0); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const phase of ["token", "clipboard"] as const) {
  test(`G5C15 clipboard singleflight blocks cross-source duplicates during ${phase}`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseActualCopy(fixture, "library", phase);
    const duplicate = [fixture.startCopy(paused.captured, copyCase("package").title), fixture.startCopy(fixture.editor(), "photo")];
    try {
      await flushLocalVideoWork(); assert.equal(fixture.clipboardWrites.length, phase === "token" ? 0 : 1);
      paused.resume(); await Promise.all([paused.work, ...duplicate]); assert.equal(fixture.clipboardWrites.length, 1);
      assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
    } finally { paused.resume(); await Promise.allSettled([paused.work, ...duplicate]); fixture.lifetime!.unmount(); }
  });
}

test("G5C15 empty actual library copy warns without writing clipboard or claiming success", async () => {
  const fixture = await copyFixture(); fixture.seedLibrary([{ ...LOCAL_COPY_ROW, avatarPrompt: "" }]);
  try {
    await fixture.startCopy(fixture.editor(), "Avatar prompt"); assert.deepEqual(fixture.clipboardWrites, []);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "warning").length, 1); assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C15 current clipboard failure is explicit and its released lock allows one successful retry", async () => {
  const fixture = await copyFixture(); fixture.clipboardFailure();
  try {
    await Promise.allSettled([fixture.startCopy(fixture.editor(), "Avatar prompt")]);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "error").length, 1); assert.ok(fixture.state.Notice);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false);
    fixture.clipboardFailure(false); await fixture.startCopy(fixture.editor(), "Avatar prompt"); assert.equal(fixture.clipboardWrites.length, 2);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

for (const mode of ["throw", "error"] as const) {
  test(`G5C15 SDK ${mode} forbids clipboard and header transfer side effects`, async () => {
    const fixture = await copyFixture(); fixture.sdkFailure(mode); const mutations = fixture.mutations.length;
    try {
      await fixture.startCopy(fixture.editor(), "Avatar prompt"); await fixture.editor().callbacks.transfer();
      assert.deepEqual(fixture.clipboardWrites, []); assert.deepEqual(fixture.toasts, []); assert.deepEqual(fixture.navigations, []);
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.dispatches, []);
    } finally { fixture.sdkFailure(); fixture.lifetime!.unmount(); }
  });
}

test("G5C15 an obsolete variant button cannot select into a newly published package", async () => {
  const fixture = await copyFixture(), captured = fixture.editor();
  try {
    captured.callbacks.publishPackage({ ...LOCAL_COPY_PACKAGE, ideaTitle: "New copy package" });
    const selected = fixture.state.SelectedAdVariantId, writes = fixture.writes.length;
    captured.callbacks.selectVariant("copy-variant-b"); assert.equal(fixture.state.SelectedAdVariantId, selected); assert.deepEqual(fixture.writes.slice(writes), []);
  } finally { fixture.lifetime!.unmount(); }
});

async function pauseLibraryTransfer(fixture: LocalHandoffFixture) {
  const token = fixture.deferToken(), captured = fixture.editor(), mutations = fixture.mutations.length;
  const work = Promise.resolve().then(() => captured.callbacks.transfer());
  try {
    await flushLocalVideoWork(); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.navigations, []);
    await token.started; return { token, captured, work };
  } catch (error) { token.resolve(); await Promise.allSettled([work]); throw error; }
}
function editTransferSource(fixture: LocalHandoffFixture, captured: LocalEditor, boundary: string) {
  editCopySource(fixture, captured, boundary);
  if (boundary === "brief-ABA") { captured.callbacks.updateBrief("service", "Temporary brief B"); fixture.editor().callbacks.updateBrief("service", LOCAL_PACKAGE_BRIEF.service); }
  if (boundary === "goal-ABA") {
    fixture.goalPrefill({ ...COPY_GOAL, targetPatients: 3 }); fixture.editor().callbacks.hydrateGoal();
    fixture.goalPrefill(COPY_GOAL); fixture.editor().callbacks.hydrateGoal();
  }
}
for (const goal of [false, true]) {
  test(`G5C15 header transfer preserves exact library payload${goal ? " and current advertising goal" : " without a goal"} at the original workspace key`, async () => {
    const fixture = await copyFixture();
    if (goal) { fixture.goalPrefill(COPY_GOAL); fixture.editor().callbacks.hydrateGoal(); }
    const toasts = fixture.toasts.length, mutations = fixture.mutations.length;
    try {
      await fixture.editor().callbacks.transfer(); const prefill = readLocalHandoff(fixture);
      const key = `negis_ads_automation_prefill::${REAL_DEMO_TEST_WORKSPACE}`;
      assert.deepEqual(fixture.mutations.slice(mutations).map((mutation) => ({ storage: mutation.storage, operation: mutation.operation, key: mutation.key })), [{ storage: "local", operation: "set", key }]);
      assert.equal(prefill.platform, "meta"); assert.equal(prefill.sourceKind, "library"); assert.equal(prefill.sourceId, LOCAL_COPY_ROW.id);
      assert.equal(prefill.campaignName, goal ? LOCAL_PACKAGE_BRIEF.service : LOCAL_COPY_ROW.title);
      assert.equal(prefill.service, goal ? LOCAL_PACKAGE_BRIEF.service : LOCAL_COPY_ROW.niche); assert.equal(prefill.city, goal ? LOCAL_PACKAGE_BRIEF.city : undefined);
      assert.equal(prefill.offer, goal ? LOCAL_PACKAGE_BRIEF.offer : LOCAL_COPY_ROW.cta); assert.equal(prefill.audience, goal ? LOCAL_PACKAGE_BRIEF.audience : LOCAL_COPY_ROW.audience);
      assert.equal(prefill.primaryText, LOCAL_COPY_ROW.caption); assert.equal(prefill.headline, LOCAL_COPY_ROW.hook); assert.equal(prefill.description, LOCAL_COPY_ROW.cta); assert.equal(prefill.cta, "LEARN_MORE");
      for (const name of Object.keys(COPY_GOAL) as (keyof typeof COPY_GOAL)[]) assert.equal(prefill[name], goal ? COPY_GOAL[name] : undefined);
      assert.deepEqual(fixture.navigations, ["/ads-automation"]); assert.equal(fixture.toasts.slice(toasts).filter((toast) => toast.kind === "success").length, 1);
      assert.equal(fixture.localStorage.getItem(`negis_ads_automation_prefill::${HANDOFF_WORKSPACE_B}`), null);
      assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []); assert.deepEqual(fixture.clipboardWrites, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

for (const boundary of ["account", "workspace", "unmount", "session-ABA", "form-ABA", "selection-ABA", "brief-ABA", "goal-ABA"]) {
  test(`G5C15 header transfer stops after ${boundary} during actual fresh auth`, { timeout: 5000 }, async () => {
    const fixture = await copyFixture(), paused = await pauseLibraryTransfer(fixture);
    try {
      editTransferSource(fixture, paused.captured, boundary); const writes = fixture.writes.length, mutations = fixture.mutations.length, toasts = fixture.toasts.length;
      paused.token.resolve(); await paused.work;
      assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.dispatches, []);
      assert.equal(fixture.localStorage.getItem(`negis_ads_automation_prefill::${REAL_DEMO_TEST_WORKSPACE}`), null);
      assert.equal(fixture.localStorage.getItem(`negis_ads_automation_prefill::${HANDOFF_WORKSPACE_B}`), null);
    } finally { paused.token.resolve(); await Promise.allSettled([paused.work]); fixture.lifetime!.unmount(); }
  });
}

for (const boundary of ["form-ABA", "brief-ABA", "goal-ABA"]) {
  test(`G5C15 retained header transfer refuses an obsolete ${boundary} render`, async () => {
    const fixture = await copyFixture(), captured = fixture.editor();
    try {
      editTransferSource(fixture, captured, boundary); const writes = fixture.writes.length, mutations = fixture.mutations.length, toasts = fixture.toasts.length;
      await captured.callbacks.transfer(); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.writes.slice(writes), []);
      assert.deepEqual(fixture.toasts.slice(toasts), []); assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.dispatches, []);
    } finally { fixture.lifetime!.unmount(); }
  });
}

test("G5C15 header handoff mutex permits one prefill and navigation across retained duplicate callbacks", { timeout: 5000 }, async () => {
  const fixture = await copyFixture(), paused = await pauseLibraryTransfer(fixture);
  const duplicate = [paused.captured.callbacks.transfer(), fixture.editor().callbacks.transfer()];
  try {
    await flushLocalVideoWork(); assert.equal(fixture.sdkReads.total, 1); assert.deepEqual(fixture.navigations, []);
    paused.token.resolve(); await Promise.all([paused.work, ...duplicate]); assert.deepEqual(fixture.navigations, ["/ads-automation"]);
    assert.equal(fixture.mutations.filter((mutation) => mutation.key.startsWith("negis_ads_automation_prefill::")).length, 1);
    assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1); assert.deepEqual(fixture.dispatches, []);
  } finally { paused.token.resolve(); await Promise.allSettled([paused.work, ...duplicate]); fixture.lifetime!.unmount(); }
});

test("G5C15 a pending actual library PATCH prevents header transfer from overtaking the write", { timeout: 5000 }, async () => {
  const fixture = await copyFixture(), token = fixture.deferToken("library-patch"), work = Promise.resolve(fixture.library().callbacks.update(LOCAL_LIBRARY_PATCH));
  try {
    await token.started; const mutations = fixture.mutations.length, toasts = fixture.toasts.length;
    await fixture.editor().callbacks.transfer(); assert.deepEqual(fixture.mutations.slice(mutations), []); assert.deepEqual(fixture.toasts.slice(toasts), []);
    assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.dispatches, []);
  } finally { token.resolve(); await Promise.allSettled([work]); fixture.lifetime!.unmount(); }
});

test("G5C15 header storage failure reports failure without navigation or a false transfer success", async () => {
  const fixture = await copyFixture(); fixture.localStorage.failNextWrite(`negis_ads_automation_prefill::${REAL_DEMO_TEST_WORKSPACE}`);
  try {
    await Promise.resolve().then(() => fixture.editor().callbacks.transfer()); assert.deepEqual(fixture.navigations, []);
    assert.equal(fixture.localStorage.getItem(`negis_ads_automation_prefill::${REAL_DEMO_TEST_WORKSPACE}`), null);
    assert.ok(fixture.state.Notice); assert.equal(fixture.toasts.filter((toast) => toast.kind === "error").length, 1);
    assert.equal(fixture.toasts.some((toast) => toast.kind === "success"), false); assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C15 actual prefill writer honors an explicit original-workspace key after the live selector changes", async () => {
  const fixture = await copyFixture(), captured = fixture.editor(), key = `negis_ads_automation_prefill::${REAL_DEMO_TEST_WORKSPACE}`;
  fixture.workspace(HANDOFF_WORKSPACE_B); const mutations = fixture.mutations.length;
  try {
    captured.callbacks.writePrefill({ sourceKind: "library", sourceId: LOCAL_COPY_ROW.id, campaignName: LOCAL_COPY_ROW.title, primaryText: LOCAL_COPY_ROW.script }, key);
    assert.deepEqual(fixture.mutations.slice(mutations).map((mutation) => mutation.key), [key]);
    const saved = JSON.parse(fixture.localStorage.getItem(key)!); assert.equal(saved.primaryText, LOCAL_COPY_ROW.script); assert.equal(saved.platform, "meta");
    assert.equal(fixture.localStorage.getItem(`negis_ads_automation_prefill::${HANDOFF_WORKSPACE_B}`), null);
    assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.dispatches, []);
  } finally { fixture.lifetime!.unmount(); }
});

test("G5C15 explicit matching local demo header transfer writes only local prefill without SDK or API", async () => {
  const fixture = await copyFixture(true);
  try {
    await fixture.editor().callbacks.transfer(); assert.equal(readLocalHandoff(fixture, "demo-local-a").sourceKind, "library");
    assert.equal(fixture.sdkReads.total, 0); assert.deepEqual(fixture.dispatches, []); assert.deepEqual(fixture.uploads, []);
    assert.deepEqual(fixture.navigations, ["/ads-automation"]); assert.equal(fixture.toasts.filter((toast) => toast.kind === "success").length, 1);
  } finally { fixture.lifetime!.unmount(); }
});

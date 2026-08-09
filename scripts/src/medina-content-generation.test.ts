import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Формы модулей описаны здесь, а не импортированы: rootDir этого пакета —
// scripts/src, и любой import из lib/** ломает сборку типов. Тот же приём, что
// и в остальных наборах каталога, — они грузят lib динамически по той же
// причине. Расхождение описания с настоящим модулем поймает первый же вызов.
type GenerationFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type GenerationFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
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
  downloadVideoContent: (input: ProviderCall & { jobId: string }) => Promise<Buffer>;
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
};

type CoreModuleShape = {
  normalizeScriptPackage: (value: unknown) => { hashtags: string[] };
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
const { normalizeScriptPackage } = core;

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
    const response: GenerationFetchResponse = {
      ok: result.ok,
      status: result.status,
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

test("GEN7 отказ провайдера пересказывается дословно и никогда не содержит ключ", async () => {
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
  assert.ok(!error.message.includes(FAKE_KEY), "ключ не попадает в текст ошибки");
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
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
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
  assert.ok(!/storageBucket|storagePath/.test(code), "ключ объекта и bucket выводятся на сервере, а не приходят снаружи");
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

test("GEN24 «сгенерировано, но не сохранено» — отдельный ответ, а не «не удалось сгенерировать»", async () => {
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
    handler.includes("Изображение сгенерировано, но не сохранено"),
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
  const secretGuard = handler.slice(handler.indexOf("const secret = jobHandleSecret()"), handler.indexOf("const handleParam"));

  // «Задача не найдена» отправило бы оператора искать несуществующую ошибку:
  // задача есть, проверить её принадлежность нечем.
  assert.ok(/sendJson\(res,\s*503/.test(secretGuard), "отсутствие хранилища — отказ конфигурации, 503");
  assert.ok(!/sendJson\(res,\s*404/.test(secretGuard));
});

test("GEN26 задача рендера переживает уход со страницы и не возвращается после новой", async () => {
  const source = await readFile(studioPage, "utf8");

  // Ролик оплачен в момент постановки задачи. Идентификатор, живущий только в
  // состоянии React, терялся бы при любом переходе — вместе с оплаченным файлом.
  assert.ok(source.includes("VIDEO_JOB_KEY"), "подписанный идентификатор задачи обязан переживать переход");
  assert.ok(
    /writeStoredVideoJob\(\{[\s\S]{0,200}url: genVideo\?\.url/.test(source),
    "готовая задача хранится вместе со ссылкой, иначе возврат опросил бы её заново и записал ролик второй раз",
  );
  assert.ok(
    /setGenVideo\(null\);[\s\S]{0,400}writeStoredVideoJob\(null\)/.test(source),
    "новая задача стирает прошлую, иначе после перезагрузки вернулся бы старый ролик",
  );
});

test("GEN27 опрос рендера не кэшируется браузером", async () => {
  const api = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "lib", "api.ts"), "utf8");
  const guard = api.slice(api.indexOf("function isUncacheable"), api.indexOf("function ttlFor"));

  // Ответ, переживший десять секунд, показал бы застывший процент, а на
  // последнем шаге — «ещё рендерится» вместо готовой ссылки.
  assert.ok(guard.includes("/video-generation"), "опрос по таймеру обязан ходить в сеть каждый раз");
});

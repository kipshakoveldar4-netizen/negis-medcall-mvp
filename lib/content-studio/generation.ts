/**
 * Настоящая генерация изображения и видео сторонним сервисом.
 *
 * До этого модуля вся «генерация» в контент-студии была текстовой: сервер
 * просил OpenAI собрать сценарий и два prompt'а, а картинку и ролик клиника
 * должна была сделать где-то ещё, руками, скопировав prompt. Раздел «Workflow»
 * при этом перечислял ElevenLabs, HeyGen и CapCut, которых в коде нет вообще —
 * то есть экран обещал цепочку, которой не существовало.
 *
 * Здесь один провайдер — OpenAI, потому что его ключ в проекте уже настроен и
 * уже тратится на тексты: подключение второго вендора ради картинки означало
 * бы второй счёт, второй секрет и второй набор отказов, ничего не добавив.
 * Модель задаётся переменной окружения, так что смена провайдерской модели не
 * требует правки кода.
 *
 * Правила, которым подчинён весь файл:
 *
 *   * ключ не попадает ни в текст ошибки, ни в лог. Наружу уходит только
 *     сообщение самого провайдера и HTTP-статус;
 *   * ничего не включается само. Нет ключа — функция не вызывается вообще,
 *     а вызывающий обязан ответить честным «не подключено», а не тихой
 *     заглушкой: демо-картинки не бывает, в отличие от демо-текста;
 *   * `fetch` инжектируется, поэтому тесты проверяют форму запроса и разбор
 *     ответа, не ходя в сеть.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type GenerationFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
      cancel(reason?: unknown): Promise<unknown>;
    };
    cancel?(): Promise<unknown>;
  } | null;
  redirected?: boolean;
  url?: string;
};

export type GenerationFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "error";
    credentials?: "omit";
    cache?: "no-store";
  },
) => Promise<GenerationFetchResponse>;

/** Форматы, которыми оперирует контент-студия, и их ориентация. */
export type CreativeOrientation = "vertical" | "square" | "horizontal";

const ORIENTATION_BY_FORMAT: Readonly<Record<string, CreativeOrientation>> = {
  reels: "vertical",
  tiktok: "vertical",
  stories: "vertical",
  story: "vertical",
  universal: "vertical",
  feed: "square",
  square: "square",
  landscape: "horizontal",
  horizontal: "horizontal",
};

export function orientationForFormat(format: unknown): CreativeOrientation {
  const key = typeof format === "string" ? format.trim().toLowerCase() : "";
  return ORIENTATION_BY_FORMAT[key] || "vertical";
}

/**
 * Размеры, которые принимает images API. Своих придумывать нельзя: параметр
 * валидируется на стороне провайдера, и произвольное «1080x1920» вернуло бы
 * отказ, который оператор прочитал бы как «генерация сломана».
 */
const IMAGE_SIZE_BY_ORIENTATION: Readonly<Record<CreativeOrientation, string>> = {
  vertical: "1024x1536",
  square: "1024x1024",
  horizontal: "1536x1024",
};

/**
 * Размеры videos API. Квадрата у него нет, поэтому Feed 1:1 снимается
 * вертикально — это осознанная замена, и вызывающий обязан сказать о ней
 * оператору, а не молча выдать другой формат.
 */
const VIDEO_SIZE_BY_ORIENTATION: Readonly<Record<CreativeOrientation, string>> = {
  vertical: "1080x1920",
  square: "1080x1920",
  horizontal: "1280x720",
};

export function imageSizeForFormat(format: unknown): string {
  return IMAGE_SIZE_BY_ORIENTATION[orientationForFormat(format)];
}

export function videoSizeForFormat(format: unknown): string {
  return VIDEO_SIZE_BY_ORIENTATION[orientationForFormat(format)];
}

/** Квадрат снимается вертикально — единственная подмена формата в модуле. */
export function videoFormatWasSubstituted(format: unknown): boolean {
  return orientationForFormat(format) === "square";
}

export const IMAGE_MODEL_DEFAULT = "gpt-image-2";
export const PROMPT_MAX_LENGTH = 4000;

export type GenerationConfig = {
  apiKey: string;
  imageModel: string;
  /**
   * Модель видео не имеет значения по умолчанию намеренно.
   *
   * Доступ к видеомодели выдаётся аккаунту отдельно, а один ролик стоит на
   * порядок дороже картинки. Значение по умолчанию означало бы, что кнопка
   * появилась и списала деньги без решения владельца.
   */
  videoModel: string;
  /**
   * Длительность ролика передаётся провайдеру только если владелец её задал.
   * Допустимый набор значений — предмет договорённости с провайдером, а не
   * нашей догадки; без переменной параметр не отправляется вовсе и работает
   * умолчание провайдера.
   */
  videoSeconds: string;
};

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] || "").trim();
}

export function readGenerationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  return {
    apiKey: readEnv(env, "OPENAI_API_KEY"),
    imageModel: readEnv(env, "CONTENT_STUDIO_IMAGE_MODEL") || IMAGE_MODEL_DEFAULT,
    videoModel: readEnv(env, "CONTENT_STUDIO_VIDEO_MODEL"),
    videoSeconds: readEnv(env, "CONTENT_STUDIO_VIDEO_SECONDS"),
  };
}

export type GenerationRefusal = {
  status: number;
  error: string;
  details: string[];
  hint?: string;
};

/**
 * Единственное место, где решается «можно ли вообще звать провайдера».
 * Возвращает отказ, который отдаётся оператору дословно, — с именем
 * переменной, но никогда с её значением.
 */
export function imageGenerationRefusal(config: GenerationConfig): GenerationRefusal | null {
  if (!config.apiKey) {
    return {
      status: 503,
      error: "Генерация изображений не подключена",
      details: ["Не задана переменная окружения OPENAI_API_KEY."],
      hint: "Задайте OPENAI_API_KEY в настройках проекта — тем же ключом уже пользуется генерация текстов.",
    };
  }
  return null;
}

export function videoGenerationRefusal(config: GenerationConfig): GenerationRefusal | null {
  if (!config.apiKey) {
    return {
      status: 503,
      error: "Генерация видео не подключена",
      details: ["Не задана переменная окружения OPENAI_API_KEY."],
      hint: "Задайте OPENAI_API_KEY в настройках проекта.",
    };
  }
  if (!config.videoModel) {
    return {
      status: 503,
      error: "Генерация видео не подключена",
      details: ["Не задана переменная окружения CONTENT_STUDIO_VIDEO_MODEL."],
      hint:
        "Укажите в CONTENT_STUDIO_VIDEO_MODEL модель видео, доступную вашему аккаунту OpenAI. " +
        "Без неё кнопка генерации видео остаётся выключенной: доступ к видеомодели выдаётся отдельно и тарифицируется отдельно от текста.",
    };
  }
  return null;
}

export function normalizePrompt(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > PROMPT_MAX_LENGTH ? text.slice(0, PROMPT_MAX_LENGTH) : text;
}

type ProviderErrorBody = {
  error?: { message?: string; code?: string; type?: string };
  raw?: string;
};

async function readJson(response: GenerationFetchResponse): Promise<Record<string, unknown>> {
  const rawText = await response.text();
  const trimmed = rawText.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: trimmed };
  } catch {
    return { raw: trimmed };
  }
}

/**
 * Внутренний текст отказа: тело провайдера может повторять параметры запроса
 * или чувствительные сведения. Не передавать его напрямую в публичный ответ.
 * Сырое тело обрезается — оно бывает html-страницей прокси.
 */
export function providerErrorMessage(body: Record<string, unknown>, status: number): string {
  const typed = body as ProviderErrorBody;
  const message = typeof typed.error?.message === "string" ? typed.error.message.trim() : "";
  if (message) return message;
  const raw = typeof typed.raw === "string" ? typed.raw.trim().slice(0, 240) : "";
  return raw ? `HTTP ${status}: ${raw}` : `HTTP ${status}`;
}

export class GenerationProviderError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GenerationProviderError";
    this.status = status;
  }
}

/** Определение типа по сигнатуре байтов, а не по заявленному формату. */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export type GeneratedImage = {
  buffer: Buffer;
  mimeType: string;
  model: string;
  size: string;
};

/**
 * images API отдаёт картинку в base64 внутри JSON, а не ссылкой, поэтому
 * промежуточного скачивания нет: сразу байты.
 */
export async function generateImage(input: {
  fetchImpl: GenerationFetch;
  config: GenerationConfig;
  prompt: string;
  size: string;
}): Promise<GeneratedImage> {
  const response = await input.fetchImpl("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.config.imageModel,
      prompt: input.prompt,
      n: 1,
      size: input.size,
    }),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new GenerationProviderError(response.status, providerErrorMessage(body, response.status));
  }

  const data = Array.isArray(body.data) ? body.data : [];
  const first = data.length > 0 && data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  const base64 = first && typeof first.b64_json === "string" ? first.b64_json.trim() : "";
  if (!base64) {
    throw new GenerationProviderError(502, "Провайдер вернул ответ без изображения.");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new GenerationProviderError(502, "Провайдер вернул пустое изображение.");
  }

  const mimeType = sniffImageMimeType(buffer);
  if (!mimeType) {
    // Дальше файл уходит в хранилище креативов, где формат проверяется по
    // списку. Записать неизвестный тип означало бы положить в библиотеку
    // объект, который Meta потом не примет, и узнать об этом при запуске.
    throw new GenerationProviderError(502, "Провайдер вернул файл неизвестного формата.");
  }

  return { buffer, mimeType, model: input.config.imageModel, size: input.size };
}

export type VideoJobStatus = "queued" | "in_progress" | "completed" | "failed";

export type VideoJob = {
  id: string;
  status: VideoJobStatus;
  progress: number;
  error: string;
};

function readVideoJobStatus(value: unknown): VideoJobStatus {
  return value === "queued" || value === "in_progress" || value === "completed" || value === "failed"
    ? value
    // Незнакомый статус — не «готово» и не «упало»: считаем, что работа идёт,
    // и оператор увидит, что процент не двигается, вместо ложного результата.
    : "in_progress";
}

function readVideoJob(body: Record<string, unknown>): VideoJob {
  const errorRecord = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
  const progress = typeof body.progress === "number" && Number.isFinite(body.progress) ? body.progress : 0;
  return {
    id: typeof body.id === "string" ? body.id : "",
    status: readVideoJobStatus(body.status),
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    error: errorRecord && typeof errorRecord.message === "string" ? errorRecord.message : "",
  };
}

/** One deadline covers headers and the bounded JSON stream, including ignored aborts. */
async function readVideoProviderJson(input: {
  fetchImpl: GenerationFetch;
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const timeout = input.timeoutMs ?? 15_000;
  const unavailable = (status = 502) => new GenerationProviderError(status, "Не удалось подтвердить ответ сервиса генерации видео.");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000 || input.signal?.aborted) throw unavailable();
  const controller = new AbortController();
  let response: GenerationFetchResponse | undefined;
  let reader: ReturnType<NonNullable<GenerationFetchResponse["body"]>["getReader"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmedFailureStatus: number | undefined;
  const cancelBody = (body: GenerationFetchResponse["body"]) => {
    try { void body?.cancel?.().catch(() => {}); } catch { /* Cleanup cannot extend the request deadline. */ }
  };
  let rejectDeadline!: (error: Error) => void;
  const abort = () => { controller.abort(); rejectDeadline(unavailable()); };
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; timer = setTimeout(abort, timeout); });
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw unavailable();
      return input.fetchImpl(input.url, {
        method: input.method, headers: input.headers, ...(input.body === undefined ? {} : { body: input.body }),
        signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
      });
    });
    void pending.then(late => {
      if (controller.signal.aborted) { try { cancelBody(late?.body); } catch { /* A late response is not a new receipt. */ } }
    }, () => {});
    response = await Promise.race([pending, deadline]);
    if (response.redirected || (response.url && response.url !== input.url)) throw unavailable();
    if (!response.ok) {
      // Only received HTTP evidence can mean rejection; transport errors/timeouts remain unknown.
      if (Number.isInteger(response.status) && response.status >= 400 && response.status <= 599) confirmedFailureStatus = response.status;
      throw unavailable();
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299 || !response.body) throw unavailable();
    // Fetch decodes compressed JSON; its Content-Length still describes encoded bytes.
    const encoding = response.headers?.get("content-encoding")?.trim().toLowerCase();
    const length = encoding && encoding !== "identity" ? null : response.headers?.get("content-length") ?? null;
    const declared = length === null ? null : /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < 1 || declared > 65_536)) throw unavailable();
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || part.value.BYTES_PER_ELEMENT !== 1 || part.value.byteLength === 0) throw unavailable();
      bytes += part.value.byteLength;
      if (bytes > 65_536 || chunks.length >= 2048 || (declared !== null && bytes > declared)) throw unavailable();
      chunks.push(Buffer.from(part.value));
    }
    if (!bytes || (declared !== null && bytes !== declared) || controller.signal.aborted) throw unavailable();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    return parsed as Record<string, unknown>;
  } catch {
    // A lost POST acknowledgement can still represent a paid job. Never turn it into a known rejection.
    throw unavailable(confirmedFailureStatus);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Never await stalled cleanup. */ } }
    else cancelBody(response?.body);
  }
}

export async function createVideoJob(input: {
  fetchImpl: GenerationFetch;
  config: GenerationConfig;
  prompt: string;
  size: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<VideoJob> {
  const payload: Record<string, unknown> = {
    model: input.config.videoModel,
    prompt: input.prompt,
    size: input.size,
  };
  if (input.config.videoSeconds) payload.seconds = input.config.videoSeconds;

  const body = await readVideoProviderJson({
    fetchImpl: input.fetchImpl,
    url: "https://api.openai.com/v1/videos",
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  const job = readVideoJob(body);
  if (!job.id) {
    throw new GenerationProviderError(502, "Провайдер не вернул идентификатор задачи.");
  }
  return job;
}

export async function fetchVideoJob(input: {
  fetchImpl: GenerationFetch;
  config: GenerationConfig;
  jobId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<VideoJob> {
  const body = await readVideoProviderJson({
    fetchImpl: input.fetchImpl,
    url: `https://api.openai.com/v1/videos/${encodeURIComponent(input.jobId)}`,
    method: "GET",
    headers: { Authorization: `Bearer ${input.config.apiKey}` },
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  const job = readVideoJob(body);
  return { ...job, id: job.id || input.jobId };
}

/**
 * Идентификатор задачи, привязанный к рабочему пространству.
 *
 * Опрос состояния — отдельный запрос, и идентификатор задачи в нём приходит из
 * браузера. Без подписи сотрудник одной клиники, узнав чужой идентификатор,
 * получил бы копию чужого ролика: провайдер про наши рабочие пространства
 * ничего не знает, а служебный ключ у сервера один на всех. Поэтому наружу
 * уходит не идентификатор, а `id.подпись`, и подпись проверяется против
 * рабочего пространства проверенного вызывающего.
 *
 * Хранилища состояния это не требует — в отличие от строки в таблице, которую
 * пришлось бы заводить, чистить и переживать в ней гонки с UI.
 *
 * Ключ подписи в результат не попадает: HMAC его не раскрывает, а сравнение
 * идёт по времени, не зависящему от данных.
 */
/**
 * Ключ подписи выводится из переданного секрета, а не равен ему.
 *
 * Секретом служит служебный ключ Supabase — он есть на сервере всегда, когда
 * вообще есть куда сохранять результат. Подписывать им напрямую значило бы
 * держать ключ полного доступа к базе и ключ подписи одним значением: любая
 * будущая отладочная печать «ключа подписи» раскрывала бы не способность
 * подделать идентификатор задачи, а всю базу. Разделение по назначению стоит
 * одного вызова HMAC и убирает эту связь.
 */
const JOB_HANDLE_KEY_INFO = "negis/content-studio/video-job/v1";

function jobHandleKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(JOB_HANDLE_KEY_INFO).digest();
}

function jobHandleSignature(input: { workspaceId: string; jobId: string; secret: string }): string {
  return createHmac("sha256", jobHandleKey(input.secret))
    .update(`${input.workspaceId}:${input.jobId}`)
    .digest("base64url");
}

export function signVideoJobHandle(input: { workspaceId: string; jobId: string; secret: string }): string {
  return `${input.jobId}.${jobHandleSignature(input)}`;
}

export function readSignedVideoJobHandle(input: {
  handle: unknown;
  workspaceId: string;
  secret: string;
}): string | null {
  const handle = typeof input.handle === "string" ? input.handle.trim() : "";
  const separator = handle.lastIndexOf(".");
  if (separator <= 0 || separator === handle.length - 1) return null;

  const jobId = handle.slice(0, separator);
  const provided = Buffer.from(handle.slice(separator + 1), "utf8");
  const expected = Buffer.from(
    jobHandleSignature({ workspaceId: input.workspaceId, jobId, secret: input.secret }),
    "utf8",
  );

  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? jobId : null;
}

/** Bounded transport only: the private native worker validates the complete video later. */
export async function downloadVideoContent(input: {
  fetchImpl: GenerationFetch;
  config: GenerationConfig;
  jobId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const timeout = input.timeoutMs ?? 15_000;
  const unavailable = () => new GenerationProviderError(502, "Не удалось подтвердить загрузку файла ролика.");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000 || input.signal?.aborted) throw unavailable();
  const url = `https://api.openai.com/v1/videos/${encodeURIComponent(input.jobId)}/content?variant=video`;
  const controller = new AbortController();
  let response: GenerationFetchResponse | undefined;
  let reader: ReturnType<NonNullable<GenerationFetchResponse["body"]>["getReader"]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelBody = (body: GenerationFetchResponse["body"]) => {
    try { void body?.cancel?.().catch(() => {}); } catch { /* Cleanup must not extend the download deadline. */ }
  };
  let rejectDeadline!: (error: Error) => void;
  const abort = () => { controller.abort(); rejectDeadline(unavailable()); };
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; timer = setTimeout(abort, timeout); });
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw unavailable();
      return input.fetchImpl(url, {
        method: "GET", headers: { Authorization: `Bearer ${input.config.apiKey}` }, signal: controller.signal,
        redirect: "error", credentials: "omit", cache: "no-store",
      });
    });
    void pending.then(late => {
      if (controller.signal.aborted) { try { cancelBody(late?.body); } catch { /* A malformed late receipt is already rejected. */ } }
    }, () => {});
    response = await Promise.race([pending, deadline]);
    if (response.redirected || (response.url && response.url !== url)) throw unavailable();
    if (!response.ok || response.status !== 200) {
      // Error bodies may echo credentials or never finish; HTTP status is sufficient.
      const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 502;
      throw new GenerationProviderError(status, "Сервис генерации не подтвердил загрузку ролика.");
    }
    const length = response.headers?.get("content-length") ?? null;
    const declared = length === null ? null : /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > VIDEO_MAX_BYTES)) throw unavailable();
    if (!response.body) throw unavailable();
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || part.value.BYTES_PER_ELEMENT !== 1 || part.value.byteLength === 0) throw unavailable();
      bytes += part.value.byteLength;
      // Bound retained fragment overhead as well as payload bytes.
      if (bytes > VIDEO_MAX_BYTES || chunks.length >= 8192 || (declared !== null && bytes > declared)) throw unavailable();
      chunks.push(Buffer.from(part.value));
    }
    if (!bytes || (declared !== null && bytes !== declared) || controller.signal.aborted) throw unavailable();
    const buffer = Buffer.concat(chunks, bytes);
    if (!looksLikeMp4(buffer)) throw new GenerationProviderError(502, "Провайдер вернул файл, который не является MP4.");
    return buffer;
  } catch (error) {
    if (error instanceof GenerationProviderError && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      throw new GenerationProviderError(error.status, "Не удалось подтвердить загрузку файла ролика.");
    }
    throw unavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Never await stalled cancellation. */ } }
    else cancelBody(response?.body);
  }
}

/** Предел размера ролика — как у ручной загрузки креатива (lib/crm/server.ts). */
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/**
 * MP4 начинается с box'а размером в 4 байта и типом `ftyp`. Проверяется именно
 * он, а не расширение: имя файла придумываем мы сами и оно ничего не доказывает.
 */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

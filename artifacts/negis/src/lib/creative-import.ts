export const CREATIVE_IMPORT_DEADLINE_MS = 20_000;
export const CREATIVE_IMPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CREATIVE_IMPORT_VIDEO_MAX_BYTES = 500 * 1024 * 1024;

export type CreativeImportInput = {
  url: string;
  fileName: string;
  mimeType: string;
  storageOrigin: string;
  workspaceId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  request?: (url: string, init: RequestInit) => Promise<Response>;
};

export class CreativeImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CreativeImportError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const mimeByExtension: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

function checkedSource(input: CreativeImportInput) {
  const fail = () => { throw new CreativeImportError("creative_import_source_untrusted"); };
  if (typeof input.url !== "string" || /[\s\\%?#\u0000-\u001f\u007f]/.test(input.url)
    || !uuid.test(input.workspaceId)) return fail();
  let origin: URL, source: URL;
  try { origin = new URL(input.storageOrigin); source = new URL(input.url); } catch { return fail(); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || (input.storageOrigin !== origin.origin && input.storageOrigin !== `${origin.origin}/`)
    || source.origin !== origin.origin || source.username || source.password || source.search || source.hash
    || input.url !== `${source.origin}${source.pathname}`) return fail();
  const prefix = `${origin.origin}/storage/v1/object/public/ad-creatives/`;
  if (!input.url.startsWith(prefix)) return fail();
  const parts = input.url.slice(prefix.length).split("/");
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part.includes(".."))) return fail();
  const tenantIndex = parts[0] === "optimized" ? 1 : 0;
  if (parts[tenantIndex] !== input.workspaceId || parts.length <= tenantIndex + 1) return fail();
  if (typeof input.fileName !== "string" || !input.fileName || input.fileName !== input.fileName.trim()
    || new TextEncoder().encode(input.fileName).length > 255 || input.fileName.includes("..")
    || /[\\/%?#\u0000-\u001f\u007f]/.test(input.fileName)) return fail();
  const nameDot = input.fileName.lastIndexOf(".");
  const nameExtension = input.fileName.slice(nameDot + 1).toLowerCase();
  if (nameDot <= 0 || !input.fileName.slice(0, nameDot).trim() || !Object.hasOwn(mimeByExtension, nameExtension)) return fail();
  const mimeType = mimeByExtension[nameExtension]!;
  if (input.mimeType !== mimeType) return fail();
  // Generated keys may omit an extension. Only a dot-free final component can
  // borrow the validated handoff type; an explicit unknown extension must fail.
  const objectName = parts.at(-1)!;
  const extension = objectName.includes(".") ? objectName.split(".").at(-1)!.toLowerCase() : nameExtension;
  if (!Object.hasOwn(mimeByExtension, extension) || mimeByExtension[extension] !== mimeType) return fail();
  return { mimeType, cap: mimeType.startsWith("image/") ? CREATIVE_IMPORT_IMAGE_MAX_BYTES : CREATIVE_IMPORT_VIDEO_MAX_BYTES };
}

function cancelQuietly(body?: ReadableStream<Uint8Array> | null, reader?: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    const work = reader ? reader.cancel() : body?.cancel();
    void work?.catch(() => undefined);
  } catch { /* Cancellation must not extend the import deadline. */ }
}

// Even own-workspace URLs and matching headers are not proof of media validity
// or readiness. Return bounded bytes only; native upload/worker validation stays
// authoritative and must issue any canonical asset identity or ready receipt.
export async function downloadCreativeImport(input: CreativeImportInput): Promise<File> {
  input = { ...input };
  const { mimeType, cap } = checkedSource(input);
  const controller = new AbortController();
  const deadline = Date.now() + CREATIVE_IMPORT_DEADLINE_MS;
  let body: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false, cancelled = false;
  const cancel = () => { if (!cancelled && body) { cancelled = true; cancelQuietly(body, reader); } };
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => undefined);
  const stop = (error: Error) => {
    if (!controller.signal.aborted) { controller.abort(error); rejectInterrupted(error); }
    cancel();
  };
  const sessionAborted = () => stop(new DOMException("Creative import cancelled", "AbortError"));
  const timedOut = () => stop(new DOMException("Creative import deadline exceeded", "TimeoutError"));
  const timer = setTimeout(timedOut, CREATIVE_IMPORT_DEADLINE_MS);
  input.signal.addEventListener("abort", sessionAborted, { once: true });
  const current = () => {
    if (input.signal.aborted) sessionAborted();
    if (Date.now() >= deadline) timedOut();
    controller.signal.throwIfAborted();
    input.assertCurrent();
  };
  const bounded = <T>(work: Promise<T>) => Promise.race([work, interrupted]);
  try {
    current();
    const pending = (input.request ?? fetch)(input.url, {
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: controller.signal,
    });
    void pending.then((response) => { if (controller.signal.aborted) cancelQuietly(response.body); }, () => undefined);
    const response = await bounded(pending);
    body = response.body;
    current();
    if (!response.ok || response.redirected || (response.url && response.url !== input.url)) {
      throw new CreativeImportError("creative_import_response_untrusted");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== mimeType) {
      throw new CreativeImportError("creative_import_mime_mismatch");
    }
    const length = response.headers.get("content-length");
    const declared = length && /^[1-9]\d*$/.test(length) ? Number(length) : NaN;
    if (!Number.isSafeInteger(declared) || declared > cap) throw new CreativeImportError("creative_import_size_invalid");
    if (!body) throw new CreativeImportError("creative_import_stream_missing");
    reader = body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let block: Uint8Array<ArrayBuffer> | undefined, used = 0;
    let size = 0;
    while (true) {
      current();
      const part = await bounded(reader.read());
      current();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > Math.min(cap, declared) - size) {
        throw new CreativeImportError("creative_import_size_exceeded");
      }
      // Coalesce tiny/empty chunks so stream fragmentation cannot inflate memory.
      let offset = 0;
      while (offset < part.value.byteLength) {
        block ??= new Uint8Array(Math.min(64 * 1024, declared - size));
        const count = Math.min(block.length - used, part.value.byteLength - offset);
        block.set(part.value.subarray(offset, offset + count), used);
        used += count; size += count; offset += count;
        if (used === block.length) { chunks.push(block); block = undefined; used = 0; }
      }
    }
    if (size !== declared) throw new CreativeImportError("creative_import_size_mismatch");
    current();
    const file = new File(chunks, input.fileName, { type: mimeType });
    current();
    completed = true;
    return file;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", sessionAborted);
    if (!completed) { controller.abort(); cancel(); }
    try { reader?.releaseLock(); } catch { /* A stalled read must not stall cleanup. */ }
  }
}

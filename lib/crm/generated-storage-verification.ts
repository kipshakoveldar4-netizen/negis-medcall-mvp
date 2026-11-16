import { createHash } from "node:crypto";

type GeneratedStorageResponse = {
  headers: { get(name: string): string | null };
  status: number;
  redirected: boolean;
  body: ReadableStream<Uint8Array> | null;
};
type GeneratedStorageFetch = (url: string, init: RequestInit) => Promise<GeneratedStorageResponse>;

/** The caller supplies an already validated server-derived Storage URL, never a browser URL. */
export async function verifyGeneratedStorageBytes(input: { publicUrl: string; mimeType: string; size: number; sha256: string }): Promise<void> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 100 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error("generated_storage_verification_invalid");
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("generated_storage_timeout")); }, 10_000);
    timer.unref?.();
  });
  try {
    const request = fetch as unknown as GeneratedStorageFetch;
    const response = await Promise.race([request(input.publicUrl, { method: "GET", redirect: "error", credentials: "omit", signal: controller.signal, cache: "no-store" }), expired]);
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || !response.body
      || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== input.mimeType
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== input.size))) throw new Error("generated_storage_unconfirmed");
    const responseBody = response.body;
    if (!responseBody) throw new Error("generated_storage_unconfirmed");
    reader = responseBody.getReader();
    const activeReader = reader;
    let bytes = 0;
    const digest = createHash("sha256");
    for (;;) {
      const part = await Promise.race([activeReader.read(), expired]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > input.size) throw new Error("generated_storage_size_mismatch");
      digest.update(part.value);
    }
    if (bytes !== input.size || digest.digest("hex") !== input.sha256) throw new Error("generated_storage_hash_mismatch");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* The read may already be closed. */ } }
  }
}

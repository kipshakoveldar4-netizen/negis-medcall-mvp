import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function downloadPrivateVideo(input: { supabaseUrl: string; serviceRoleKey: string;
  bucket: string; path: string; outputPath: string; expectedBytes: number; maxBytes: number; expectedSha256?: string; timeoutMs?: number }): Promise<number> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const origin = new URL(input.supabaseUrl);
  if (origin.protocol !== "https:" || origin.origin !== input.supabaseUrl || !input.serviceRoleKey
    || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.bucket)
    || !input.path || input.path.startsWith("/") || /[\\%\u0000-\u001f\u007f]/.test(input.path)
    || input.path.split("/").some(part => !part || part === "." || part === "..")
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0
    || (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedSha256))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0 || input.expectedBytes > input.maxBytes) throw new Error("video_download_invalid");
  const url = `${origin.origin}/storage/v1/object/${encodeURIComponent(input.bucket)}/${input.path.split("/").map(encodeURIComponent).join("/")}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("video_download_timeout")); }, timeoutMs);
  });
  let bytes = 0;
  const digest = createHash("sha256");
  try {
    const response = await Promise.race([fetch(url, { redirect: "error", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${input.serviceRoleKey}`, apikey: input.serviceRoleKey }, signal: controller.signal }), expired]);
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || !response.body
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== input.expectedBytes))) throw new Error("video_download_unconfirmed");
    const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      digest.update(chunk);
      done(bytes > input.expectedBytes || bytes > input.maxBytes ? new Error("video_download_size_mismatch") : null, chunk);
    } });
    await Promise.race([pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limit,
      createWriteStream(input.outputPath, { flags: "wx" }), { signal: controller.signal }), expired]);
    if (bytes !== input.expectedBytes) throw new Error("video_download_size_mismatch");
    if (input.expectedSha256 !== undefined && digest.digest("hex") !== input.expectedSha256) throw new Error("video_download_digest_mismatch");
    return bytes;
  } catch { throw new Error("video_download_unconfirmed"); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

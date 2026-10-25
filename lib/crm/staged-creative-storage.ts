import type { SupabaseClient } from "@supabase/supabase-js";
import { issueStagedCreativeTicket, readStagedCreativeTicket, stagedCreativeKind, stagedCreativePath,
  STAGED_CREATIVE_BUCKET, type StagedCreativeActor, type StagedCreativeTicket } from "./staged-creative-ticket";
import { CreativeImageValidationUnavailable, normalizeCreativeImageBytes } from "./creative-image";

const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"]);
type Storage = Pick<SupabaseClient, "storage">;
type Config = { supabase: Storage; origin: string; serviceRoleKey: string };

export class StagedCreativeStorageError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function storageCall<T>(operation: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error()), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function originOf(config: Config): string {
  try {
    const url = new URL(config.origin);
    if (url.protocol !== "https:" || url.origin !== config.origin || url.username || url.password || config.serviceRoleKey.length < 32) throw new Error();
    return url.origin;
  } catch { throw new StagedCreativeStorageError("creative_staging_configuration_unconfirmed"); }
}

async function privateBucket(config: Config, ticket: StagedCreativeTicket): Promise<void> {
  try {
    const { data, error } = await storageCall(() => config.supabase.storage.getBucket(STAGED_CREATIVE_BUCKET));
    if (error || data?.id !== STAGED_CREATIVE_BUCKET || data.public !== false || !Number.isSafeInteger(data.file_size_limit)
      || Number(data.file_size_limit) < ticket.fileSize || Number(data.file_size_limit) > 100 * 1024 * 1024
      || !Array.isArray(data.allowed_mime_types) || !data.allowed_mime_types.includes(ticket.mimeType)
      || data.allowed_mime_types.some(mime => !allowedMimes.has(mime))) throw new Error();
  } catch { throw new StagedCreativeStorageError("creative_staging_bucket_unconfirmed"); }
}

/** Only a private upload ticket: never a public URL or a ready asset. */
export async function prepareStagedCreativeUpload(config: Config, input: StagedCreativeActor & {
  fileName: string; mimeType: string; fileSize: number;
}, now = Date.now()) {
  const origin = originOf(config);
  const { ticket, handle } = issueStagedCreativeTicket(input, config.serviceRoleKey, now);
  await privateBucket(config, ticket);
  const storagePath = stagedCreativePath(ticket);
  try {
    const { data, error } = await storageCall(() => config.supabase.storage.from(STAGED_CREATIVE_BUCKET).createSignedUploadUrl(storagePath, { upsert: false }));
    if (error || !data || data.path !== storagePath || typeof data.token !== "string" || !data.token
      || typeof data.signedUrl !== "string") throw new Error();
    const url = new URL(data.signedUrl);
    if (url.origin !== origin || url.username || url.password || url.hash
      || url.pathname !== `/storage/v1/object/upload/sign/${STAGED_CREATIVE_BUCKET}/${storagePath}`
      || [...url.searchParams].length !== 1 || url.searchParams.get("token") !== data.token) throw new Error();
    return { bucket: STAGED_CREATIVE_BUCKET, storageBucket: STAGED_CREATIVE_BUCKET, storagePath,
      signedUrl: data.signedUrl, token: data.token, uploadHandle: handle, expiresAt: ticket.expiresAt,
      fileName: ticket.fileName, fileType: stagedCreativeKind(ticket), mimeType: ticket.mimeType, fileSize: ticket.fileSize };
  } catch { throw new StagedCreativeStorageError("creative_staging_ticket_unconfirmed"); }
}

/** The image API may buffer only its bounded image. Videos belong to the worker. */
export async function readAndNormalizeStagedCreativeImage(config: Config, handle: unknown, actor: StagedCreativeActor,
  options: { now?: number; timeoutMs?: number } = {}): Promise<{ ticket: StagedCreativeTicket; buffer: Buffer }> {
  const origin = originOf(config);
  const ticket = readStagedCreativeTicket(handle, actor, config.serviceRoleKey, options.now);
  if (stagedCreativeKind(ticket) !== "image") throw new StagedCreativeStorageError("creative_staged_video_requires_worker");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new StagedCreativeStorageError("creative_staging_configuration_unconfirmed");
  await privateBucket(config, ticket);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let raw: Buffer | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(`${origin}/storage/v1/object/${STAGED_CREATIVE_BUCKET}/${stagedCreativePath(ticket)}`, {
      redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey },
    }), expired]);
    reader = response.body?.getReader();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || !response.body
      || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== ticket.mimeType
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== ticket.fileSize))) throw new Error();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader!.read(), expired]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > ticket.fileSize) throw new Error();
      chunks.push(Buffer.from(part.value));
    }
    if (bytes !== ticket.fileSize) throw new Error();
    raw = Buffer.concat(chunks, bytes);
  } catch { throw new StagedCreativeStorageError("creative_staging_image_unconfirmed"); }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Already closed. */ } }
  }
  // No publication or persistence in this step. The caller still needs a live
  // authorization check and an immutable, verified promotion receipt.
  try { return { ticket, buffer: await normalizeCreativeImageBytes({ buffer: raw!, fileName: ticket.fileName, mimeType: ticket.mimeType }) }; }
  catch (error) { throw new StagedCreativeStorageError(error instanceof CreativeImageValidationUnavailable
    ? "creative_staging_decoder_unavailable" : "creative_staging_image_invalid"); }
}

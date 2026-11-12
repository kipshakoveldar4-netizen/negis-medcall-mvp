import type { SupabaseClient } from "@supabase/supabase-js";
import { issueStagedCreativeTicket, readStagedCreativeTicket, sealStagedCreativeTicket, stagedCreativeKind, stagedCreativePath,
  STAGED_CREATIVE_BUCKET, type StagedCreativeActor, type StagedCreativeTicket } from "./staged-creative-ticket";
import { CreativeImageValidationUnavailable, normalizeCreativeImageBytes } from "./creative-image";

const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"]);
type Storage = Pick<SupabaseClient, "storage">;
export type StagedCreativeStorageConfig = { supabase: Storage; origin: string; serviceRoleKey: string };
type Config = StagedCreativeStorageConfig;
type StorageReply<T> = { data: T; error: unknown };
type StorageBucket = { id?: string; public?: boolean; file_size_limit?: number; allowed_mime_types?: string[] };
type SignedUpload = { path?: string; token?: string; signedUrl?: string };
type StorageObject = { name?: string; id?: string };
type StorageResponse = { body: ReadableStream<Uint8Array> | null; headers: { get(name: string): string | null }; status: number; redirected: boolean };
type StorageFetch = (url: string, init: RequestInit) => Promise<StorageResponse>;

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
    const bucketResult = config.supabase.storage.getBucket(STAGED_CREATIVE_BUCKET);
    const { data, error } = await storageCall(() => bucketResult as unknown as Promise<StorageReply<StorageBucket>>);
    if (error || data?.id !== STAGED_CREATIVE_BUCKET || data.public !== false || !Number.isSafeInteger(data.file_size_limit)
      || Number(data.file_size_limit) < ticket.fileSize || Number(data.file_size_limit) > 100 * 1024 * 1024
      || !Array.isArray(data.allowed_mime_types) || !data.allowed_mime_types.includes(ticket.mimeType)
      || data.allowed_mime_types.some((mime: string) => !allowedMimes.has(mime))) throw new Error();
  } catch { throw new StagedCreativeStorageError("creative_staging_bucket_unconfirmed"); }
}

/** Only a private upload ticket: never a public URL or a ready asset. */
export async function prepareStagedCreativeUpload(config: Config, input: StagedCreativeActor & {
  fileName: string; mimeType: string; fileSize: number;
}, now = Date.now()) {
  originOf(config);
  const { ticket } = issueStagedCreativeTicket(input, config.serviceRoleKey, now);
  return prepareReservedStagedCreativeUpload(config, ticket, now);
}

function uploadInfo(config: Config, ticket: StagedCreativeTicket, now: number) {
  return { bucket: STAGED_CREATIVE_BUCKET, storageBucket: STAGED_CREATIVE_BUCKET, storagePath: stagedCreativePath(ticket),
    uploadHandle: sealStagedCreativeTicket(ticket, config.serviceRoleKey, now), expiresAt: ticket.expiresAt,
    fileName: ticket.fileName, fileType: stagedCreativeKind(ticket), mimeType: ticket.mimeType, fileSize: ticket.fileSize };
}

async function mintReservedUpload(config: Config, ticket: StagedCreativeTicket, now: number,
  bucket: ReturnType<Config["supabase"]["storage"]["from"]>) {
  const origin = originOf(config);
  const info = uploadInfo(config, ticket, now), storagePath = info.storagePath;
  try {
    const signedUpload = bucket.createSignedUploadUrl(storagePath, { upsert: false });
    const { data, error } = await storageCall(() => signedUpload as unknown as Promise<StorageReply<SignedUpload>>);
    if (error || !data || data.path !== storagePath || typeof data.token !== "string" || !data.token
      || typeof data.signedUrl !== "string") throw new Error();
    const url = new URL(data.signedUrl);
    if (url.origin !== origin || url.username || url.password || url.hash
      || url.pathname !== `/storage/v1/object/upload/sign/${STAGED_CREATIVE_BUCKET}/${storagePath}`
      || [...url.searchParams].length !== 1 || url.searchParams.get("token") !== data.token) throw new Error();
    return { ...info, signedUrl: data.signedUrl, token: data.token };
  } catch { throw new StagedCreativeStorageError("creative_staging_ticket_unconfirmed"); }
}

export async function prepareReservedStagedCreativeUpload(config: Config, ticket: StagedCreativeTicket, now = Date.now()) {
  originOf(config);
  await privateBucket(config, ticket);
  return mintReservedUpload(config, ticket, now, config.supabase.storage.from(STAGED_CREATIVE_BUCKET));
}

/** An existing private object is resumable input, never a ready asset. */
export async function prepareOrResumeStagedCreativeUpload(config: Config, ticket: StagedCreativeTicket, now = Date.now()) {
  originOf(config);
  const info = uploadInfo(config, ticket, now);
  await privateBucket(config, ticket);
  const bucket = config.supabase.storage.from(STAGED_CREATIVE_BUCKET);
  const split = info.storagePath.lastIndexOf("/"), folder = info.storagePath.slice(0, split), name = info.storagePath.slice(split + 1);
  try {
    const listing = bucket.list(folder, { limit: 2, search: name });
    const { data, error } = await storageCall(() => listing as unknown as Promise<StorageReply<StorageObject[]>>);
    if (error || !Array.isArray(data) || data.length > 1 || data.some(row => row.name !== name
      || typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id))) throw new Error();
    if (data.length === 1) return { ...info, uploadRequired: false as const };
  } catch { throw new StagedCreativeStorageError("creative_staging_listing_unconfirmed"); }
  return mintReservedUpload(config, ticket, now, bucket);
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
    const request = fetch as unknown as StorageFetch;
    const response = await Promise.race([request(`${origin}/storage/v1/object/${STAGED_CREATIVE_BUCKET}/${stagedCreativePath(ticket)}`, {
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

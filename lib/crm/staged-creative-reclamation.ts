import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Config = { supabase: SupabaseClient; origin: string; serviceRoleKey: string };
type Row = Record<string, unknown>;
type StorageUploadReply = { data: { path?: string } | null; error: unknown };
type StorageResponse = { body: ReadableStream<Uint8Array> | null; headers: { get(name: string): string | null }; status: number; redirected: boolean; url: string };
type StorageFetch = (url: string, init: RequestInit) => Promise<StorageResponse>;
type Claim = { operationId: string; workspaceId: string; fileName: string; mimeType: string; fileSize: number;
  issuedAt: number; expiresAt: number; claimId: string; claimedUntil: string };
const bucket = "ad-creatives-staging";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"]);
// Fixed 1x1 black images, generated once with native Sharp; no original content survives.
const formats: Record<string, { extensions: string[]; base64: string }> = {
  "image/jpeg": { extensions: ["jpg", "jpeg"], base64: "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJUAB//Z" },
  "image/png": { extensions: ["png"], base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYGAAAAAEAAGjChXjAAAAAElFTkSuQmCC" },
  "image/webp": { extensions: ["webp"], base64: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=" },
};
const unavailable = () => new Error("creative_upload_reclamation_unconfirmed");
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const isoTime = (value: unknown): number => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

async function bounded<T>(operation: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function acknowledged(operation: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply;
    try { reply = await bounded(operation); } catch { continue; }
    if (!reply.error) return reply.data;
    // SQL business refusals are known outcomes, not lost acknowledgments.
    if (typeof object(reply.error).code === "string" && /^P\d{4}$/.test(String(object(reply.error).code))) throw unavailable();
  }
  throw unavailable();
}

function validateConfig(config: Config, workspaceId: string): string {
  const url = new URL(config.origin);
  if (url.protocol !== "https:" || url.origin !== config.origin || url.username || url.password || typeof workspaceId !== "string" || !uuid.test(workspaceId)
    || typeof config.serviceRoleKey !== "string" || config.serviceRoleKey.length < 32 || /[\s\u0000-\u001f\u007f]/.test(config.serviceRoleKey)) throw unavailable();
  return url.origin;
}

function claimFor(value: unknown, workspaceId: string, claimId: string): Claim {
  const row = object(value), format = typeof row.mimeType === "string" && Object.hasOwn(formats, row.mimeType) ? formats[row.mimeType] : undefined;
  const extension = typeof row.fileName === "string" ? /\.([a-z0-9]+)$/i.exec(row.fileName)?.[1]?.toLowerCase() : undefined;
  const now = Date.now(), claimedUntil = isoTime(row.claimedUntil);
  if (row.workspaceId !== workspaceId || typeof row.operationId !== "string" || !uuid4.test(row.operationId)
    || row.claimId !== claimId || typeof row.fileName !== "string" || !row.fileName.length || Buffer.byteLength(row.fileName) > 255
    || /[\\/\u0000-\u001f\u007f]/.test(row.fileName) || !format || !extension || !format.extensions.includes(extension)
    || !Number.isSafeInteger(row.fileSize) || Number(row.fileSize) < 1 || Number(row.fileSize) > 10 * 1024 * 1024
    || !Number.isSafeInteger(row.issuedAt) || Number(row.issuedAt) < 0 || Number(row.issuedAt) > now || !Number.isSafeInteger(row.expiresAt)
    || Number(row.expiresAt) - Number(row.issuedAt) !== 7_200_000 || !(claimedUntil > now)
    || claimedUntil > now + 120_000 + 5_000) throw unavailable();
  return { operationId: row.operationId, workspaceId, claimId, fileName: row.fileName, mimeType: String(row.mimeType),
    fileSize: Number(row.fileSize), issuedAt: Number(row.issuedAt), expiresAt: Number(row.expiresAt), claimedUntil: String(row.claimedUntil) };
}

async function confirmBucket(config: Config, claim: Claim, tombstoneSize: number): Promise<void> {
  const data = object(await acknowledged(() => config.supabase.storage.getBucket(bucket)));
  if (data.id !== bucket || (data.name !== undefined && data.name !== bucket) || data.public !== false
    || !Number.isSafeInteger(data.file_size_limit) || Number(data.file_size_limit) < Math.max(claim.fileSize, tombstoneSize)
    || Number(data.file_size_limit) > 100 * 1024 * 1024 || !Array.isArray(data.allowed_mime_types)
    || !data.allowed_mime_types.includes(claim.mimeType) || data.allowed_mime_types.some(mime => !allowedMimes.has(mime))) throw unavailable();
  // Legacy Storage responses omit versioning_status. Any explicit status must be disabled:
  // enabled/suspended could retain the original bytes even after the tombstone upsert.
  if (Object.hasOwn(data, "versioning_status") && data.versioning_status !== "disabled") throw unavailable();
}

async function provePrivateTombstone(config: Config, url: string, mimeType: string, size: number, sha256: string): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 10_000);
  });
  try {
    const request = fetch as unknown as StorageFetch;
    const pending = request(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      signal: controller.signal, headers: { Authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey } });
    void pending.then(response => {
      if (controller.signal.aborted) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* A late response must not keep its stream alive. */ }
      }
    }, () => {});
    const response = await Promise.race([pending, deadline]);
    reader = response.body?.getReader();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !reader
      || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== mimeType
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== size))) throw unavailable();
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (!part.value.byteLength) throw unavailable();
      bytes += part.value.byteLength;
      if (bytes > size || bytes > 2048) throw unavailable();
      hash.update(part.value);
    }
    if (bytes !== size || hash.digest("hex") !== sha256) throw unavailable();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    // Cancellation is best effort: a hostile/stalled body must not extend the deadline.
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Already closed. */ } }
  }
}

function confirmReceipt(value: unknown, claim: Claim, size: number, sha256: string): void {
  const row = object(value);
  if (Object.keys(row).length !== 6 || row.operationId !== claim.operationId || row.workspaceId !== claim.workspaceId
    || row.cleanupKind !== "tombstone" || row.size !== size || row.sha256 !== sha256 || !(isoTime(row.rawDeletedAt) > 0)) throw unavailable();
}

/** One server-eligible signed upload only. The occupied key permanently fences old upsert:false tokens. */
export async function reclaimStagedCreativeUploads(config: Config, workspaceId: string): Promise<{ reclaimed: number }> {
  try {
    const origin = validateConfig(config, workspaceId), claimId = randomUUID();
    const args = { p_workspace_id: workspaceId, p_claim_id: claimId, p_limit: 1 };
    const claims = await acknowledged(() => config.supabase.rpc("claim_creative_upload_reclamation", args));
    if (!Array.isArray(claims) || claims.length > 1) throw unavailable();
    if (!claims.length) return { reclaimed: 0 };
    // Eligibility (finalized/rejected/expired signed uploads) belongs exclusively to the RPC.
    const claim = claimFor(claims[0], workspaceId, claimId);
    const bytes = Buffer.from(formats[claim.mimeType]!.base64, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!bytes.length || bytes.length > 2048) throw unavailable();
    await confirmBucket(config, claim, bytes.length);
    const extension = claim.fileName.slice(claim.fileName.lastIndexOf(".") + 1).toLowerCase();
    const path = `${workspaceId}/staged/${claim.operationId}/original.${extension}`;
    const url = `${origin}/storage/v1/object/${bucket}/${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(isoTime(claim.claimedUntil) > Date.now())) throw unavailable();
      let unknownOutcome = true;
      try {
        const upload = config.supabase.storage.from(bucket).upload(path, Buffer.from(bytes), { contentType: claim.mimeType, upsert: true });
        const reply = await bounded(() => upload as unknown as Promise<StorageUploadReply>);
        unknownOutcome = Boolean(reply.error) || reply.data?.path !== path;
      } catch { /* A lost SDK ACK is reconciled only against exact private bytes. */ }
      try { await provePrivateTombstone(config, url, claim.mimeType, bytes.length, sha256); break; }
      catch { if (!unknownOutcome || attempt === 1) throw unavailable(); }
    }
    if (!(isoTime(claim.claimedUntil) > Date.now())) throw unavailable();
    const completeArgs = { p_workspace_id: workspaceId, p_operation_id: claim.operationId, p_claim_id: claimId,
      p_tombstone_sha256: sha256, p_tombstone_size: bytes.length };
    confirmReceipt(await acknowledged(() => config.supabase.rpc("complete_creative_upload_reclamation", completeArgs)), claim, bytes.length, sha256);
    return { reclaimed: 1 };
  } catch { throw unavailable(); }
}

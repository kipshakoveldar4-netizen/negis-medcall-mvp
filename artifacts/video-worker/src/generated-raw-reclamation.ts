import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.js";

const free = Buffer.alloc(32);
free.writeUInt32BE(32, 0);
free.write("free", 4);
free.write("MEDINA-RAW-FENCE-V1", 8);
const fenceBytes = Buffer.concat([Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"), free]);
// The exported copy is inspectable without making the internal marker mutable.
export const GENERATED_RAW_FENCE = Buffer.from(fenceBytes);
export const GENERATED_RAW_FENCE_SIZE = fenceBytes.length;
export const GENERATED_RAW_FENCE_SHA256 = createHash("sha256").update(fenceBytes).digest("hex");

type Row = Record<string, unknown>;
export type GeneratedRawReclamationJob = {
  id: string; workspace_id: string | null; asset_id: string | null; status: string; attempts: number | null;
  claimed_by: string | null; claimed_at: string | null; raw_bucket: string | null; raw_path: string | null;
  raw_size: number | null; source_mime_type: string | null; source_file_name: string | null;
  output_bucket: string | null; optimized_bucket: string | null; metadata: Record<string, unknown> | null;
};
export type GeneratedRawReclamationReceipt = {
  jobId: string; workspaceId: string; status: "reclaimed"; fenceSize: number; fenceSha256: string;
};
type ReclamationConfig = Pick<WorkerConfig, "supabaseUrl" | "serviceRoleKey" | "workerId" | "maxAttempts" | "rawBucket" | "outputBucket">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const unavailable = () => new Error("generated_raw_reclamation_unconfirmed");

async function bounded<T>(operation: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function validIdentity(config: ReclamationConfig, job: GeneratedRawReclamationJob): void {
  try {
    const origin = new URL(config.supabaseUrl), metadata = object(job.metadata), key = metadata.generationKey;
    if (origin.protocol !== "https:" || origin.origin !== config.supabaseUrl || origin.username || origin.password
      || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(origin.host) || typeof config.serviceRoleKey !== "string"
      || config.serviceRoleKey.length < 32 || config.serviceRoleKey.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(config.serviceRoleKey)
      || typeof config.workerId !== "string" || !config.workerId || Buffer.byteLength(config.workerId) > 512 || /[\u0000-\u001f\u007f]/.test(config.workerId)
      || !Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 10
      || !BUCKET.test(config.rawBucket) || config.outputBucket !== "ad-creatives" || config.rawBucket === config.outputBucket
      || typeof job.id !== "string" || !UUID4.test(job.id) || typeof job.workspace_id !== "string" || !UUID.test(job.workspace_id)
      || typeof job.asset_id !== "string" || !UUID5.test(job.asset_id) || job.status !== "ready"
      || job.claimed_by !== config.workerId || typeof job.claimed_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(job.claimed_at)
      || !Number.isFinite(Date.parse(job.claimed_at)) || !Number.isSafeInteger(job.attempts) || Number(job.attempts) < 1 || Number(job.attempts) > config.maxAttempts
      || job.raw_bucket !== config.rawBucket || job.output_bucket !== config.outputBucket || job.optimized_bucket !== config.outputBucket
      || !Number.isSafeInteger(job.raw_size) || Number(job.raw_size) < 1 || Number(job.raw_size) > 100 * 1024 * 1024
      || job.source_mime_type !== "video/mp4" || metadata.kind !== "generated-video-native"
      || typeof metadata.inputSha256 !== "string" || !SHA256.test(metadata.inputSha256)
      || typeof key !== "string" || !key || Buffer.byteLength(key) > 512 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)
      || Buffer.from(key).toString("utf8") !== key
      || (key.startsWith("v2:") && !/^v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key))) throw unavailable();
    const digest = createHash("sha256").update(JSON.stringify(["medina-generated-v1", job.workspace_id, key])).digest("hex");
    if (job.raw_path !== `${job.workspace_id}/generated-raw/${digest}/original.mp4`
      || job.source_file_name !== `negis-video-${digest.slice(0, 20)}.mp4`) throw unavailable();
  } catch { throw unavailable(); }
}

async function confirmBucket(supabase: SupabaseClient, config: ReclamationConfig): Promise<void> {
  const { data, error } = await bounded(() => supabase.storage.getBucket(config.rawBucket));
  const row = object(data);
  if (error || row.id !== config.rawBucket || (row.name !== undefined && row.name !== config.rawBucket) || row.public !== false
    || !Number.isSafeInteger(row.file_size_limit) || Number(row.file_size_limit) < 100 * 1024 * 1024 || Number(row.file_size_limit) > 500 * 1024 * 1024
    || !Array.isArray(row.allowed_mime_types) || !row.allowed_mime_types.includes("video/mp4")
    || row.allowed_mime_types.some(mime => typeof mime !== "string" || !MIMES.has(mime))
    || (Object.hasOwn(row, "versioning_status") && row.versioning_status !== "disabled")) throw unavailable();
  // Legacy responses omit versioning_status. Separate backend acceptance must
  // establish retention semantics; this receipt never claims physical erasure.
}

async function proveFence(config: ReclamationConfig, job: GeneratedRawReclamationJob): Promise<void> {
  const url = `${config.supabaseUrl}/storage/v1/object/${config.rawBucket}/${job.raw_path}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 10_000);
  });
  try {
    const pending = fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey } });
    void pending.then(response => {
      if (controller.signal.aborted) { try { void response.body?.cancel().catch(() => {}); } catch { /* Late body cleanup must not prolong the deadline. */ } }
    }, () => {});
    const response = await Promise.race([pending, deadline]);
    reader = response.body?.getReader();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !reader
      || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "video/mp4"
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== GENERATED_RAW_FENCE_SIZE))) throw unavailable();
    let bytes = 0;
    const digest = createHash("sha256");
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (!part.value.byteLength) throw unavailable();
      bytes += part.value.byteLength;
      if (bytes > GENERATED_RAW_FENCE_SIZE) throw unavailable();
      digest.update(part.value);
    }
    if (bytes !== GENERATED_RAW_FENCE_SIZE || digest.digest("hex") !== GENERATED_RAW_FENCE_SHA256) throw unavailable();
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Cancellation is best effort, never awaited. */ } }
  }
}

async function acknowledge(supabase: SupabaseClient, job: GeneratedRawReclamationJob): Promise<GeneratedRawReclamationReceipt> {
  const args = { p_job_id: job.id, p_workspace_id: job.workspace_id, p_claimed_by: job.claimed_by,
    p_claimed_at: job.claimed_at, p_attempt: job.attempts, p_fence_size: GENERATED_RAW_FENCE_SIZE, p_fence_sha256: GENERATED_RAW_FENCE_SHA256 };
  const expected: GeneratedRawReclamationReceipt = { jobId: job.id, workspaceId: job.workspace_id!, status: "reclaimed",
    fenceSize: GENERATED_RAW_FENCE_SIZE, fenceSha256: GENERATED_RAW_FENCE_SHA256 };
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply;
    try { reply = await bounded(() => supabase.rpc("ack_generated_video_raw_reclamation", args)); }
    catch { continue; }
    if (reply.error) {
      const code = object(reply.error).code;
      if (typeof code === "string" && (/^P\d{4}$/.test(code) || code === "42501")) throw unavailable();
      continue;
    }
    const row = object(reply.data);
    if (Object.keys(row).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => row[key] === value)) return expected;
    // Malformed/uncertain replies may only replay this exact acknowledgement.
  }
  throw unavailable();
}

/** Replace live raw bytes while permanently occupying the create-only key. */
export async function reclaimGeneratedVideoRaw(supabase: SupabaseClient, config: ReclamationConfig,
  job: GeneratedRawReclamationJob): Promise<GeneratedRawReclamationReceipt> {
  try {
    const binding: GeneratedRawReclamationJob = { ...job, metadata: { ...object(job.metadata) } };
    const settings: ReclamationConfig = { supabaseUrl: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey,
      workerId: config.workerId, maxAttempts: config.maxAttempts, rawBucket: config.rawBucket, outputBucket: config.outputBucket };
    validIdentity(settings, binding);
    await confirmBucket(supabase, settings);
    try {
      const { data, error } = await bounded(() => supabase.storage.from(settings.rawBucket).upload(binding.raw_path!, Buffer.from(fenceBytes),
        { contentType: "video/mp4", upsert: true }));
      if (error || data?.path !== binding.raw_path) throw unavailable();
    } catch { /* An uncertain upsert is confirmed only by exact private bytes. */ }
    await proveFence(settings, binding);
    return await acknowledge(supabase, binding);
  } catch { throw unavailable(); }
}

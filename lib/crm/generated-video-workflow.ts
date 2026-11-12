import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasPermission } from "../auth/permissions";
import { getSupabaseServerClient } from "../supabase/server";
import { generatedVideoIdentity } from "./generated-video-identity";
import type { VideoRequestLifetime } from "../content-studio/video-request-lifetime";

type Row = Record<string, unknown>;
export type GeneratedVideoActor = { workspaceId: string; staffUserId: string; userId: string };
export type GeneratedVideoWorkflowActor = GeneratedVideoActor;
export type GeneratedVideoWorkflowConfig = {
  supabase: SupabaseClient; origin: string; serviceRoleKey: string;
  enabled: boolean; rawBucket: string; outputBucket: string;
  requestLifetime?: VideoRequestLifetime;
};
export type GeneratedVideoAsset = {
  id: string; workspaceId: string; fileName: string; fileType: "video"; mimeType: "video/mp4";
  fileSize: number; storageBucket: string; storagePath: string; publicUrl: string; status: "ready";
  sha256: string; thumbnailUrl: string; thumbnailPath: string; thumbnailSize: number; thumbnailSha256: string;
};
export type GeneratedVideoReceipt = {
  assetId: string; validationJobId: string; nativeValidated: true; fileName: string; mimeType: "video/mp4";
  fileSize: number; storageBucket: string; storagePath: string; creativeUrl: string; sha256: string;
  thumbnailUrl: string; thumbnailPath: string; thumbnailSize: number; thumbnailSha256: string;
};
export type GeneratedVideoWorkflowState = {
  status: "reserved" | "dispatching" | "rendering" | "awaiting_upload" | "queued" | "processing" | "failed" | "ready" | "cancelled";
  generationKey: string; requestDigest: string | null; providerJobId: string | null;
  validationJobId: string | null; progress: number; needInput: boolean;
  result: GeneratedVideoReceipt | null;
  asset?: GeneratedVideoAsset; nativeValidated?: true; failureCode?: string; dispatchAccepted?: boolean;
};
export class GeneratedVideoWorkflowError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const PRIVATE_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const STATUSES = new Set(["reserved", "dispatching", "rendering", "awaiting_upload", "queued", "ready", "failed", "cancelled"]);
const JOB_STATUSES = new Set(["awaiting_upload", "queued", "downloading", "transcoding", "uploading", "ready", "failed", "deleted_original"]);
const unavailable = () => new GeneratedVideoWorkflowError(503, "generated_video_unconfirmed");
const invalid = () => new GeneratedVideoWorkflowError(400, "generated_video_request_invalid");
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const nullableString = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0);
const validTime = (value: unknown): boolean => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const size = (value: unknown, max = MAX_INPUT_BYTES): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
const hash = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
type Envelope = { operation: Row; job: Row | null; asset: Row | null; dispatchAccepted?: boolean };

function terminalProviderFailure(op: Row): boolean {
  if (op.provider_failure_receipt == null) return false;
  const proof = object(op.provider_failure_receipt);
  const fields = ["kind", "provider", "status", "providerJobId", "generationKey", "requestDigest", "keyDigest", "acknowledgedAt", "staffUserId", "authUserId"];
  if (Object.keys(proof).length !== fields.length || fields.some(field => !Object.hasOwn(proof, field))
    || proof.kind !== "provider-terminal-failure-v1" || proof.provider !== "openai" || proof.status !== "failed"
    || proof.providerJobId !== op.provider_job_id || proof.generationKey !== op.generation_key
    || proof.requestDigest !== op.request_digest || proof.keyDigest !== op.key_digest || !validTime(proof.acknowledgedAt)
    || typeof proof.staffUserId !== "string" || !UUID.test(proof.staffUserId)
    || typeof proof.authUserId !== "string" || !UUID.test(proof.authUserId)
    || op.status !== "cancelled" || typeof op.provider_job_id !== "string" || !op.provider_job_id
    || op.input_size !== null || op.input_sha256 !== null || op.raw_bucket !== null || op.raw_path !== null || op.result !== null
    || (String(op.generation_key).startsWith("v2:") && op.dispatch_id === null)) throw unavailable();
  return true;
}

/** Read at call time; importing this module never initializes a client or an external connection. */
export function generatedVideoWorkflowConfig(): GeneratedVideoWorkflowConfig {
  const supabase = getSupabaseServerClient();
  if (!supabase) throw unavailable();
  const config: GeneratedVideoWorkflowConfig = {
    supabase, origin: (process.env.SUPABASE_URL || "").trim().replace(/\/$/, ""),
    serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    enabled: ["true", "1", "yes", "on"].includes((process.env.VIDEO_OPTIMIZATION_ENABLED || "").trim().toLowerCase()),
    rawBucket: (process.env.VIDEO_OPTIMIZATION_RAW_BUCKET || "ad-creatives-raw").trim(),
    outputBucket: (process.env.VIDEO_OPTIMIZATION_OUTPUT_BUCKET || "ad-creatives").trim(),
  };
  validateConfig(config);
  return config;
}

function validateConfig(config: GeneratedVideoWorkflowConfig): void {
  try {
    const url = new URL(config.origin);
    if (url.protocol !== "https:" || url.origin !== config.origin || url.username || url.password
      || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(url.host) || typeof config.serviceRoleKey !== "string"
      || config.serviceRoleKey.length < 32 || config.serviceRoleKey.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(config.serviceRoleKey)
      || typeof config.enabled !== "boolean" || !BUCKET.test(config.rawBucket) || config.rawBucket === "ad-creatives"
      || config.outputBucket !== "ad-creatives" || !config.supabase) throw new Error();
  } catch { throw unavailable(); }
}

function actorArgs(actor: GeneratedVideoActor): Row {
  if (![actor.workspaceId, actor.staffUserId, actor.userId].every(value => typeof value === "string" && UUID.test(value))) {
    throw new GeneratedVideoWorkflowError(403, "generated_video_access_denied");
  }
  return { p_workspace_id: actor.workspaceId, p_staff_user_id: actor.staffUserId, p_auth_user_id: actor.userId };
}

function identity(actor: GeneratedVideoActor, key: string) {
  actorArgs(actor);
  try { return generatedVideoIdentity({ workspaceId: actor.workspaceId, generationKey: key }); }
  catch { throw invalid(); }
}

async function bounded<T>(config: GeneratedVideoWorkflowConfig, operation: () => PromiseLike<T>): Promise<T> {
  if (config.requestLifetime) return config.requestLifetime.run(operation, 20_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function knownError(error: unknown): GeneratedVideoWorkflowError | null {
  const code = object(error).code;
  const codes: Record<string, [number, string]> = {
    P9001: [400, "generated_video_request_invalid"], P9002: [409, "generated_video_request_conflict"],
    P9003: [409, "generated_video_unavailable"], P9004: [403, "generated_video_access_denied"],
    P9005: [429, "generated_video_capacity_exhausted"], "42501": [403, "generated_video_access_denied"],
  };
  return typeof code === "string" && Object.hasOwn(codes, code) ? new GeneratedVideoWorkflowError(...codes[code]!) : null;
}

async function rpc(config: GeneratedVideoWorkflowConfig, name: string, args: Row): Promise<unknown> {
  // Only identical arguments reconcile an uncertain acknowledgement. A second
  // dispatch nonce or generation key would be a new paid action, not a retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await bounded(config, () => config.supabase.rpc(name, args));
      if (error) throw knownError(error) || unavailable();
      return data;
    } catch (error) { if (error instanceof GeneratedVideoWorkflowError && error.status !== 503) throw error; }
  }
  throw unavailable();
}

async function liveActor(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor): Promise<void> {
  actorArgs(actor);
  let row: Row;
  try {
    const { data, error } = await bounded(config, () => config.supabase.from("staff_users").select("id,workspace_id,auth_user_id,role,status")
      .eq("id", actor.staffUserId).eq("workspace_id", actor.workspaceId).eq("auth_user_id", actor.userId).maybeSingle());
    if (error) throw unavailable();
    row = object(data);
  } catch { throw unavailable(); }
  if (row.id !== actor.staffUserId || row.workspace_id !== actor.workspaceId || row.auth_user_id !== actor.userId || row.status !== "active"
    || !hasPermission(typeof row.role === "string" ? row.role : null, "manage_marketing")) {
    throw new GeneratedVideoWorkflowError(403, "generated_video_access_denied");
  }
}

async function privateBucket(config: GeneratedVideoWorkflowConfig): Promise<void> {
  try {
    const { data, error } = await bounded(config, () => config.supabase.storage.getBucket(config.rawBucket));
    const row = object(data);
    if (error || row.id !== config.rawBucket || (row.name !== undefined && row.name !== config.rawBucket) || row.public !== false
      || !size(row.file_size_limit, 500 * 1024 * 1024) || row.file_size_limit < MAX_INPUT_BYTES
      || !Array.isArray(row.allowed_mime_types) || !row.allowed_mime_types.includes("video/mp4")
      || row.allowed_mime_types.some(mime => typeof mime !== "string" || !PRIVATE_MIMES.has(mime))
      || (Object.hasOwn(row, "versioning_status") && row.versioning_status !== "disabled")) throw unavailable();
    // Older Storage versions omit versioning_status; physical version retention
    // still requires separate backend acceptance, never an inferred deletion.
  } catch { throw new GeneratedVideoWorkflowError(503, "generated_video_private_bucket_unconfirmed"); }
}

async function publicBucket(config: GeneratedVideoWorkflowConfig): Promise<void> {
  try {
    const { data, error } = await bounded(config, () => config.supabase.storage.getBucket(config.outputBucket));
    const row = object(data);
    if (error || row.id !== config.outputBucket || row.public !== true || !size(row.file_size_limit) || row.file_size_limit < MAX_INPUT_BYTES
      || !Array.isArray(row.allowed_mime_types) || !row.allowed_mime_types.includes("video/mp4")
      || !row.allowed_mime_types.includes("image/jpeg")) throw unavailable();
  } catch { throw new GeneratedVideoWorkflowError(503, "generated_video_output_bucket_unconfirmed"); }
}

function envelope(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, value: unknown): Envelope {
  const body = object(value), op = object(body.operation), expected = identity(actor, key);
  if (op.workspace_id !== actor.workspaceId || op.generation_key !== key || op.key_digest !== expected.keyDigest
    || op.asset_id !== expected.assetId || op.file_name !== expected.fileName || typeof op.job_id !== "string" || !UUID4.test(op.job_id)
    || typeof op.status !== "string" || !STATUSES.has(op.status) || !nullableString(op.provider_job_id) || !nullableString(op.dispatch_id)
    || (op.dispatch_id !== null && !UUID4.test(String(op.dispatch_id))) || !validTime(op.reserved_until)
    || !validTime(op.created_at) || !validTime(op.updated_at)
    || typeof op.created_by_staff_user_id !== "string" || !UUID.test(op.created_by_staff_user_id)
    || typeof op.created_by_auth_user_id !== "string" || !UUID.test(op.created_by_auth_user_id)
    || (key.startsWith("v2:") ? !hash(op.request_digest) : op.request_digest !== null)
    || (op.provider_job_id !== null && (String(op.provider_job_id).length > 512 || String(op.provider_job_id).trim() !== op.provider_job_id
      || /[\u0000-\u001f\u007f]/.test(String(op.provider_job_id))))
    || (!key.startsWith("v2:") && op.provider_job_id !== key)
    || (!key.startsWith("v2:") && op.dispatch_id !== null)
    || (key.startsWith("v2:") && !["reserved", "cancelled"].includes(op.status) && op.dispatch_id === null)
    || (op.status === "reserved" && (op.dispatch_id !== null || op.provider_job_id !== null))
    || (op.status === "dispatching" && (op.dispatch_id === null || op.provider_job_id !== null))
    || (["rendering", "awaiting_upload", "queued", "ready", "failed"].includes(op.status) && op.provider_job_id === null)
    || (op.status !== "ready" && op.result !== null)) throw unavailable();
  const hasInput = op.input_size !== null;
  const job = body.job === null ? null : object(body.job), asset = body.asset === null ? null : object(body.asset);
  if (hasInput) {
    if (!size(op.input_size) || !hash(op.input_sha256) || op.raw_bucket !== config.rawBucket || op.raw_path !== expected.rawPath
      || !job || !asset || job.id !== op.job_id || job.workspace_id !== actor.workspaceId || job.asset_id !== expected.assetId
      || typeof job.status !== "string" || !JOB_STATUSES.has(job.status) || !Number.isSafeInteger(job.progress) || Number(job.progress) < 0 || Number(job.progress) > 100
      || job.raw_bucket !== op.raw_bucket || job.raw_path !== op.raw_path || job.raw_size !== op.input_size
      || job.source_file_name !== expected.fileName || job.source_mime_type !== "video/mp4"
      || job.output_bucket !== config.outputBucket || job.optimized_bucket !== config.outputBucket
      || object(job.metadata).kind !== "generated-video-native" || object(job.metadata).inputSha256 !== op.input_sha256
      || object(job.metadata).generationKey !== key || (job.raw_public_url !== null && job.raw_public_url !== undefined)
      || asset.id !== expected.assetId || asset.workspace_id !== actor.workspaceId || asset.file_name !== expected.fileName
      || asset.file_type !== "video" || asset.mime_type !== "video/mp4" || !validTime(asset.updated_at)
      || !["uploaded", "ready", "optimization_failed"].includes(String(asset.status))
      || object(asset.metadata).generationKey !== key) throw unavailable();
    if (job.status !== "ready" && (asset.generated_key !== null || asset.generated_sha256 !== null || asset.generated_video_job_id !== null
      || asset.storage_bucket !== config.rawBucket || asset.storage_path !== expected.rawPath || asset.file_size !== op.input_size
      || asset.public_url !== null || object(asset.metadata).kind !== "generated-video-pending"
      || object(asset.metadata).uploadMode !== "native-generated-pending" || object(asset.metadata).contentSha256 !== op.input_sha256)) throw unavailable();
    if (op.status === "awaiting_upload" && job.status !== "awaiting_upload") throw unavailable();
    if (["queued", "ready", "failed"].includes(op.status) && job.status === "awaiting_upload") throw unavailable();
    if (op.status === "ready" && job.status !== "ready") throw unavailable();
  } else if (op.input_sha256 !== null || op.raw_bucket !== null || op.raw_path !== null || job !== null || asset !== null
    || !["reserved", "dispatching", "rendering", "cancelled"].includes(op.status)) throw unavailable();
  const providerFailed = terminalProviderFailure(op);
  if (op.status === "cancelled" && op.provider_job_id !== null && !providerFailed) throw unavailable();
  if (body.dispatchAccepted !== undefined && typeof body.dispatchAccepted !== "boolean") throw unavailable();
  return { operation: op, job, asset, ...(body.dispatchAccepted === undefined ? {} : { dispatchAccepted: body.dispatchAccepted as boolean }) };
}

function normalize(value: Envelope): GeneratedVideoWorkflowState {
  const op = value.operation, job = value.job;
  let status = op.status as GeneratedVideoWorkflowState["status"];
  if (job?.status === "failed" || job?.status === "deleted_original") status = "failed";
  else if (["downloading", "transcoding", "uploading"].includes(String(job?.status))) status = "processing";
  else if (job?.status === "queued" || job?.status === "ready") status = "queued";
  // A SQL ready row alone is not a delivery receipt: the public bytes must be
  // checked in resume before exposing either asset identity or a URL.
  if (op.status === "ready") status = "queued";
  return { status, generationKey: String(op.generation_key), requestDigest: op.request_digest as string | null,
    providerJobId: op.provider_job_id as string | null, validationJobId: job ? String(op.job_id) : null,
    progress: job ? Math.min(95, Number(job.progress)) : 0, result: null,
    needInput: status === "rendering" || status === "awaiting_upload",
    ...(terminalProviderFailure(op) ? { failureCode: "generated_video_provider_failed" } : {}),
    ...(status === "failed" ? { failureCode: "generated_video_validation_failed" } : {}),
    ...(value.dispatchAccepted === undefined ? {} : { dispatchAccepted: value.dispatchAccepted }) };
}

async function readEnvelope(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string): Promise<Envelope | null> {
  validateConfig(config); identity(actor, key);
  const value = await rpc(config, "read_generated_video_workflow", { ...actorArgs(actor), p_generation_key: key });
  return value === null ? null : envelope(config, actor, key, value);
}

export async function readGeneratedVideoWorkflow(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string): Promise<GeneratedVideoWorkflowState | null> {
  const value = await readEnvelope(config, actor, key);
  return value ? normalize(value) : null;
}

export async function requireGeneratedVideoWorkflowReady(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor): Promise<void> {
  validateConfig(config); actorArgs(actor);
  if (!config.enabled) throw new GeneratedVideoWorkflowError(409, "generated_video_native_worker_required");
  await liveActor(config, actor);
  await privateBucket(config);
  await publicBucket(config);
  // Read-only schema/authorization probe, before admission, quota or provider.
  await readEnvelope(config, actor, "v2:00000000-0000-4000-8000-000000000000");
}

export async function admitGeneratedVideoWorkflow(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, input: {
  generationKey: string; requestDigest: string | null; providerJobId?: string | null;
}): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config);
  const expected = identity(actor, input.generationKey);
  if (input.generationKey.startsWith("v2:") ? !hash(input.requestDigest) || input.providerJobId != null
    : input.requestDigest !== null || input.providerJobId !== input.generationKey) throw invalid();
  await requireGeneratedVideoWorkflowReady(config, actor);
  const reply = envelope(config, actor, input.generationKey, await rpc(config, "admit_generated_video_workflow", {
    ...actorArgs(actor), p_generation_key: input.generationKey, p_request_digest: input.requestDigest,
    p_key_digest: expected.keyDigest, p_asset_id: expected.assetId, p_file_name: expected.fileName, p_provider_job_id: input.providerJobId ?? null,
  }));
  if (reply.operation.request_digest !== input.requestDigest || (input.providerJobId && reply.operation.provider_job_id !== input.providerJobId)) throw unavailable();
  return normalize(reply);
}

export async function beginGeneratedVideoDispatch(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, dispatchId: string,
  quota: { usageId: string; requestDigest: string; units: number; limit: number; model: string }): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config); identity(actor, key);
  if (typeof dispatchId !== "string" || !UUID4.test(dispatchId) || !quota || typeof quota.usageId !== "string" || !UUID.test(quota.usageId)
    || !hash(quota.requestDigest) || !Number.isSafeInteger(quota.units) || quota.units < 1 || quota.units > 3600
    || !Number.isSafeInteger(quota.limit) || quota.limit < quota.units || quota.limit > 2_147_483_647
    || typeof quota.model !== "string" || !quota.model || quota.model.length > 120 || quota.model.trim() !== quota.model
    || /[\u0000-\u001f\u007f]/.test(quota.model)) throw invalid();
  if (!config.enabled) throw new GeneratedVideoWorkflowError(409, "generated_video_native_worker_required");
  const reply = envelope(config, actor, key, await rpc(config, "begin_generated_video_dispatch_with_usage", {
    ...actorArgs(actor), p_generation_key: key, p_dispatch_id: dispatchId,
    p_usage_id: quota.usageId, p_request_digest: quota.requestDigest, p_units: quota.units, p_limit_units: quota.limit, p_model: quota.model,
  }));
  if (reply.operation.quota_usage_id !== quota.usageId || reply.operation.request_digest !== quota.requestDigest
    || typeof reply.dispatchAccepted !== "boolean" || (reply.dispatchAccepted && (reply.operation.status !== "dispatching" || reply.operation.dispatch_id !== dispatchId))) throw unavailable();
  return normalize(reply);
}

export async function linkGeneratedVideoProvider(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, dispatchId: string, providerJobId: string): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config); identity(actor, key);
  if (typeof dispatchId !== "string" || !UUID4.test(dispatchId) || typeof providerJobId !== "string" || !providerJobId.length
    || providerJobId.length > 512 || providerJobId.trim() !== providerJobId || /[\u0000-\u001f\u007f]/.test(providerJobId)) throw invalid();
  const reply = envelope(config, actor, key, await rpc(config, "link_generated_video_provider", {
    ...actorArgs(actor), p_generation_key: key, p_dispatch_id: dispatchId, p_provider_job_id: providerJobId,
  }));
  if (reply.operation.dispatch_id !== dispatchId || reply.operation.provider_job_id !== providerJobId) throw unavailable();
  return normalize(reply);
}

export async function cancelGeneratedVideoWorkflow(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, dispatchId?: string | null, knownFailure = false): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config); identity(actor, key);
  if ((dispatchId != null && (typeof dispatchId !== "string" || !UUID4.test(dispatchId))) || typeof knownFailure !== "boolean") throw invalid();
  const reply = envelope(config, actor, key, await rpc(config, "cancel_generated_video_workflow", {
    ...actorArgs(actor), p_generation_key: key, p_dispatch_id: dispatchId ?? null, p_known_failure: knownFailure,
  }));
  if (reply.operation.status !== "cancelled") throw unavailable();
  return normalize(reply);
}

/** Call only after an authenticated provider GET returns failed for the signed, already-linked job. */
export async function ackGeneratedVideoProviderFailure(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string,
  providerJob: { id: string; status: "failed" }): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config); identity(actor, key);
  if (!providerJob || providerJob.status !== "failed" || typeof providerJob.id !== "string"
    || providerJob.id.length < 1 || providerJob.id.length > 512 || providerJob.id.trim() !== providerJob.id
    || /[\u0000-\u001f\u007f]/.test(providerJob.id)) throw invalid();
  const providerJobId = providerJob.id;
  await liveActor(config, actor);
  const reply = envelope(config, actor, key, await rpc(config, "ack_generated_video_provider_failure", {
    ...actorArgs(actor), p_generation_key: key, p_provider_job_id: providerJobId, p_provider_status: "failed",
  }));
  if (!terminalProviderFailure(reply.operation) || reply.operation.provider_job_id !== providerJobId) throw unavailable();
  await liveActor(config, actor);
  return normalize(reply);
}

async function proveBytes(config: GeneratedVideoWorkflowConfig, input: {
  path: string; bucket: string; mimeType: string; size: number; sha256: string; private: boolean; allowAbsent?: boolean;
}): Promise<boolean> {
  validateConfig(config);
  if (!size(input.size, input.mimeType === "image/jpeg" ? MAX_THUMBNAIL_BYTES : MAX_INPUT_BYTES) || !hash(input.sha256)
    || (input.private ? input.bucket !== config.rawBucket : input.bucket !== config.outputBucket)
    || !/^[a-z0-9/._-]+$/.test(input.path) || input.path.split("/").some(part => !part || part === "." || part === "..")) throw unavailable();
  const url = `${config.origin}/storage/v1/object/${input.private ? "" : "public/"}${input.bucket}/${input.path}`;
  config.requestLifetime?.assertActive();
  const controller = new AbortController();
  const abort = () => controller.abort();
  config.requestLifetime?.signal.addEventListener("abort", abort, { once: true });
  const wait = <T>(operation: () => PromiseLike<T>) => config.requestLifetime ? config.requestLifetime.run(operation) : operation();
  let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 10_000);
  });
  try {
    const pending = fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      ...(input.private ? { headers: { Authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey } } : {}) });
    void pending.then(response => {
      if (controller.signal.aborted) { try { void response.body?.cancel().catch(() => {}); } catch { /* Late body cleanup is best effort. */ } }
    }, () => {});
    const response = await wait(() => Promise.race([pending, deadline]));
    reader = response.body?.getReader();
    if (response.redirected || (response.url && response.url !== url)) throw unavailable();
    // Only a definite HTTP 404 is absence. Unknown SDK/network/body failures
    // never permit another private upload or a paid rerender.
    if (input.allowAbsent && response.status === 404) return false;
    const length = response.headers.get("content-length");
    if (response.status !== 200 || !reader || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== input.mimeType
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== input.size))) throw unavailable();
    const digest = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const part = await wait(() => Promise.race([reader!.read(), deadline]));
      if (part.done) break;
      if (!part.value.byteLength) throw unavailable();
      bytes += part.value.byteLength;
      if (bytes > input.size) throw unavailable();
      digest.update(part.value);
    }
    if (bytes !== input.size || digest.digest("hex") !== input.sha256) throw unavailable();
    return true;
  } catch { throw unavailable(); }
  finally {
    if (timer) clearTimeout(timer);
    config.requestLifetime?.signal.removeEventListener("abort", abort);
    controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* Never await a stalled cleanup. */ } }
  }
}

function privateProof(config: GeneratedVideoWorkflowConfig, value: Envelope, allowAbsent = false): Promise<boolean> {
  const op = value.operation;
  return proveBytes(config, { path: String(op.raw_path), bucket: String(op.raw_bucket), mimeType: "video/mp4",
    size: Number(op.input_size), sha256: String(op.input_sha256), private: true, allowAbsent });
}

function promotion(config: GeneratedVideoWorkflowConfig, value: Envelope): Row {
  const op = value.operation, job = value.job!, asset = value.asset!;
  const proof = object(job.promotion_receipt), result = object(proof.result);
  const exactFields = ["storage_origin", "storage_bucket", "storage_path", "public_url", "file_size", "sha256",
    "thumbnail_path", "thumbnail_public_url", "thumbnail_size", "thumbnail_sha256", "input_size"];
  const path = typeof result.storage_path === "string" ? result.storage_path : "";
  if (job.status !== "ready" || asset.status !== "ready" || Object.keys(proof).length !== 2 || !validTime(proof.asset_version)
    || Object.keys(result).length !== exactFields.length || exactFields.some(field => !Object.hasOwn(result, field))
    || result.storage_origin !== config.origin || result.storage_bucket !== config.outputBucket
    || !new RegExp(`^optimized/${op.workspace_id}/${op.job_id}-[0-9a-f]{20}\\.mp4$`).test(path)
    || result.thumbnail_path !== path.slice(0, -4) + "-thumbnail.jpg"
    || result.public_url !== `${config.origin}/storage/v1/object/public/${config.outputBucket}/${path}`
    || result.thumbnail_public_url !== `${config.origin}/storage/v1/object/public/${config.outputBucket}/${result.thumbnail_path}`
    || !size(result.file_size) || !size(result.thumbnail_size, MAX_THUMBNAIL_BYTES) || !hash(result.sha256) || !hash(result.thumbnail_sha256)
    || result.input_size !== op.input_size || asset.file_size !== result.file_size || asset.storage_bucket !== result.storage_bucket
    || asset.storage_path !== path || asset.public_url !== result.public_url || object(asset.metadata).optimized !== true
    || object(asset.metadata).optimizationStatus !== "ready" || object(asset.metadata).contentSha256 !== result.sha256
    || object(asset.metadata).thumbnailUrl !== result.thumbnail_public_url || object(asset.metadata).thumbnailSource !== "worker"
    || object(asset.metadata).thumbnailMimeType !== "image/jpeg" || object(asset.metadata).inputSizeBytes !== op.input_size
    || object(asset.metadata).outputSizeBytes !== result.file_size
    || job.output_path !== path || job.optimized_path !== path || job.output_public_url !== result.public_url || job.optimized_public_url !== result.public_url
    || job.output_size !== result.file_size || job.output_size_bytes !== result.file_size || job.input_size_bytes !== op.input_size
    || job.output_mime_type !== "video/mp4" || job.input_mime_type !== "video/mp4" || job.thumbnail_path !== result.thumbnail_path
    || job.thumbnail_public_url !== result.thumbnail_public_url || job.thumbnail_url !== result.thumbnail_public_url || job.progress !== 100) throw unavailable();
  return result;
}

function delivery(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, value: Envelope, proof: Row): GeneratedVideoWorkflowState {
  const op = value.operation, asset = value.asset!, result = object(op.result);
  const expected = { assetId: op.asset_id, validationJobId: op.job_id, nativeValidated: true, fileName: op.file_name, mimeType: "video/mp4",
    fileSize: proof.file_size, storageBucket: proof.storage_bucket, storagePath: proof.storage_path, creativeUrl: proof.public_url, sha256: proof.sha256,
    thumbnailUrl: proof.thumbnail_public_url, thumbnailPath: proof.thumbnail_path, thumbnailSize: proof.thumbnail_size, thumbnailSha256: proof.thumbnail_sha256 };
  if (op.status !== "ready" || Object.keys(result).length !== Object.keys(expected).length
    || Object.entries(expected).some(([field, v]) => result[field] !== v)
    || asset.generated_key !== identity(actor, key).generatedKey || asset.generated_sha256 !== proof.sha256 || asset.generated_video_job_id !== op.job_id
    || object(asset.metadata).uploadMode !== "ai-generated" || object(asset.metadata).kind !== "generated-video"
    || object(asset.metadata).jobId !== key || object(asset.metadata).nativeValidated !== true) throw unavailable();
  promotion(config, value);
  const receipt: GeneratedVideoReceipt = { assetId: String(op.asset_id), validationJobId: String(op.job_id), nativeValidated: true,
    fileName: String(op.file_name), mimeType: "video/mp4", fileSize: Number(proof.file_size), storageBucket: String(proof.storage_bucket),
    storagePath: String(proof.storage_path), creativeUrl: String(proof.public_url), sha256: String(proof.sha256),
    thumbnailUrl: String(proof.thumbnail_public_url), thumbnailPath: String(proof.thumbnail_path),
    thumbnailSize: Number(proof.thumbnail_size), thumbnailSha256: String(proof.thumbnail_sha256) };
  return { ...normalize(value), status: "ready", needInput: false, progress: 100, nativeValidated: true, result: receipt,
    asset: { id: String(op.asset_id), workspaceId: actor.workspaceId, fileName: String(op.file_name), fileType: "video", mimeType: "video/mp4",
      fileSize: Number(proof.file_size), storageBucket: String(proof.storage_bucket), storagePath: String(proof.storage_path), publicUrl: String(proof.public_url),
      status: "ready", sha256: String(proof.sha256), thumbnailUrl: String(proof.thumbnail_public_url), thumbnailPath: String(proof.thumbnail_path),
      thumbnailSize: Number(proof.thumbnail_size), thumbnailSha256: String(proof.thumbnail_sha256) } };
}

async function resumeEnvelope(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, value: Envelope): Promise<GeneratedVideoWorkflowState> {
  if (value.job?.status === "ready") {
    const proof = promotion(config, value);
    await proveBytes(config, { bucket: String(proof.storage_bucket), path: String(proof.storage_path), mimeType: "video/mp4",
      size: Number(proof.file_size), sha256: String(proof.sha256), private: false });
    await proveBytes(config, { bucket: String(proof.storage_bucket), path: String(proof.thumbnail_path), mimeType: "image/jpeg",
      size: Number(proof.thumbnail_size), sha256: String(proof.thumbnail_sha256), private: false });
    // The final RPC rechecks current access and the exact 086 receipt under row
    // locks, even for replay; a role withdrawal during either GET cannot leak it.
    const final = envelope(config, actor, key, await rpc(config, "finalize_generated_video_workflow", { ...actorArgs(actor), p_generation_key: key }));
    await liveActor(config, actor);
    return delivery(config, actor, key, final, proof);
  }
  if (value.operation.status === "awaiting_upload") {
    if (!config.enabled) throw new GeneratedVideoWorkflowError(409, "generated_video_native_worker_required");
    await privateBucket(config);
    if (await privateProof(config, value, true)) {
      const queued = envelope(config, actor, key, await rpc(config, "queue_generated_video_workflow", { ...actorArgs(actor), p_generation_key: key }));
      return queued.job?.status === "ready" ? resumeEnvelope(config, actor, key, queued) : normalize(queued);
    }
    await liveActor(config, actor);
  }
  return normalize(value);
}

export async function resumeGeneratedVideoWorkflow(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string): Promise<GeneratedVideoWorkflowState> {
  const value = await readEnvelope(config, actor, key);
  if (!value) throw new GeneratedVideoWorkflowError(404, "generated_video_not_found");
  return resumeEnvelope(config, actor, key, value);
}

export async function receiveGeneratedVideoInput(config: GeneratedVideoWorkflowConfig, actor: GeneratedVideoActor, key: string, buffer: Buffer): Promise<GeneratedVideoWorkflowState> {
  validateConfig(config); identity(actor, key);
  if (!Buffer.isBuffer(buffer) || !size(buffer.length)) throw invalid();
  // Copy synchronously before the first await so the binding cannot describe
  // different bytes from those subsequently handed to the private uploader.
  const bytes = Buffer.from(buffer), sha256 = createHash("sha256").update(bytes).digest("hex");
  const prior = await readEnvelope(config, actor, key);
  if (!prior) throw new GeneratedVideoWorkflowError(404, "generated_video_not_found");
  if (prior.operation.input_size !== null && (prior.operation.input_size !== bytes.length || prior.operation.input_sha256 !== sha256)) {
    throw new GeneratedVideoWorkflowError(409, "generated_video_input_conflict");
  }
  if (!["rendering", "awaiting_upload"].includes(String(prior.operation.status))) return resumeEnvelope(config, actor, key, prior);
  await requireGeneratedVideoWorkflowReady(config, actor);
  const bound = envelope(config, actor, key, await rpc(config, "bind_generated_video_input", { ...actorArgs(actor), p_generation_key: key,
    p_input_size: bytes.length, p_input_sha256: sha256, p_raw_bucket: config.rawBucket }));
  if (bound.operation.input_size !== bytes.length || bound.operation.input_sha256 !== sha256) throw unavailable();
  if (bound.operation.status !== "awaiting_upload") return resumeEnvelope(config, actor, key, bound);
  const present = await privateProof(config, bound, true);
  if (!present) {
    await liveActor(config, actor);
    try {
      const reply = await bounded(config, () => config.supabase.storage.from(config.rawBucket).upload(String(bound.operation.raw_path), bytes,
        { contentType: "video/mp4", upsert: false }));
      if (reply.error || reply.data?.path !== bound.operation.raw_path) throw unavailable();
    } catch { /* The exact immutable private GET, not the upload ACK, decides whether queueing is safe. */ }
    await privateProof(config, bound);
  }
  const queued = envelope(config, actor, key, await rpc(config, "queue_generated_video_workflow", { ...actorArgs(actor), p_generation_key: key }));
  return queued.job?.status === "ready" ? resumeEnvelope(config, actor, key, queued) : normalize(queued);
}

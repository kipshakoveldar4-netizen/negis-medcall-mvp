import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasPermission } from "../auth/permissions";
import { CreativeImageValidationUnavailable, normalizeCreativeImageBytes } from "./creative-image";
import { verifyGeneratedStorageBytes } from "./generated-storage-verification";
import { issueStagedCreativeTicket, readStagedCreativeTicket, sealStagedCreativeTicket, verifiedCreativeIdentity,
  type StagedCreativeActor, type StagedCreativeTicket } from "./staged-creative-ticket";
import { prepareOrResumeStagedCreativeUpload, readAndNormalizeStagedCreativeImage, StagedCreativeStorageError,
  type StagedCreativeStorageConfig } from "./staged-creative-storage";
import { reclaimStagedCreativeUploads } from "./staged-creative-reclamation";

type Row = Record<string, unknown>;
export type CreativeUploadWorkflowConfig = Omit<StagedCreativeStorageConfig, "supabase"> & { supabase: SupabaseClient };
export class CreativeUploadWorkflowError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const unavailable = () => new CreativeUploadWorkflowError(503, "creative_upload_unconfirmed");
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

async function bounded<T>(fn: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable()), 20_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

function businessError(error: unknown): CreativeUploadWorkflowError | null {
  const codes: Record<string, [number, string]> = { P8801: [400, "creative_upload_invalid"], P8802: [409, "creative_upload_request_conflict"],
    P8803: [409, "creative_upload_unavailable"], P8804: [403, "creative_upload_access_denied"], P8805: [429, "creative_upload_capacity_exhausted"] };
  const code = object(error).code;
  const mapped = typeof code === "string" && Object.hasOwn(codes, code) ? codes[code] : null;
  return mapped ? new CreativeUploadWorkflowError(...mapped) : null;
}

async function rpc(config: CreativeUploadWorkflowConfig, name: string, args: Row): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await bounded(() => config.supabase.rpc(name, args));
      if (error) { const denied = businessError(error); if (denied) throw denied; throw unavailable(); }
      return data;
    } catch (error) { if (error instanceof CreativeUploadWorkflowError && error.status !== 503) throw error; }
  }
  throw unavailable();
}

function actorArgs(actor: StagedCreativeActor): Row {
  return { p_workspace_id: actor.workspaceId, p_staff_user_id: actor.staffUserId, p_auth_user_id: actor.userId };
}

export async function requireLiveCreativeUploadActor(config: CreativeUploadWorkflowConfig, actor: StagedCreativeActor): Promise<void> {
  let row: Row;
  try {
    const { data, error } = await bounded(() => config.supabase.from("staff_users").select("id,workspace_id,auth_user_id,role,status")
      .eq("id", actor.staffUserId).eq("workspace_id", actor.workspaceId).eq("auth_user_id", actor.userId).maybeSingle());
    if (error) throw unavailable(); row = object(data);
  } catch { throw unavailable(); }
  if (row.id !== actor.staffUserId || row.workspace_id !== actor.workspaceId || row.auth_user_id !== actor.userId
    || row.status !== "active" || !hasPermission(typeof row.role === "string" ? row.role : null, "manage_marketing")) {
    throw new CreativeUploadWorkflowError(403, "creative_upload_access_denied");
  }
}

export async function reserveCreativeUpload(config: CreativeUploadWorkflowConfig, input: StagedCreativeActor & {
  requestKey: string; fileName: string; mimeType: string; fileSize: number;
}, source: "signed" | "inline" = "signed"): Promise<{ ticket: StagedCreativeTicket; status: "reserved" | "finalized" }> {
  if (!uuid4.test(input.requestKey)) throw new CreativeUploadWorkflowError(400, "creative_upload_request_key_required");
  // Validate all metadata before the admission RPC; the actual nonce/time comes from that RPC.
  issueStagedCreativeTicket(input, config.serviceRoleKey);
  if (!input.mimeType.startsWith("image/")) throw new CreativeUploadWorkflowError(409, "creative_video_worker_required");
  const args = { ...actorArgs(input), p_request_key: input.requestKey,
    p_file_name: input.fileName, p_mime_type: input.mimeType, p_file_size: input.fileSize, p_source: source };
  let result: Row;
  try { result = object(await rpc(config, "reserve_creative_upload", args)); }
  catch (error) {
    if (!(error instanceof CreativeUploadWorkflowError) || error.code !== "creative_upload_capacity_exhausted") throw error;
    await requireLiveCreativeUploadActor(config, input);
    try { await reclaimStagedCreativeUploads(config, input.workspaceId); }
    catch { /* A lost cleanup ACK is reconciled by the exact same admission, never a new key. */ }
    result = object(await rpc(config, "reserve_creative_upload", args));
  }
  const ticket = object(result.ticket) as unknown as StagedCreativeTicket;
  try {
    const verified = readStagedCreativeTicket(sealStagedCreativeTicket(ticket, config.serviceRoleKey), input, config.serviceRoleKey);
    if (result.requestKey !== input.requestKey.toLowerCase() || !["reserved", "finalized"].includes(String(result.status))
      || verified.fileName !== input.fileName || verified.mimeType !== input.mimeType || verified.fileSize !== input.fileSize) throw unavailable();
    return { ticket: verified, status: result.status as "reserved" | "finalized" };
  } catch { throw unavailable(); }
}

export async function prepareCreativeImageUpload(config: CreativeUploadWorkflowConfig, input: StagedCreativeActor & {
  requestKey: string; fileName: string; mimeType: string; fileSize: number;
}) {
  const { ticket, status } = await reserveCreativeUpload(config, input);
  await requireLiveCreativeUploadActor(config, input);
  if (status === "finalized") {
    const row = await operation(config, ticket, "signed"), asset = await replay(config, ticket, row);
    if (!asset) throw unavailable();
    const receipt = { id: asset.id, workspaceId: asset.workspace_id, fileName: asset.file_name, fileType: asset.file_type,
      mimeType: asset.mime_type, fileSize: asset.file_size, storageBucket: asset.storage_bucket, storagePath: asset.storage_path,
      publicUrl: asset.public_url, status: asset.status };
    return { finalized: true as const, operationId: ticket.id, requestKey: input.requestKey.toLowerCase(), asset: receipt, item: receipt };
  }
  return prepareOrResumeStagedCreativeUpload(config, ticket);
}

function resultFor(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, sha256: string, size: number): Row {
  const identity = verifiedCreativeIdentity(ticket, sha256);
  return { file_name: ticket.fileName, file_type: "image", mime_type: ticket.mimeType, file_size: size,
    storage_bucket: identity.storageBucket, storage_path: identity.storagePath,
    public_url: `${config.origin}/storage/v1/object/public/${identity.storageBucket}/${identity.storagePath}`, sha256 };
}

function verifiedResult(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, value: unknown): Row {
  const result = object(value);
  if (typeof result.sha256 !== "string" || !Number.isSafeInteger(result.file_size) || Number(result.file_size) < 1 || Number(result.file_size) > 10 * 1024 * 1024) throw unavailable();
  const expected = resultFor(config, ticket, result.sha256, Number(result.file_size));
  if (Object.keys(result).length !== Object.keys(expected).length || Object.entries(expected).some(([key, v]) => result[key] !== v)) throw unavailable();
  return expected;
}

function verifiedAsset(ticket: StagedCreativeTicket, result: Row, value: unknown): Row {
  const asset = object(value);
  if (asset.id !== ticket.id || asset.workspace_id !== ticket.workspaceId || asset.verified_upload_key !== ticket.id
    || asset.verified_upload_actor_id !== ticket.userId || asset.verified_upload_sha256 !== result.sha256
    || !["uploaded", "ready"].includes(String(asset.status))
    || Object.entries(result).some(([key, v]) => key !== "sha256" && asset[key] !== v)) throw unavailable();
  return asset;
}

async function confirmPublic(result: Row): Promise<void> {
  try { await verifyGeneratedStorageBytes({ publicUrl: String(result.public_url), mimeType: String(result.mime_type), size: Number(result.file_size), sha256: String(result.sha256) }); }
  catch { throw unavailable(); }
}

async function commit(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, result: Row): Promise<Row> {
  const reply = object(await rpc(config, "finalize_creative_image_upload", { ...actorArgs(ticket), p_operation_id: ticket.id, p_result: result }));
  if (reply.operationId !== ticket.id || reply.status !== "finalized" || typeof reply.replayed !== "boolean") throw unavailable();
  return verifiedAsset(ticket, result, reply.asset);
}

async function operation(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, source: "signed" | "inline"): Promise<Row> {
  let value: unknown;
  try {
    const { data, error } = await bounded(() => config.supabase.from("creative_upload_operations").select("*")
      .eq("id", ticket.id).eq("workspace_id", ticket.workspaceId).eq("auth_user_id", ticket.userId).eq("staff_user_id", ticket.staffUserId).maybeSingle());
    if (error) throw unavailable(); value = data;
  } catch { throw unavailable(); }
  const row = object(value);
  if (!Object.keys(row).length || row.status === "rejected") throw new CreativeUploadWorkflowError(409, "creative_upload_unavailable");
  if (row.id !== ticket.id || row.workspace_id !== ticket.workspaceId || row.auth_user_id !== ticket.userId || row.staff_user_id !== ticket.staffUserId
    || row.file_name !== ticket.fileName || row.mime_type !== ticket.mimeType || row.file_size !== ticket.fileSize
    || row.issued_at !== ticket.issuedAt || row.expires_at !== ticket.expiresAt || row.source !== source
    || !["reserved", "finalized"].includes(String(row.status))) throw unavailable();
  return row;
}

async function publish(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, buffer: Buffer): Promise<Row> {
  readStagedCreativeTicket(sealStagedCreativeTicket(ticket, config.serviceRoleKey), ticket, config.serviceRoleKey);
  await requireLiveCreativeUploadActor(config, ticket);
  const sha256 = createHash("sha256").update(buffer).digest("hex"), result = resultFor(config, ticket, sha256, buffer.length);
  try {
    const reply = await bounded(() => config.supabase.storage.from(String(result.storage_bucket))
      .upload(String(result.storage_path), buffer, { contentType: ticket.mimeType, upsert: false }));
    if (reply.error || reply.data?.path !== result.storage_path) throw unavailable();
  } catch { /* Reconcile the exact immutable public bytes; never overwrite or create a new operation. */ }
  await confirmPublic(result);
  return commit(config, ticket, result);
}

async function rejectInvalid(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket): Promise<void> {
  try { await rpc(config, "reject_creative_upload", { ...actorArgs(ticket), p_operation_id: ticket.id }); }
  catch { /* An unconfirmed rejection is not success; raw retention remains reserved. */ }
}

async function replay(config: CreativeUploadWorkflowConfig, ticket: StagedCreativeTicket, row: Row): Promise<Row | null> {
  if (row.status !== "finalized") return null;
  const result = verifiedResult(config, ticket, row.result);
  await requireLiveCreativeUploadActor(config, ticket);
  await confirmPublic(result);
  return commit(config, ticket, result);
}

export async function finalizeCreativeImageUpload(config: CreativeUploadWorkflowConfig, handle: unknown, actor: StagedCreativeActor): Promise<Row> {
  const ticket = readStagedCreativeTicket(handle, actor, config.serviceRoleKey);
  if (!ticket.mimeType.startsWith("image/")) throw new CreativeUploadWorkflowError(409, "creative_video_worker_required");
  await requireLiveCreativeUploadActor(config, actor);
  const row = await operation(config, ticket, "signed");
  const prior = await replay(config, ticket, row); if (prior) return prior;
  let buffer: Buffer;
  try { ({ buffer } = await readAndNormalizeStagedCreativeImage(config, handle, actor)); }
  catch (error) {
    if (error instanceof StagedCreativeStorageError && error.code === "creative_staging_image_invalid") {
      await rejectInvalid(config, ticket); throw new CreativeUploadWorkflowError(400, "creative_upload_image_invalid");
    }
    throw error;
  }
  return publish(config, ticket, buffer);
}

export async function finalizeInlineCreativeImage(config: CreativeUploadWorkflowConfig, input: StagedCreativeActor & {
  requestKey: string; fileName: string; mimeType: string; buffer: Buffer;
}): Promise<Row> {
  const { ticket } = await reserveCreativeUpload(config, { ...input, fileSize: input.buffer.length }, "inline");
  const row = await operation(config, ticket, "inline");
  const prior = await replay(config, ticket, row); if (prior) return prior;
  let buffer: Buffer;
  try { buffer = await normalizeCreativeImageBytes(input); }
  catch (error) {
    if (error instanceof CreativeImageValidationUnavailable) throw new CreativeUploadWorkflowError(503, "creative_staging_decoder_unavailable");
    await rejectInvalid(config, ticket); throw new CreativeUploadWorkflowError(400, "creative_upload_image_invalid");
  }
  return publish(config, ticket, buffer);
}

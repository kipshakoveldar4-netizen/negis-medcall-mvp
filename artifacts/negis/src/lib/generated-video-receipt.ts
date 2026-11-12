export type GeneratedVideoPhase = "generation" | "validation";

export type GeneratedVideoJobSnapshot = {
  handle: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  progress: number;
  formatSubstituted: boolean;
  phase: GeneratedVideoPhase;
  validationJobId?: string;
};

export type NativeGeneratedVideoReceipt = {
  nativeValidated: true;
  assetId: string;
  validationJobId: string;
  fileName: string;
  mimeType: "video/mp4";
  fileSize: number;
  sha256: string;
  creativeUrl: string;
  thumbnailUrl: string;
};

export type GeneratedVideoPoll = Omit<GeneratedVideoJobSnapshot, "handle" | "formatSubstituted"> & {
  receipt?: NativeGeneratedVideoReceipt;
};

type Owner = { actorId: string; workspaceId: string };
type ReceiptContext = { workspaceId: string; storageOrigin: string; validationJobId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function requireOwner(owner: Owner): void {
  if (!uuid.test(owner.actorId) || !uuid.test(owner.workspaceId)) throw new Error("generated_video_owner_unconfirmed");
}

export function generatedVideoStorageKey(base: string, owner: Owner): string {
  requireOwner(owner);
  return `${base}::${owner.workspaceId}::${owner.actorId}`;
}

export function isGeneratedVideoHandle(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192 && /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{43}$/.test(value);
}

export function parseGeneratedVideoPoll(value: unknown, context: ReceiptContext): GeneratedVideoPoll {
  const data = record(value);
  const error = () => new Error("generated_video_receipt_unconfirmed");
  if (!data || !uuid.test(context.workspaceId) || !["queued", "in_progress", "completed", "failed"].includes(String(data.status))
    || typeof data.progress !== "number" || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100
    || (data.workspaceId !== undefined && data.workspaceId !== context.workspaceId)
    || (data.phase !== undefined && data.phase !== "generation" && data.phase !== "validation")) throw error();
  const status = data.status as GeneratedVideoPoll["status"];
  const phase = data.phase === "validation" || status === "completed" ? "validation" : "generation";
  const jobId = data.validationJobId;
  if ((jobId !== undefined && (typeof jobId !== "string" || !uuid4.test(jobId)))
    || (status === "completed" && typeof jobId !== "string")
    || (context.validationJobId !== undefined && jobId !== context.validationJobId)
    || (status === "completed" && data.phase !== undefined && data.phase !== "validation")) throw error();
  const result: GeneratedVideoPoll = { status, phase, progress: status === "completed" ? 100 : Math.min(95, data.progress),
    ...(typeof jobId === "string" ? { validationJobId: jobId } : {}) };
  if (status !== "completed") {
    for (const field of ["creativeUrl", "publicUrl", "url", "thumbnailUrl", "storageBucket", "storagePath", "asset", "receipt"]) {
      if (data[field] !== undefined && data[field] !== null) throw error();
    }
    if (data.nativeValidated === true) throw error();
    return result;
  }

  let origin: URL;
  try { origin = new URL(context.storageOrigin); } catch { throw error(); }
  if (origin.protocol !== "https:" || origin.origin !== context.storageOrigin || origin.username || origin.password
    || data.nativeValidated !== true || typeof data.assetId !== "string" || !uuid.test(data.assetId)
    || typeof data.fileName !== "string" || !/^negis-video-[0-9a-f]{20}\.mp4$/.test(data.fileName)
    || new TextEncoder().encode(data.fileName).length > 255 || /[\\/\u0000-\u001f\u007f]/.test(data.fileName)
    || data.mimeType !== "video/mp4" || typeof data.fileSize !== "number" || !Number.isSafeInteger(data.fileSize)
    || data.fileSize <= 0 || data.fileSize > 100 * 1024 * 1024 || typeof data.sha256 !== "string" || !sha256.test(data.sha256)
    || typeof data.creativeUrl !== "string" || typeof data.thumbnailUrl !== "string" || data.progress !== 100) throw error();
  const prefix = `${origin.origin}/storage/v1/object/public/ad-creatives/optimized/${context.workspaceId}/${jobId}-`;
  const tail = data.creativeUrl.startsWith(prefix) ? data.creativeUrl.slice(prefix.length) : "";
  if (!/^[0-9a-f]{20}\.mp4$/.test(tail)
    || data.thumbnailUrl !== `${prefix}${tail.slice(0, -4)}-thumbnail.jpg`
    || (data.storageBucket !== undefined && data.storageBucket !== "ad-creatives")
    || (data.storagePath !== undefined && data.storagePath !== `optimized/${context.workspaceId}/${jobId}-${tail}`)
    || (data.thumbnailPath !== undefined && data.thumbnailPath !== `optimized/${context.workspaceId}/${jobId}-${tail.slice(0, -4)}-thumbnail.jpg`)
    || (data.thumbnailSize !== undefined && (typeof data.thumbnailSize !== "number" || !Number.isSafeInteger(data.thumbnailSize)
      || data.thumbnailSize <= 0 || data.thumbnailSize > 10 * 1024 * 1024))
    || (data.thumbnailSha256 !== undefined && (typeof data.thumbnailSha256 !== "string" || !sha256.test(data.thumbnailSha256)))) throw error();
  result.receipt = { nativeValidated: true, assetId: data.assetId, validationJobId: jobId as string,
    fileName: data.fileName, mimeType: "video/mp4", fileSize: data.fileSize, sha256: data.sha256,
    creativeUrl: data.creativeUrl, thumbnailUrl: data.thumbnailUrl };
  return result;
}

export function parseAcceptedGeneratedVideo(value: unknown, context: ReceiptContext): GeneratedVideoJobSnapshot {
  const data = record(value);
  if (!data || !isGeneratedVideoHandle(data.handle) || (data.formatSubstituted !== undefined && typeof data.formatSubstituted !== "boolean")) {
    throw new Error("generated_video_handle_unconfirmed");
  }
  const poll = parseGeneratedVideoPoll(data, context);
  // Even a replayed completed POST is polled before its public receipt is displayed.
  return { handle: data.handle, formatSubstituted: data.formatSubstituted === true, phase: poll.phase,
    status: poll.status === "completed" ? "in_progress" : poll.status,
    progress: Math.min(95, poll.progress), ...(poll.validationJobId ? { validationJobId: poll.validationJobId } : {}) };
}

export function parseRecoverableGeneratedVideo(value: unknown, context: ReceiptContext): GeneratedVideoJobSnapshot | null {
  const envelope = record(value), data = record(envelope?.data);
  if (envelope?.success !== false || envelope.accepted !== true || !data || !isGeneratedVideoHandle(data.handle)) return null;
  try {
    const parsed = parseGeneratedVideoPoll({ ...data, progress: data.progress ?? 0 }, context);
    return { handle: data.handle, status: "failed", progress: parsed.progress, phase: parsed.phase,
      formatSubstituted: data.formatSubstituted === true,
      ...(parsed.validationJobId ? { validationJobId: parsed.validationJobId } : {}) };
  } catch { return null; }
}

export function serializeGeneratedVideoDraft(job: GeneratedVideoJobSnapshot, owner: Owner): string {
  requireOwner(owner);
  const parsed = parseGeneratedVideoDraft(JSON.stringify({ version: 2, actorId: owner.actorId, workspaceId: owner.workspaceId, ...job }), owner);
  if (!parsed) throw new Error("generated_video_draft_unconfirmed");
  return JSON.stringify({ version: 2, actorId: owner.actorId, workspaceId: owner.workspaceId, ...parsed });
}

export function parseGeneratedVideoDraft(raw: string, owner: Owner): GeneratedVideoJobSnapshot | null {
  try {
    requireOwner(owner);
    if (raw.length > 12_000) return null;
    const data = record(JSON.parse(raw));
    if (!data || data.version !== 2 || data.actorId !== owner.actorId || data.workspaceId !== owner.workspaceId
      || !isGeneratedVideoHandle(data.handle) || typeof data.formatSubstituted !== "boolean"
      || !["queued", "in_progress", "completed", "failed"].includes(String(data.status))
      || (data.phase !== "generation" && data.phase !== "validation")
      || typeof data.progress !== "number" || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100
      || (data.validationJobId !== undefined && (typeof data.validationJobId !== "string" || !uuid4.test(data.validationJobId)))
      || (data.status === "completed" && typeof data.validationJobId !== "string")) return null;
    // Local storage is not an authority for public media or completed processing.
    return { handle: data.handle, formatSubstituted: data.formatSubstituted, phase: data.phase,
      status: data.status === "completed" ? "in_progress" : data.status as GeneratedVideoJobSnapshot["status"],
      progress: Math.min(95, data.progress), ...(typeof data.validationJobId === "string" ? { validationJobId: data.validationJobId } : {}) };
  } catch { return null; }
}

export function requireGeneratedVideoRetryReceipt(value: unknown, owner: Owner, jobId: string): void {
  requireOwner(owner);
  const envelope = record(value), data = record(envelope?.data), job = record(data?.job);
  if (!uuid4.test(jobId) || envelope?.success !== true || envelope.mode !== "supabase" || !job
    || job.id !== jobId || job.workspaceId !== owner.workspaceId || !["queued", "processing", "ready"].includes(String(job.status))) {
    throw new Error("generated_video_retry_unconfirmed");
  }
}

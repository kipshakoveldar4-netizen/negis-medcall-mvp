import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { buildDecodeArgs, buildThumbnailArgs, buildTranscodeArgs, probeVideo, runFfmpeg, VIDEO_MEDIA_LIMITS } from "./ffmpeg.js";
import { downloadPrivateVideo } from "./download.js";
import { reclaimGeneratedVideoRaw } from "./generated-raw-reclamation.js";

export type JobRow = {
  id: string;
  workspace_id: string | null;
  asset_id: string | null;
  status: string;
  attempts: number | null;
  raw_bucket: string | null;
  raw_path: string | null;
  raw_size: number | null;
  source_file_name: string | null;
  source_mime_type: string | null;
  output_bucket: string | null;
  optimized_bucket: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  metadata: Record<string, unknown> | null;
};

const PROGRESS = { downloading: 10, transcoding: 40, uploading: 80, ready: 100 } as const;
const failureCodes = new Set(["video_job_identity_invalid", "video_job_claim_unconfirmed", "video_raw_identity_invalid",
  "video_asset_identity_unconfirmed", "video_download_invalid", "video_download_unconfirmed", "video_probe_invalid",
  "video_media_timeout", "video_media_process_failed", "video_media_output_limit", "video_media_process_config_invalid", "video_output_limits_invalid",
  "video_encoder_options_invalid", "video_output_size_invalid", "video_output_geometry_invalid", "video_thumbnail_size_invalid",
  "video_output_upload_unconfirmed", "video_thumbnail_upload_unconfirmed", "video_public_url_unconfirmed", "video_asset_save_unconfirmed", "video_promotion_unconfirmed"]);

export function createSupabase(config: WorkerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      // Node.js 20 has no native WebSocket; supabase-js crashes at startup
      // without an explicit transport. The worker never opens realtime
      // channels, but the client still requires a valid constructor.
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  });
}

// Atomic claim: select the oldest queued job, then win the queued → downloading
// transition with an UPDATE guarded by status = queued. If another worker got
// there first, zero rows come back and we simply try again on the next poll.
export async function claimNextJob(supabase: SupabaseClient, config: WorkerConfig): Promise<JobRow | null> {
  const { data: candidates, error } = await supabase
    .from("video_processing_jobs")
    .select("id, attempts")
    .eq("status", "queued")
    .lt("attempts", config.maxAttempts)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error("video_queue_read_unconfirmed");
  const candidate = candidates?.[0] as { id: string; attempts: number | null } | undefined;
  if (!candidate) return null;

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("video_processing_jobs")
    .update({
      status: "downloading",
      progress: PROGRESS.downloading,
      claimed_by: config.workerId,
      claimed_at: now,
      attempts: (candidate.attempts ?? 0) + 1,
      updated_at: now,
    })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  if (claimError) throw new Error("video_queue_claim_unconfirmed");
  const job = claimed as JobRow | null;
  // Re-verify ownership: only proceed when this worker holds the claim.
  if (!job || job.claimed_by !== config.workerId) return null;
  return job;
}

async function updateClaim(supabase: SupabaseClient, config: WorkerConfig, job: JobRow, expectedStatus: string,
  values: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase
    .from("video_processing_jobs")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", job.id).eq("workspace_id", job.workspace_id).eq("claimed_by", config.workerId)
    .eq("claimed_at", job.claimed_at).eq("attempts", job.attempts).eq("status", expectedStatus)
    .select("id").maybeSingle();
  if (error || data?.id !== job.id) throw new Error("video_job_claim_unconfirmed");
}

function inputExtension(job: JobRow): string {
  const fromName = (job.source_file_name || "").toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "webm"].includes(fromName)) return fromName;
  const mime = (job.source_mime_type || "").toLowerCase();
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/webm") return "webm";
  return "mp4";
}

export async function processJob(supabase: SupabaseClient, config: WorkerConfig, job: JobRow): Promise<void> {
  const tmpBase = await mkdtemp(path.join(config.tmpDir, "negis-video-"));
  let assetAuthorized = false;
  let claimValidated = false;
  let phase = "downloading";
  let assetVersion = "";
  try {
    const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    if (!uuid(job.id) || !uuid(job.workspace_id) || (job.asset_id !== null && !uuid(job.asset_id))
      || job.status !== "downloading" || job.claimed_by !== config.workerId || !job.claimed_at || !Number.isFinite(Date.parse(job.claimed_at))
      || !Number.isSafeInteger(job.attempts) || Number(job.attempts) < 1 || Number(job.attempts) > config.maxAttempts) {
      throw new Error("video_job_identity_invalid");
    }
    claimValidated = true;
    await updateClaim(supabase, config, job, phase, { status: phase, progress: PROGRESS.downloading });
    const rawBucket = job.raw_bucket || config.rawBucket;
    const rawPath = job.raw_path || "";
    if (rawBucket !== config.rawBucket || [job.optimized_bucket, job.output_bucket].some(bucket => bucket && bucket !== config.outputBucket)
      || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(config.outputBucket) || config.outputBucket === rawBucket
      || !rawPath.startsWith(`${job.workspace_id}/`) || rawPath.length > 1024 || /[\\%\u0000-\u001f\u007f]/.test(rawPath)
      || rawPath.split("/").some(segment => !segment || segment === "." || segment === "..")
      || !Number.isSafeInteger(job.raw_size) || Number(job.raw_size) <= 0 || Number(job.raw_size) > VIDEO_MEDIA_LIMITS.maxInputBytes
      || !["video/mp4", "video/quicktime", "video/webm"].includes(job.source_mime_type || "")) throw new Error("video_raw_identity_invalid");
    // Recheck queued jobs too: older API versions accepted unchecked asset ids.
    if (job.asset_id) {
      const { data: asset, error } = await supabase
        .from("ad_creative_assets")
        .select("*")
        .eq("id", job.asset_id)
        .eq("workspace_id", job.workspace_id)
        .maybeSingle();
      if (error || !asset || asset.id !== job.asset_id || asset.workspace_id !== job.workspace_id
        || asset.storage_bucket !== rawBucket || asset.storage_path !== rawPath || asset.file_type !== "video"
        || asset.mime_type !== job.source_mime_type || asset.file_size !== job.raw_size
        || (asset.generated_key !== null && asset.generated_key !== undefined)
        || (asset.metadata?.uploadMode === "ai-generated" && asset.metadata?.kind === "generated-video")
        || typeof asset.updated_at !== "string" || !Number.isFinite(Date.parse(asset.updated_at))) {
        throw new Error("video_asset_identity_unconfirmed");
      }
      assetAuthorized = true;
      assetVersion = asset.updated_at;
    }
    const inputPath = path.join(tmpBase, `input.${inputExtension(job)}`);
    const generatedInputSha256 = job.metadata?.kind === "generated-video-native" ? job.metadata.inputSha256 : undefined;
    if (job.metadata?.kind === "generated-video-native"
      && (typeof generatedInputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(generatedInputSha256))) throw new Error("video_raw_identity_invalid");
    const inputSizeBytes = await downloadPrivateVideo({ supabaseUrl: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey,
      bucket: rawBucket, path: rawPath, outputPath: inputPath, expectedBytes: Number(job.raw_size), maxBytes: VIDEO_MEDIA_LIMITS.maxInputBytes,
      ...(typeof generatedInputSha256 === "string" ? { expectedSha256: generatedInputSha256 } : {}) });
    await probeVideo(config.ffprobePath, inputPath, job.source_mime_type!);

    // transcoding — optimized MP4 (H.264 + AAC, +faststart, metadata stripped)
    await updateClaim(supabase, config, job, phase, { status: "transcoding", progress: PROGRESS.transcoding });
    phase = "transcoding";
    const optimizedTmpPath = path.join(tmpBase, "optimized.mp4");
    await runFfmpeg(config.ffmpegPath, buildTranscodeArgs(inputPath, optimizedTmpPath, config));
    const outputSizeBytes = (await stat(optimizedTmpPath)).size;
    if (outputSizeBytes <= 0 || outputSizeBytes > VIDEO_MEDIA_LIMITS.maxOutputBytes) throw new Error("video_output_size_invalid");
    const output = await probeVideo(config.ffprobePath, optimizedTmpPath, "video/mp4");
    if (output.width > config.maxWidth || output.height > config.maxHeight) throw new Error("video_output_geometry_invalid");
    await runFfmpeg(config.ffmpegPath, buildDecodeArgs(optimizedTmpPath));
    // Thumbnail is taken from the OPTIMIZED video, never the raw original.
    const thumbnailTmpPath = path.join(tmpBase, "thumbnail.jpg");
    await runFfmpeg(config.ffmpegPath, buildThumbnailArgs(optimizedTmpPath, thumbnailTmpPath));
    const thumbnailSizeBytes = (await stat(thumbnailTmpPath)).size;
    if (thumbnailSizeBytes <= 0 || thumbnailSizeBytes > VIDEO_MEDIA_LIMITS.maxThumbnailBytes) throw new Error("video_thumbnail_size_invalid");

    // uploading
    await updateClaim(supabase, config, job, phase, { status: "uploading", progress: PROGRESS.uploading });
    phase = "uploading";
    const outputBucket = config.outputBucket;
    const claimTag = createHash("sha256").update(JSON.stringify([config.workerId, job.claimed_at, job.attempts])).digest("hex").slice(0, 20);
    const outputStoragePath = `optimized/${job.workspace_id}/${job.id}-${claimTag}.mp4`;
    const thumbnailStoragePath = `optimized/${job.workspace_id}/${job.id}-${claimTag}-thumbnail.jpg`;

    const videoBytes = await readFile(optimizedTmpPath);
    const thumbnailBytes = await readFile(thumbnailTmpPath);
    const { data: videoUpload, error: videoUploadError } = await supabase.storage
      .from(outputBucket)
      .upload(outputStoragePath, videoBytes, { contentType: "video/mp4", upsert: false });
    if (videoUploadError || videoUpload?.path !== outputStoragePath) throw new Error("video_output_upload_unconfirmed");

    const { data: thumbnailUpload, error: thumbnailUploadError } = await supabase.storage
      .from(outputBucket)
      .upload(thumbnailStoragePath, thumbnailBytes, { contentType: "image/jpeg", upsert: false });
    if (thumbnailUploadError || thumbnailUpload?.path !== thumbnailStoragePath) throw new Error("video_thumbnail_upload_unconfirmed");

    const outputPublicUrl = supabase.storage.from(outputBucket).getPublicUrl(outputStoragePath).data.publicUrl || "";
    const thumbnailPublicUrl = supabase.storage.from(outputBucket).getPublicUrl(thumbnailStoragePath).data.publicUrl || "";
    const expectedUrl = (object: string) => `${config.supabaseUrl}/storage/v1/object/public/${outputBucket}/${object.split("/").map(encodeURIComponent).join("/")}`;
    if (outputPublicUrl !== expectedUrl(outputStoragePath) || thumbnailPublicUrl !== expectedUrl(thumbnailStoragePath)) throw new Error("video_public_url_unconfirmed");

    const compressionRatio = inputSizeBytes > 0 ? Number((outputSizeBytes / inputSizeBytes).toFixed(3)) : null;
    await updateClaim(supabase, config, job, phase, { status: phase, progress: PROGRESS.uploading });
    const promotion = { storage_origin: config.supabaseUrl, storage_bucket: outputBucket, storage_path: outputStoragePath,
      public_url: outputPublicUrl, file_size: outputSizeBytes, sha256: createHash("sha256").update(videoBytes).digest("hex"),
      thumbnail_path: thumbnailStoragePath, thumbnail_public_url: thumbnailPublicUrl, thumbnail_size: thumbnailBytes.length,
      thumbnail_sha256: createHash("sha256").update(thumbnailBytes).digest("hex"), input_size: inputSizeBytes };
    // 086 locks the claim and atomically promotes the job and matching asset.
    // The second identical call only reconciles a lost response, not a new job.
    let promoted = false;
    for (let attempt = 0; attempt < 2 && !promoted; attempt++) {
      try {
        const { data, error } = await supabase.rpc("finalize_video_job", { p_job_id: job.id, p_workspace_id: job.workspace_id,
          p_claimed_by: config.workerId, p_claimed_at: job.claimed_at, p_attempt: job.attempts,
          p_asset_version: assetVersion || null, p_result: promotion });
        const proof = data?.promotion;
        promoted = Boolean(!error && data?.jobId === job.id && data?.workspaceId === job.workspace_id && data?.assetId === job.asset_id
          && data?.status === "ready" && proof && typeof proof === "object" && !Array.isArray(proof)
          && Object.keys(proof).length === Object.keys(promotion).length
          && Object.entries(promotion).every(([key, value]) => Object.hasOwn(proof, key) && proof[key] === value));
      } catch { /* Preserve the private original while a commit is unconfirmed. */ }
    }
    if (!promoted) throw new Error("video_promotion_unconfirmed");
    phase = "ready";

    // Retain raw on any unconfirmed asset/job commit. A cleanup failure must not
    // turn an already-confirmed playable result into a failed/retryable job.
    let rawDeleted = false;
    try {
      if (job.metadata?.kind === "generated-video-native") {
        // A delayed create-only producer may still be uploading. Keep this key
        // occupied; deleting it would permit resurrecting unaccounted raw bytes.
        await reclaimGeneratedVideoRaw(supabase, config, { ...job, status: "ready" });
        rawDeleted = true;
      } else {
        const { data: removed, error: removeError } = await supabase.storage.from(rawBucket).remove([rawPath]);
        rawDeleted = !removeError && Array.isArray(removed) && removed.some(item => item.name === rawPath);
        await updateClaim(supabase, config, job, phase, { raw_deleted_at: rawDeleted ? new Date().toISOString() : null,
          raw_delete_error: rawDeleted ? null : "video_raw_cleanup_unconfirmed" });
      }
    } catch { console.warn("[video-worker] raw cleanup unconfirmed"); }

    console.log(
      `[video-worker] job ${job.id} ready (input ${inputSizeBytes} bytes -> output ${outputSizeBytes} bytes, ratio ${compressionRatio ?? "n/a"}, raw reclaimed: ${rawDeleted ? "yes" : "no"})`,
    );
  } catch (error) {
    // Native/SDK errors can contain paths, credentials or customer metadata.
    const message = error instanceof Error && failureCodes.has(error.message) ? error.message : "video_processing_failed";
    console.error(`[video-worker] processing failed: ${message}`);
    try {
      if (!claimValidated || phase === "ready") return;
      await updateClaim(supabase, config, job, phase, { status: "failed", error: message, error_message: message });
      if (job.asset_id && assetAuthorized) {
        await supabase
          .from("ad_creative_assets")
          .update({ status: "optimization_failed", updated_at: new Date().toISOString() })
          .eq("id", job.asset_id)
          .eq("workspace_id", job.workspace_id).eq("storage_bucket", config.rawBucket).eq("storage_path", job.raw_path).eq("updated_at", assetVersion);
      }
    } catch (markError) {
      console.error("[video-worker] failure state unconfirmed");
    }
  } finally {
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

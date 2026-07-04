import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { buildThumbnailArgs, buildTranscodeArgs, runFfmpeg } from "./ffmpeg.js";

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
  claimed_by: string | null;
  metadata: Record<string, unknown> | null;
};

const PROGRESS = { downloading: 10, transcoding: 40, uploading: 80, ready: 100 } as const;

export function createSupabase(config: WorkerConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
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
  if (error) throw new Error(`queue select failed: ${error.message}`);
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
  if (claimError) throw new Error(`claim failed: ${claimError.message}`);
  const job = claimed as JobRow | null;
  // Re-verify ownership: only proceed when this worker holds the claim.
  if (!job || job.claimed_by !== config.workerId) return null;
  return job;
}

async function setJobProgress(supabase: SupabaseClient, jobId: string, status: string, progress: number): Promise<void> {
  const { error } = await supabase
    .from("video_processing_jobs")
    .update({ status, progress, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`job status update failed: ${error.message}`);
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
  try {
    const rawBucket = job.raw_bucket || "ad-creatives-raw";
    const rawPath = job.raw_path || "";
    if (!rawPath) throw new Error("job has no raw_path");

    // downloading (progress set during the claim)
    const { data: rawBlob, error: downloadError } = await supabase.storage.from(rawBucket).download(rawPath);
    if (downloadError || !rawBlob) {
      throw new Error(`raw download failed: ${downloadError?.message || "empty file"}`);
    }
    const inputPath = path.join(tmpBase, `input.${inputExtension(job)}`);
    await writeFile(inputPath, Buffer.from(await rawBlob.arrayBuffer()));
    const inputSizeBytes = (await stat(inputPath)).size;

    // transcoding
    await setJobProgress(supabase, job.id, "transcoding", PROGRESS.transcoding);
    const optimizedTmpPath = path.join(tmpBase, "optimized.mp4");
    await runFfmpeg(buildTranscodeArgs(inputPath, optimizedTmpPath, config));
    const thumbnailTmpPath = path.join(tmpBase, "thumbnail.jpg");
    await runFfmpeg(buildThumbnailArgs(optimizedTmpPath, thumbnailTmpPath));
    const outputSizeBytes = (await stat(optimizedTmpPath)).size;

    // uploading
    await setJobProgress(supabase, job.id, "uploading", PROGRESS.uploading);
    const outputBucket = job.output_bucket || "ad-creatives";
    const workspaceSegment = job.workspace_id || "demo";
    const outputStoragePath = `optimized/${workspaceSegment}/${job.id}.mp4`;
    const thumbnailStoragePath = `optimized/${workspaceSegment}/${job.id}-thumbnail.jpg`;

    const { error: videoUploadError } = await supabase.storage
      .from(outputBucket)
      .upload(outputStoragePath, await readFile(optimizedTmpPath), { contentType: "video/mp4", upsert: true });
    if (videoUploadError) throw new Error(`optimized upload failed: ${videoUploadError.message}`);

    const { error: thumbnailUploadError } = await supabase.storage
      .from(outputBucket)
      .upload(thumbnailStoragePath, await readFile(thumbnailTmpPath), { contentType: "image/jpeg", upsert: true });
    if (thumbnailUploadError) throw new Error(`thumbnail upload failed: ${thumbnailUploadError.message}`);

    const outputPublicUrl = supabase.storage.from(outputBucket).getPublicUrl(outputStoragePath).data.publicUrl || "";
    const thumbnailPublicUrl = supabase.storage.from(outputBucket).getPublicUrl(thumbnailStoragePath).data.publicUrl || "";
    if (!outputPublicUrl || !thumbnailPublicUrl) throw new Error("optimized public URL is missing");

    // Delete the raw original only after the optimized upload succeeded.
    let rawDeletedAt: string | null = null;
    let rawDeleteError: string | null = null;
    const { error: removeError } = await supabase.storage.from(rawBucket).remove([rawPath]);
    if (removeError) {
      rawDeleteError = removeError.message.slice(0, 300);
    } else {
      rawDeletedAt = new Date().toISOString();
    }

    const compressionRatio = inputSizeBytes > 0 ? Number((outputSizeBytes / inputSizeBytes).toFixed(3)) : null;
    const now = new Date().toISOString();

    // Point the asset at the optimized MP4: Meta launches read public_url, so the
    // raw original can never reach Meta once the job is ready.
    if (job.asset_id) {
      const { data: assetRow } = await supabase.from("ad_creative_assets").select("metadata").eq("id", job.asset_id).maybeSingle();
      const existingMetadata = (assetRow?.metadata && typeof assetRow.metadata === "object" ? assetRow.metadata : {}) as Record<string, unknown>;
      const { error: assetError } = await supabase
        .from("ad_creative_assets")
        .update({
          public_url: outputPublicUrl,
          storage_bucket: outputBucket,
          storage_path: outputStoragePath,
          mime_type: "video/mp4",
          file_size: outputSizeBytes,
          status: "ready",
          metadata: {
            ...existingMetadata,
            optimized: true,
            optimizationStatus: "ready",
            thumbnailUrl: thumbnailPublicUrl,
            thumbnailSource: "worker_frame",
            thumbnailGeneratedAt: now,
            thumbnailMimeType: "image/jpeg",
            inputSizeBytes,
            outputSizeBytes,
            compressionRatio,
          },
          updated_at: now,
        })
        .eq("id", job.asset_id);
      if (assetError) throw new Error(`asset update failed: ${assetError.message}`);
    }

    const { error: readyError } = await supabase
      .from("video_processing_jobs")
      .update({
        status: "ready",
        progress: PROGRESS.ready,
        output_path: outputStoragePath,
        output_public_url: outputPublicUrl,
        output_size: outputSizeBytes,
        thumbnail_path: thumbnailStoragePath,
        thumbnail_public_url: thumbnailPublicUrl,
        thumbnail_source: "worker_frame",
        raw_deleted_at: rawDeletedAt,
        raw_delete_error: rawDeleteError,
        completed_at: now,
        error: null,
        updated_at: now,
      })
      .eq("id", job.id);
    if (readyError) throw new Error(`job ready update failed: ${readyError.message}`);

    console.log(
      `[video-worker] job ${job.id} ready (input ${inputSizeBytes} bytes -> output ${outputSizeBytes} bytes, ratio ${compressionRatio ?? "n/a"}, raw deleted: ${rawDeletedAt ? "yes" : "no"})`,
    );
  } catch (error) {
    const message = (error instanceof Error ? error.message : "video processing failed").slice(0, 500);
    console.error(`[video-worker] job ${job.id} failed: ${message}`);
    try {
      await supabase
        .from("video_processing_jobs")
        .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
      if (job.asset_id) {
        await supabase
          .from("ad_creative_assets")
          .update({ status: "optimization_failed", updated_at: new Date().toISOString() })
          .eq("id", job.asset_id);
      }
    } catch (markError) {
      console.error(`[video-worker] job ${job.id} could not be marked failed: ${markError instanceof Error ? markError.message : "unknown"}`);
    }
  } finally {
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

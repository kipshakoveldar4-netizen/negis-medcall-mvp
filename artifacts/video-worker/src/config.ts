import os from "node:os";

export type WorkerConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  pollIntervalMs: number;
  workerId: string;
  maxAttempts: number;
  maxConcurrentJobs: number;
  tmpDir: string;
  rawBucket: string;
  outputBucket: string;
  ffmpegPath: string;
  ffprobePath: string;
  crf: number;
  preset: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
};

function readString(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function readPositiveNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]?.trim() ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadWorkerConfig(): WorkerConfig {
  const supabaseUrl = readString("SUPABASE_URL");
  const serviceRoleKey = readString("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the video worker");
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    pollIntervalMs: readPositiveNumber("VIDEO_WORKER_POLL_INTERVAL_MS", 5000),
    workerId: readString("VIDEO_WORKER_ID", `video-worker-${os.hostname()}-${process.pid}`),
    maxAttempts: readPositiveNumber("VIDEO_WORKER_MAX_ATTEMPTS", 3),
    maxConcurrentJobs: readPositiveNumber("VIDEO_WORKER_MAX_CONCURRENT_JOBS", 1),
    tmpDir: readString("VIDEO_WORKER_TMP_DIR", os.tmpdir() || "/tmp"),
    rawBucket: readString("VIDEO_OPTIMIZATION_RAW_BUCKET", "ad-creatives-raw"),
    outputBucket: readString("VIDEO_OPTIMIZATION_OUTPUT_BUCKET", "ad-creatives"),
    ffmpegPath: readString("FFMPEG_PATH", "ffmpeg"),
    ffprobePath: readString("FFPROBE_PATH", "ffprobe"),
    crf: readPositiveNumber("VIDEO_WORKER_CRF", 23),
    preset: readString("VIDEO_WORKER_PRESET", "medium"),
    maxWidth: readPositiveNumber("VIDEO_WORKER_MAX_WIDTH", 1080),
    maxHeight: readPositiveNumber("VIDEO_WORKER_MAX_HEIGHT", 1920),
    fps: readPositiveNumber("VIDEO_WORKER_FPS", 30),
  };
}

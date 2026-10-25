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

function invalidConfig(key: string): Error {
  return new Error(`Invalid video worker configuration: ${key}`);
}

// Defaults apply only to unset/blank values; explicit invalid settings fail closed.
function readInteger(key: string, fallback: number, min: number, max: number, step = 1): number {
  const raw = readString(key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max || value % step !== 0) {
    throw invalidConfig(key);
  }
  return value;
}

const presets = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]);

function readPreset(): string {
  const preset = readString("VIDEO_WORKER_PRESET", "medium");
  if (!presets.has(preset)) throw invalidConfig("VIDEO_WORKER_PRESET");
  return preset;
}

function readExecutablePath(key: string, fallback: string): string {
  const value = readString(key, fallback);
  // execFile uses a single binary path, without a shell. Preserve spaces in paths.
  if (/[\x00-\x1f\x7f]/.test(value)) throw invalidConfig(key);
  return value;
}

export function loadWorkerConfig(): WorkerConfig {
  const supabaseUrl = readString("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = readString("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl) throw invalidConfig("SUPABASE_URL");
  if (!serviceRoleKey) throw invalidConfig("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== supabaseUrl) throw new Error();
  } catch { throw invalidConfig("SUPABASE_URL"); }

  // Scheduling caps limit polling pressure, retry amplification and parallel work.
  // Even 3840-side output stays below ffmpeg's 4096-side and VIDEO_MEDIA_LIMITS pixel caps.
  return {
    supabaseUrl,
    serviceRoleKey,
    pollIntervalMs: readInteger("VIDEO_WORKER_POLL_INTERVAL_MS", 5000, 1000, 60_000),
    workerId: readString("VIDEO_WORKER_ID", `video-worker-${os.hostname()}-${process.pid}`),
    maxAttempts: readInteger("VIDEO_WORKER_MAX_ATTEMPTS", 3, 1, 10),
    maxConcurrentJobs: readInteger("VIDEO_WORKER_MAX_CONCURRENT_JOBS", 1, 1, 4),
    tmpDir: readString("VIDEO_WORKER_TMP_DIR", os.tmpdir() || "/tmp"),
    rawBucket: readString("VIDEO_OPTIMIZATION_RAW_BUCKET", "ad-creatives-raw"),
    outputBucket: readString("VIDEO_OPTIMIZATION_OUTPUT_BUCKET", "ad-creatives"),
    ffmpegPath: readExecutablePath("FFMPEG_PATH", "ffmpeg"),
    ffprobePath: readExecutablePath("FFPROBE_PATH", "ffprobe"),
    crf: readInteger("VIDEO_WORKER_CRF", 23, 0, 51),
    preset: readPreset(),
    maxWidth: readInteger("VIDEO_WORKER_MAX_WIDTH", 1080, 2, 3840, 2),
    maxHeight: readInteger("VIDEO_WORKER_MAX_HEIGHT", 1920, 2, 3840, 2),
    fps: readInteger("VIDEO_WORKER_FPS", 30, 1, 60),
  };
}

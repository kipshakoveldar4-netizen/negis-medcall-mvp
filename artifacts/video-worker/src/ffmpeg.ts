import path from "node:path";
import { runMediaProcess } from "./media-process.js";

export { mediaProcessEnvironment, runMediaProcess } from "./media-process.js";

export type TranscodeOptions = {
  crf: number;
  preset: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
};

const presets = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]);
const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const decoderArgs = ["-hide_banner", "-loglevel", "error", "-max_alloc", "134217728",
  "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm", "-probesize", "8388608", "-analyzeduration", "5000000"];

// These are technical admission limits, not a process/container memory sandbox.
export const VIDEO_MEDIA_LIMITS = Object.freeze({ maxDurationSeconds: 600, maxPixels: 16_777_216,
  maxSide: 8192, maxFps: 120, maxFrames: 72_000, maxInputBytes: 500 * 1024 * 1024,
  maxOutputBytes: 100 * 1024 * 1024, maxThumbnailBytes: 10 * 1024 * 1024 });

export function buildScaleFilter(options: TranscodeOptions): string {
  if (!integer(options.maxWidth, 2, 4096) || !integer(options.maxHeight, 2, 4096) || !integer(options.fps, 1, 60)) {
    throw new Error("video_output_limits_invalid");
  }
  return `scale=w='min(${options.maxWidth},iw)':h='min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${options.fps}`;
}

export function buildTranscodeArgs(inputPath: string, outputPath: string, options: TranscodeOptions): string[] {
  if (!integer(options.crf, 0, 51) || !presets.has(options.preset)) throw new Error("video_encoder_options_invalid");
  return [
    "-nostdin", "-n", "-xerror", ...decoderArgs, "-threads", "1", "-err_detect", "explode",
    "-i",
    inputPath,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-filter_threads", "1", "-threads", "1",
    "-vf",
    buildScaleFilter(options),
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-map_metadata:s", "-1", "-map_chapters", "-1",
    outputPath,
  ];
}

// Thumbnail from the first decoded frame of the OPTIMIZED video.
export function buildThumbnailArgs(inputPath: string, outputPath: string): string[] {
  // First decoded frame also works for a valid video shorter than one second.
  return ["-nostdin", "-n", "-xerror", ...decoderArgs, "-threads", "1", "-i", inputPath,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-threads", "1", "-frames:v", "1", "-q:v", "3", outputPath];
}

export function buildDecodeArgs(inputPath: string): string[] {
  return ["-nostdin", "-xerror", ...decoderArgs, "-threads", "1", "-err_detect", "explode", "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-threads", "1", "-f", "null", "-"];
}

function mediaPath(value: string): string {
  return value === "-" || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:/i.test(value)) ? value : path.resolve(value);
}

export async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  // Builders retain their public argument contract. Resolve local file paths
  // before the subprocess enters its private cwd, including relative tmpDir.
  const localArgs = args.map((arg, index) => args[index - 1] === "-i"
    || (index === args.length - 1 && !arg.startsWith("-")) ? mediaPath(arg) : arg);
  await runMediaProcess(ffmpegPath || "ffmpeg", localArgs, 120_000);
}

function positive(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function validateVideoProbe(value: unknown, mimeType: string): { width: number; height: number; duration: number; fps: number } {
  const input = value as { format?: { format_name?: unknown; duration?: unknown }; streams?: Array<Record<string, unknown>> } | null;
  if (!input || !Array.isArray(input.streams) || input.streams.length < 1 || input.streams.length > 4) throw new Error("video_probe_invalid");
  const allowed = mimeType === "video/webm" ? ["matroska", "webm"]
    : ["video/mp4", "video/quicktime"].includes(mimeType) ? ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] : [];
  const formats = typeof input.format?.format_name === "string" ? input.format.format_name.split(",") : [];
  const duration = positive(input.format?.duration);
  const videos = input.streams.filter(stream => stream && stream.codec_type === "video");
  const audio = input.streams.filter(stream => stream && stream.codec_type === "audio");
  if (!formats.length || formats.some(format => !allowed.includes(format)) || !duration
    || duration > VIDEO_MEDIA_LIMITS.maxDurationSeconds || videos.length !== 1 || audio.length > 1) throw new Error("video_probe_invalid");
  const video = videos[0]!;
  const width = positive(video.width), height = positive(video.height);
  const rate = typeof video.avg_frame_rate === "string" ? /^(\d+)\/(\d+)$/.exec(video.avg_frame_rate) : null;
  const fps = rate && Number(rate[2]) > 0 ? Number(rate[1]) / Number(rate[2]) : 0;
  const frameCount = video.nb_frames === undefined || video.nb_frames === "N/A" ? null : positive(video.nb_frames);
  if (video.nb_frames !== undefined && video.nb_frames !== "N/A" && frameCount === null) throw new Error("video_probe_invalid");
  if (!width || !height || !integer(width, 2, VIDEO_MEDIA_LIMITS.maxSide) || !integer(height, 2, VIDEO_MEDIA_LIMITS.maxSide)
    || width * height > VIDEO_MEDIA_LIMITS.maxPixels || !Number.isFinite(fps) || fps <= 0 || fps > VIDEO_MEDIA_LIMITS.maxFps
    || duration * fps > VIDEO_MEDIA_LIMITS.maxFrames || (frameCount !== null && (!Number.isSafeInteger(frameCount) || frameCount > VIDEO_MEDIA_LIMITS.maxFrames))
    || !["h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mjpeg"].includes(String(video.codec_name))
    || (video.disposition && (video.disposition as { attached_pic?: unknown }).attached_pic === 1)) throw new Error("video_probe_invalid");
  return { width, height, duration, fps };
}

export async function probeVideo(ffprobePath: string, inputPath: string, mimeType: string) {
  const json = await runMediaProcess(ffprobePath || "ffprobe", [...decoderArgs, "-threads", "1",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames:stream_disposition=attached_pic",
    "-of", "json", mediaPath(inputPath)], 15_000);
  try { return validateVideoProbe(JSON.parse(json), mimeType); }
  catch { throw new Error("video_probe_invalid"); }
}

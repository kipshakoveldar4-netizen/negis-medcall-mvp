import { spawn } from "node:child_process";

export type TranscodeOptions = {
  crf: number;
  preset: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
};

// Downscale-only fit inside maxWidth x maxHeight, preserve aspect ratio (no crop),
// force even dimensions for libx264, normalize fps.
export function buildScaleFilter(options: TranscodeOptions): string {
  return [
    `scale='min(${options.maxWidth},iw)':'min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease`,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    `fps=${options.fps}`,
  ].join(",");
}

export function buildTranscodeArgs(inputPath: string, outputPath: string, options: TranscodeOptions): string[] {
  return [
    "-y",
    "-i",
    inputPath,
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
    outputPath,
  ];
}

// Thumbnail from the OPTIMIZED video at ~1 second.
export function buildThumbnailArgs(inputPath: string, outputPath: string): string[] {
  return ["-y", "-ss", "1", "-i", inputPath, "-frames:v", "1", "-q:v", "3", outputPath];
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    child.on("error", (error) => {
      reject(new Error(`ffmpeg is not available: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-500)}`));
      }
    });
  });
}

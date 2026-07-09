import { spawn } from "node:child_process";

export type TranscodeOptions = {
  crf: number;
  preset: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
};

// Cap width to maxWidth, auto-compute height with -2 (preserves aspect ratio,
// preserves orientation, keeps an even height for libx264), normalize fps.
// No crop by default — faces are never cut.
export function buildScaleFilter(options: TranscodeOptions): string {
  return `scale='min(${options.maxWidth},iw)':-2,fps=${options.fps}`;
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
    "-map_metadata",
    "-1",
    outputPath,
  ];
}

// Thumbnail from the OPTIMIZED video at ~1 second (first valid frame).
export function buildThumbnailArgs(inputPath: string, outputPath: string): string[] {
  return ["-y", "-ss", "1", "-i", inputPath, "-frames:v", "1", "-q:v", "3", outputPath];
}

// Runs the configured ffmpeg binary (FFMPEG_PATH, default "ffmpeg").
export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
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

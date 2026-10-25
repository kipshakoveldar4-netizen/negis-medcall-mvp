import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Import only the config and pure argument builders: no worker main, SDK, native
// media process, network request or environment file is needed by this suite.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configModule = await import(pathToFileURL(path.join(root, "artifacts/video-worker/src/config.ts")).href);
const media = await import(pathToFileURL(path.join(root, "artifacts/video-worker/src/ffmpeg.ts")).href);
const ORIGIN = "https://video-worker.fixture.invalid";
const CREDENTIAL = "SYNTHETIC_SERVICE_CREDENTIAL";
const envKeys = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VIDEO_WORKER_POLL_INTERVAL_MS", "VIDEO_WORKER_ID",
  "VIDEO_WORKER_MAX_ATTEMPTS", "VIDEO_WORKER_MAX_CONCURRENT_JOBS", "VIDEO_WORKER_TMP_DIR",
  "VIDEO_OPTIMIZATION_RAW_BUCKET", "VIDEO_OPTIMIZATION_OUTPUT_BUCKET", "FFMPEG_PATH", "FFPROBE_PATH",
  "VIDEO_WORKER_CRF", "VIDEO_WORKER_PRESET", "VIDEO_WORKER_MAX_WIDTH", "VIDEO_WORKER_MAX_HEIGHT", "VIDEO_WORKER_FPS",
] as const;
type EnvKey = typeof envKeys[number];

// All loader inputs are synthetic, and every touched key is restored on failure.
function withEnv<T>(overrides: Partial<Record<EnvKey, string | undefined>>, run: () => T): T {
  const saved = envKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.SUPABASE_URL = ORIGIN;
    process.env.SUPABASE_SERVICE_ROLE_KEY = CREDENTIAL;
    for (const key of envKeys) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function rejects(key: EnvKey, value: string | undefined): void {
  withEnv({ [key]: value }, () => {
    assert.throws(() => configModule.loadWorkerConfig(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Invalid video worker configuration: ${key}`);
      assert.equal(String(error).includes(CREDENTIAL), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

const numericSettings = [
  { key: "VIDEO_WORKER_POLL_INTERVAL_MS", field: "pollIntervalMs", min: 1000, max: 60_000, fallback: 5000 },
  { key: "VIDEO_WORKER_MAX_ATTEMPTS", field: "maxAttempts", min: 1, max: 10, fallback: 3 },
  { key: "VIDEO_WORKER_MAX_CONCURRENT_JOBS", field: "maxConcurrentJobs", min: 1, max: 4, fallback: 1 },
  { key: "VIDEO_WORKER_CRF", field: "crf", min: 0, max: 51, fallback: 23 },
  { key: "VIDEO_WORKER_MAX_WIDTH", field: "maxWidth", min: 2, max: 3840, fallback: 1080 },
  { key: "VIDEO_WORKER_MAX_HEIGHT", field: "maxHeight", min: 2, max: 3840, fallback: 1920 },
  { key: "VIDEO_WORKER_FPS", field: "fps", min: 1, max: 60, fallback: 30 },
] as const;

test("unset optional worker settings retain all existing defaults", () => {
  withEnv({}, () => {
    const config = configModule.loadWorkerConfig();
    assert.equal(config.supabaseUrl, ORIGIN);
    assert.equal(config.serviceRoleKey, CREDENTIAL);
    for (const setting of numericSettings) assert.equal(config[setting.field], setting.fallback);
    assert.equal(config.workerId, `video-worker-${os.hostname()}-${process.pid}`);
    assert.equal(config.tmpDir, os.tmpdir() || "/tmp");
    assert.equal(config.rawBucket, "ad-creatives-raw");
    assert.equal(config.outputBucket, "ad-creatives");
    assert.equal(config.ffmpegPath, "ffmpeg");
    assert.equal(config.ffprobePath, "ffprobe");
    assert.equal(config.preset, "medium");
  });
});

test("empty and whitespace-only optional values retain defaults", () => {
  const defaults = withEnv({}, () => configModule.loadWorkerConfig());
  for (const value of ["", " \t\r\n "]) {
    const overrides = Object.fromEntries(envKeys.filter(key => !key.startsWith("SUPABASE_")).map(key => [key, value]));
    withEnv(overrides, () => assert.deepEqual(configModule.loadWorkerConfig(), defaults));
  }
});

for (const setting of numericSettings) {
  test(`${setting.key} accepts inclusive integer boundaries and trims whitespace`, () => {
    for (const value of [setting.min, setting.max, setting.fallback]) {
      withEnv({ [setting.key]: ` \t${value}\r\n ` }, () => {
        assert.equal(configModule.loadWorkerConfig()[setting.field], value);
      });
    }
  });

  test(`${setting.key} fails closed for invalid, fractional, extreme and injection-like values`, () => {
    for (const value of [
      String(setting.min - 1), String(setting.max + 1), String(setting.min + 0.5), "-1", "-0", "NaN", "nan",
      "Infinity", "-Infinity", "1e309", "9007199254740993", "9".repeat(400), "1e0", "0x2", "0b10", "0o2",
      "1.0", "+1", "1_000", "1,000", "true", "null", "undefined", "[]", "{}", "[1]", '{"value":1}',
      "1; echo SYNTHETIC_PRIVATE_VALUE", "$(SYNTHETIC_PRIVATE_VALUE)", "1\n2", "1px", "--threads=4",
    ]) rejects(setting.key, value);
  });
}

test("dimensions reject odd integers even when within their numeric bounds", () => {
  for (const key of ["VIDEO_WORKER_MAX_WIDTH", "VIDEO_WORKER_MAX_HEIGHT"] as const) {
    for (const value of ["3", "1079", "1919", "3839"]) rejects(key, value);
  }
});

test("valid output extremes remain within media admission limits and pure FFmpeg contracts", () => {
  for (const upper of [false, true]) {
    const overrides = Object.fromEntries(numericSettings.map(setting => [setting.key, String(upper ? setting.max : setting.min)]));
    withEnv(overrides, () => {
      const config = configModule.loadWorkerConfig();
      assert.ok(config.maxWidth <= media.VIDEO_MEDIA_LIMITS.maxSide);
      assert.ok(config.maxHeight <= media.VIDEO_MEDIA_LIMITS.maxSide);
      assert.ok(config.maxWidth * config.maxHeight <= media.VIDEO_MEDIA_LIMITS.maxPixels);
      assert.ok(config.fps <= media.VIDEO_MEDIA_LIMITS.maxFps);
      assert.ok(config.fps * media.VIDEO_MEDIA_LIMITS.maxDurationSeconds <= media.VIDEO_MEDIA_LIMITS.maxFrames);
      const args = media.buildTranscodeArgs("synthetic-input.mp4", "synthetic-output.mp4", config);
      assert.ok(args.includes(String(config.crf)));
      assert.ok(args.includes(config.preset));
      assert.ok(args.includes(media.buildScaleFilter(config)));
    });
  }
});

test("presets are limited to the actual FFmpeg encoder whitelist", () => {
  for (const preset of ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]) {
    withEnv({ VIDEO_WORKER_PRESET: ` ${preset} ` }, () => {
      const config = configModule.loadWorkerConfig();
      assert.equal(config.preset, preset);
      assert.ok(media.buildTranscodeArgs("synthetic-input.mp4", "synthetic-output.mp4", config).includes(preset));
    });
  }
  for (const preset of ["placebo", "MEDIUM", "0", "NaN", "null", "[]", "--preset=medium", "medium -threads 99",
    "medium; echo SYNTHETIC_PRIVATE_VALUE", "$(SYNTHETIC_PRIVATE_VALUE)", "medium\nslow"]) rejects("VIDEO_WORKER_PRESET", preset);
});

test("Supabase requires a canonical HTTPS origin with no credentials, path, query or fragment", () => {
  for (const value of [ORIGIN, ` ${ORIGIN}/ `, "https://video-worker.fixture.invalid:8443", "https://[::1]:8443"]) {
    withEnv({ SUPABASE_URL: value }, () => {
      assert.equal(configModule.loadWorkerConfig().supabaseUrl, value.trim().replace(/\/$/, ""));
    });
  }
  for (const value of [undefined, "", " \t ", "not-a-url", "http://video-worker.fixture.invalid", "//video-worker.fixture.invalid",
    "file:///synthetic", "javascript:synthetic", `https://${CREDENTIAL}@video-worker.fixture.invalid`,
    `https://user:${CREDENTIAL}@video-worker.fixture.invalid`, "https://@video-worker.fixture.invalid", `${ORIGIN}/path`,
    `${ORIGIN}/path/`, `${ORIGIN}//`, `${ORIGIN}/./`, `${ORIGIN}/%2e%2e/`, `${ORIGIN}\\path`, `${ORIGIN}/?`, `${ORIGIN}/#`,
    `${ORIGIN}?${CREDENTIAL}`, `${ORIGIN}#${CREDENTIAL}`, `${ORIGIN}\n.invalid`, `https://video-worker.fixture.invalid;${CREDENTIAL}`,
  ]) rejects("SUPABASE_URL", value);
});

test("the existing nonempty service-key contract is preserved and missing keys fail without echoing values", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: ` ${CREDENTIAL} ` }, () => {
    assert.equal(configModule.loadWorkerConfig().serviceRoleKey, CREDENTIAL);
  });
  for (const value of [undefined, "", " \t\r\n "]) rejects("SUPABASE_SERVICE_ROLE_KEY", value);
});

test("executable paths retain defaults or literal paths with spaces without filesystem probing", () => {
  for (const [key, field, fallback] of [["FFMPEG_PATH", "ffmpegPath", "ffmpeg"], ["FFPROBE_PATH", "ffprobePath", "ffprobe"]] as const) {
    for (const value of [undefined, "", " \t "]) {
      withEnv({ [key]: value }, () => assert.equal(configModule.loadWorkerConfig()[field], fallback));
    }
    for (const value of [fallback, `C:\\synthetic tools\\${fallback}.exe`, `/synthetic tools/${fallback}`, `./synthetic/${fallback}`]) {
      withEnv({ [key]: ` ${value} ` }, () => assert.equal(configModule.loadWorkerConfig()[field], value));
    }
    for (const value of [`${fallback}\nSYNTHETIC_PRIVATE_VALUE`, `${fallback}\rSYNTHETIC_PRIVATE_VALUE`, `${fallback}\targument`, `${fallback}\x7f`]) {
      rejects(key, value);
    }
  }
});

test("environment fixture restores every key after a configuration failure", () => {
  withEnv({ VIDEO_WORKER_ID: "synthetic-outer-worker", VIDEO_WORKER_CRF: "0" }, () => {
    const saved = envKeys.map(key => [key, process.env[key]]);
    assert.throws(() => withEnv({ VIDEO_WORKER_MAX_CONCURRENT_JOBS: "Infinity" }, () => configModule.loadWorkerConfig()));
    assert.deepEqual(envKeys.map(key => [key, process.env[key]]), saved);
    assert.equal(configModule.loadWorkerConfig().workerId, "synthetic-outer-worker");
  });
});

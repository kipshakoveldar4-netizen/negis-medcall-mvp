// Local synthetic harness only. This is not a deployable Preview environment.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const sourceBaseline = "41865a8";
const readerSnapshot = Object.freeze(JSON.parse(readFileSync(new URL("./readiness-isolation-readers.json", import.meta.url), "utf8")));

export function verifyReaderSnapshot(root, readSource = file => readFileSync(path.join(root, file), "utf8")) {
  for (const [file, expected] of Object.entries(readerSnapshot)) {
    const actual = createHash("sha256").update(readSource(file).replace(/\r\n/g, "\n")).digest("hex");
    if (actual !== expected) throw new Error(`Isolation reader changed: ${file}`);
  }
  return Object.keys(readerSnapshot).length;
}

export const omittedBindings = Object.freeze([
  "DATABASE_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "VITE_NEGIS_CONTROL_API_URL", "VITE_MEDINA_CONTROL_MODE", "VITE_MEDINA_API_URL",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_TEXT_PROVIDER", "ANTHROPIC_MODEL", "OPENAI_MODEL", "OPENAI_ADS_MODEL",
  "CONTENT_STUDIO_IMAGE_MODEL", "CONTENT_STUDIO_VIDEO_MODEL", "CONTENT_STUDIO_VIDEO_SECONDS",
  "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "HEYGEN_API_KEY", "TAPNOW_API_KEY",
  "META_ACCESS_TOKEN", "META_APP_SECRET", "META_APP_ID", "META_AD_ACCOUNT_ID", "META_PAGE_ID", "META_INSTAGRAM_ACTOR_ID", "META_BUSINESS_ID",
  "META_WORKSPACE_ID", "META_GRAPH_VERSION", "META_ASTANA_CITY_KEY", "META_VIDEO_PROCESSING_POLL_ATTEMPTS", "META_VIDEO_PROCESSING_POLL_DELAY_MS",
  "TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID", "TIKTOK_APP_ID", "TIKTOK_APP_SECRET", "TIKTOK_WORKSPACE_ID", "TIKTOK_IDENTITY_ID",
  "TIKTOK_IDENTITY_AUTHORIZED_BC_ID", "TIKTOK_IDENTITY_TYPE",
  "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WAZZUP_API_KEY", "WAZZUP_WEBHOOK_SECRET", "WAZZUP_CRM_KEY", "WAZZUP_DEFAULT_CLINIC_ID",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NEGIS_VAPID_PUBLIC_KEY", "NEGIS_VAPID_PRIVATE_KEY", "NEGIS_VAPID_SUBJECT",
  "NEGIS_API_BASE_URL", "META_INSIGHTS_WORKER_SECRET", "META_INSIGHTS_WORKSPACE_ALLOWLIST", "META_INSIGHTS_WORKSPACE_IDS",
  "META_INSIGHTS_WORKER_ID", "META_INSIGHTS_MAX_LAUNCHES", "META_INSIGHTS_REQUEST_TIMEOUT_MS", "META_INSIGHTS_WORKER_MAX_CLOCK_SKEW_SECONDS",
  "VIDEO_OPTIMIZATION_WORKER_SECRET", "VIDEO_OPTIMIZATION_THRESHOLD_MB", "VIDEO_OPTIMIZATION_MAX_INPUT_MB", "VIDEO_OPTIMIZATION_RAW_BUCKET", "VIDEO_OPTIMIZATION_OUTPUT_BUCKET",
  "VIDEO_WORKER_POLL_INTERVAL_MS", "VIDEO_WORKER_ID", "VIDEO_WORKER_MAX_ATTEMPTS", "VIDEO_WORKER_MAX_CONCURRENT_JOBS", "VIDEO_WORKER_TMP_DIR",
  "VIDEO_WORKER_CRF", "VIDEO_WORKER_PRESET", "VIDEO_WORKER_MAX_WIDTH", "VIDEO_WORKER_MAX_HEIGHT", "VIDEO_WORKER_FPS", "FFMPEG_PATH", "FFPROBE_PATH",
  "TARGETING_AGENT_API_KEY", "MEDINA_PLATFORM_OWNER_IDS", "MEDINA_CONTROL_ORIGINS", "MEDINA_APP_ORIGIN",
  "MEDINA_PUBLIC_SITE_WORKSPACE_ID", "MEDINA_SITE_ORIGIN", "MEDINA_SITE_API_ORIGIN", "MEDINA_SITE_CONSENT_VERSION",
  "MEDINA_SITE_INTAKE_KEY", "MEDINA_SITE_TURNSTILE_SECRET", "MEDINA_SITE_TURNSTILE_SITE_KEY",
  "VERCEL_ENV", "VERCEL_GIT_COMMIT_REF", "VERCEL_URL", "NODE_OPTIONS", "NODE_PATH",
]);

export const falseFlags = Object.freeze([
  "META_VIDEO_LAUNCH_ENABLED", "TIKTOK_DISABLED_LAUNCH_ENABLED", "TIKTOK_VIDEO_UPLOAD_ENABLED", "VIDEO_OPTIMIZATION_ENABLED",
  "MEDINA_PUBLIC_SITE_ENABLED", "MEDINA_SITE_INDEXABLE", "MEDINA_SITE_FORM_ENABLED", "MEDINA_SITE_INTAKE_ENABLED",
]);

export const permittedSystemKeys = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
]);

export function syntheticProcessEnvironment(system = {}) {
  const result = Object.create(null);
  for (const key of permittedSystemKeys) {
    if (Object.hasOwn(system, key) && typeof system[key] === "string") result[key] = system[key];
  }
  Object.assign(result, { NODE_ENV: "test", TZ: "UTC", VITE_API_BASE_URL: "/", TARGETING_AGENT_URL: "http://127.0.0.1:1" });
  for (const key of falseFlags) result[key] = "false";
  return result;
}

export const prohibitedEntrypoints = Object.freeze([
  "artifacts/video-worker/src/index.ts", "artifacts/meta-insights-worker/src/index.ts",
  "supabase/functions/wazzup-webhook/index.ts", "supabase/functions/wazzup-send/index.ts",
  "artifacts/api-server/src/index.ts",
]);

export const isolatedTestFiles = Object.freeze([
  "scripts/fixtures/readiness-isolation-profile.test.mjs",
  "scripts/src/medina-isolation-ai-readers.test.ts",
  "scripts/src/medina-isolation-browser-bindings.test.ts",
  "scripts/src/medina-isolation-legacy-senders.test.ts",
  "scripts/src/medina-isolation-site-build.test.ts",
  "scripts/src/medina-update-prompt-lifetime.test.ts",
  "scripts/src/medina-installable-app.test.ts",
  "scripts/src/medina-service-worker-cache.test.ts",
  "scripts/fixtures/pwa-build.test.mjs",
  "scripts/src/medina-appointment-capacity-identity.test.ts",
  "scripts/src/medina-mortgage-results-ui.test.ts",
  "scripts/src/medina-mortgage-activity-ui.test.ts",
  "scripts/src/medina-analytics-report-lifetime.test.ts",
  "scripts/src/medina-auth-profile-session.test.ts",
  "scripts/src/medina-signout-boundary.test.ts",
]);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type UsageModule = {
  billableVideoSeconds: (value: unknown) => number;
  quotaForPlan: (plan: "basic" | "standard" | "pro" | null, kind: "text_request" | "image" | "video_seconds") => number | null;
  summarizeUsageRows: (rows: Array<{ kind?: unknown; units?: unknown; status?: unknown }>) => Record<string, number>;
};

const usage = await import(pathToFileURL(path.join(repoRoot, "lib", "content-studio", "usage.ts")).href) as UsageModule;
const migration = await readFile(path.join(repoRoot, "migrations", "051_content_generation_usage.sql"), "utf8");
const route = await readFile(path.join(repoRoot, "api", "content-studio", "[...path].ts"), "utf8");
const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx"), "utf8");

test("CU1 media quotas come from the commercial plan, while text is only accounted", () => {
  assert.equal(usage.quotaForPlan("basic", "image"), 0);
  assert.equal(usage.quotaForPlan("standard", "image"), 60);
  assert.equal(usage.quotaForPlan("pro", "image"), 150);
  assert.equal(usage.quotaForPlan("standard", "video_seconds"), 0);
  assert.equal(usage.quotaForPlan("pro", "video_seconds"), 180);
  assert.equal(usage.quotaForPlan("pro", "text_request"), null);
  assert.equal(usage.quotaForPlan(null, "image"), 0);
});

test("CU2 video usage has a bounded deterministic unit", () => {
  assert.equal(usage.billableVideoSeconds("12"), 12);
  assert.equal(usage.billableVideoSeconds("") , 8);
  assert.equal(usage.billableVideoSeconds("0"), 8);
  assert.equal(usage.billableVideoSeconds("999"), 8);
  assert.equal(usage.billableVideoSeconds("not-a-number"), 8);
});

test("CU3 reserved, successful and uncertain calls consume quota; known failures do not", () => {
  assert.deepEqual(
    usage.summarizeUsageRows([
      { kind: "image", units: 1, status: "reserved" },
      { kind: "image", units: 2, status: "succeeded" },
      { kind: "image", units: 4, status: "unknown" },
      { kind: "image", units: 8, status: "failed" },
      { kind: "video_seconds", units: 12, status: "succeeded" },
      { kind: "text_request", units: 3, status: "succeeded" },
      { kind: "other", units: 100, status: "succeeded" },
    ]),
    { text_request: 3, image: 7, video_seconds: 12 },
  );
});

test("CU4 migration serializes reservations and keeps receipts server-only", () => {
  assert.match(migration, /create table if not exists public\.content_generation_usage/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /unique \(workspace_id, request_key\)/i);
  assert.match(migration, /status in \('reserved', 'succeeded', 'failed', 'unknown'\)/i);
  assert.match(migration, /revoke all on table public\.content_generation_usage from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.content_generation_usage to service_role/i);
  assert.doesNotMatch(migration, /\b(prompt|raw_response|access_token|service_role_key|public_url)\s+(text|json|jsonb)/i);
});

test("CU5 paid media is reserved before provider calls and completion is durable", () => {
  const imageReservation = route.indexOf('operation: "generated_image"');
  const imageProvider = route.indexOf("image = await generateImage");
  const videoReservation = route.indexOf('operation: "generated_video"');
  const videoProvider = route.indexOf("const job = await createVideoJob");
  assert.ok(imageReservation > 0 && imageReservation < imageProvider);
  assert.ok(videoReservation > 0 && videoReservation < videoProvider);
  assert.match(route, /completeContentGeneration/);
  assert.match(route, /generation_quota_exceeded/);
  assert.match(route, /x-idempotency-key/);
  assert.match(page, /X-Idempotency-Key/);
  assert.match(route, /usage:\s*\{[\s\S]*?kind:\s*"browser"[\s\S]*?view_ai_content/);
});

test("CU6 Content Studio shows the plan balance without exposing technical receipts", () => {
  assert.match(page, /Лимит креативов/);
  assert.match(page, /Изображения:/);
  assert.match(page, /Видео:/);
  assert.match(page, /Лимит обновляется в начале месяца/);
  assert.match(page, /\/api\/content-studio\/usage/);
  assert.doesNotMatch(page, /content_generation_usage|usageId|request_key/);
});

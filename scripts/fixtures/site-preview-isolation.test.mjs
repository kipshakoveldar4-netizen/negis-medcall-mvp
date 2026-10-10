import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { previewIsolation as plan, previewUiOverrides as ui } from "./site-preview-isolation.mjs";

const root = process.env.MEDINA_PREVIEW_SOURCE_ROOT
  ? path.resolve(process.env.MEDINA_PREVIEW_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
const calls = [];
// Never inherit credentials, DB URLs or an external agent URL into the tests.
process.env = { NODE_ENV: "test", ...ui };
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init?.headers });
  throw new Error("Network disabled in preview isolation fixture");
};
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
afterEach(() => { assert.equal(calls.length, 0, "unexpected fetch attempt"); });

const sourceFiles = [
  "lib/ai/text-provider.ts", "lib/content-studio/generation.ts",
  "lib/meta/marketing.ts", "lib/tiktok/diagnostics.ts",
  "lib/auth/worker.ts", "lib/crm/web-push.ts", "lib/auth/platform.ts",
  "lib/auth/cors.ts", "lib/targeting-agent/client.ts",
  "lib/whatsapp-cloud/webhook.ts", "lib/wazzup/webhook.ts",
  "lib/crm/site-page.ts", "lib/crm/site-intake-handler.ts",
];
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const [ai, studio, meta, tiktok, worker, push, platform, cors, targeting, whatsapp, wazzup, site, intake] =
  await Promise.all(sourceFiles.map(load));

test("tested configuration readers match the pinned release candidate", () => {
  for (const file of sourceFiles) {
    const expected = execFileSync("git", ["show", `${plan.candidate}:${file}`], {
      cwd: root, env: originalEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n"), expected.replace(/\r\n/g, "\n"), file);
  }
});

test("plan is branch-only, non-secret and leaves the approved Supabase overrides intact", () => {
  assert.equal(plan.target, "preview");
  assert.equal(plan.branch, "codex/site-blog-release-20260929");
  assert.equal(plan.supabaseProject, "ukiobbwsdoblooynzlnx");
  assert.equal(Object.keys(plan.overrides).some((key) => key.includes("SUPABASE")), false);
  for (const [key, value] of Object.entries(plan.overrides)) {
    assert.ok(value === "" || value === "false" || (key === "TARGETING_AGENT_URL" && value === "http://127.0.0.1:1"));
  }
  assert.equal(plan.overrides.VITE_API_BASE_URL, "");
  assert.equal(plan.overrides.DATABASE_URL, "");
  assert.equal(plan.overrides.MEDINA_APP_ORIGIN, "", "Preview must not inherit a production auth-link origin");
});

test("both AI keys must be blank; removing only one leaves a fallback provider", async () => {
  const env = ui;
  assert.equal(ai.resolveTextProvider({ ...env, OPENAI_API_KEY: "fixture-not-a-key" }), "openai");
  assert.equal(ai.resolveTextProvider({ ...env, ANTHROPIC_API_KEY: "fixture-not-a-key" }), "anthropic");
  assert.equal(ai.resolveTextProvider(env), null);
  const result = await ai.generateText({ system: "fixture", user: {}, purpose: "ads" }, { env });
  assert.equal(result.ok, false);
  assert.equal(studio.imageGenerationRefusal(studio.readGenerationConfig(env))?.status, 503);
  assert.equal(studio.videoGenerationRefusal(studio.readGenerationConfig(env))?.status, 503);
});

test("UI overrides use whitespace only for blanks and no synthetic database URL", () => {
  assert.equal(Object.hasOwn(ui, "DATABASE_URL"), false);
  assert.equal(ui.VITE_API_BASE_URL, "/");
  const apiSource = readFileSync(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8");
  assert.ok(apiSource.includes('?.replace(/\\/$/, "") || ""'));
  assert.equal(ui.VITE_API_BASE_URL.replace(/\/$/, ""), "");
  for (const [key, value] of Object.entries(plan.overrides)) {
    if (key === "DATABASE_URL" || key === "VITE_API_BASE_URL") continue;
    assert.equal(ui[key], value === "" ? " " : value, key);
  }
});

test("Meta is unconfigured and cannot make a diagnostic request", async () => {
  assert.equal(meta.getMetaConfig().configured, false);
  assert.equal(meta.isMetaVideoLaunchEnabled(), false);
  await assert.rejects(meta.metaRequest("fixture", "GET"), /not configured/);
});

test("TikTok diagnostics and OAuth remain unconfigured", async () => {
  assert.equal(tiktok.getTikTokAdsConfig(ui).configured, false);
  assert.equal(tiktok.getTikTokAdsConfig(ui).oauthReady, false);
  const result = await tiktok.validateTikTokAdsConnection({ env: ui });
  assert.equal(result.errorCode, "not_configured");
  assert.equal(plan.overrides.TIKTOK_DISABLED_LAUNCH_ENABLED, "false");
  assert.equal(plan.overrides.TIKTOK_VIDEO_UPLOAD_ENABLED, "false");
});

test("worker auth fails closed; no workspace or push configuration is inherited", () => {
  assert.throws(() => worker.getWorkerAuthConfig(ui), (error) => error.statusCode === 503 && error.reason === "not_configured");
  assert.deepEqual(worker.getWorkerWorkspaceAllowlist(ui), []);
  assert.equal(push.readVapidKeys(ui), null);
  assert.deepEqual(platform.platformOwnerIds(ui), []);
  assert.deepEqual(cors.parseControlOrigins(ui.MEDINA_CONTROL_ORIGINS), []);
});

function response() {
  return {
    code: 0, body: null,
    status(code) { this.code = code; return this; },
    setHeader() { return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

for (const method of ["GET", "POST"]) {
  test(`WhatsApp ${method} rejects before parsing or database access`, async () => {
    const res = response();
    await whatsapp.handleWhatsAppCloudWebhook({ method, query: {}, headers: {} }, res, Buffer.from("{}"));
    assert.equal(res.code, 503);
  });
}

test("Wazzup cannot accept an inherited webhook credential", async () => {
  const res = response();
  await wazzup.handleWazzupWebhook({ method: "POST", headers: {}, body: { test: true } }, res);
  assert.equal(res.code, 503);
});

test("Targeting Agent is loopback-only, not falsely described as disabled", async () => {
  try {
    const result = await new targeting.TargetingAgentClient().healthCheck();
    assert.equal(result.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:1/health");
    assert.equal(calls[0].headers["x-api-key"], undefined);
  } finally { calls.length = 0; }
});

test("public site and intake stay closed until a separate test publication step", () => {
  assert.equal(site.publicSiteConfig(ui), null);
  assert.equal(intake.readSiteIntakeConfig(ui), null);
  assert.equal(plan.overrides.MEDINA_SITE_INDEXABLE, "false");
  assert.equal(plan.overrides.MEDINA_SITE_FORM_ENABLED, "false");
});

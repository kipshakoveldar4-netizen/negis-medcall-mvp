import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const briefModulePath = path.join(
  repoRoot,
  "lib",
  "advertising",
  "campaignBrief.ts",
);
const importedBrief = await import(
  `${pathToFileURL(briefModulePath).href}?test=${Date.now()}`
);

type Platform = "meta" | "tiktok";
type Prefill = {
  schemaVersion: 1;
  platform: Platform;
  sourceModule: "content-studio";
  sourceKind: "photo" | "generated" | "package" | "library";
  sourceId?: string;
  campaignName?: string;
  service?: string;
  city?: string;
  offer?: string;
  audience?: string;
  primaryText?: string;
  headline?: string;
  description?: string;
  cta?: string;
  creative?: {
    type: "image" | "video";
    url?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    format?: string;
    brief?: string;
  };
};

type BriefModule = {
  ADVERTISING_CAMPAIGN_PREFILL_KEY: string;
  ADVERTISING_CAMPAIGN_BRIEF_VERSION: 1;
  createAdvertisingCampaignPrefill(input: Record<string, unknown>): Prefill;
  parseAdvertisingCampaignPrefill(value: unknown): Prefill | null;
  parseAdvertisingCampaignPrefillForPlatform(
    value: unknown,
    platform: Platform,
  ): Prefill | null;
};

const campaignBrief = ((importedBrief as { default?: unknown }).default ??
  importedBrief) as BriefModule;

test("creates one versioned Meta handoff with nested creative metadata", () => {
  const prefill = campaignBrief.createAdvertisingCampaignPrefill({
    platform: "meta",
    sourceKind: "photo",
    campaignName: "Уход за кожей",
    service: "Консультация косметолога",
    city: "Астана",
    offer: "Первичная консультация",
    audience: "Женщины 25-45",
    primaryText: "Запишитесь на консультацию",
    headline: "Консультация в Астане",
    cta: "LEARN_MORE",
    creative: {
      type: "image",
      url: "https://cdn.example.test/creative.jpg",
      fileName: "creative.jpg",
      mimeType: "image/jpeg",
      fileSize: 2048,
      format: "story",
    },
  });

  assert.equal(prefill.schemaVersion, 1);
  assert.equal(prefill.platform, "meta");
  assert.equal(prefill.sourceModule, "content-studio");
  assert.equal(prefill.sourceKind, "photo");
  assert.deepEqual(prefill.creative, {
    type: "image",
    url: "https://cdn.example.test/creative.jpg",
    fileName: "creative.jpg",
    mimeType: "image/jpeg",
    fileSize: 2048,
    format: "story",
  });
});

test("normalizes the legacy Content Studio photo payload", () => {
  const prefill = campaignBrief.parseAdvertisingCampaignPrefill({
    source: "content_studio_photo",
    title: "Фото клиники",
    niche: "Косметология",
    city: "Astana",
    targetAudience: "Женщины 25-45",
    adText: "Безопасный текст объявления",
    caption: "Описание",
    hook: "Заголовок",
    creativeUrl: "https://cdn.example.test/legacy.jpg",
    creativeType: "image",
    fileSize: 512.9,
    format: "story",
  });

  assert.ok(prefill);
  assert.equal(prefill.platform, "meta", "legacy handoffs remain Meta-only");
  assert.equal(prefill.sourceKind, "photo");
  assert.equal(prefill.campaignName, "Фото клиники");
  assert.equal(prefill.service, "Косметология");
  assert.equal(prefill.audience, "Женщины 25-45");
  assert.equal(prefill.primaryText, "Безопасный текст объявления");
  assert.equal(prefill.headline, "Заголовок");
  assert.equal(prefill.creative?.url, "https://cdn.example.test/legacy.jpg");
  assert.equal(prefill.creative?.fileSize, 512);
});

test("normalizes legacy library aliases without inventing a creative", () => {
  const prefill = campaignBrief.parseAdvertisingCampaignPrefill({
    sourceModule: "content-studio",
    contentPackageId: "content-1",
    title: "Reels о консультации",
    niche: "Дерматология",
    targetAudience: "Жители Алматы",
    script: "Сценарий ролика",
    description: "Запись через WhatsApp",
  });

  assert.ok(prefill);
  assert.equal(prefill.sourceKind, "package");
  assert.equal(prefill.sourceId, "content-1");
  assert.equal(prefill.service, "Дерматология");
  assert.equal(prefill.primaryText, "Сценарий ролика");
  assert.equal(prefill.creative, undefined);
});

test("keeps TikTok drafts isolated from the working Meta launcher", () => {
  const tiktokPrefill = campaignBrief.createAdvertisingCampaignPrefill({
    platform: "tiktok",
    sourceKind: "generated",
    service: "Диагностика",
    city: "Алматы",
    primaryText: "Вертикальный ролик",
    creative: { type: "video", url: "https://cdn.example.test/video.mp4" },
  });

  assert.equal(
    campaignBrief.parseAdvertisingCampaignPrefillForPlatform(
      tiktokPrefill,
      "meta",
    ),
    null,
  );
  assert.equal(
    campaignBrief.parseAdvertisingCampaignPrefillForPlatform(
      tiktokPrefill,
      "tiktok",
    )?.platform,
    "tiktok",
  );
});

test("rejects unsupported versions, unknown platforms and empty payloads", () => {
  assert.equal(
    campaignBrief.parseAdvertisingCampaignPrefill({
      schemaVersion: 2,
      service: "Test",
    }),
    null,
  );
  assert.equal(
    campaignBrief.parseAdvertisingCampaignPrefill({
      platform: "other",
      service: "Test",
    }),
    null,
  );
  assert.equal(
    campaignBrief.parseAdvertisingCampaignPrefill({ platform: "meta" }),
    null,
  );
  assert.throws(
    () =>
      campaignBrief.createAdvertisingCampaignPrefill({
        platform: "meta",
        sourceKind: "package",
      }),
    /must contain campaign or creative data/,
  );
});

test("exports the workspace-scoped handoff key without storing platform credentials", () => {
  assert.equal(
    campaignBrief.ADVERTISING_CAMPAIGN_PREFILL_KEY,
    "negis_ads_automation_prefill",
  );
  assert.equal(campaignBrief.ADVERTISING_CAMPAIGN_BRIEF_VERSION, 1);
  const moduleSource = JSON.stringify(Object.keys(importedBrief));
  assert.doesNotMatch(moduleSource, /token|secret|access_key/i);
});

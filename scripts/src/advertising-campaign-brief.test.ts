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
const evidenceModulePath = path.join(
  repoRoot,
  "lib",
  "advertising",
  "creativeEvidence.ts",
);
const importedEvidence = await import(
  `${pathToFileURL(evidenceModulePath).href}?test=${Date.now()}`
);

type Platform = "meta" | "tiktok";
type ContentApproval = {
  packageId?: string;
  variantId: string;
  variantLabel?: string;
  variantAngle?: string;
  version: 1;
  approvedAt: string;
  approvedCopy: {
    primaryText: string;
    headline: string;
    description: string;
  };
  copyMatchesLaunch?: boolean;
};
type Prefill = {
  schemaVersion: 1;
  platform: Platform;
  sourceModule: "content-studio" | "advertising-hub";
  sourceKind: "photo" | "generated" | "package" | "library" | "goal";
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
  targetPatients?: number;
  durationDays?: number;
  maxBudget?: number;
  dailyBudget?: number;
  budgetCurrency?: "USD" | "KZT";
  creative?: {
    type: "image" | "video";
    assetId?: string;
    url?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    thumbnailUrl?: string;
    thumbnailSource?: string;
    format?: string;
    brief?: string;
  };
  contentApproval?: ContentApproval;
};

type BriefModule = {
  ADVERTISING_CAMPAIGN_PREFILL_KEY: string;
  ADVERTISING_CONTENT_STUDIO_PREFILL_KEY: string;
  ADVERTISING_CAMPAIGN_BRIEF_VERSION: 1;
  ADVERTISING_CONTENT_APPROVAL_VERSION: 1;
  createAdvertisingCampaignPrefill(input: Record<string, unknown>): Prefill;
  normalizeAdvertisingContentApproval(value: unknown): ContentApproval | undefined;
  contentApprovalMatchesCopy(approval: ContentApproval, copy: Record<string, string>): boolean;
  parseAdvertisingCampaignPrefill(value: unknown): Prefill | null;
  parseAdvertisingCampaignPrefillForPlatform(
    value: unknown,
    platform: Platform,
  ): Prefill | null;
};

const campaignBrief = ((importedBrief as { default?: unknown }).default ??
  importedBrief) as BriefModule;
const creativeEvidence = ((importedEvidence as { default?: unknown }).default ??
  importedEvidence) as {
  buildCreativeExperimentGroups(
    launches: Array<Record<string, unknown>>,
    summaries: Array<Record<string, unknown>>,
  ): Array<{
    packageId: string;
    reviewState: "same_period" | "partial" | "not_ready";
    coveredDateStart: string | null;
    coveredDateStop: string | null;
    items: Array<{ approval: ContentApproval }>;
  }>;
};

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

test("keeps an owner goal handoff explicit without inventing performance", () => {
  const prefill = campaignBrief.createAdvertisingCampaignPrefill({
    platform: "meta",
    sourceModule: "advertising-hub",
    sourceKind: "goal",
    campaignName: "Консультация · Астана",
    service: "Консультация",
    city: "Астана",
    targetPatients: 20,
    durationDays: 14,
    maxBudget: 280,
    dailyBudget: 20,
    budgetCurrency: "USD",
  });

  assert.equal(prefill.sourceModule, "advertising-hub");
  assert.equal(prefill.sourceKind, "goal");
  assert.equal(prefill.targetPatients, 20);
  assert.equal(prefill.durationDays, 14);
  assert.equal(prefill.maxBudget, 280);
  assert.equal(prefill.dailyBudget, 20);
  assert.equal(prefill.budgetCurrency, "USD");
  assert.equal("expectedPatients" in prefill, false);
  assert.equal("forecast" in prefill, false);
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

test("preserves generated video asset and cover metadata for the Meta handoff", () => {
  const prefill = campaignBrief.createAdvertisingCampaignPrefill({
    platform: "meta",
    sourceKind: "generated",
    service: "Консультация",
    creative: {
      type: "video",
      assetId: "6d4c7a93-c66d-4e16-9eb4-fdf430f50b7f",
      url: "https://cdn.example.test/generated.mp4",
      fileName: "negis-video.mp4",
      mimeType: "video/mp4",
      fileSize: 4096,
      thumbnailUrl: "https://cdn.example.test/generated-cover.jpg",
      thumbnailSource: "auto_frame",
    },
  });

  assert.deepEqual(prefill.creative, {
    type: "video",
    assetId: "6d4c7a93-c66d-4e16-9eb4-fdf430f50b7f",
    url: "https://cdn.example.test/generated.mp4",
    fileName: "negis-video.mp4",
    mimeType: "video/mp4",
    fileSize: 4096,
    thumbnailUrl: "https://cdn.example.test/generated-cover.jpg",
    thumbnailSource: "auto_frame",
  });
});

test("preserves an approved content variant and detects later copy changes", () => {
  const approval: ContentApproval = {
    packageId: "5d466256-5de8-4c13-bcf0-84072668e5d7",
    variantId: "expert",
    variantLabel: "Экспертное объяснение",
    variantAngle: "Объясняет первый визит",
    version: 1,
    approvedAt: "2026-09-14T09:00:00.000Z",
    approvedCopy: {
      primaryText: "Врач ответит на вопросы на консультации.",
      headline: "Консультация со специалистом",
      description: "Понятный первый шаг",
    },
  };
  const prefill = campaignBrief.createAdvertisingCampaignPrefill({
    platform: "meta",
    sourceKind: "package",
    service: "Консультация",
    primaryText: approval.approvedCopy.primaryText,
    headline: approval.approvedCopy.headline,
    contentApproval: approval,
  });

  assert.deepEqual(prefill.contentApproval, approval);
  assert.equal(campaignBrief.contentApprovalMatchesCopy(approval, approval.approvedCopy), true);
  assert.equal(
    campaignBrief.contentApprovalMatchesCopy(approval, {
      ...approval.approvedCopy,
      headline: "Другой заголовок",
    }),
    false,
  );
  assert.equal(
    campaignBrief.normalizeAdvertisingContentApproval({ ...approval, version: 2 }),
    undefined,
    "unknown approval versions must fail closed",
  );
  assert.equal(
    campaignBrief.normalizeAdvertisingContentApproval({
      ...approval,
      copyMatchesLaunch: false,
    })?.copyMatchesLaunch,
    false,
    "launch history must preserve an explicit copy mismatch",
  );
});

test("groups only unchanged approved variants without inventing a winner", () => {
  const approval = (variantId: string, variantLabel: string, copyMatchesLaunch = true) => ({
    packageId: "package-1",
    variantId,
    variantLabel,
    version: 1,
    approvedAt: "2026-09-15T09:00:00.000Z",
    approvedCopy: {
      primaryText: `${variantLabel} body`,
      headline: `${variantLabel} headline`,
      description: `${variantLabel} description`,
    },
    copyMatchesLaunch,
  });
  const launches = [
    { id: "launch-direct", campaignName: "Direct", createdAt: "2026-09-15T10:00:00.000Z", contentApproval: approval("direct", "Прямой оффер") },
    { id: "launch-trust", campaignName: "Trust", createdAt: "2026-09-15T11:00:00.000Z", contentApproval: approval("trust", "Доверие") },
    { id: "launch-edited", campaignName: "Edited", createdAt: "2026-09-15T12:00:00.000Z", contentApproval: approval("expert", "Экспертный", false) },
  ];
  const summary = (metaCampaignLaunchId: string) => ({
    metaCampaignLaunchId,
    availability: "available",
    coveredDateStart: "2026-09-10",
    coveredDateStop: "2026-09-14",
    latestFetchedAt: "2026-09-15T08:00:00.000Z",
    rowCount: 5,
    spendByCurrency: [{ currency: "USD", currencyExponent: 2, spendMinor: "1250" }],
    impressions: "1000",
    clicks: "50",
    inlineLinkClicks: "40",
    metaLeads: "3",
  });

  const groups = creativeEvidence.buildCreativeExperimentGroups(
    launches,
    [summary("launch-direct"), summary("launch-trust")],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].reviewState, "same_period");
  assert.equal(groups[0].coveredDateStart, "2026-09-10");
  assert.equal(groups[0].items.length, 2, "edited copy must not enter the experiment evidence");
  assert.deepEqual(
    groups[0].items.map((item) => item.approval.variantId).sort(),
    ["direct", "trust"],
  );
  assert.doesNotMatch(JSON.stringify(groups), /winner|score|cpl|roi|romi/i);

  const partial = creativeEvidence.buildCreativeExperimentGroups(
    launches,
    [summary("launch-direct")],
  );
  assert.equal(partial[0].reviewState, "partial");
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
  assert.equal(
    campaignBrief.ADVERTISING_CONTENT_STUDIO_PREFILL_KEY,
    "negis_content_studio_goal_prefill",
  );
  assert.equal(campaignBrief.ADVERTISING_CAMPAIGN_BRIEF_VERSION, 1);
  assert.equal(campaignBrief.ADVERTISING_CONTENT_APPROVAL_VERSION, 1);
  const moduleSource = JSON.stringify(Object.keys(importedBrief));
  assert.doesNotMatch(moduleSource, /token|secret|access_key/i);
});

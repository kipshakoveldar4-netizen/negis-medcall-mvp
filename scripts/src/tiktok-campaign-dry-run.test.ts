import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "tiktok", "campaign.ts");
const imported = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);

type DryRun = {
  platform: "tiktok";
  dryRun: true;
  launchEnabled: false;
  targetOperationStatus: "DISABLE";
  readiness: {
    briefReady: boolean;
    providerReady: false;
    blockers: Array<{ code: string; message: string }>;
    providerDependencies: Array<{ code: string; message: string }>;
  };
  summary: {
    dailyBudget: string;
    currency: string;
    destinationConfigured: boolean;
    creativeType: string;
    status: string;
  };
  payloadTemplate: {
    campaign: Record<string, unknown>;
    adGroup: Record<string, unknown>;
    ad: Record<string, unknown>;
  };
  safety: {
    providerCallsMade: false;
    createsCampaign: false;
    credentialsIncluded: false;
    rawCreativeUrlIncluded: false;
  };
};

type CampaignModule = {
  TIKTOK_CAMPAIGN_CREATE_ENDPOINT: string;
  TIKTOK_ADGROUP_CREATE_ENDPOINT: string;
  TIKTOK_AD_CREATE_ENDPOINT: string;
  TIKTOK_DISABLED_OPERATION_STATUS: "DISABLE";
  buildTikTokCampaignDryRun(
    value: unknown,
    context?: {
      advertiserConfigured?: boolean;
      identityConfigured?: boolean;
      locationIds?: readonly string[];
      uploadedVideoIdAvailable?: boolean;
    },
  ): DryRun;
};

const campaign = ((imported as { default?: unknown }).default ?? imported) as CampaignModule;

function validInput() {
  return {
    brief: {
      schemaVersion: 1,
      platform: "tiktok",
      sourceModule: "content-studio",
      sourceKind: "generated",
      campaignName: "Консультация · Алматы",
      service: "Консультация косметолога",
      city: "Алматы",
      primaryText: "Запишитесь на консультацию: специалист объяснит доступные варианты.",
      creative: {
        type: "video",
        url: "https://private.example.test/creative.mp4",
      },
    },
    dailyBudget: "5000,50",
    currency: "KZT",
    destinationUrl: "https://clinic.example.test/booking",
    scheduleStartTime: "2026-09-10T09:30",
  };
}

function creativeFrom(result: DryRun): Record<string, unknown> {
  const creatives = result.payloadTemplate.ad.creatives;
  assert.ok(Array.isArray(creatives));
  const first = creatives[0];
  assert.ok(first && typeof first === "object" && !Array.isArray(first));
  return first as Record<string, unknown>;
}

test("builds a disabled-first campaign, ad group and ad template without provider calls", () => {
  const result = campaign.buildTikTokCampaignDryRun(validInput(), {
    advertiserConfigured: true,
    identityConfigured: true,
    locationIds: ["123456789"],
    uploadedVideoIdAvailable: true,
  });

  assert.equal(result.platform, "tiktok");
  assert.equal(result.dryRun, true);
  assert.equal(result.launchEnabled, false);
  assert.equal(result.targetOperationStatus, "DISABLE");
  assert.equal(result.readiness.briefReady, true);
  assert.equal(result.readiness.providerReady, false, "live provider adapter remains disabled");
  assert.deepEqual(result.readiness.providerDependencies.map((item) => item.code), ["live_adapter_disabled"]);

  assert.equal(result.payloadTemplate.campaign.operation_status, "DISABLE");
  assert.equal(result.payloadTemplate.campaign.objective_type, "TRAFFIC");
  assert.equal(result.payloadTemplate.campaign.budget_optimize_on, false);
  assert.equal(result.payloadTemplate.adGroup.operation_status, "DISABLE");
  assert.deepEqual(result.payloadTemplate.adGroup.placements, ["PLACEMENT_TIKTOK"]);
  assert.equal(result.payloadTemplate.adGroup.budget_mode, "BUDGET_MODE_DAY");
  assert.equal(result.payloadTemplate.adGroup.budget, 5000.5);
  assert.equal(creativeFrom(result).operation_status, "DISABLE");
  assert.equal(creativeFrom(result).ad_format, "SINGLE_VIDEO");

  assert.deepEqual(result.safety, {
    providerCallsMade: false,
    createsCampaign: false,
    credentialsIncluded: false,
    rawCreativeUrlIncluded: false,
  });
});

test("keeps credentials and raw creative URLs out of the browser-safe template", () => {
  const result = campaign.buildTikTokCampaignDryRun(validInput(), {
    advertiserConfigured: true,
    identityConfigured: true,
    locationIds: ["123456789"],
    uploadedVideoIdAvailable: true,
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /private\.example\.test/);
  assert.doesNotMatch(serialized, /clinic\.example\.test/);
  assert.doesNotMatch(serialized, /access[_-]?token|app[_-]?secret/i);
  assert.match(serialized, /__SERVER_ADVERTISER_ID__/);
  assert.match(serialized, /__CONFIGURED_DESTINATION_URL__/);
  assert.equal(result.summary.destinationConfigured, true);
  assert.equal(result.summary.dailyBudget, "5000.50");
  assert.equal(result.summary.currency, "KZT");
});

test("reports every unresolved provider dependency without inventing identifiers", () => {
  const result = campaign.buildTikTokCampaignDryRun(validInput());
  assert.equal(result.readiness.briefReady, true);
  assert.deepEqual(result.readiness.providerDependencies.map((item) => item.code), [
    "advertiser_not_configured",
    "identity_not_configured",
    "location_not_resolved",
    "video_upload_required",
    "live_adapter_disabled",
  ]);
  assert.equal("location_ids" in result.payloadTemplate.adGroup, false);
  assert.equal("identity_id" in creativeFrom(result), false);
  assert.equal("video_id" in creativeFrom(result), false);
});

test("rejects a Meta brief, image creative and incomplete campaign inputs", () => {
  const result = campaign.buildTikTokCampaignDryRun({
    brief: {
      schemaVersion: 1,
      platform: "meta",
      sourceModule: "content-studio",
      sourceKind: "photo",
      creative: { type: "image", url: "https://example.test/image.jpg" },
    },
    dailyBudget: "0",
    currency: "EUR",
    destinationUrl: "javascript:alert(1)",
    scheduleStartTime: "tomorrow",
  });
  const codes = result.readiness.blockers.map((item) => item.code);

  assert.equal(result.readiness.briefReady, false);
  for (const expected of [
    "invalid_brief",
    "campaign_name_required",
    "service_required",
    "city_required",
    "ad_text_required",
    "video_required",
    "destination_required",
    "invalid_currency",
    "schedule_required",
  ]) {
    assert.ok(codes.includes(expected), `missing blocker ${expected}`);
  }
});

test("exports official v1.3 create paths but contains no network implementation", async () => {
  assert.equal(campaign.TIKTOK_CAMPAIGN_CREATE_ENDPOINT, "/open_api/v1.3/campaign/create/");
  assert.equal(campaign.TIKTOK_ADGROUP_CREATE_ENDPOINT, "/open_api/v1.3/adgroup/create/");
  assert.equal(campaign.TIKTOK_AD_CREATE_ENDPOINT, "/open_api/v1.3/ad/create/");
  assert.equal(campaign.TIKTOK_DISABLED_OPERATION_STATUS, "DISABLE");

  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type TikTokLaunchStatus = "creating" | "campaign_created" | "adgroup_created" | "created_disabled" | "failed" | "unknown";
type TikTokLaunchStep = "campaign" | "adgroup" | "ad" | "persistence";
type TikTokLaunchRow = {
  id: string; workspace_id: string; advertiser_id: string; video_upload_id: string;
  requested_by_staff_user_id: string | null; idempotency_key: string; campaign_name: string;
  service: string; city: string; daily_budget_minor: string; currency: string;
  destination_fingerprint: string; operation_status: "DISABLE"; status: TikTokLaunchStatus;
  current_step: "campaign" | "adgroup" | "ad" | "complete"; campaign_id: string | null;
  adgroup_id: string | null; ad_id: string | null; error_step: TikTokLaunchStep | null;
  error_code: string | null; started_at: string; finished_at: string | null;
  created_at: string; updated_at: string;
};
type TikTokLaunchStore = {
  claim(row: TikTokLaunchRow): Promise<{ claimed: boolean; row: TikTokLaunchRow }>;
  advance(row: TikTokLaunchRow, expectedStatus: TikTokLaunchStatus, patch: Partial<TikTokLaunchRow>): Promise<TikTokLaunchRow>;
};
type LaunchSummary = {
  status: TikTokLaunchStatus; targetOperationStatus: "DISABLE"; message: string;
  providerObjects: { campaignCreated: boolean; adGroupCreated: boolean; adCreated: boolean };
  automaticRetryAllowed: false;
};
type CampaignModule = {
  TIKTOK_CAMPAIGN_CREATE_ENDPOINT: string;
  TIKTOK_ADGROUP_CREATE_ENDPOINT: string;
  TIKTOK_AD_CREATE_ENDPOINT: string;
  buildTikTokDisabledLaunchPayloads(value: unknown, identifiers: Record<string, unknown>): {
    dailyBudgetMinor: string; campaign: Record<string, unknown>; adGroup: Record<string, unknown>;
    ad: Record<string, unknown>;
  };
};
type LaunchModule = {
  createTikTokDisabledLaunchService(options: Record<string, unknown>): {
    launch(workspaceId: string, staffUserId: string, value: unknown): Promise<LaunchSummary>;
  };
  TikTokLaunchError: new (
    status: number,
    launchCode: string,
    message: string,
    step?: TikTokLaunchStep,
    uncertain?: boolean,
  ) => Error;
  createTikTokProviderObject(
    endpoint: string,
    payload: Record<string, unknown>,
    accessToken: string,
    step: TikTokLaunchStep,
    options: {
      fetchImpl: (input: string, init: {
        method: "POST"; headers: Record<string, string>; body: string;
        redirect: "error"; signal: AbortSignal;
      }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
      timeoutMs?: number;
    },
  ): Promise<string>;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

async function load<T>(file: string): Promise<T> {
  const value = await import(
    `${pathToFileURL(path.join(repoRoot, file)).href}?test=${Date.now()}`
  );
  return ((value as { default?: unknown }).default ?? value) as T;
}

const campaign = await load<CampaignModule>("lib/tiktok/campaign.ts");
const launch = await load<LaunchModule>("lib/tiktok/launch.ts");

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECEIPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_KEY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = Date.parse("2026-09-08T08:00:00Z");
const ADVERTISER_ID = "7123456789012345678";
const DESTINATION_URL = "https://clinic.example.test/booking";

function validPayload(idempotencyKey = REQUEST_KEY) {
  return {
    brief: {
      schemaVersion: 1,
      platform: "tiktok",
      sourceModule: "content-studio",
      sourceKind: "generated",
      campaignName: "Консультация · Алматы",
      service: "Консультация косметолога",
      city: "Алматы",
      primaryText:
        "Запишитесь на консультацию: специалист объяснит доступные варианты.",
      creative: { type: "video", brief: "Вертикальный ролик" },
    },
    dailyBudget: "5000.50",
    currency: "KZT",
    destinationUrl: DESTINATION_URL,
    scheduleStartTime: "2026-09-10T09:30",
    videoAssetId: ASSET,
    idempotencyKey,
    confirm: true,
    confirmationPhrase: "СОЗДАТЬ",
  };
}

function launchFixture(
  overrides: {
    enabled?: boolean;
    currency?: string;
    readyForAd?: boolean;
    createObject?: (
      step: "campaign" | "adgroup" | "ad" | "persistence",
      endpoint: string,
      payload: Record<string, unknown>,
    ) => Promise<string>;
  } = {},
) {
  let stored: TikTokLaunchRow | null = null;
  let claims = 0;
  let providerChecks = 0;
  let clock = NOW;
  const providerCalls: Array<{
    step: "campaign" | "adgroup" | "ad" | "persistence";
    endpoint: string;
    payload: Record<string, unknown>;
  }> = [];

  const store: TikTokLaunchStore = {
    async claim(row) {
      claims += 1;
      if (stored) return { claimed: false, row: stored };
      stored = structuredClone(row);
      return { claimed: true, row: structuredClone(stored) };
    },
    async advance(row, expectedStatus: TikTokLaunchStatus, patch) {
      assert.equal(row.status, expectedStatus);
      assert.equal(stored?.status, expectedStatus);
      stored = { ...row, ...patch };
      return structuredClone(stored);
    },
  };

  const env = {
    TIKTOK_WORKSPACE_ID: WORKSPACE,
    TIKTOK_ACCESS_TOKEN: "test-token-never-sent",
    TIKTOK_ADVERTISER_ID: ADVERTISER_ID,
    TIKTOK_IDENTITY_ID: "customized-user-01",
    TIKTOK_IDENTITY_TYPE: "CUSTOMIZED_USER",
    TIKTOK_DISABLED_LAUNCH_ENABLED:
      overrides.enabled === false ? "false" : "true",
  };

  const service = launch.createTikTokDisabledLaunchService({
    env,
    store,
    now: () => {
      clock += 1_000;
      return clock;
    },
    readConnection: async () => ({
      state: "connected",
      saved: true,
      launchEnabled: false,
      message: "connected",
      currency: overrides.currency ?? "KZT",
      timezone: "Asia/Almaty",
      verifiedAt: new Date(NOW).toISOString(),
    }),
    validateConnection: async () => {
      providerChecks += 1;
      return {
        configured: true,
        connected: true,
        readOnly: true,
        launchEnabled: false,
        advertiserIdConfigured: true,
        hasAccessToken: true,
        hasAppId: false,
        hasAppSecret: false,
        oauthReady: false,
        checkedAt: new Date(NOW).toISOString(),
        advertiser: {
          maskedId: "********5678",
          name: "Clinic advertiser",
          currency: "KZT",
          timezone: "Asia/Almaty",
          status: "STATUS_ENABLE",
          accountType: "AUCTION",
        },
      };
    },
    verifySetup: async () => ({
      readOnly: true,
      launchEnabled: false,
      checkedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      source: "provider",
      city: {
        status: "verified",
        name: "Almaty",
        countryCode: "KZ",
        message: "verified",
      },
      identity: {
        status: "verified",
        type: "CUSTOMIZED_USER",
        message: "verified",
      },
    }),
    readSetup: () => ({
      locationIds: ["1301649"],
      identityConfigured: true,
      identityType: "CUSTOMIZED_USER",
    }),
    checkVideo: async () => ({
      assetId: ASSET,
      status: "uploaded",
      readinessStatus: overrides.readyForAd === false ? "processing" : "ready",
      message: "ready",
      canRetry: false,
      videoIdAvailable: true,
      readyForAd: overrides.readyForAd !== false,
      checkedAt: new Date(NOW).toISOString(),
    }),
    resolveVideo: async () => ({
      receiptId: RECEIPT,
      videoId: "v070-ready-video",
    }),
    createObject: async (
      step: TikTokLaunchStep,
      endpoint: string,
      payload: Record<string, unknown>,
    ) => {
      providerCalls.push({ step, endpoint, payload: structuredClone(payload) });
      if (overrides.createObject)
        return overrides.createObject(step, endpoint, payload);
      return step === "campaign"
        ? "campaign-01"
        : step === "adgroup"
          ? "adgroup-01"
          : "ad-01";
    },
  });

  return {
    service,
    state: () => ({ stored, claims, providerChecks, providerCalls }),
  };
}

function creative(payload: Record<string, unknown>): Record<string, unknown> {
  const values = payload.creatives;
  assert.ok(Array.isArray(values));
  assert.ok(
    values[0] && typeof values[0] === "object" && !Array.isArray(values[0]),
  );
  return values[0] as Record<string, unknown>;
}

test("server payloads create only disabled TikTok objects with budget at ad-group level", () => {
  const payloads = campaign.buildTikTokDisabledLaunchPayloads(validPayload(), {
    advertiserId: ADVERTISER_ID,
    identityId: "customized-user-01",
    locationIds: ["1301649"],
    videoId: "v070-ready-video",
    idempotencyKey: REQUEST_KEY,
  });

  assert.equal(payloads.campaign.operation_status, "DISABLE");
  assert.equal(payloads.campaign.objective_type, "TRAFFIC");
  assert.equal(payloads.campaign.budget_optimize_on, false);
  assert.equal("budget" in payloads.campaign, false);
  assert.equal(payloads.adGroup.operation_status, "DISABLE");
  assert.equal(payloads.adGroup.budget, 5000.5);
  assert.equal(payloads.adGroup.budget_mode, "BUDGET_MODE_DAY");
  assert.equal(payloads.adGroup.schedule_type, "SCHEDULE_FROM_NOW");
  assert.deepEqual(payloads.adGroup.placements, ["PLACEMENT_TIKTOK"]);
  const adCreative = creative(payloads.ad);
  assert.equal(adCreative.operation_status, "DISABLE");
  assert.equal(adCreative.identity_type, "CUSTOMIZED_USER");
  assert.equal(adCreative.video_id, "v070-ready-video");
  assert.equal(payloads.dailyBudgetMinor, "500050");
  assert.doesNotMatch(JSON.stringify(payloads), /\bENABLE\b|\bACTIVE\b/);
});

test("provider writer uses only the fixed TikTok host and redacts malformed or rejected responses", async () => {
  const providerId = await launch.createTikTokProviderObject(
    campaign.TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
    { operation_status: "DISABLE" },
    "test-token-never-returned",
    "campaign",
    {
      fetchImpl: async (input, init) => {
        assert.equal(input, "https://business-api.tiktok.com/open_api/v1.3/campaign/create/");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers["Access-Token"], "test-token-never-returned");
        assert.deepEqual(JSON.parse(init.body), { operation_status: "DISABLE" });
        assert.doesNotMatch(input, /test-token/);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, data: { campaign_id: "campaign-safe-id" } }),
        };
      },
    },
  );
  assert.equal(providerId, "campaign-safe-id");

  await assert.rejects(
    launch.createTikTokProviderObject(
      campaign.TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
      { operation_status: "DISABLE" },
      "test-token-never-returned",
      "campaign",
      {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => "private malformed body" }),
      },
    ),
    (error: unknown) => {
      const safe = error as { launchCode?: string; message?: string; uncertain?: boolean };
      assert.equal(safe.launchCode, "provider_response_unknown");
      assert.equal(safe.uncertain, true);
      assert.doesNotMatch(safe.message || "", /private|malformed|token/i);
      return true;
    },
  );

  await assert.rejects(
    launch.createTikTokProviderObject(
      campaign.TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
      { operation_status: "DISABLE" },
      "test-token-never-returned",
      "campaign",
      {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ code: 40100, message: "Unauthorized private account detail" }),
        }),
      },
    ),
    (error: unknown) => {
      const safe = error as { launchCode?: string; message?: string };
      assert.equal(safe.launchCode, "provider_auth");
      assert.doesNotMatch(safe.message || "", /private account detail/i);
      return true;
    },
  );
});

test("feature flag blocks before persistence and every provider check", async () => {
  const fixture = launchFixture({ enabled: false });
  await assert.rejects(
    fixture.service.launch(WORKSPACE, STAFF, validPayload()),
    (error: unknown) => {
      assert.equal(
        (error as { launchCode?: string }).launchCode,
        "launch_disabled",
      );
      return true;
    },
  );
  assert.equal(fixture.state().claims, 0);
  assert.equal(fixture.state().providerChecks, 0);
  assert.equal(fixture.state().providerCalls.length, 0);
});

test("successful launch persists progress and returns no provider identifiers or URLs", async () => {
  const fixture = launchFixture();
  const result = await fixture.service.launch(WORKSPACE, STAFF, validPayload());

  assert.equal(result.status, "created_disabled");
  assert.equal(result.targetOperationStatus, "DISABLE");
  assert.deepEqual(result.providerObjects, {
    campaignCreated: true,
    adGroupCreated: true,
    adCreated: true,
  });
  assert.deepEqual(
    fixture.state().providerCalls.map((call) => call.step),
    ["campaign", "adgroup", "ad"],
  );
  assert.deepEqual(
    fixture.state().providerCalls.map((call) => call.endpoint),
    [
      campaign.TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
      campaign.TIKTOK_ADGROUP_CREATE_ENDPOINT,
      campaign.TIKTOK_AD_CREATE_ENDPOINT,
    ],
  );
  assert.equal(fixture.state().stored?.status, "created_disabled");
  assert.equal(fixture.state().stored?.destination_fingerprint.length, 64);
  assert.doesNotMatch(
    JSON.stringify(fixture.state().stored),
    /clinic\.example|test-token|v070-ready-video/,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /campaign-01|adgroup-01|ad-01|clinic\.example|test-token|v070-ready-video/,
  );
  assert.equal(result.automaticRetryAllowed, false);
});

test("a repeated idempotency key returns its receipt without another provider write", async () => {
  const fixture = launchFixture();
  const first = await fixture.service.launch(WORKSPACE, STAFF, validPayload());
  const second = await fixture.service.launch(WORKSPACE, STAFF, validPayload());

  assert.equal(first.status, "created_disabled");
  assert.equal(second.status, "created_disabled");
  assert.equal(fixture.state().claims, 2);
  assert.equal(
    fixture.state().providerCalls.length,
    3,
    "duplicate request performs no provider writes",
  );
});

test("an ambiguous provider result becomes unknown and is never retried automatically", async () => {
  let writes = 0;
  const fixture = launchFixture({
    createObject: async () => {
      writes += 1;
      throw new launch.TikTokLaunchError(
        502,
        "provider_response_unknown",
        "TikTok не подтвердил результат.",
        "campaign",
        true,
      );
    },
  });

  await assert.rejects(
    fixture.service.launch(WORKSPACE, STAFF, validPayload()),
    (error: unknown) => {
      assert.equal(
        (error as { launchCode?: string }).launchCode,
        "provider_response_unknown",
      );
      return true;
    },
  );
  assert.equal(fixture.state().stored?.status, "unknown");
  assert.equal(fixture.state().stored?.error_step, "campaign");
  assert.equal(writes, 1);

  const duplicate = await fixture.service.launch(
    WORKSPACE,
    STAFF,
    validPayload(),
  );
  assert.equal(duplicate.status, "unknown");
  assert.equal(duplicate.automaticRetryAllowed, false);
  assert.equal(writes, 1, "unknown receipt blocks a second provider request");
});

test("currency, video readiness and explicit confirmation fail before a provider write", async () => {
  const currency = launchFixture({ currency: "USD" });
  await assert.rejects(
    currency.service.launch(WORKSPACE, STAFF, validPayload()),
    (error: unknown) => {
      assert.equal(
        (error as { launchCode?: string }).launchCode,
        "currency_mismatch",
      );
      return true;
    },
  );
  assert.equal(currency.state().providerCalls.length, 0);

  const video = launchFixture({ readyForAd: false });
  await assert.rejects(
    video.service.launch(WORKSPACE, STAFF, validPayload()),
    (error: unknown) => {
      assert.equal(
        (error as { launchCode?: string }).launchCode,
        "video_not_ready",
      );
      return true;
    },
  );
  assert.equal(video.state().providerCalls.length, 0);

  const confirmation = launchFixture();
  await assert.rejects(
    confirmation.service.launch(WORKSPACE, STAFF, {
      ...validPayload(),
      confirmationPhrase: "ДА",
    }),
    (error: unknown) => {
      assert.equal(
        (error as { launchCode?: string }).launchCode,
        "confirmation_required",
      );
      return true;
    },
  );
  assert.equal(confirmation.state().providerChecks, 0);
  assert.equal(confirmation.state().providerCalls.length, 0);
});

test("migration and route preserve server-only, admin-only, disabled-first boundaries", async () => {
  const sql = await readFile(
    path.join(repoRoot, "migrations/050_tiktok_disabled_campaign_launches.sql"),
    "utf8",
  );
  for (const marker of [
    "unique (workspace_id, idempotency_key)",
    "operation_status = 'DISABLE'",
    "enable row level security",
    "from public, anon, authenticated",
    "to service_role",
    "destination_fingerprint",
  ])
    assert.ok(sql.includes(marker), marker);
  assert.doesNotMatch(
    sql,
    /destination_url\s+text|access_token\s+text|raw_(?:payload|response)\s+json|create policy/i,
  );

  const router = await readFile(
    path.join(repoRoot, "api/crm/[...path].ts"),
    "utf8",
  );
  const authorization = await readFile(
    path.join(repoRoot, "lib/crm/authorization.ts"),
    "utf8",
  );
  const service = await readFile(
    path.join(repoRoot, "lib/tiktok/launch.ts"),
    "utf8",
  );
  assert.ok(router.includes('case "tiktok-launch":'));
  assert.ok(
    authorization.includes(
      '"tiktok-launch": { kind: "browser", methods: ["POST"], roles: WORKSPACE_ADMIN }',
    ),
  );
  assert.ok(service.includes('TIKTOK_DISABLED_LAUNCH_ENABLED !== "true"'));
  assert.ok(service.includes("destination_fingerprint"));
  assert.doesNotMatch(service, /operation_status:\s*["'](?:ENABLE|ACTIVE)["']/);
});

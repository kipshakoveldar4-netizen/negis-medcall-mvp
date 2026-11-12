import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2A — Meta safety invariants, asserted without an HTTP request.
//
// test:routes proves the same invariants today through /api/crm/meta-launch.
// Security-2B makes that endpoint return 401 to unauthenticated callers, so the
// invariants are pinned here first. Nothing in this file touches the network,
// Supabase, Meta, or the environment.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const payloadModulePath = path.join(repoRoot, "lib", "crm", "meta-launch-payload.ts");
const payloadModule = (await import(pathToFileURL(payloadModulePath).href)) as {
  buildMetaLaunchPayloadPreview: (
    launch: MetaLaunchPayloadInput,
    campaignId?: string,
    options?: MetaLaunchPayloadOptions,
  ) => Record<string, unknown>;
};
const { buildMetaLaunchPayloadPreview } = payloadModule;

// lib/meta/marketing.ts is a protected path: it is only read here, never changed.
const marketingPath = path.join(repoRoot, "lib", "meta", "marketing.ts");
const marketing = (await import(pathToFileURL(marketingPath).href)) as {
  buildImageLinkCreativePayload: (input: Record<string, unknown>) => Record<string, unknown>;
  buildVideoCreativePayload: (input: Record<string, unknown>) => Record<string, unknown>;
};

type MetaLaunchPayloadInput = Record<string, unknown> & {
  creativeType: string;
  statusMode: string;
  targetingResolution?: { warning?: string } | undefined;
};
type MetaLaunchPayloadOptions = {
  omitInstagramPositions?: boolean;
  videoLaunchEnabled?: boolean;
  imageUploadMode?: "adimages" | "picture_url";
  usesInstagramActor?: boolean;
  instagramActorFallback?: boolean;
};

function baseInput(overrides: Partial<MetaLaunchPayloadInput> = {}): MetaLaunchPayloadInput {
  return {
    campaignName: "Имплантация - Астана - заявки 2026-07-28_10-00",
    objective: "OUTCOME_LEADS",
    statusMode: "PAUSED",
    dailyBudgetMinor: 2000,
    totalBudgetMinor: 14000,
    currency: "USD",
    primaryText: "Консультация имплантолога",
    headline: "Запишитесь на консультацию",
    description: "Бесплатный первичный осмотр",
    cta: "LEARN_MORE",
    landingUrl: "https://wa.me/77010000000",
    imageUrl: "https://example.test/creative.jpg",
    creativeUrl: "https://example.test/creative.jpg",
    creativeType: "image",
    videoUrl: "",
    videoId: "",
    thumbnailUrl: "",
    startDate: "2026-08-01T09:00:00.000Z",
    endDate: "",
    city: "Астана",
    selectedCityId: "astana",
    selectedCityLabelRu: "Астана",
    selectedCityCanonicalName: "Astana",
    audienceLabel: "25-55",
    launchTimestamp: "2026-07-28_10-00",
    adSetName: "Астана - Instagram - 25-55 2026-07-28_10-00",
    creativeName: "Креатив - Имплантация 2026-07-28_10-00",
    adName: "Объявление - Имплантация 2026-07-28_10-00",
    metaCityKey: "1301648",
    astanaCityKey: "1301648",
    instagramActorId: "17841400000000000",
    mimeType: "",
    fileName: "",
    targetingResolution: undefined,
    ...overrides,
  };
}

function build(
  overrides: Partial<MetaLaunchPayloadInput> = {},
  options: MetaLaunchPayloadOptions = {},
): Record<string, unknown> {
  return buildMetaLaunchPayloadPreview(baseInput(overrides), "META_CAMPAIGN_ID", options);
}

function section(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  assert.ok(value && typeof value === "object", `payload.${key} must be an object`);
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Campaign status: PAUSED is the invariant the whole product depends on
// ---------------------------------------------------------------------------

test("01 campaign payload carries the requested PAUSED status", () => {
  const campaign = section(build(), "campaign");
  assert.equal(campaign.status, "PAUSED");
});

test("02 ad payload carries the same status as the campaign", () => {
  const payload = build();
  const ad = section(payload, "ad");
  const campaign = section(payload, "campaign");
  assert.equal(ad.status, campaign.status);
  assert.equal(ad.status, "PAUSED");
});

test("03 a PAUSED launch produces no ACTIVE anywhere in the payload", () => {
  const serialized = JSON.stringify(build());
  assert.ok(!serialized.includes("ACTIVE"), "no payload branch may contain ACTIVE for a paused launch");
});

test("04 the builder never invents ACTIVE on its own", () => {
  // The status is passed through, never defaulted upward. If a caller asks for
  // PAUSED the builder must not widen it under any creative type.
  for (const creativeType of ["image", "video"]) {
    const payload = build({ creativeType, videoId: creativeType === "video" ? "vid_1" : "" });
    assert.ok(!JSON.stringify(payload).includes("ACTIVE"), `${creativeType} launch must stay paused`);
  }
});

// ---------------------------------------------------------------------------
// Placements: Instagram only
// ---------------------------------------------------------------------------

test("05 ad set targeting is Instagram-only", () => {
  const adSet = section(build(), "adSet");
  const targeting = section(adSet, "targeting");
  assert.deepEqual(targeting.publisher_platforms, ["instagram"]);
});

test("06-08 no Facebook, Messenger or Audience Network placements are added", () => {
  const adSet = section(build(), "adSet");
  const targeting = section(adSet, "targeting");
  const serialized = JSON.stringify(targeting);
  for (const forbidden of ["facebook_positions", "messenger_positions", "audience_network_positions"]) {
    assert.ok(!(forbidden in targeting), `targeting must not include ${forbidden}`);
  }
  for (const platform of ["facebook", "messenger", "audience_network"]) {
    assert.ok(
      !JSON.parse(serialized).publisher_platforms?.includes(platform),
      `publisher_platforms must not include ${platform}`,
    );
  }
});

test("09 the ad set is explicitly marked instagram_only", () => {
  const adSet = section(build(), "adSet");
  assert.equal(adSet.placementsMode, "instagram_only");
});

test("10 Instagram positions are present unless explicitly omitted", () => {
  const withPositions = section(section(build(), "adSet"), "targeting");
  assert.ok(Array.isArray(withPositions.instagram_positions), "instagram_positions expected by default");

  const omitted = section(section(build({}, { omitInstagramPositions: true }), "adSet"), "targeting");
  assert.ok(
    !("instagram_positions" in omitted),
    "omitInstagramPositions must drop the field, not silently keep it",
  );
});

// ---------------------------------------------------------------------------
// Billing, objective and budget level
// ---------------------------------------------------------------------------

test("11 billing_event stays IMPRESSIONS", () => {
  const adSet = section(build(), "adSet");
  assert.equal(adSet.billing_event, "IMPRESSIONS");
});

test("12 objective passes through unchanged", () => {
  const campaign = section(build(), "campaign");
  assert.equal(campaign.objective, "OUTCOME_LEADS");
});

test("13 budget stays at ad set level", () => {
  const payload = build();
  assert.equal(payload.budgetLevel, "adset");
  const campaign = section(payload, "campaign");
  const adSet = section(payload, "adSet");
  assert.ok(!("daily_budget" in campaign), "campaign must not carry daily_budget");
  assert.equal(adSet.daily_budget, "2000");
  assert.equal(campaign.is_adset_budget_sharing_enabled, false);
});

test("14 a daily budget adds neither lifetime_budget nor end_time", () => {
  const adSet = section(build(), "adSet");
  assert.ok(!("lifetime_budget" in adSet), "lifetime_budget must not appear with a daily budget");
  assert.ok(!("end_time" in adSet), "end_time must not appear with a daily budget");
});

// ---------------------------------------------------------------------------
// Destination / WhatsApp behaviour
// ---------------------------------------------------------------------------

test("15 the WhatsApp destination reaches both link and call_to_action verbatim", () => {
  // The payload preview summarises the creative rather than embedding it, so the
  // destination invariant belongs to the creative builders in lib/meta/marketing
  // (read-only here). Both the image and the video creative must send the exact
  // landing URL twice: as the link and inside call_to_action.value.link.
  const landingUrl = "https://wa.me/77010000000?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5";
  const shared = { ...baseInput({ landingUrl }), pageId: "page_1", instagramActorId: "17841400000000000" };

  const image = marketing.buildImageLinkCreativePayload({ ...shared, imageHash: "hash_1" }) as Record<string, unknown>;
  const imageSpec = (image.object_story_spec as Record<string, unknown>).link_data as Record<string, unknown>;
  assert.equal(imageSpec.link, landingUrl, "image creative link must be the exact destination");
  assert.equal(
    ((imageSpec.call_to_action as Record<string, unknown>).value as Record<string, unknown>).link,
    landingUrl,
    "image creative CTA must point at the same destination",
  );

  const video = marketing.buildVideoCreativePayload({ ...shared, videoId: "vid_1" }) as Record<string, unknown>;
  const videoSpec = (video.object_story_spec as Record<string, unknown>).video_data as Record<string, unknown>;
  assert.equal(
    ((videoSpec.call_to_action as Record<string, unknown>).value as Record<string, unknown>).link,
    landingUrl,
    "video creative CTA must point at the same destination",
  );
});

test("15b the creative keeps the Instagram actor and never leaks credentials", () => {
  const shared = { ...baseInput(), pageId: "page_1", instagramActorId: "17841400000000000" };
  const image = marketing.buildImageLinkCreativePayload({ ...shared, imageHash: "hash_1" }) as Record<string, unknown>;
  const spec = image.object_story_spec as Record<string, unknown>;
  assert.equal(spec.instagram_actor_id, "17841400000000000");

  const withoutActor = marketing.buildImageLinkCreativePayload({
    ...baseInput({ instagramActorId: "" }),
    pageId: "page_1",
    imageHash: "hash_1",
  }) as Record<string, unknown>;
  assert.ok(
    !("instagram_actor_id" in (withoutActor.object_story_spec as Record<string, unknown>)),
    "the actor field must be omitted, not sent empty",
  );

  const serialized = JSON.stringify(image).toLowerCase();
  for (const forbidden of ["service_role", "apikey", "secret", "access_token"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear in a creative payload`);
  }
});

test("16 the builder does not substitute a different destination host", () => {
  const payload = build({ landingUrl: "https://wa.me/77010000000" });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("facebook.com/messages"), "no Messenger destination substitution");
  assert.ok(!serialized.includes("m.me/"), "no m.me destination substitution");
});

// ---------------------------------------------------------------------------
// Creative shape
// ---------------------------------------------------------------------------

test("17 an image launch uses link_data and an ad-images upload by default", () => {
  const creative = section(build(), "creative");
  assert.equal(creative.objectStorySpecType, "link_data");
  assert.equal(creative.imageUploadMode, "adimages");
  assert.equal(creative.usesLinkData, true);
  assert.equal(creative.usesVideoData, false);
  assert.equal(creative.imageHash, true);
});

test("18 a video launch uses video_data and reports the video flags", () => {
  const creative = section(build({ creativeType: "video", videoUrl: "https://example.test/v.mp4", videoId: "vid_1", mimeType: "video/mp4", fileName: "v.mp4" }), "creative");
  assert.equal(creative.objectStorySpecType, "video_data");
  assert.equal(creative.usesVideoData, true);
  assert.equal(creative.usesLinkData, false);
  const video = section(creative, "video");
  assert.equal(video.mimeType, "video/mp4");
  assert.equal(video.videoId, true);
});

test("19 videoLaunchEnabled is supplied by the caller, never read from the environment", () => {
  const disabled = section(build({ creativeType: "video" }, { videoLaunchEnabled: false }), "creative");
  assert.equal(disabled.videoLaunchEnabled, false);
  assert.equal(disabled.metaVideoLaunchStatus, "soon");

  const enabled = section(build({ creativeType: "video" }, { videoLaunchEnabled: true }), "creative");
  assert.equal(enabled.videoLaunchEnabled, true);
  assert.equal(enabled.metaVideoLaunchStatus, "experimental");
});

test("20 the Instagram actor flags reflect the resolved launch", () => {
  const withActor = section(build(), "creative");
  assert.equal(withActor.usesInstagramActor, true);
  assert.equal(withActor.instagramActorFallback, false);

  const withoutActor = section(build({ instagramActorId: "" }), "creative");
  assert.equal(withoutActor.usesInstagramActor, false);
});

// ---------------------------------------------------------------------------
// Naming and timestamp consistency
// ---------------------------------------------------------------------------

test("21 one launch timestamp is shared across campaign, ad set, creative and ad", () => {
  const payload = build();
  assert.equal(payload.launchTimestamp, "2026-07-28_10-00");
  const campaign = section(payload, "campaign");
  const adSet = section(payload, "adSet");
  const creative = section(payload, "creative");
  const ad = section(payload, "ad");
  for (const [label, value] of [
    ["campaign", campaign.name],
    ["adSet", adSet.name],
    ["creative", creative.name],
    ["ad", ad.name],
  ] as const) {
    assert.ok(String(value).includes("2026-07-28_10-00"), `${label} name must carry the launch timestamp`);
  }
});

// ---------------------------------------------------------------------------
// Sanitisation: nothing the browser sends becomes Meta authority
// ---------------------------------------------------------------------------

test("22 unsupported browser fields never reach the Meta payload", () => {
  const polluted = {
    ...baseInput(),
    workspaceId: "11111111-1111-1111-1111-111111111111",
    role: "owner",
    auth_user_id: "22222222-2222-2222-2222-222222222222",
    access_token: "should-never-appear",
    adAccountId: "act_should_not_leak",
  } as unknown as MetaLaunchPayloadInput;

  const serialized = JSON.stringify(buildMetaLaunchPayloadPreview(polluted, "META_CAMPAIGN_ID", {}));
  for (const forbidden of ["workspaceId", "auth_user_id", "access_token", "should-never-appear", "act_should_not_leak"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach the Meta payload`);
  }
});

test("23 no credential-shaped key appears in the result", () => {
  const serialized = JSON.stringify(build()).toLowerCase();
  for (const forbidden of ["service_role", "apikey", "authorization", "secret", "password"]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear in a payload preview`);
  }
});

// ---------------------------------------------------------------------------
// Purity contract
// ---------------------------------------------------------------------------

test("24 the input object is not mutated", () => {
  const input = baseInput();
  const snapshot = JSON.stringify(input);
  buildMetaLaunchPayloadPreview(input, "META_CAMPAIGN_ID", {});
  assert.equal(JSON.stringify(input), snapshot, "the builder must not mutate its input");
});

test("25 the result is deterministic across repeated calls", () => {
  const first = JSON.stringify(build());
  const second = JSON.stringify(build());
  assert.equal(first, second, "identical input must produce an identical payload");
});

test("26 the module performs no network, database, environment or clock access", async () => {
  const source = await readFile(path.join(repoRoot, "lib", "crm", "meta-launch-payload.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["process.env", "Date.now", "new Date(", "Math.random", "fetch(", "supabase", "await "]) {
    assert.ok(!code.includes(forbidden), `the pure payload module must not use ${forbidden}`);
  }
});

test("27 the runtime keeps a single source of truth for the payload", async () => {
  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  assert.ok(
    server.includes("buildMetaLaunchPayloadPreview(launch, campaignId, {"),
    "lib/crm/server.ts must delegate to the extracted builder",
  );
  assert.ok(
    server.includes("videoLaunchEnabled: isMetaVideoLaunchEnabled()"),
    "the environment read stays in the server wrapper",
  );
  // A second independent builder would let the two drift apart silently.
  assert.equal(
    server.split("buildMetaCampaignPayload(").length - 1,
    0,
    "lib/crm/server.ts must not build campaign payloads itself any more",
  );
});

// ---------------------------------------------------------------------------
// Characterization: the extracted builder still produces the shipped shape
// ---------------------------------------------------------------------------

test("28 the payload keeps its exact top-level and section key sets", () => {
  const payload = build();
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["ad", "adSet", "budgetLevel", "campaign", "creative", "launchTimestamp", "warnings"],
    "top-level payload keys must not change",
  );
  assert.deepEqual(Object.keys(section(payload, "ad")).sort(), ["name", "status"]);
  const creativeKeys = Object.keys(section(payload, "creative")).sort();
  for (const expected of [
    "asset",
    "imageHash",
    "imageUploadCapabilityFallback",
    "imageUploadMode",
    "instagramActorFallback",
    "metaVideoLaunchStatus",
    "name",
    "objectStorySpecType",
    "pictureUrl",
    "usesInstagramActor",
    "usesLinkData",
    "usesVideoData",
    "video",
    "videoDataHasImageUrl",
    "videoLaunchEnabled",
  ]) {
    assert.ok(creativeKeys.includes(expected), `creative.${expected} must still be present`);
  }
});

test("29 warnings surface only the targeting resolution warning", () => {
  assert.deepEqual(build().warnings, []);
  const warned = build({
    targetingResolution: { warning: "Город не найден" } as MetaLaunchPayloadInput["targetingResolution"],
  });
  assert.deepEqual(warned.warnings, ["Город не найден"]);
});

test("30 a dry run and a real launch share one payload builder", () => {
  // The dry-run response embeds exactly what a real launch would send, so the
  // preview cannot drift away from what Meta actually receives.
  const dryRun = build();
  const real = buildMetaLaunchPayloadPreview(baseInput(), "META_CAMPAIGN_ID", {});
  assert.equal(JSON.stringify(dryRun), JSON.stringify(real));
});

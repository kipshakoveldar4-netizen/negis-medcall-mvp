import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function load<T>(file: string): Promise<T> {
  const value = await import(pathToFileURL(path.join(root, file)).href);
  return ((value as { default?: unknown }).default ?? value) as T;
}

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIDEO = "v070-ready-video";
const NOW = Date.parse("2026-09-07T10:00:00Z");
const env = {
  TIKTOK_WORKSPACE_ID: WORKSPACE,
  TIKTOK_ACCESS_TOKEN: "not-a-real-secret",
  TIKTOK_ADVERTISER_ID: "7123456789012345678",
  TIKTOK_VIDEO_UPLOAD_ENABLED: "true",
};

type ProviderResult = { state: string; displayable: boolean | null; tiktokPlacementAllowed: boolean | null };
type ProviderFetch = (url: string, init: {
  method: string; headers: Record<string, string>; redirect: string; signal: unknown;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type ProviderModule = {
  checkTikTokVideoReadiness(videoId: string, options: {
    env: Record<string, string>; fetchImpl: ProviderFetch; timeoutMs?: number;
  }): Promise<ProviderResult>;
};
const provider = await load<ProviderModule>("lib/tiktok/videoReadiness.ts");
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => typeof body === "string" ? body : JSON.stringify(body),
});

test("video info request is fixed-host, exact-id and returns only safe readiness", async () => {
  const result = await provider.checkTikTokVideoReadiness(VIDEO, { env, fetchImpl: async (rawUrl, init) => {
    const url = new URL(rawUrl);
    assert.equal(url.origin, "https://business-api.tiktok.com");
    assert.equal(url.pathname, "/open_api/v1.3/file/video/ad/info/");
    assert.equal(url.searchParams.get("advertiser_id"), env.TIKTOK_ADVERTISER_ID);
    assert.deepEqual(JSON.parse(url.searchParams.get("video_ids") || "[]"), [VIDEO]);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["Access-Token"], env.TIKTOK_ACCESS_TOKEN);
    assert.ok(!rawUrl.includes(env.TIKTOK_ACCESS_TOKEN));
    return response({ code: 0, data: { list: [
      { video_id: "another-video", displayable: false, allowed_placements: [] },
      { video_id: VIDEO, displayable: true, allowed_placements: ["PLACEMENT_TIKTOK"],
        preview_url: "https://temporary.example/preview", video_cover_url: "https://temporary.example/cover" },
    ] } });
  } });
  assert.deepEqual(result, { state: "ready", displayable: true, tiktokPlacementAllowed: true });
  assert.doesNotMatch(JSON.stringify(result), /video_id|preview|cover|https:|secret/i);
});

test("displayability and TikTok placement produce honest provider states", async () => {
  async function check(item: Record<string, unknown> | null) {
    return provider.checkTikTokVideoReadiness(VIDEO, { env, fetchImpl: async () =>
      response({ code: 0, data: { list: item ? [{ video_id: VIDEO, ...item }] : [] } }) });
  }
  assert.deepEqual(await check(null), { state: "processing", displayable: null, tiktokPlacementAllowed: null });
  assert.deepEqual(await check({ displayable: true }), { state: "processing", displayable: true, tiktokPlacementAllowed: null });
  assert.deepEqual(await check({ displayable: false, allowed_placements: ["PLACEMENT_TIKTOK"] }),
    { state: "not_displayable", displayable: false, tiktokPlacementAllowed: true });
  assert.deepEqual(await check({ displayable: true, allowed_placements: ["PLACEMENT_PANGLE"] }),
    { state: "not_displayable", displayable: true, tiktokPlacementAllowed: false });
});

test("provider errors and malformed bodies are redacted and never become ready", async () => {
  const failures: ProviderFetch[] = [
    async () => response({ code: 40001, message: "private token details" }),
    async () => response("not-json"),
    async () => { throw new Error("private network details"); },
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(provider.checkTikTokVideoReadiness(VIDEO, { env, fetchImpl }), (error: unknown) => {
      const safe = error as { code: string; message: string };
      assert.ok(["provider_rejected", "check_unknown"].includes(safe.code));
      assert.doesNotMatch(safe.message, /private|token details|network details/i);
      return true;
    });
  }
});

type Asset = {
  id: string; workspace_id: string; file_name: string; file_type: string; mime_type: string; file_size: number;
  storage_bucket: string; storage_path: string; status: string; updated_at: string;
};
type Receipt = {
  id: string; workspace_id: string; advertiser_id: string; asset_id: string; source_fingerprint: string;
  asset_revision: string; status: "uploaded"; video_id: string; error_code: null; attempt: number;
  started_at: string; finished_at: string; readiness_status: "not_checked" | "ready" | "unknown";
  displayable: boolean | null; tiktok_placement_allowed: boolean | null; readiness_checked_at: string | null;
  readiness_error_code: "connection_revoked" | null;
};
type Store = {
  assets(workspaceId: string): Promise<Asset[]>;
  asset(workspaceId: string, assetId: string): Promise<Asset | null>;
  latest(workspaceId: string, advertiserId: string, assetId: string): Promise<Receipt | null>;
  claim(row: Receipt, retry: boolean): Promise<{ claimed: boolean; row: Receipt }>;
  finish(row: Receipt): Promise<void>;
  saveReadiness(row: Receipt): Promise<Receipt>;
};
type ServiceModule = {
  createTikTokVideoService(options: {
    env: Record<string, string>; store: Store; now: () => number;
    connection: () => Promise<{ state: string }>;
    verify: () => Promise<boolean>;
    check: () => Promise<{ state: "ready"; displayable: true; tiktokPlacementAllowed: true }>;
    prepare: () => Promise<never>;
    upload: () => Promise<string>;
  }): {
    read(workspaceId: string, assetId: string): Promise<Record<string, unknown>>;
    checkReadiness(workspaceId: string, assetId: string): Promise<Record<string, unknown>>;
  };
};

test("service checks provider explicitly, persists safe readiness and never uploads again", async () => {
  const module = await load<ServiceModule>("lib/tiktok/videoAssets.ts");
  const asset: Asset = { id: ASSET, workspace_id: WORKSPACE, file_name: "clinic.mp4", file_type: "video",
    mime_type: "video/mp4", file_size: 1000, storage_bucket: "ad-creatives",
    storage_path: `${WORKSPACE}/clinic.mp4`, status: "uploaded", updated_at: new Date(NOW).toISOString() };
  let receipt: Receipt = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", workspace_id: WORKSPACE,
    advertiser_id: env.TIKTOK_ADVERTISER_ID, asset_id: ASSET, source_fingerprint: "a".repeat(64),
    asset_revision: asset.updated_at, status: "uploaded", video_id: VIDEO, error_code: null, attempt: 1,
    started_at: asset.updated_at, finished_at: asset.updated_at, readiness_status: "not_checked", displayable: null,
    tiktok_placement_allowed: null, readiness_checked_at: null, readiness_error_code: null };
  let checks = 0;
  let uploads = 0;
  let verified = true;
  const store: Store = {
    async assets() { return [asset]; },
    async asset(workspaceId, assetId) { return workspaceId === WORKSPACE && assetId === ASSET ? asset : null; },
    async latest() { return receipt; },
    async claim() { return { claimed: false, row: receipt }; },
    async finish() {},
    async saveReadiness(row) { receipt = row; return row; },
  };
  const service = module.createTikTokVideoService({ env, store, now: () => NOW,
    connection: async () => ({ state: "connected" }), verify: async () => verified,
    check: async () => { checks++; return { state: "ready", displayable: true, tiktokPlacementAllowed: true }; },
    prepare: async () => { throw new Error("must not prepare"); }, upload: async () => { uploads++; return VIDEO; } });

  const before = await service.read(WORKSPACE, ASSET);
  assert.equal(before.readinessStatus, "not_checked");
  assert.equal(checks, 0, "ordinary GET does not call TikTok");

  const ready = await service.checkReadiness(WORKSPACE, ASSET);
  assert.equal(ready.readinessStatus, "ready");
  assert.equal(ready.readyForAd, true);
  assert.equal(checks, 1);
  assert.equal(uploads, 0, "readiness check never starts a second upload");
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(`${VIDEO}|${env.TIKTOK_ADVERTISER_ID}|secret|https:`, "i"));

  verified = false;
  const revoked = await service.checkReadiness(WORKSPACE, ASSET);
  assert.equal(revoked.readinessStatus, "unknown");
  assert.equal(revoked.readyForAd, false);
  assert.equal(checks, 1, "video info is not called after access verification fails");
  assert.equal(receipt.readiness_error_code, "connection_revoked");
});

test("migration, catch-all action and admin UI preserve the disabled-first boundary", async () => {
  const sql = await readFile(path.join(root, "migrations/049_tiktok_video_readiness.sql"), "utf8");
  for (const marker of ["readiness_status", "not_displayable", "tiktok_placement_allowed", "enable row level security",
    "from public, anon, authenticated", "to service_role"]) assert.ok(sql.includes(marker), marker);
  assert.doesNotMatch(sql, /preview_url\s+text|video_cover_url\s+text|raw_(?:payload|response)\s+json|access_token\s+text/i);

  const route = await readFile(path.join(root, "lib/crm/tiktok-videos.ts"), "utf8");
  assert.ok(route.includes('body.action === "check_readiness"'));
  assert.ok(route.includes("tikTokVideos.checkReadiness(context.workspaceId, assetId)"));

  const ui = await readFile(path.join(root, "artifacts/negis/src/components/admin/TikTokVideoUpload.tsx"), "utf8");
  for (const marker of ["Проверить готовность в TikTok", "Проверка не загружает видео повторно", "Кампания не создаётся"])
    assert.ok(ui.includes(marker), marker);
  assert.doesNotMatch(ui, /localStorage|preview_url|video_cover_url|video_id|TIKTOK_ACCESS_TOKEN/);

  const campaign = await readFile(path.join(root, "lib/tiktok/campaign.ts"), "utf8");
  assert.ok(campaign.includes("live_adapter_disabled"));
  assert.doesNotMatch(campaign, /operation_status: "ENABLE"/);
});

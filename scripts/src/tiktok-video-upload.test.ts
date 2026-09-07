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
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = Date.parse("2026-09-06T10:00:00Z");
const env = { TIKTOK_WORKSPACE_ID: A, TIKTOK_ACCESS_TOKEN: "not-a-real-secret", TIKTOK_ADVERTISER_ID: "7123456789012345678",
  TIKTOK_VIDEO_UPLOAD_ENABLED: "true", SUPABASE_URL: "https://testproject.supabase.co" };
type Asset = { id: string; workspace_id: string; file_name: string; file_type: string; mime_type: string; file_size: number;
  storage_bucket: string; storage_path: string; status: string; updated_at: string };
const asset: Asset = { id: ID, workspace_id: A, file_name: "Клиника.MOV", file_type: "video", mime_type: "video/quicktime", file_size: 1000,
  storage_bucket: "ad-creatives", storage_path: `${A}/2026/09/test.mov`, status: "uploaded", updated_at: new Date(now).toISOString() };
type Prepared = { url: string; fingerprint: string; extension: "mp4" | "mov" };
type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; redirect: string; signal: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;
type Provider = {
  prepareTikTokVideo(asset: Asset, workspace: string, options: { env: Record<string, string>; fetchImpl: Fetch }): Promise<Prepared>;
  uploadTikTokVideo(prepared: Prepared, id: string, options: { env: Record<string, string>; fetchImpl: Fetch; timeoutMs?: number }): Promise<string>;
  TikTokVideoError: new (code: string, message: string, uncertain?: boolean) => Error;
};
const provider = await load<Provider>("lib/tiktok/videoUpload.ts");
const prepared: Prepared = { url: `https://testproject.supabase.co/storage/v1/object/public/ad-creatives/${asset.storage_path}`, fingerprint: "a".repeat(64), extension: "mov" };
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { ok: status === 200, status, headers: { get: (key: string) => headers[key] ?? null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };

test("workspace storage HEAD uses no credentials; MOV and optimized MP4 use verified metadata", async () => {
  for (const video of [asset, { ...asset, storage_path: `optimized/${A}/${ID}.mp4`, mime_type: "video/mp4" }]) {
    const result = await provider.prepareTikTokVideo(video, A, { env, fetchImpl: async (url, init) => {
      assert.match(url, /^https:\/\/testproject.supabase.co\/storage\/v1\/object\/public\/ad-creatives\//);
      assert.equal(init.method, "HEAD"); assert.equal(init.redirect, "error"); assert.equal(init.headers, undefined);
      return response("", 200, { "content-length": "1000", "content-type": video.mime_type, etag: '"storage-content-version"' });
    } });
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/); assert.equal(result.extension, video.mime_type === "video/mp4" ? "mp4" : "mov");
  }
});

test("foreign paths, private raw objects, invalid origins and oversized actual files never reach TikTok", async () => {
  let heads = 0;
  const head: Fetch = async () => { heads++; return response("", 200, { "content-length": "11000000", "content-type": "video/quicktime", etag: '"v1"' }); };
  for (const changes of [{ workspace_id: B }, { storage_path: `${B}/file.mov` }, { storage_path: `${A}/../file.mov` },
    { storage_path: `${A}/%2e%2e/file.mov` }, { storage_bucket: "ad-creatives-raw" }, { file_size: 11000000 }, { status: "processing" }]) {
    await assert.rejects(provider.prepareTikTokVideo({ ...asset, ...changes }, A, { env, fetchImpl: head }), code("video_not_ready"));
  }
  assert.equal(heads, 0);
  await assert.rejects(provider.prepareTikTokVideo(asset, A, { env: { ...env, SUPABASE_URL: "https://evil.test" }, fetchImpl: head }), code("video_not_ready"));
  await assert.rejects(provider.prepareTikTokVideo(asset, A, { env, fetchImpl: head }), code("video_not_ready"));
  assert.equal(heads, 1, "database size is not trusted as proof");
  for (const headers of [{ "content-length": "1000", "content-type": "text/html", etag: '"v1"' },
    { "content-length": "1000", "content-type": "video/quicktime", etag: "W/version" }]) {
    await assert.rejects(provider.prepareTikTokVideo(asset, A, { env, fetchImpl: async () => response("", 200, headers) }), code("video_not_ready"));
  }
});

test("provider JSON URL upload extracts only video_id; no SmartFix or campaign creation", async () => {
  const id = await provider.uploadTikTokVideo(prepared, ID, { env, fetchImpl: async (url, init) => {
    assert.equal(url, "https://business-api.tiktok.com/open_api/v1.3/file/video/ad/upload/");
    assert.equal(init.redirect, "error"); assert.equal(init.headers?.["Content-Type"], "application/json");
    assert.equal(init.headers?.["Access-Token"], env.TIKTOK_ACCESS_TOKEN);
    assert.deepEqual(JSON.parse(init.body || "{}"), { advertiser_id: env.TIKTOK_ADVERTISER_ID, upload_type: "UPLOAD_BY_URL",
      video_url: prepared.url, file_name: `negis-${ID}.mov`, flaw_detect: false, auto_fix_enabled: false, auto_bind_enabled: false, pre_review_enabled: false });
    return response({ code: 0, data: [{ video_id: "v070sample", preview_url: "https://private.example", material_id: "private" }] });
  } });
  assert.equal(id, "v070sample");
  const objectShapeId = await provider.uploadTikTokVideo(prepared, ID, { env, fetchImpl: async () =>
    response({ code: 0, data: { video_id: "v070object" } }) });
  assert.equal(objectShapeId, "v070object");
});

test("ambiguous responses and timeouts are unknown; provider rejection is safe; disabled flag sends nothing", async () => {
  for (const reply of [response("", 200), response("not json"), response({ code: 0, data: [] }), response({ code: 0, data: [{ fix_task_id: "task" }] }), response("secret", 503)]) {
    await assert.rejects(provider.uploadTikTokVideo(prepared, ID, { env, fetchImpl: async () => reply }), code("upload_unknown"));
  }
  for (const reply of [response("private", 401), response("private", 429), response({ code: 40002, message: "secret" })]) {
    await assert.rejects(provider.uploadTikTokVideo(prepared, ID, { env, fetchImpl: async () => reply }), (error: unknown) => {
      assert.equal((error as { code: string }).code, "provider_rejected"); assert.doesNotMatch(String(error), /secret|private/); return true;
    });
  }
  await assert.rejects(provider.uploadTikTokVideo(prepared, ID, { env, timeoutMs: 5, fetchImpl: async (_url, init) => ({
    ...response({}), text: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")))),
  }) }), code("upload_unknown"));
  await assert.rejects(provider.uploadTikTokVideo(prepared, ID, { env: { ...env, TIKTOK_VIDEO_UPLOAD_ENABLED: "false" },
    fetchImpl: async () => { throw new Error("must not call"); } }), code("upload_disabled"));
});

type Receipt = { id: string; workspace_id: string; advertiser_id: string; asset_id: string; source_fingerprint: string; asset_revision: string;
  status: string; video_id: string | null; error_code: string | null; attempt: number; started_at: string; finished_at: string | null };
type Summary = { assetId: string; status: string; message: string; canRetry: boolean; videoIdAvailable: boolean };
type Store = { assets(id: string): Promise<Asset[]>; asset(workspace: string, id: string): Promise<Asset | null>;
  latest(workspace: string, advertiser: string, id: string): Promise<Receipt | null>;
  claim(row: Receipt, retry: boolean): Promise<{ claimed: boolean; row: Receipt }>; finish(row: Receipt): Promise<void> };
type ServiceModule = { createTikTokVideoService(options: { env: Record<string, string>; store: Store; now: () => number;
  connection: () => Promise<{ state: string }>; verify: () => Promise<boolean>;
  prepare: () => Promise<Prepared>; upload: () => Promise<string> }): {
    list(workspace: string): Promise<unknown>; read(workspace: string, id: string): Promise<Summary>; transfer(workspace: string, id: string, retry?: boolean): Promise<Summary>;
  } };
const { createTikTokVideoService } = await load<ServiceModule>("lib/tiktok/videoAssets.ts");
function fixture() {
  let receipt: Receipt | null = null;
  let video = { ...asset };
  let connection = "connected", verified = true, uploads = 0, queries = 0, checks = 0, failFinish = false, clock = now;
  let uploadError: Error | null = null;
  const settings = { ...env };
  const store: Store = {
    async assets() { queries++; return [video]; },
    async asset(workspace, id) { queries++; return workspace === video.workspace_id && id === video.id ? video : null; },
    async latest(workspace, advertiser, id) {
      queries++; return receipt?.workspace_id === workspace && receipt?.advertiser_id === advertiser && receipt?.asset_id === id ? receipt : null;
    },
    async claim(row, retry) {
      if (receipt) {
        if (retry && receipt.status === "failed" && receipt.attempt < 3) {
          receipt = { ...row, id: receipt.id, attempt: receipt.attempt + 1 }; return { claimed: true, row: receipt };
        }
        return { claimed: false, row: receipt };
      }
      receipt = row; return { claimed: true, row };
    },
    async finish(row) { if (failFinish) throw new Error("private DB failure"); receipt = row; },
  };
  const service = createTikTokVideoService({ env: settings, store, now: () => clock,
    connection: async () => ({ state: connection }), verify: async () => { checks++; return verified; },
    prepare: async () => prepared, upload: async () => { uploads++; if (uploadError) throw uploadError; return "v070sample"; } });
  return { service, settings, get: () => ({ receipt, uploads, queries, checks }),
    set(options: { connection?: string; verified?: boolean; uploadError?: Error | null; failFinish?: boolean; video?: Asset; clock?: number }) {
      connection = options.connection ?? connection; verified = options.verified ?? verified; failFinish = options.failFinish ?? failFinish;
      if ("uploadError" in options) uploadError = options.uploadError ?? null;
      video = options.video ?? video; clock = options.clock ?? clock;
    } };
}

test("provisioning, server flag, fresh provider access and asset ownership fail before upload", async () => {
  const f = fixture();
  await assert.rejects(f.service.transfer(B, ID), code("workspace_not_authorized")); assert.equal(f.get().queries, 0);
  f.settings.TIKTOK_VIDEO_UPLOAD_ENABLED = "false";
  await assert.rejects(f.service.transfer(A, ID), code("upload_disabled")); assert.equal(f.get().checks, 0);
  f.settings.TIKTOK_VIDEO_UPLOAD_ENABLED = "true";
  await assert.rejects(f.service.transfer(A, B), code("asset_not_found"));
  f.set({ verified: false }); await assert.rejects(f.service.transfer(A, ID), code("connection_revoked"));
  f.set({ connection: "disabled" }); await assert.rejects(f.service.list(A), code("connection_required"));
  assert.equal(f.get().uploads, 0); assert.equal(f.get().receipt, null);
});

test("duplicate/concurrent transfer is one provider upload; receipt evidence stays server-only", async () => {
  const f = fixture();
  await Promise.all([f.service.transfer(A, ID), f.service.transfer(A, ID)]);
  assert.equal(f.get().uploads, 1);
  const summary = await f.service.read(A, ID);
  assert.equal(summary.status, "uploaded"); assert.equal(summary.videoIdAvailable, true);
  assert.doesNotMatch(JSON.stringify(summary), /v070sample|7123456789012345678|https:|secret|raw_payload/);
  assert.doesNotMatch(JSON.stringify(f.get().receipt), /https:|not-a-real-secret|raw_payload/);
  await f.service.transfer(A, ID); assert.equal(f.get().uploads, 1);
  f.set({ video: { ...asset, updated_at: new Date(now + 1).toISOString() } });
  assert.equal((await f.service.read(A, ID)).videoIdAvailable, false, "changed asset cannot feed stale receipt into dry-run");
});

test("known rejection retries explicitly at most three times; unknown never retries", async () => {
  const f = fixture(); f.set({ uploadError: new provider.TikTokVideoError("provider_rejected", "safe") });
  assert.equal((await f.service.transfer(A, ID)).status, "failed");
  await f.service.transfer(A, ID); assert.equal(f.get().uploads, 1);
  await f.service.transfer(A, ID, true); await f.service.transfer(A, ID, true);
  assert.equal((await f.service.transfer(A, ID, true)).canRetry, false); assert.equal(f.get().uploads, 3);
  const unknown = fixture(); unknown.set({ uploadError: new Error("private timeout") });
  assert.equal((await unknown.service.transfer(A, ID)).status, "unknown");
  await unknown.service.transfer(A, ID, true); assert.equal(unknown.get().uploads, 1);
});

test("lost persistence remains claimed; old uploading becomes unknown without automatic reclaim", async () => {
  const f = fixture(); f.set({ failFinish: true });
  assert.equal((await f.service.transfer(A, ID)).status, "unknown");
  f.set({ clock: now + 121000, failFinish: false });
  assert.equal((await f.service.read(A, ID)).status, "unknown");
  assert.equal((await f.service.transfer(A, ID, true)).status, "unknown"); assert.equal(f.get().uploads, 1);
});

test("migration protects receipts; UI never sends media URL/ID; launch behavior remains disabled", async () => {
  const sql = await readFile(path.join(root, "migrations/048_tiktok_video_uploads.sql"), "utf8");
  for (const marker of ["unique (workspace_id, advertiser_id, asset_id, source_fingerprint)", "enable row level security",
    "from public, anon, authenticated", "to service_role", "attempt between 1 and 3"]) assert.ok(sql.includes(marker), marker);
  assert.doesNotMatch(sql, /public_url\s+text|raw_payload\s+json|access_token\s+text|create policy/i);
  const ui = await readFile(path.join(root, "artifacts/negis/src/components/admin/TikTokVideoUpload.tsx"), "utf8");
  for (const marker of ["Подтверждаю передачу", "!enabled", "current.signal.aborted", "canRetry"]) assert.ok(ui.includes(marker), marker);
  assert.doesNotMatch(ui, /localStorage|publicUrl|video_url|video_id|TIKTOK_ACCESS_TOKEN/);
  const server = await readFile(path.join(root, "lib/crm/server.ts"), "utf8");
  assert.ok(server.includes("await tikTokVideos.read(readWorkspaceId(req, body), body.videoAssetId)"));
  const mapper = await readFile(path.join(root, "lib/tiktok/campaign.ts"), "utf8");
  assert.ok(mapper.includes("live_adapter_disabled")); assert.doesNotMatch(mapper, /operation_status: "ENABLE"/);
});

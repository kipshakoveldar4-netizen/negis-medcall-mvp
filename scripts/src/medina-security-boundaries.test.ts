import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "11111111-1111-4111-8111-111111111111";
const ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JOB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STORAGE = "https://project.example.test";
const VIDEO = `${STORAGE}/storage/v1/object/public/ad-creatives/optimized/${WORKSPACE}/${JOB}.mp4`;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-device";

type Row = Record<string, any>;
type Query = { table: string; op: string; filters: Row; row?: Row };

function response() {
  return {
    statusCode: 0, body: {} as Row,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    json(body: Row) { this.body = body; return this; },
  };
}

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const device = createECDH("prime256v1");
  device.generateKeys();
  return {
    vapid: {
      publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url"),
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      subject: "mailto:security-test@example.test",
    },
    device: { endpoint: ENDPOINT, p256dh: device.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") },
  };
}

async function isolated(fn: (ctx: any) => Promise<void>) {
  const keys = makeKeys();
  const env = {
    SUPABASE_URL: STORAGE, SUPABASE_SERVICE_ROLE_KEY: "local-test-placeholder",
    NEGIS_VAPID_PUBLIC_KEY: keys.vapid.publicKey, NEGIS_VAPID_PRIVATE_KEY: keys.vapid.privateKey,
    NEGIS_VAPID_SUBJECT: keys.vapid.subject, META_VIDEO_LAUNCH_ENABLED: "true",
    META_ACCESS_TOKEN: "local-test-placeholder", META_AD_ACCOUNT_ID: "act_123",
    META_PAGE_ID: "123", META_INSTAGRAM_ACTOR_ID: "123", VIDEO_OPTIMIZATION_ENABLED: "true",
  };
  const oldEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, env);
  const ctx: any = {
    keys, queries: [] as Query[], network: [] as Array<{ url: string; init: Row }>, storageCalls: [] as Row[],
    rows: { staff_users: [{ id: STAFF, workspace_id: WORKSPACE, auth_user_id: STAFF, role: "owner", status: "active" }] },
    errors: {} as Row, onQuery: undefined,
    fetch: () => { throw new Error("Unexpected network request intercepted"); },
    raw: undefined,
  };
  globalThis.fetch = (async (url: any, init: any) => {
    ctx.network.push({ url: String(url), init: init ?? {} });
    return ctx.fetch(String(url), init ?? {});
  }) as typeof fetch;
  const db = {
    from(table: string) {
      const entry: Query = { table, op: "select", filters: {} };
      ctx.queries.push(entry);
      const builder: any = {};
      const settle = (single = false) => {
        ctx.onQuery?.(entry);
        const rows = (ctx.rows[table] ?? []).filter((row: Row) => Object.entries(entry.filters).every(([key, value]) => row[key] === value));
        return Promise.resolve({ data: entry.row ? { id: JOB, ...entry.row } : single ? rows[0] ?? null : rows, error: ctx.errors[table] ?? null });
      };
      Object.assign(builder, {
        select: () => builder,
        insert: (row: Row) => { entry.op = "insert"; entry.row = row; return builder; },
        upsert: (row: Row) => { entry.op = "upsert"; entry.row = row; return builder; },
        update: (row: Row) => { entry.op = "update"; entry.row = row; return builder; },
        eq: (key: string, value: any) => { entry.filters[key] = value; return builder; },
        is: (key: string, value: any) => { entry.filters[key] = value; return builder; },
        in: () => builder, order: () => builder, limit: () => builder,
        single: () => settle(true), maybeSingle: () => settle(true),
        then: (resolve: any, reject: any) => settle().then(resolve, reject),
      });
      return builder;
    },
    storage: {
      from(bucket: string) {
        return {
          download: async (key: string) => {
            ctx.storageCalls.push({ op: "download", bucket, key });
            return { data: ctx.raw, error: ctx.raw ? null : { message: "local download refused" } };
          },
          upload: async (key: string) => { ctx.storageCalls.push({ op: "upload", bucket, key }); return { error: null }; },
          remove: async (keys: string[]) => { ctx.storageCalls.push({ op: "remove", bucket, keys }); return { error: null }; },
          getPublicUrl: (key: string) => ({ data: { publicUrl: `${STORAGE}/storage/v1/object/public/${bucket}/${key}` } }),
        };
      },
    },
  };
  ctx.db = db;
  const supabase = await load("lib/supabase/server.ts");
  supabase.setSupabaseServerClientFactoryForTests(() => db);
  try {
    ctx.crm = await load("lib/crm/server.ts");
    ctx.push = await load("lib/crm/web-push.ts");
    ctx.subscriptions = await load("lib/crm/push-subscriptions.ts");
    ctx.meta = await load("lib/meta/marketing.ts");
    await fn(ctx);
  } finally {
    globalThis.fetch = oldFetch;
    supabase.setSupabaseServerClientFactoryForTests(null);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const ownAsset = { id: ASSET, workspace_id: WORKSPACE, metadata: { retained: true } };
const videoBody = { assetId: ASSET, rawPath: `${WORKSPACE}/test.mp4`, fileName: "test.mp4", inputMimeType: "video/mp4", inputSizeBytes: 100 };

async function queueVideo(ctx: any, body = videoBody) {
  ctx.fetch = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: STAFF }) });
  const router = await load("api/crm/[...path].ts");
  const res = response();
  await router.default({ method: "POST", headers: { authorization: "Bearer local.test.signature" }, query: { path: ["video-processing-jobs"], workspaceId: WORKSPACE }, body }, res);
  return res;
}

for (const [name, row] of [["foreign", { ...ownAsset, workspace_id: FOREIGN }], ["missing", undefined]] as const) {
  test(`SB video queue rejects ${name} creative without an insert`, () => isolated(async (ctx) => {
    ctx.rows.ad_creative_assets = row ? [row] : [];
    assert.equal((await queueVideo(ctx)).statusCode, 404);
    assert.ok(!ctx.queries.some((q: Query) => q.table === "video_processing_jobs" && q.op === "insert"));
    assert.deepEqual(ctx.queries.find((q: Query) => q.table === "ad_creative_assets").filters, { id: ASSET, workspace_id: WORKSPACE });
  }));
}

test("SB video queue accepts its own creative and retains its workspace", () => isolated(async (ctx) => {
  ctx.rows.ad_creative_assets = [ownAsset];
  assert.equal((await queueVideo(ctx)).statusCode, 201);
  const insert = ctx.queries.find((q: Query) => q.table === "video_processing_jobs" && q.op === "insert");
  assert.equal(insert.row.asset_id, ASSET);
  assert.equal(insert.row.workspace_id, WORKSPACE);
}));

test("SB asset lookup failure cannot enqueue a job", () => isolated(async (ctx) => {
  ctx.errors.ad_creative_assets = { message: "local simulated error" };
  assert.equal((await queueVideo(ctx)).statusCode, 502);
  assert.ok(!ctx.queries.some((q: Query) => q.op === "insert"));
}));

test("SB malformed asset id cannot silently become a detached job", () => isolated(async (ctx) => {
  assert.equal((await queueVideo(ctx, { ...videoBody, assetId: "not-a-uuid" })).statusCode, 400);
  assert.ok(!ctx.queries.some((q: Query) => q.table === "video_processing_jobs"));
}));

async function runWorker(ctx: any, overrides: Row = {}) {
  const worker = await load("artifacts/video-worker/src/worker.ts");
  await worker.processJob(ctx.db, {
    tmpDir: os.tmpdir(), rawBucket: "ad-creatives-raw", outputBucket: "ad-creatives", ffmpegPath: "ffmpeg",
    crf: 23, preset: "ultrafast", maxWidth: 64, maxHeight: 64, fps: 5,
  }, {
    id: JOB, workspace_id: WORKSPACE, asset_id: ASSET, raw_bucket: "ad-creatives-raw",
    raw_path: `${WORKSPACE}/test.mp4`, source_file_name: "test.mp4", source_mime_type: "video/mp4", ...overrides,
  });
}

test("SB worker rejects previously queued foreign assets before storage and never updates them", () => isolated(async (ctx) => {
  ctx.rows.ad_creative_assets = [{ ...ownAsset, workspace_id: FOREIGN }];
  await runWorker(ctx);
  assert.equal(ctx.storageCalls.length, 0);
  assert.ok(!ctx.queries.some((q: Query) => q.table === "ad_creative_assets" && q.op === "update"));
  assert.equal(ctx.queries.find((q: Query) => q.table === "video_processing_jobs" && q.op === "update").row.status, "failed");
}));

test("SB worker failure update is restricted to the verified workspace", () => isolated(async (ctx) => {
  ctx.rows.ad_creative_assets = [ownAsset];
  await runWorker(ctx);
  const update = ctx.queries.find((q: Query) => q.table === "ad_creative_assets" && q.op === "update");
  assert.deepEqual(update.filters, { id: ASSET, workspace_id: WORKSPACE });
  assert.equal(update.row.status, "optimization_failed");
}));

test("SB worker rejects a foreign raw object before download", () => isolated(async (ctx) => {
  ctx.rows.ad_creative_assets = [ownAsset];
  await runWorker(ctx, { raw_path: `${FOREIGN}/test.mp4` });
  assert.equal(ctx.storageCalls.length, 0);
}));

test("SB real local transcode preserves own asset scope and metadata on success", (t) => isolated(async (ctx) => {
  const { stdout } = await promisify(execFile)("ffmpeg", [
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5", "-t", "2", "-c:v", "libx264",
    "-pix_fmt", "yuv420p", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    t.skip("Local ffmpeg is required for the transcode integration case");
    return { stdout: null };
  });
  if (!stdout) return;
  ctx.raw = { arrayBuffer: async () => stdout };
  ctx.rows.ad_creative_assets = [ownAsset];
  await runWorker(ctx);
  const update = ctx.queries.find((q: Query) => q.table === "ad_creative_assets" && q.op === "update");
  assert.deepEqual(update.filters, { id: ASSET, workspace_id: WORKSPACE });
  assert.equal(update.row.status, "ready");
  assert.equal(update.row.metadata.retained, true);
  assert.equal(update.row.metadata.optimized, true);
  assert.equal(ctx.queries.find((q: Query) => q.table === "video_processing_jobs" && q.row?.status === "ready").row.status, "ready");
  assert.deepEqual(ctx.storageCalls.find((call: Row) => call.op === "remove").keys, [`${WORKSPACE}/test.mp4`]);
}));

const badEndpoints = [
  "https://127.0.0.1/push", "https://[::1]/push", "https://169.254.169.254/push", "http://fcm.googleapis.com/push",
  "https://fcm.googleapis.com.evil.example/push", "https://fcm.googleapis.com@evil.example/push",
  "https://evil.example@fcm.googleapis.com/push", "https://fcm.googleapis.com:8443/push",
  "https://fcm.googleapis.com/push#fragment", "https://fcm.googleapis.com./push",
  "https://evil.push.apple.com.evil.example/push", "https://evilnotify.windows.com/push",
  "https://fcm.googleapis.com\\@evil.example/push", "not a URL",
];

test("SB push rejects private hosts, deceptive domains and URL credentials at both boundaries", () => isolated(async (ctx) => {
  for (const endpoint of badEndpoints) {
    assert.equal(ctx.push.isTrustedPushEndpoint(endpoint), false, endpoint);
    assert.deepEqual(await ctx.push.sendWebPush({ ...ctx.keys.device, endpoint }, "{}", ctx.keys.vapid, 1700000000), { outcome: "rejected", status: 0 });
    const req = { method: "POST", headers: {}, query: {}, body: { ...ctx.keys.device, endpoint } };
    ctx.crm.attachWorkspaceContext(req, { userId: STAFF, staffUserId: STAFF, workspaceId: WORKSPACE, role: "doctor", permissions: ["view_appointments"] });
    const res = response();
    await ctx.subscriptions.handlePushSubscriptions(req, res);
    assert.equal(res.statusCode, 400, endpoint);
  }
  assert.equal(ctx.network.length, 0);
  assert.equal(ctx.queries.length, 0);
}));

test("SB supported browser services remain accepted and redirects are forbidden", () => isolated(async (ctx) => {
  for (const endpoint of [ENDPOINT, "https://updates.push.services.mozilla.com/wpush/v2/token", "https://web.push.apple.com/token", "https://wns2-test.notify.windows.com/w/?token=test"]) {
    assert.equal(ctx.push.isTrustedPushEndpoint(endpoint), true, endpoint);
  }
  ctx.fetch = () => ({ status: 201 });
  assert.equal((await ctx.push.sendWebPush(ctx.keys.device, "{}", ctx.keys.vapid, 1700000000)).outcome, "delivered");
  assert.equal(ctx.network[0].init.redirect, "error");
  assert.ok(ctx.network[0].init.signal instanceof AbortSignal);
  ctx.fetch = () => ({ status: 302 });
  assert.equal((await ctx.push.sendWebPush(ctx.keys.device, "{}", ctx.keys.vapid, 1700000000)).outcome, "rejected");
}));

test("SB valid push registration remains scoped to the current staff session", () => isolated(async (ctx) => {
  const req = { method: "POST", headers: {}, query: {}, body: ctx.keys.device };
  ctx.crm.attachWorkspaceContext(req, { userId: STAFF, staffUserId: STAFF, workspaceId: WORKSPACE, role: "doctor", permissions: ["view_appointments"] });
  const res = response();
  await ctx.subscriptions.handlePushSubscriptions(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.queries[0].row.workspace_id, WORKSPACE);
  assert.equal(ctx.queries[0].row.staff_user_id, STAFF);
}));

async function notify(ctx: any) {
  ctx.rows.clinic_doctors = [{ id: "doctor-test", full_name: "Test doctor", staff_user_id: STAFF, is_active: true, workspace_id: WORKSPACE }];
  ctx.rows.push_subscriptions = [{ ...ctx.keys.device, workspace_id: WORKSPACE, staff_user_id: STAFF, revoked_at: null, gone_at: null }];
  ctx.fetch = () => ({ status: 201 });
  await ctx.subscriptions.notifyAppointmentEvent({
    supabase: ctx.db, workspaceId: WORKSPACE, event: "created", actorStaffUserId: "other-staff",
    appointment: { doctorId: "doctor-test", doctorName: "Test doctor", client: "Fictional client", service: "Test service", startsAt: new Date(Date.now() + 86400000).toISOString() }, timeZone: "Asia/Almaty",
  });
}

for (const [name, changes] of [["inactive", { status: "inactive" }], ["unlinked", { auth_user_id: null }], ["foreign", { workspace_id: FOREIGN }], ["unprivileged", { role: "marketer" }]] as const) {
  test(`SB notification fails closed for ${name} recipient`, () => isolated(async (ctx) => {
    ctx.rows.staff_users = [{ ...ctx.rows.staff_users[0], ...changes }];
    await notify(ctx);
    assert.equal(ctx.network.length, 0);
    const lookup = ctx.queries.find((q: Query) => q.table === "staff_users");
    assert.deepEqual(lookup.filters, { id: STAFF, workspace_id: WORKSPACE, status: "active" });
  }));
}

test("SB unreadable or missing membership does not send CRM data", () => isolated(async (ctx) => {
  ctx.errors.staff_users = { message: "local error" };
  await notify(ctx);
  ctx.errors = {};
  ctx.rows.staff_users = [];
  await notify(ctx);
  assert.equal(ctx.network.length, 0);
}));

test("SB access is rechecked after reading devices and valid members still receive push", () => isolated(async (ctx) => {
  ctx.onQuery = (q: Query) => { if (q.table === "push_subscriptions" && q.op === "select") ctx.rows.staff_users[0].status = "inactive"; };
  await notify(ctx);
  assert.equal(ctx.network.length, 0);
  ctx.onQuery = undefined;
  ctx.rows.staff_users[0].status = "active";
  await notify(ctx);
  assert.equal(ctx.network.length, 1);
  const update = ctx.queries.find((q: Query) => q.table === "push_subscriptions" && q.op === "update");
  assert.equal(update.filters.workspace_id, WORKSPACE);
  assert.equal(update.filters.staff_user_id, STAFF);
}));

function metaFallback(ctx: any, options: Row = {}) {
  let binaryPosts = 0;
  let readCount = 0;
  let cancelled = false;
  const chunks = options.chunks ?? [Buffer.from("video")];
  ctx.fetch = (url: string, init: Row) => {
    if (init.method === "GET" && url === options.url) {
      return {
        ok: options.ok ?? true, status: options.status ?? 200,
        headers: { get: () => options.length ?? null },
        text: () => { throw new Error("Must not read unbounded text"); },
        arrayBuffer: () => { throw new Error("Must not read unbounded arrayBuffer"); },
        body: { getReader: () => ({
          read: async () => options.readError ? Promise.reject(new Error("local stream failed")) : readCount < chunks.length ? { done: false, value: chunks[readCount++] } : { done: true },
          cancel: async () => { cancelled = true; }, releaseLock() {},
        }) },
      };
    }
    if (url.includes("/advideos") && init.method === "POST") {
      if (typeof init.body === "string") return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Unable to fetch source URL", code: 100 } }) };
      binaryPosts++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "video_test" }) };
    }
    if (url.includes("/video_test")) return { ok: true, status: 200, text: async () => JSON.stringify({ status: { video_status: "ready" } }) };
    throw new Error("Unexpected network request intercepted");
  };
  return { binaryPosts: () => binaryPosts, reads: () => readCount, cancelled: () => cancelled };
}

async function uploadVideo(ctx: any, options: Row = {}) {
  return ctx.meta.uploadMetaVideoAndGetId({ workspaceId: WORKSPACE, videoUrl: VIDEO, fileName: "test.mp4", mimeType: "video/mp4", processingPollAttempts: 1, processingPollDelayMs: 0, ...options });
}

test("SB Meta fallback rejects unsafe hosts and objects before any server download", () => isolated(async (ctx) => {
  for (const videoUrl of [
    "http://127.0.0.1/test.mp4", "https://127.0.0.1/test.mp4", "https://evil.example/test.mp4",
    `${STORAGE}/storage/v1/object/public/ad-creatives/${FOREIGN}/test.mp4`,
    `${STORAGE}/storage/v1/object/public/ad-creatives-raw/${WORKSPACE}/test.mp4`,
    `${VIDEO}?redirect=http://127.0.0.1`, `${VIDEO}#fragment`, VIDEO.replace("https://", "https://user:pass@"),
    `${STORAGE}/storage/v1/object/public/ad-creatives/${WORKSPACE}/%2f..%2fforeign.mp4`,
  ]) {
    metaFallback(ctx, { url: videoUrl });
    await assert.rejects(uploadVideo(ctx, { videoUrl }), /configured storage/);
  }
  assert.ok(ctx.network.every((call: Row) => call.init.method !== "GET"));
  metaFallback(ctx, { url: VIDEO });
  await assert.rejects(uploadVideo(ctx, { workspaceId: undefined }), /configured storage/);
}));

test("SB Meta fallback streams its own optimized object with a timeout and no redirects", () => isolated(async (ctx) => {
  const state = metaFallback(ctx, { url: VIDEO });
  const result = await uploadVideo(ctx);
  assert.equal(result.videoId, "video_test");
  assert.equal(result.uploadMode, "binary");
  assert.equal(state.binaryPosts(), 1);
  assert.equal(state.cancelled(), true);
  const download = ctx.network.find((call: Row) => call.url === VIDEO);
  assert.equal(download.init.redirect, "error");
  assert.equal(download.init.signal.aborted, true);
}));

test("SB Meta accepts normal own-workspace public objects too", () => isolated(async (ctx) => {
  const videoUrl = `${STORAGE}/storage/v1/object/public/ad-creatives/${WORKSPACE}/2026/10/test.mp4`;
  metaFallback(ctx, { url: videoUrl });
  assert.equal((await uploadVideo(ctx, { videoUrl })).uploadMode, "binary");
}));

test("SB Meta enforces streaming size limit without Content-Length", () => isolated(async (ctx) => {
  const state = metaFallback(ctx, { url: VIDEO, chunks: [Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5)] });
  await assert.rejects(uploadVideo(ctx, { maxBinaryBytes: 8 }), /слишком большое/);
  assert.equal(state.reads(), 2);
  assert.equal(state.cancelled(), true);
  assert.equal(state.binaryPosts(), 0);
}));

test("SB Meta rejects declared oversize before reading any body", () => isolated(async (ctx) => {
  const state = metaFallback(ctx, { url: VIDEO, length: "100" });
  await assert.rejects(uploadVideo(ctx, { maxBinaryBytes: 8 }));
  assert.equal(state.reads(), 0);
  assert.equal(state.cancelled(), true);
}));

test("SB Meta refuses redirects, failed bodies and empty videos without binary upload", () => isolated(async (ctx) => {
  for (const options of [{ status: 302 }, { readError: true }, { chunks: [] }]) {
    const state = metaFallback(ctx, { url: VIDEO, ...options });
    await assert.rejects(uploadVideo(ctx));
    assert.equal(state.binaryPosts(), 0);
    assert.equal(state.cancelled(), true);
  }
}));

test("SB Meta cancels a stalled stream at the download deadline", (t) => isolated(async (ctx) => {
  metaFallback(ctx, { url: VIDEO });
  const graphFetch = ctx.fetch;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  ctx.fetch = (url: string, init: Row) => url !== VIDEO ? graphFetch(url, init) : {
    ok: true, status: 200,
    body: { getReader: () => ({
      read: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        started();
      }),
      cancel: async () => { cancelled = true; }, releaseLock() {},
    }) },
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rejected = assert.rejects(uploadVideo(ctx), /timed out/);
    await reading;
    t.mock.timers.tick(15_001);
    await rejected;
    assert.equal(cancelled, true);
  } finally {
    t.mock.timers.reset();
  }
}));

test("SB legacy TikTok callback has no credential access even if mounted accidentally", async () => {
  const source = await readFile(path.join(root, "artifacts/api-server/src/routes/index.ts"), "utf8");
  assert.doesNotMatch(source, /import adsTikTokRouter|router\.use\(adsTikTokRouter\)/);
  const module = await load("artifacts/api-server/src/routes/ads-tiktok.ts");
  const route = module.default.stack.find((layer: any) => layer.route?.path === "/ads/tiktok/callback");
  const res = response();
  route.route.stack[0].handle({ body: { code: "local", clinic_id: FOREIGN } }, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.code, "oauth_disabled");
  assert.ok(!("access_token" in res.body));
  const callback = await readFile(path.join(root, "artifacts/api-server/src/routes/ads-tiktok.ts"), "utf8");
  assert.doesNotMatch(callback, /supabaseAdmin|fetch\(/);
});

test("SB retired password route cannot mutate accounts even if mounted accidentally", async () => {
  const index = await readFile(path.join(root, "artifacts/api-server/src/routes/index.ts"), "utf8");
  assert.doesNotMatch(index, /import .*auth-reset|router\.use\(authResetRouter\)/);
  const source = await readFile(path.join(root, "artifacts/api-server/src/routes/auth-reset.ts"), "utf8");
  assert.doesNotMatch(source, /supabaseAdmin|nodemailer|updateUserById|listUsers|process\.env|fetch\(/);
  const module = await load("artifacts/api-server/src/routes/auth-reset.ts");
  const route = module.default.stack.find((layer: any) => layer.route?.path === "/auth/reset-password");
  assert.equal(route.route.methods.post, true);
  for (const body of [undefined, {}, { email: "fixture@example.test" }, { email: "fixture@example.test", password: "attacker-supplied" }]) {
    const res = response();
    await route.route.stack[0].handle({ body }, res);
    assert.equal(res.statusCode, 410);
    assert.deepEqual(res.body, { code: "password_reset_disabled" });
  }
});

test("SB unused vulnerable mail and workbook libraries stay out of application dependencies", async () => {
  for (const file of ["package.json", "artifacts/api-server/package.json", "artifacts/negis/package.json"]) {
    const manifest = JSON.parse(await readFile(path.join(root, file), "utf8"));
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const name of ["nodemailer", "@types/nodemailer", "xlsx"]) {
        assert.equal(dependencies?.[name], undefined, `${file}: ${name}`);
      }
    }
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["markdown-it"], "14.3.2");
  const installed = JSON.parse(await readFile(path.join(root, "node_modules/markdown-it/package.json"), "utf8"));
  assert.equal(installed.version, manifest.dependencies["markdown-it"]);
  const spec = JSON.parse(await readFile(path.join(root, "lib/api-spec/package.json"), "utf8"));
  assert.equal(spec.devDependencies.orval, "8.22.0");
  const orval = JSON.parse(await readFile(path.join(root, "lib/api-spec/node_modules/orval/package.json"), "utf8"));
  assert.equal(orval.version, spec.devDependencies.orval);
});

test("SB updated Express dependencies reject forged proxy trust and preserve form parsing", () => {
  const requireApi = createRequire(path.join(root, "artifacts/api-server/package.json"));
  const requireExpress = createRequire(requireApi.resolve("express"));
  const proxyaddr = requireExpress("proxy-addr");
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    assert.equal(proxyaddr.compile(subnet)("203.0.113.10"), false, subnet);
  }
  const trusted = proxyaddr.compile("10.0.0.0/8");
  assert.equal(trusted("10.1.2.3"), true);
  assert.equal(trusted("203.0.113.10"), false);
  const qs = requireExpress("qs");
  assert.deepEqual(qs.parse("clinic[id]=local&items[0]=first&items[1]=second"), {
    clinic: { id: "local" }, items: ["first", "second"],
  });
  assert.deepEqual(qs.parse("__proto__[medinaInjected]=yes&constructor[prototype][medinaInjected]=yes"), {});
  assert.equal(({} as any).medinaInjected, undefined);
});

async function isolatedCodegen(fn: (ctx: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "medina-codegen-security-"));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Code generation must not access the network"); }) as typeof fetch;
  try {
    const requireSpec = createRequire(path.join(root, "lib/api-spec/package.json"));
    const orval = await import(pathToFileURL(requireSpec.resolve("orval")).href);
    const typescript = createRequire(path.join(root, "package.json"))("typescript");
    const generate = async (input: string, client: string, file: string) => {
      const target = path.join(dir, file);
      await orval.generate({ input, output: { target, client, mode: "single", clean: false, prettier: false, baseUrl: "/api" } }, dir);
      const source = await readFile(target, "utf8");
      const parsed = typescript.createSourceFile(target, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
      assert.deepEqual(parsed.parseDiagnostics, [], `${client} output must remain valid TypeScript`);
      return { source, target };
    };
    await fn({ dir, generate });
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

test("SB patched generator still handles the local API spec for React Query and Zod", () => isolatedCodegen(async (ctx) => {
  const input = path.join(root, "lib/api-spec/openapi.yaml");
  const react = await ctx.generate(input, "react-query", "react.ts");
  assert.match(react.source, /useHealthCheck/);
  assert.match(react.source, /getDashboardMetrics/);
  const zod = await ctx.generate(input, "zod", "schemas.ts");
  assert.match(zod.source, /export const HealthCheckResponse = zod\.object/);
  assert.match(zod.source, /export const GetDashboardMetricsResponse = zod\.object/);
}));

test("SB generated request URL treats injected code as data, without evaluating it", () => isolatedCodegen(async (ctx) => {
  const marker = "__medinaCodegenInjected";
  const hostilePath = `/users/\` + (globalThis.${marker} = true) + \`/list`;
  const spec = {
    openapi: "3.0.3", info: { title: "Security fixture", version: "1.0.0" },
    paths: { [hostilePath]: { get: { operationId: "securityProbe", responses: { "200": { description: "Local fixture" } } } } },
  };
  const input = path.join(ctx.dir, "hostile.json");
  await writeFile(input, JSON.stringify(spec));
  assert.equal((globalThis as any)[marker], undefined);
  try {
    const output = await ctx.generate(input, "fetch", "safe-client.ts");
    const generated = await import(pathToFileURL(output.target).href);
    assert.equal((globalThis as any)[marker], undefined);
    assert.equal(generated.getSecurityProbeUrl(), `/api${hostilePath}`);
    assert.equal((globalThis as any)[marker], undefined);
  } finally {
    delete (globalThis as any)[marker];
  }
}));

function deploymentParsers() {
  const requireRoot = createRequire(path.join(root, "package.json"));
  const requireVercel = createRequire(requireRoot.resolve("@vercel/node"));
  const requireBuild = createRequire(requireVercel.resolve("@vercel/build-utils"));
  return createRequire(requireBuild.resolve("@vercel/python-analysis"));
}

test("SB patched YAML parser bounds empty merges and preserves ordinary configuration", () => {
  const requireParser = deploymentParsers();
  assert.equal(requireParser("js-yaml/package.json").version, "4.3.2");
  const yaml = requireParser("js-yaml");
  const source = `arr: &arr [${Array(20).fill("{}").join(",")} ]\nresult:\n  <<: *arr\n`;
  assert.throws(() => yaml.load(source, { maxTotalMergeKeys: 8 }), /maxTotalMergeKeys/);
  assert.deepEqual(yaml.load("defaults: &defaults\n  port: 8080\nserver:\n  <<: *defaults\n  name: fixture\n"), {
    defaults: { port: 8080 }, server: { port: 8080, name: "fixture" },
  });
});

test("SB patched TOML parser preserves nested config and rejects duplicate keys", () => {
  const requireParser = deploymentParsers();
  const toml = requireParser("smol-toml");
  const value = toml.parse('name = "fixture"\n[project]\nversion = "1.0"\n[[project.tasks]]\nname = "build"\n');
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.project), null);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { name: "fixture", project: { version: "1.0", tasks: [{ name: "build" }] } });
  assert.deepEqual(toml.parse(toml.stringify(value)), value);
  assert.throws(() => toml.parse("key = 1\nkey = 2\n"), /duplicate|defined/i);
  const flat = Array.from({ length: 2000 }, (_, i) => `k${i} = ${i}`).join("\n");
  const parsed = toml.parse(flat);
  assert.equal(Object.keys(parsed).length, 2000);
  assert.equal(parsed.k1999, 1999);
});

test("SB actual generator URI parser normalizes encoded host spelling consistently", () => {
  const requireSpec = createRequire(path.join(root, "lib/api-spec/package.json"));
  const requireOrval = createRequire(requireSpec.resolve("orval"));
  const requireScalar = createRequire(requireOrval.resolve("@scalar/openapi-parser"));
  const requireAjv = createRequire(requireScalar.resolve("ajv"));
  assert.equal(requireAjv("fast-uri/package.json").version, "3.1.8");
  const uri = requireAjv("fast-uri");
  for (const spelling of ["//%41.com", "//A.com", "//a.com"]) {
    assert.equal(uri.parse(spelling).host, "a.com");
    assert.equal(uri.equal(spelling, "//a.com"), true);
  }
  assert.equal(uri.resolve("https://example.test/api/", "../health"), "https://example.test/health");
});

test("SB workspace migration denies browser roles without changing business rows or server access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key, name text not null);
      insert into public.workspaces values ('${WORKSPACE}', 'Local clinic fixture');
      grant all on public.workspaces to public, anon, authenticated;
    `);
    const sql = await readFile(path.join(root, "migrations/068_workspaces_row_security.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql); // Repeat is safe and changes neither rows nor schema shape.
    assert.deepEqual((await db.query("select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass")).rows, [{ relrowsecurity: true }]);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const query of ["select * from public.workspaces", "update public.workspaces set name = 'blocked'", "delete from public.workspaces", `insert into public.workspaces values ('${FOREIGN}', 'blocked')`]) {
        await assert.rejects(db.exec(query), /permission denied/);
      }
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.deepEqual((await db.query("select id, name from public.workspaces")).rows, [{ id: WORKSPACE, name: "Local clinic fixture" }]);
    await db.exec(`insert into public.workspaces values ('${FOREIGN}', 'Server fixture'); update public.workspaces set name = 'Server updated' where id = '${FOREIGN}'; delete from public.workspaces where id = '${FOREIGN}';`);
    await db.exec("reset role");
    assert.deepEqual((await db.query("select id, name from public.workspaces")).rows, [{ id: WORKSPACE, name: "Local clinic fixture" }]);
  } finally {
    await db.close();
  }
});

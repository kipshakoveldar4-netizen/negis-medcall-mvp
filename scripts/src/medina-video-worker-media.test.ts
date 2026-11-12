import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";

// Real ffprobe/ffmpeg, streams and scratch files. Queue/Storage/auth/network are
// explicit doubles. No worker main(), real SDK client, credentials or cloud DB.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const media = await load("artifacts/video-worker/src/ffmpeg.ts");
const download = await load("artifacts/video-worker/src/download.ts");
const worker = await load("artifacts/video-worker/src/worker.ts");
const generationIdentity = await load("lib/crm/generated-video-identity.ts");
const reclamation = await load("artifacts/video-worker/src/generated-raw-reclamation.ts");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", JOB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORIGIN = "https://video-worker.fixture.invalid", KEY = "SYNTHETIC_SERVICE_CREDENTIAL_FOR_LOCAL_ONLY";
const PRIVATE = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
type Row = Record<string, any>;
let directory: string, clip: Buffer;
before(async () => {
  directory = await mkdtemp(path.join(root, "node_modules/.cache/video-worker-media-"));
  const metadataFile = path.join(directory, "source-metadata.txt");
  await writeFile(metadataFile, `;FFMETADATA1\ncomment=${PRIVATE}\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=${PRIVATE}\n`);
  await promisify(execFile)("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=green:s=64x256:r=5", "-f", "ffmetadata", "-i", metadataFile, "-map", "0:v:0",
    "-map_metadata", "1", "-map_chapters", "1", "-t", "2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p",
    "-metadata:s:v:0", `title=${PRIVATE}`, path.join(directory, "source.mp4")], { windowsHide: true, timeout: 15000 });
  clip = await readFile(path.join(directory, "source.mp4"));
});
after(async () => { if (directory) {
  assert.equal(path.dirname(directory), path.join(root, "node_modules/.cache"));
  assert.ok(path.basename(directory).startsWith("video-worker-media-"));
  await rm(directory, { recursive: true });
} });

function probe(overrides: Row = {}) {
  return { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.0" }, streams: [
    { codec_type: "video", codec_name: "h264", width: 64, height: 256, avg_frame_rate: "5/1", nb_frames: "10", ...overrides },
  ] };
}

for (const stage of ["read", "claim"] as const) test(`queue ${stage} failure cannot echo an SDK diagnostic`, async () => {
  const builder: Row = {};
  Object.assign(builder, {
    select: () => builder, eq: () => builder, lt: () => builder, order: () => builder, limit: () => builder, update: () => builder,
    then: (resolve: (value: Row) => void) => resolve(stage === "read"
      ? { data: null, error: { message: PRIVATE } } : { data: [{ id: JOB, attempts: 0 }], error: null }),
    maybeSingle: async () => ({ data: null, error: { message: PRIVATE } }),
  });
  await assert.rejects(worker.claimNextJob({ from: () => builder }, { maxAttempts: 3, workerId: "qa-worker" }),
    (error: Error) => error.message === `video_queue_${stage}_unconfirmed` && !String(error).includes(PRIVATE));
  const main = await readFile(path.join(root, "artifacts/video-worker/src/index.ts"), "utf8");
  assert.doesNotMatch(main, /error\.message|String\(error\)/);
});

test("probe contract admits the intended file and denies pathological metadata", () => {
  assert.deepEqual(media.validateVideoProbe(probe(), "video/mp4"), { width: 64, height: 256, duration: 2, fps: 5 });
  for (const change of [{ width: 0 }, { width: 9000 }, { height: 9000 }, { width: 8192, height: 8192 },
    { width: 2.5 }, { width: "64oops" }, { avg_frame_rate: "0/0" }, { avg_frame_rate: "121/1" },
    { avg_frame_rate: "Infinity/1" }, { nb_frames: "72001" }, { nb_frames: "0" }, { nb_frames: null }, { codec_name: "rawvideo" }, { disposition: { attached_pic: 1 } }]) {
    assert.throws(() => media.validateVideoProbe(probe(change), "video/mp4"));
  }
  for (const duration of ["0", "601", "NaN", "Infinity", "", null]) {
    const value: Row = probe(); value.format.duration = duration;
    assert.throws(() => media.validateVideoProbe(value, "video/mp4"));
  }
  const duplicate = probe(); duplicate.streams.push({ ...duplicate.streams[0] });
  assert.throws(() => media.validateVideoProbe(duplicate, "video/mp4"));
  assert.throws(() => media.validateVideoProbe(probe(), "video/webm"));
});

test("native media commands bound both dimensions and retain no service environment", async () => {
  const env = media.mediaProcessEnvironment({ PATH: "synthetic", SUPABASE_SERVICE_ROLE_KEY: KEY,
    META_ACCESS_TOKEN: PRIVATE, FFREPORT: PRIVATE, LD_PRELOAD: PRIVATE });
  assert.deepEqual(env, { PATH: "synthetic" });
  assert.match(media.buildScaleFilter({ maxWidth: 64, maxHeight: 64, fps: 5 }), /h='min\(64,ih\)'/);
  for (const options of [{ maxWidth: 0 }, { maxHeight: 8192 }, { fps: 1.5 }]) {
    assert.throws(() => media.buildScaleFilter({ maxWidth: 64, maxHeight: 64, fps: 5, ...options }));
  }
  const input = path.join(directory, "source.mp4");
  const decoded = await media.probeVideo("ffprobe", input, "video/mp4");
  assert.equal(decoded.height, 256);
  await media.runFfmpeg("ffmpeg", media.buildDecodeArgs(input));
});

test("native child timeout kills the owned process and never echoes arguments or stderr", async () => {
  const pidFile = path.join(directory, "timeout.pid");
  await assert.rejects(media.runMediaProcess(process.execPath, ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); console.error(${JSON.stringify(PRIVATE)}); setInterval(()=>{},1000)`], 5000),
  (error: Error) => error.message === "video_media_timeout" && !String(error).includes(PRIVATE));
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  await assert.rejects(media.runMediaProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"], 5000),
    (error: Error) => !error.message.includes("x".repeat(100)));
});

test("native probe refuses a remote protocol without making a loopback request", async () => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.end(clip); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    await assert.rejects(media.probeVideo("ffprobe", `http://127.0.0.1:${address.port}/test.mp4`, "video/mp4"));
    const playlist = path.join(directory, "fake-mp4.mp4");
    await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/test.mp4\n#EXT-X-ENDLIST\n`);
    await assert.rejects(media.probeVideo("ffprobe", playlist, "video/mp4"));
    assert.equal(calls, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("native decoder rejects corrupted payload even when the original MP4 metadata remains readable", async () => {
  const corrupt = Buffer.from(clip), marker = corrupt.indexOf(Buffer.from("mdat"));
  assert.ok(marker >= 4);
  const end = marker - 4 + corrupt.readUInt32BE(marker - 4);
  assert.ok(end > marker + 4 && end < corrupt.length);
  corrupt.fill(0, marker + 4, end);
  const file = path.join(directory, "corrupt.mp4"); await writeFile(file, corrupt);
  const metadata = await media.probeVideo("ffprobe", file, "video/mp4"); assert.equal(metadata.width, 64);
  await assert.rejects(media.runFfmpeg("ffmpeg", media.buildDecodeArgs(file)));
});

async function fixture(t: TestContext, options: Row = {}) {
  const config = { supabaseUrl: ORIGIN, serviceRoleKey: KEY, workerId: "SYNTHETIC_QA_WORKER", maxAttempts: 3,
    tmpDir: directory, rawBucket: "ad-creatives-raw", outputBucket: "ad-creatives", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe",
    crf: 23, preset: "ultrafast", maxWidth: 64, maxHeight: 64, fps: 5 };
  const job: Row = { id: JOB, workspace_id: A, asset_id: ASSET, status: "downloading", attempts: 1,
    claimed_by: config.workerId, claimed_at: "2026-10-25T00:00:00Z", raw_bucket: config.rawBucket,
    raw_path: `${A}/input.mp4`, raw_size: clip.length, source_file_name: "input.mp4", source_mime_type: "video/mp4",
    output_bucket: config.outputBucket, optimized_bucket: config.outputBucket, metadata: {}, ...options.job };
  const asset: Row = { id: ASSET, workspace_id: A, file_type: "video", mime_type: "video/mp4", file_size: clip.length,
    storage_bucket: config.rawBucket, storage_path: `${A}/input.mp4`, updated_at: "2026-10-25T00:00:00Z",
    generated_key: null, metadata: { retained: true }, status: "optimizing", ...options.asset };
  if (job.metadata.kind === "generated-video-native") {
    job.metadata.generationKey = "v2:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const generated = generationIdentity.generatedVideoIdentity({ workspaceId: A, generationKey: job.metadata.generationKey });
    job.raw_path = generated.rawPath; job.asset_id = generated.assetId; job.source_file_name = generated.fileName;
    asset.id = generated.assetId; asset.storage_path = generated.rawPath; asset.file_name = generated.fileName;
  }
  let privateBytes = clip;
  const queries: Row[] = [], events: string[] = [], objects = new Map<string, Buffer>(), logs: string[] = [];
  let promotionCalls = 0;
  const db = { from(table: string) {
    assert.ok(["ad_creative_assets", "video_processing_jobs"].includes(table));
    const query: Row = { table, filters: {}, values: null }; queries.push(query);
    const execute = async () => {
      const row = table === "ad_creative_assets" ? asset : job;
      if (!Object.entries(query.filters).every(([key, value]) => row[key] === value)) return { data: null, error: null };
      if (query.values) {
        events.push(`db:${table}:${query.values.status || "cleanup"}`);
        if (table === "ad_creative_assets" && query.values.status === "ready" && options.assetSaveFailure) return { data: null, error: { message: PRIVATE } };
        if (table === "video_processing_jobs" && query.values.status === "ready" && options.readyFailure === "before") return { data: null, error: { message: PRIVATE } };
        Object.assign(row, structuredClone(query.values));
        if (table === "video_processing_jobs" && query.values.status === "ready" && options.readyFailure === "after") return { data: null, error: { message: PRIVATE } };
      }
      return { data: structuredClone(row), error: null };
    };
    const builder = { select() { return builder; }, update(values: Row) { query.values = values; return builder; },
      eq(key: string, value: unknown) { query.filters[key] = value; return builder; }, maybeSingle: execute,
      then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) { return execute().then(resolve, reject); } };
    return builder;
  }, async rpc(name: string, args: Row) {
    if (name === "ack_generated_video_raw_reclamation") {
      assert.equal(job.status, "ready"); assert.equal(args.p_job_id, JOB); assert.equal(args.p_workspace_id, A);
      assert.deepEqual(privateBytes, reclamation.GENERATED_RAW_FENCE);
      events.push("ack:raw-fence"); job.raw_deleted_at = new Date().toISOString();
      return { data: { jobId: JOB, workspaceId: A, status: "reclaimed", fenceSize: args.p_fence_size, fenceSha256: args.p_fence_sha256 }, error: null };
    }
    promotionCalls++;
    assert.equal(name, "finalize_video_job");
    assert.equal(args.p_job_id, JOB); assert.equal(args.p_workspace_id, A);
    assert.equal(args.p_claimed_at, "2026-10-25T00:00:00Z"); assert.equal(args.p_attempt, 1);
    if (job.claimed_by !== args.p_claimed_by || job.claimed_at !== args.p_claimed_at || job.attempts !== args.p_attempt
      || !["uploading", "ready"].includes(job.status)) return { data: null, error: { message: PRIVATE } };
    if (job.status === "uploading") {
      if (options.assetSaveFailure || options.readyFailure === "before" || asset.updated_at !== args.p_asset_version) return { data: null, error: { message: PRIVATE } };
      const r = args.p_result;
      events.push("db:ad_creative_assets:ready", "db:video_processing_jobs:ready");
      Object.assign(asset, { status: "ready", storage_path: r.storage_path, storage_bucket: r.storage_bucket,
        public_url: r.public_url, mime_type: "video/mp4", file_size: r.file_size,
        metadata: { ...asset.metadata, optimized: true } });
      Object.assign(job, { status: "ready", optimized_path: r.storage_path, optimized_public_url: r.public_url,
        raw_deleted_at: null, raw_delete_error: null, error: null, error_message: null, promotion_receipt: r });
    }
    assert.deepEqual(job.promotion_receipt, args.p_result, "The fake RPC never invents a different replay payload");
    if (options.readyFailure === "after" || (options.readyFailure === "after-once" && promotionCalls === 1)) return { data: null, error: { message: PRIVATE } };
    return { data: { jobId: JOB, workspaceId: A, assetId: job.asset_id, status: "ready", promotion: args.p_result, ...options.receipt }, error: null };
  }, storage: { async getBucket(bucket: string) {
    assert.equal(bucket, config.rawBucket);
    return { data: { id: bucket, name: bucket, public: false, versioning_status: "disabled", file_size_limit: 104857600,
      allowed_mime_types: ["video/mp4"] }, error: null };
  }, from(bucket: string) {
    assert.ok([config.rawBucket, config.outputBucket].includes(bucket));
    return {
      async upload(key: string, bytes: Buffer, settings: Row) {
        if (bucket === config.rawBucket) {
          assert.equal(settings.upsert, true); assert.equal(settings.contentType, "video/mp4");
          assert.equal(key, job.raw_path); assert.deepEqual(bytes, reclamation.GENERATED_RAW_FENCE);
          events.push("replace:raw-fence"); privateBytes = Buffer.from(bytes);
          return { data: { path: key }, error: null };
        }
        events.push("upload:" + key); assert.equal(bucket, config.outputBucket); assert.equal(settings.upsert, false);
        assert.equal(objects.has(key), false); objects.set(key, Buffer.from(bytes));
        options.afterUpload?.({ job, asset });
        return { data: { path: key }, error: null };
      },
      getPublicUrl(key: string) { return { data: { publicUrl: `${ORIGIN}/storage/v1/object/public/${bucket}/${key}` } }; },
      async remove(keys: string[]) {
        events.push("remove:raw"); assert.equal(bucket, config.rawBucket); assert.deepEqual(keys, [`${A}/input.mp4`]);
        if (options.cleanupFailure) throw new Error(PRIVATE);
        return { data: keys.map(name => ({ name })), error: null };
      },
    };
  } } };
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(String(url), `${ORIGIN}/storage/v1/object/ad-creatives-raw/${job.raw_path}`);
    assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
    events.push("fetch:private");
    const bytes: Buffer = options.bytes ?? privateBytes;
    return new Response(bytes, { headers: { "content-length": String(bytes.length), "content-type": "video/mp4" } });
  });
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values.join(" ")); });
  t.mock.method(console, "warn", (...values: unknown[]) => { logs.push(values.join(" ")); });
  t.mock.method(console, "log", (...values: unknown[]) => { logs.push(values.join(" ")); });
  t.after(async () => {
    assert.equal(logs.join(" ").includes(PRIVATE), false);
    assert.equal(JSON.stringify([job.error, job.error_message]).includes(KEY), false);
    assert.deepEqual((await readdir(directory)).filter(file => file.startsWith("negis-video-")), [], "Every worker scratch directory is removed");
  });
  return { job, asset, objects, events, queries, logs, config,
    promotionCalls: () => promotionCalls, run: () => worker.processJob(db, config, structuredClone(job)),
  };
}

test("actual worker validates/transcodes the file, caps portrait height and deletes raw only after both durable receipts", async t => {
  const f = await fixture(t); await f.run();
  assert.equal(f.job.status, "ready"); assert.equal(f.asset.status, "ready"); assert.equal(f.objects.size, 2);
  assert.equal(f.asset.metadata.retained, true); assert.equal(f.asset.metadata.optimized, true);
  assert.match(f.job.optimized_path, new RegExp(`^optimized/${A}/${JOB}-[a-f0-9]{20}\\.mp4$`));
  const readyAt = f.events.indexOf("db:video_processing_jobs:ready"), removeAt = f.events.indexOf("remove:raw");
  assert.ok(readyAt > f.events.indexOf("db:ad_creative_assets:ready")); assert.ok(removeAt > readyAt);
  assert.ok(f.job.raw_deleted_at); assert.equal(f.job.raw_delete_error, null);
  const verified = path.join(directory, "verified.mp4"); await writeFile(verified, f.objects.get(f.job.optimized_path)!);
  const info = await media.probeVideo("ffprobe", verified, "video/mp4"); assert.equal(info.width, 16); assert.equal(info.height, 64);
  await media.runFfmpeg("ffmpeg", media.buildDecodeArgs(verified));
  const describe = (file: string) => media.runMediaProcess("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file], 15000);
  assert.ok((await describe(path.join(directory, "source.mp4"))).includes(PRIVATE), "The source actually contains private fixture metadata");
  assert.equal((await describe(verified)).includes(PRIVATE), false, "Global, stream and chapter metadata never survive into the published result");
  for (const query of f.queries.filter(item => item.table === "video_processing_jobs")) {
    assert.equal(query.filters.workspace_id, A); assert.equal(query.filters.claimed_by, f.config.workerId);
    assert.equal(query.filters.claimed_at, "2026-10-25T00:00:00Z"); assert.equal(query.filters.attempts, 1);
  }
});

test("generated input requires its bound SHA-256 before any public output or raw cleanup", async t => {
  const f = await fixture(t, { job: { metadata: { kind: "generated-video-native", inputSha256: "0".repeat(64) } } });
  await f.run();
  assert.equal(f.job.status, "failed"); assert.equal(f.objects.size, 0);
  assert.equal(f.events.includes("fetch:private"), true); assert.equal(f.events.includes("remove:raw"), false);
  assert.equal(f.promotionCalls(), 0);
});

test("the same generated input hash survives native decode, promotion and confirmed cleanup", async t => {
  const f = await fixture(t, { job: { metadata: { kind: "generated-video-native", inputSha256: createHash("sha256").update(clip).digest("hex") } } });
  await f.run();
  assert.equal(f.job.status, "ready"); assert.equal(f.objects.size, 2); assert.equal(f.promotionCalls(), 1);
  assert.equal(f.events.includes("remove:raw"), false); assert.equal(f.events.includes("replace:raw-fence"), true);
  assert.equal(f.events.includes("ack:raw-fence"), true);
});

for (const invalid of [undefined, "", "x".repeat(64), "A".repeat(64), 42]) test(`generated input refuses an invalid bound hash (${String(invalid)}) before download`, async t => {
  const f = await fixture(t, { job: { metadata: { kind: "generated-video-native", inputSha256: invalid } } });
  await f.run();
  assert.equal(f.job.status, "failed"); assert.equal(f.events.includes("fetch:private"), false);
  assert.equal(f.objects.size, 0); assert.equal(f.promotionCalls(), 0);
});

for (const [label, options] of [
  ["foreign asset", { asset: { workspace_id: B } }], ["different raw bucket", { job: { raw_bucket: "another-private" } }],
  ["foreign raw path", { job: { raw_path: `${B}/input.mp4` } }], ["redirected output bucket", { job: { optimized_bucket: "another-public" } }],
  ["oversized declared original", { job: { raw_size: media.VIDEO_MEDIA_LIMITS.maxInputBytes + 1 } }],
  ["changed asset file", { asset: { storage_path: `${A}/replacement.mp4` } }],
  ["immutable generated source", { asset: { generated_key: "v1:SYNTHETIC_GENERATION" } }],
  ["old generated metadata", { asset: { metadata: { uploadMode: "ai-generated", kind: "generated-video" } } }],
] as Array<[string, Row]>) test(`worker refuses ${label} before download/public upload`, async t => {
  const f = await fixture(t, options); await f.run();
  assert.equal(f.events.includes("fetch:private"), false); assert.equal(f.objects.size, 0);
  assert.equal(f.events.includes("remove:raw"), false); assert.equal(f.job.status, "failed");
});

test("worker retains raw and never publishes signature-only/truncated input", async t => {
  const f = await fixture(t, { bytes: Buffer.alloc(8) }); f.job.raw_size = 8; f.asset.file_size = 8;
  await f.run(); assert.equal(f.job.status, "failed"); assert.equal(f.objects.size, 0); assert.equal(f.events.includes("remove:raw"), false);
});

test("lost claim after output upload cannot replace the asset or remove raw", async t => {
  const f = await fixture(t, { afterUpload: ({ job }: Row) => { job.claimed_by = "SYNTHETIC_OTHER_WORKER"; } });
  await f.run(); assert.equal(f.asset.status, "optimizing"); assert.equal(f.events.includes("remove:raw"), false);
});

test("asset save failure retains raw and never marks the job ready", async t => {
  const f = await fixture(t, { assetSaveFailure: true }); await f.run();
  assert.equal(f.job.status, "failed"); assert.equal(f.events.includes("remove:raw"), false);
  assert.equal(f.job.optimized_public_url, undefined);
});

test("lost ready response after commit never downgrades the committed ready row or deletes unconfirmed raw", async t => {
  const f = await fixture(t, { readyFailure: "after" }); await f.run();
  assert.equal(f.job.status, "ready"); assert.equal(f.asset.status, "ready"); assert.equal(f.events.includes("remove:raw"), false);
});

test("one lost promotion response replays the same transaction without duplicate uploads or another render", async t => {
  const f = await fixture(t, { readyFailure: "after-once" }); await f.run();
  assert.equal(f.job.status, "ready"); assert.equal(f.promotionCalls(), 2); assert.equal(f.objects.size, 2);
  assert.equal(f.events.filter(event => event === "db:ad_creative_assets:ready").length, 1);
  assert.equal(f.events.filter(event => event === "remove:raw").length, 1);
});

test("failed atomic promotion leaves the original asset identity and original file intact", async t => {
  const f = await fixture(t, { readyFailure: "before" }); await f.run();
  assert.equal(f.job.status, "failed"); assert.equal(f.asset.storage_path, `${A}/input.mp4`);
  assert.equal(f.events.includes("remove:raw"), false); assert.equal(f.events.includes("db:ad_creative_assets:ready"), false);
});

test("a malformed or foreign promotion acknowledgement never authorizes deleting the private original", async t => {
  const f = await fixture(t, { receipt: { workspaceId: B } }); await f.run();
  assert.equal(f.events.includes("remove:raw"), false); assert.equal(f.job.status, "ready");
});

test("cleanup failure preserves a confirmed ready result and cannot leak a private diagnostic", async t => {
  const f = await fixture(t, { cleanupFailure: true }); await f.run();
  assert.equal(f.job.status, "ready"); assert.equal(f.asset.status, "ready"); assert.equal(f.job.raw_deleted_at, null);
  assert.equal(f.job.error, null);
});

test("streaming download rejects excess/short bodies and never calls whole-body allocation", async t => {
  let index = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(index++ === 0 ? 11 : 9)); controller.close(); } }));
    Object.defineProperty(response, "arrayBuffer", { value() { assert.fail("No whole-body download"); } });
    return response;
  });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(download.downloadPrivateVideo({
    supabaseUrl: ORIGIN, serviceRoleKey: KEY, bucket: "ad-creatives-raw", path: `${A}/input.mp4`,
    outputPath: path.join(directory, `invalid-${attempt}.mp4`), expectedBytes: 10, maxBytes: 10,
  }));
});

for (const stalled of ["headers", "body"] as const) test(`download deadline aborts stalled ${stalled} and closes the own stream`, async t => {
  let signal: AbortSignal | undefined, cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    signal = init?.signal ?? undefined;
    if (stalled === "headers") return await new Promise<Response>(() => {});
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const at = Date.now();
  await assert.rejects(download.downloadPrivateVideo({ supabaseUrl: ORIGIN, serviceRoleKey: KEY, bucket: "ad-creatives-raw",
    path: `${A}/input.mp4`, outputPath: path.join(directory, `timeout-${stalled}.mp4`), expectedBytes: 10, maxBytes: 10, timeoutMs: 50 }));
  assert.ok(Date.now() - at < 3000); assert.equal(signal?.aborted, true); await setImmediate();
  if (stalled === "body") assert.equal(cancelled, true);
});

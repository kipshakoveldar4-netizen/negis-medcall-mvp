import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Only the production reclamation module runs. Storage, its create-only commit
// fence, RPC and HTTP are explicit doubles; SQL claim/capacity rules have their
// own disposable PostgreSQL suite. No real SDK client or worker is started.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Row = Record<string, any>;
const reclamation = await import(pathToFileURL(path.join(root, "artifacts/video-worker/src/generated-raw-reclamation.ts")).href) as {
  GENERATED_RAW_FENCE: Buffer; GENERATED_RAW_FENCE_SIZE: number; GENERATED_RAW_FENCE_SHA256: string;
  reclaimGeneratedVideoRaw: (sdk: Row, config: Row, job: Row) => Promise<Row>;
};
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "cccccccc-cccc-5ccc-8ccc-cccccccccccc", REQUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORIGIN = "https://generated-raw.fixture.invalid", SECRET = "SYNTHETIC_PRIVATE_CREDENTIAL_090_NO_NETWORK";
const KEY = `v2:${REQUEST}`, RAW_BUCKET = "ad-creatives-raw";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const KEY_DIGEST = digest(JSON.stringify(["medina-generated-v1", W, KEY]));
const RAW_PATH = `${W}/generated-raw/${KEY_DIGEST}/original.mp4`;
const URI = `${ORIGIN}/storage/v1/object/${RAW_BUCKET}/${RAW_PATH}`;
const SHA = "7522cc049e7a011985341bb575c7634f6333318a191b08beb1196b7e7426c1e2";
const free = Buffer.alloc(32); free.writeUInt32BE(32, 0); free.write("free", 4); free.write("MEDINA-RAW-FENCE-V1", 8);
const MARKER = Buffer.concat([Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"), free]);
const ORIGINAL = Buffer.from("OWNED_SYNTHETIC_GENERATED_RAW");
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function refused(promise: Promise<unknown>) {
  return assert.rejects(promise, (error: unknown) => error instanceof Error
    && error.message === "generated_raw_reclamation_unconfirmed" && !String(error).includes(SECRET));
}

function fixture(t: TestContext, options: Row = {}) {
  const config: Row = { supabaseUrl: ORIGIN, serviceRoleKey: SECRET, workerId: "qa-native-worker", maxAttempts: 3,
    rawBucket: RAW_BUCKET, outputBucket: "ad-creatives" };
  const job: Row = { id: JOB, workspace_id: W, asset_id: ASSET, status: "ready", attempts: 1,
    claimed_by: config.workerId, claimed_at: "2026-10-25T01:02:03.000Z", raw_bucket: RAW_BUCKET, raw_path: RAW_PATH,
    raw_size: ORIGINAL.length, source_mime_type: "video/mp4", source_file_name: `negis-video-${KEY_DIGEST.slice(0, 20)}.mp4`,
    output_bucket: "ad-creatives", optimized_bucket: "ad-creatives",
    metadata: { kind: "generated-video-native", generationKey: KEY, inputSha256: digest(ORIGINAL) } };
  const files = new Map<string, Buffer>([[RAW_PATH, Buffer.from(ORIGINAL)]]), calls: Row[] = [], events: string[] = [];
  const bucketStarted = deferred(), uploadStarted = deferred(), fetchStarted = deferred(), ackStarted = deferred();
  let uploads = 0, acknowledgements = 0, bodyFinished = false, cancellationCount = 0, aborted = false;
  const receipt = { jobId: JOB, workspaceId: W, status: "reclaimed", fenceSize: 56, fenceSha256: SHA };
  const sdk: Row = { storage: {
    async getBucket(bucket: string) {
      calls.push({ kind: "bucket", bucket }); events.push("bucket"); bucketStarted.resolve();
      if (options.bucketHang) return new Promise(() => {});
      if (options.bucketThrow) throw new Error(SECRET);
      const data: Row = { id: RAW_BUCKET, name: RAW_BUCKET, public: false, file_size_limit: 104857600,
        allowed_mime_types: ["video/mp4"], versioning_status: "disabled", ...options.bucket };
      if (options.legacyVersioning) delete data.versioning_status;
      options.afterBucket?.(config, job);
      return { data, error: options.bucketError ? { message: SECRET } : null };
    },
    from(bucket: string) {
      assert.equal(bucket, RAW_BUCKET);
      return {
        async upload(objectPath: string, bytes: Buffer, uploadOptions: Row) {
          calls.push({ kind: "upload", bucket, path: objectPath, options: { ...uploadOptions }, bytes: Buffer.from(bytes) });
          events.push("upload"); uploads++; uploadStarted.resolve();
          assert.equal(objectPath, RAW_PATH); assert.deepEqual(uploadOptions, { contentType: "video/mp4", upsert: true });
          assert.deepEqual(bytes, MARKER);
          if (!options.noCommit) files.set(objectPath, options.corruptCommit ? Buffer.alloc(56, 9) : Buffer.from(bytes));
          options.afterUpload?.(config, job);
          if (options.uploadHang) return new Promise(() => {});
          if (options.uploadThrow) throw new Error(SECRET);
          return { data: { path: options.wrongUploadPath ? "wrong" : objectPath }, error: options.uploadError ? { message: SECRET } : null };
        },
        remove() { throw new Error("A generated raw key must never be deleted"); },
      };
    },
  }, async rpc(name: string, args: Row) {
    calls.push({ kind: "rpc", name, args: { ...args } }); events.push("ack"); acknowledgements++; ackStarted.resolve();
    assert.equal(name, "ack_generated_video_raw_reclamation");
    assert.equal(bodyFinished, true, "A complete private byte proof must precede database acknowledgement");
    assert.deepEqual(args, { p_job_id: JOB, p_workspace_id: W, p_claimed_by: "qa-native-worker", p_claimed_at: "2026-10-25T01:02:03.000Z",
      p_attempt: 1, p_fence_size: 56, p_fence_sha256: SHA });
    if (options.ackHang) return new Promise(() => {});
    if (acknowledgements <= (options.lostAcks ?? 0)) throw new Error(SECRET);
    if (options.ackCode) return { data: null, error: { code: options.ackCode, message: SECRET } };
    return { data: { ...receipt, ...options.receipt }, error: null };
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, request: RequestInit) => {
    calls.push({ kind: "fetch", url, request }); events.push("fetch"); fetchStarted.resolve();
    assert.equal(url, URI); assert.equal(request.method, "GET"); assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit"); assert.equal(request.cache, "no-store");
    assert.deepEqual(request.headers, { Authorization: `Bearer ${SECRET}`, apikey: SECRET });
    request.signal?.addEventListener("abort", () => { aborted = true; });
    if (options.fetchPromise) return options.fetchPromise;
    if (options.fetchHang) return new Promise(() => {});
    if (options.fetchThrow) throw new Error(SECRET);
    const bytes = options.body ?? files.get(RAW_PATH)!;
    const headers: Row = { "content-type": options.mime ?? "video/mp4", "content-length": String(options.length ?? bytes.length) };
    if (options.noLength) delete headers["content-length"];
    let sent = false;
    const body = options.nullBody ? null : new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) { bodyFinished = true; events.push("body-finished"); controller.close(); return; }
        if (options.stallBody) return new Promise(() => {});
        if (options.bodyGate) await options.bodyGate;
        sent = true;
        controller.enqueue(new Uint8Array(bytes));
      },
      cancel() { cancellationCount++; if (options.cancelHang) return new Promise(() => {}); return undefined; },
    });
    const response = new Response(body, { status: options.httpStatus ?? 200, headers });
    if (options.redirected) Object.defineProperty(response, "redirected", { value: true });
    if (options.responseUrl) Object.defineProperty(response, "url", { value: options.responseUrl });
    return response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { config, job, sdk, files, calls, events, receipt, bucketStarted: bucketStarted.promise, uploading: uploadStarted.promise,
    fetching: fetchStarted.promise, acknowledging: ackStarted.promise,
    run: () => reclamation.reclaimGeneratedVideoRaw(sdk, config, job),
    counts: () => ({ uploads, acknowledgements, bodyFinished, cancellationCount, aborted }),
    lateCreateOnly() {
      // Models the create-only Storage commit fence: a prior token/request
      // cannot replace a key occupied by the verified marker.
      if (files.has(RAW_PATH)) return false;
      files.set(RAW_PATH, Buffer.from(ORIGINAL)); return true;
    } };
}

test("generated raw fence constants exactly match the SQL-bound two-box 56-byte marker", () => {
  assert.equal(reclamation.GENERATED_RAW_FENCE_SIZE, 56); assert.equal(reclamation.GENERATED_RAW_FENCE_SHA256, SHA);
  assert.deepEqual(reclamation.GENERATED_RAW_FENCE, MARKER); assert.equal(digest(MARKER), SHA);
  assert.equal(MARKER.readUInt32BE(0), 24); assert.equal(MARKER.subarray(4, 8).toString(), "ftyp");
  assert.equal(MARKER.readUInt32BE(24), 32); assert.equal(MARKER.subarray(28, 32).toString(), "free");
  assert.equal(MARKER.subarray(32, 51).toString(), "MEDINA-RAW-FENCE-V1"); assert.deepEqual(MARKER.subarray(51), Buffer.alloc(5));
});

test("generated raw reclamation overwrites only its private key, proves bytes, then acknowledges the same claim", async t => {
  const f = fixture(t); assert.deepEqual(await f.run(), f.receipt);
  assert.deepEqual(f.files.get(RAW_PATH), MARKER); assert.equal(f.files.size, 1);
  assert.deepEqual(f.events, ["bucket", "upload", "fetch", "body-finished", "ack"]);
  assert.equal(f.counts().uploads, 1); assert.equal(f.counts().acknowledgements, 1); assert.equal(f.counts().aborted, true);
});

test("generated raw reclamation leaves an occupied key that rejects a late create-only raw commit", async t => {
  const f = fixture(t); await f.run();
  assert.equal(f.lateCreateOnly(), false); assert.deepEqual(f.files.get(RAW_PATH), MARKER);
  await f.run(); assert.equal(f.lateCreateOnly(), false); assert.equal(f.files.size, 1);
});

test("generated raw a late create-only commit is refused while byte proof and ACK are still pending", async t => {
  const gate = deferred(), f = fixture(t, { bodyGate: gate.promise });
  const pending = f.run(); await f.fetching; await flush();
  assert.equal(f.counts().acknowledgements, 0); assert.equal(f.lateCreateOnly(), false);
  assert.deepEqual(f.files.get(RAW_PATH), MARKER); gate.resolve(); assert.deepEqual(await pending, f.receipt);
});

for (const option of ["uploadThrow", "uploadError", "wrongUploadPath"]) test(`generated raw ${option} reconciles only the exact committed private marker`, async t => {
  const f = fixture(t, { [option]: true }); assert.deepEqual(await f.run(), f.receipt);
  assert.equal(f.counts().acknowledgements, 1); assert.deepEqual(f.files.get(RAW_PATH), MARKER);
});

test("generated raw no acknowledgement is sent before the final response-body chunk is consumed", async t => {
  const gate = deferred(), f = fixture(t, { bodyGate: gate.promise });
  const pending = f.run(); await f.fetching; await flush();
  assert.equal(f.counts().acknowledgements, 0); gate.resolve(); assert.deepEqual(await pending, f.receipt);
});

for (const lostAcks of [1, 2]) test(`generated raw reconciles at most two identical ACK calls after ${lostAcks} lost responses`, async t => {
  const f = fixture(t, { lostAcks });
  if (lostAcks === 1) assert.deepEqual(await f.run(), f.receipt); else await refused(f.run());
  const calls = f.calls.filter(call => call.kind === "rpc"); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.counts().uploads, 1); assert.deepEqual(f.files.get(RAW_PATH), MARKER);
});

for (const ackCode of ["P9002", "P9004", "42501"]) test(`generated raw does not retry known database refusal ${ackCode}`, async t => {
  const f = fixture(t, { ackCode }); await refused(f.run()); assert.equal(f.counts().acknowledgements, 1);
});

for (const receipt of [{ jobId: W }, { workspaceId: JOB }, { status: "ready" }, { fenceSize: 55 }, { fenceSha256: "a".repeat(64) }, { extra: true }]) {
  test(`generated raw rejects malformed acknowledgement ${JSON.stringify(receipt)}`, async t => {
    const f = fixture(t, { receipt }); await refused(f.run()); assert.equal(f.counts().acknowledgements, 2);
  });
}

for (const options of [
  { noCommit: true }, { corruptCommit: true }, { body: Buffer.alloc(56, 8) }, { body: Buffer.alloc(55) }, { body: Buffer.alloc(57) },
  { body: Buffer.alloc(55), length: 56 }, { body: Buffer.alloc(57), length: 56 }, { body: Buffer.alloc(0), length: 56 },
  { length: "56garbage" }, { length: 55 }, { length: 57 }, { mime: "image/jpeg" }, { mime: "video/quicktime" },
  { httpStatus: 403 }, { httpStatus: 404 }, { httpStatus: 503 }, { nullBody: true }, { fetchThrow: true },
  { redirected: true }, { responseUrl: "https://foreign.invalid/storage/v1/object/ad-creatives-raw/object.mp4" },
]) test(`generated raw private proof refuses ${JSON.stringify(options)} without database acknowledgement`, async t => {
  const f = fixture(t, options); await refused(f.run()); assert.equal(f.counts().acknowledgements, 0);
});

test("generated raw exact proof accepts chunked transfer without a Content-Length header", async t => {
  const f = fixture(t, { noLength: true }); assert.deepEqual(await f.run(), f.receipt);
});

for (const bucket of [
  { public: true }, { id: "foreign" }, { name: "foreign" }, { file_size_limit: 104857599 }, { file_size_limit: 524288001 },
  { allowed_mime_types: ["image/jpeg"] }, { allowed_mime_types: ["video/mp4", "text/html"] },
  { versioning_status: "enabled" }, { versioning_status: "suspended" }, { versioning_status: null }, { versioning_status: "unknown" },
]) test(`generated raw rejects unsafe bucket ${JSON.stringify(bucket)} before upload`, async t => {
  const f = fixture(t, { bucket }); await refused(f.run()); assert.equal(f.counts().uploads, 0); assert.equal(f.counts().acknowledgements, 0);
});

test("generated raw legacy bucket metadata is not mistaken for proof of physical version erasure", async t => {
  const f = fixture(t, { legacyVersioning: true }); assert.deepEqual(await f.run(), f.receipt);
  assert.equal(f.receipt.status, "reclaimed"); assert.equal(f.files.has(RAW_PATH), true);
});

for (const option of ["bucketError", "bucketThrow"]) test(`generated raw ${option} stops before upload and hides diagnostics`, async t => {
  const f = fixture(t, { [option]: true }); await refused(f.run());
  assert.equal(f.counts().uploads, 0); assert.equal(f.counts().acknowledgements, 0);
});

for (const [field, value] of [
  ["id", W.replace("4aaa", "1aaa")], ["workspace_id", null], ["asset_id", JOB], ["status", "uploading"],
  ["attempts", 0], ["attempts", 4], ["claimed_by", "foreign-worker"], ["claimed_at", "invalid"],
  ["raw_bucket", "ad-creatives"], ["raw_path", `${W}/generated-raw/${"0".repeat(64)}/original.mp4`],
  ["raw_size", 0], ["raw_size", 104857601], ["source_mime_type", "video/quicktime"], ["source_file_name", "foreign.mp4"],
  ["output_bucket", "foreign"], ["optimized_bucket", null], ["metadata", {}],
] as const) test(`generated raw rejects invalid own job ${field}=${String(value)} without I/O`, async t => {
  const f = fixture(t); f.job[field] = value; await refused(f.run()); assert.deepEqual(f.calls, []);
});

for (const change of [
  { kind: "uploaded-video" }, { inputSha256: null }, { generationKey: "v2:not-a-request" }, { generationKey: " padded " },
  { generationKey: "\u0000" }, { generationKey: "\ud800" }, { generationKey: "x".repeat(513) },
]) test(`generated raw rejects unbound metadata ${JSON.stringify(change)} without I/O`, async t => {
  const f = fixture(t); Object.assign(f.job.metadata, change); await refused(f.run()); assert.deepEqual(f.calls, []);
});

for (const [field, value] of [
  ["supabaseUrl", "http://generated-raw.fixture.invalid"], ["supabaseUrl", "https://name:password@foreign.invalid"],
  ["supabaseUrl", `${ORIGIN}/path`], ["supabaseUrl", `${ORIGIN}?query=1`], ["serviceRoleKey", "short"],
  ["serviceRoleKey", `key\r\n${SECRET}`], ["rawBucket", "ad-creatives"], ["outputBucket", "foreign"], ["workerId", ""],
] as const) test(`generated raw invalid configuration ${field} is refused before credential-bearing I/O`, async t => {
  const f = fixture(t); f.config[field] = value; await refused(f.run()); assert.deepEqual(f.calls, []);
});

test("generated raw snapshots claim, metadata, path and trusted origin before asynchronous bucket work", async t => {
  const f = fixture(t, { afterBucket(config: Row, job: Row) {
    config.supabaseUrl = "https://foreign.invalid"; config.rawBucket = "foreign"; config.serviceRoleKey = "foreign";
    job.raw_path = "foreign"; job.claimed_by = "foreign"; job.metadata.generationKey = "foreign";
  } });
  assert.deepEqual(await f.run(), f.receipt); assert.equal(f.calls.find(call => call.kind === "fetch")?.url, URI);
});

test("generated raw exported marker mutation cannot change the internal marker or acknowledged hash", async t => {
  const saved = Buffer.from(reclamation.GENERATED_RAW_FENCE);
  try {
    reclamation.GENERATED_RAW_FENCE.fill(0); const f = fixture(t); assert.deepEqual(await f.run(), f.receipt);
    assert.deepEqual(f.files.get(RAW_PATH), MARKER);
  } finally { saved.copy(reclamation.GENERATED_RAW_FENCE); }
});

test("generated raw stalled private response headers stop at ten seconds with no ACK", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { fetchHang: true }), rejected = refused(f.run());
  await f.fetching; t.mock.timers.tick(10000); await rejected;
  assert.equal(f.counts().acknowledgements, 0); assert.equal(f.counts().aborted, true);
});

test("generated raw stalled body and stalled cancellation cannot extend the ten-second deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { stallBody: true, cancelHang: true }), rejected = refused(f.run());
  await f.fetching; await flush(); t.mock.timers.tick(10000); await rejected;
  assert.equal(f.counts().acknowledgements, 0); assert.equal(f.counts().aborted, true);
});

test("generated raw headers and body share one deadline rather than ten seconds each", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const headers = deferred<Response>(); let cancelled = false;
  const f = fixture(t, { fetchPromise: headers.promise }), pending = f.run(), rejected = refused(pending);
  await f.fetching; t.mock.timers.tick(6000);
  headers.resolve(new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }),
    { headers: { "content-type": "video/mp4", "content-length": "56" } }));
  await flush(); let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(3999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(f.counts().acknowledgements, 0); assert.equal(cancelled, true);
});

test("generated raw a late fetch response is cancelled after timeout without acknowledging it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const headers = deferred<Response>(); let cancellations = 0;
  const f = fixture(t, { fetchPromise: headers.promise }), rejected = refused(f.run());
  await f.fetching; t.mock.timers.tick(10000); await rejected;
  headers.resolve(new Response(new ReadableStream({ cancel() { cancellations++; } })));
  await flush(); assert.equal(cancellations, 1); assert.equal(f.counts().acknowledgements, 0);
});

test("generated raw an uncertain stalled upload may succeed only after its exact private byte proof", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { uploadHang: true }), pending = f.run();
  await f.uploading; t.mock.timers.tick(20000); assert.deepEqual(await pending, f.receipt);
  assert.equal(f.counts().uploads, 1); assert.equal(f.counts().acknowledgements, 1);
});

test("generated raw a stalled uncommitted upload cannot release raw capacity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { uploadHang: true, noCommit: true }), rejected = refused(f.run());
  await f.uploading; t.mock.timers.tick(20000); await rejected; assert.equal(f.counts().acknowledgements, 0);
});

test("generated raw bucket SDK timeout ends before upload or acknowledgement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { bucketHang: true }), rejected = refused(f.run());
  await f.bucketStarted; t.mock.timers.tick(20000); await rejected; assert.equal(f.counts().uploads, 0);
});

test("generated raw ACK SDK timeout permits exactly two identical twenty-second attempts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => t.mock.timers.reset());
  const f = fixture(t, { ackHang: true }), rejected = refused(f.run());
  await f.acknowledging; t.mock.timers.tick(20000); await flush(); t.mock.timers.tick(20000); await rejected;
  assert.equal(f.counts().acknowledgements, 2);
  const calls = f.calls.filter(call => call.kind === "rpc"); assert.deepEqual(calls[0], calls[1]);
});

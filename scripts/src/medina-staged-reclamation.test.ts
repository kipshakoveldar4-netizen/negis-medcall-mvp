import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { reclaimStagedCreativeUploads } = await import(pathToFileURL(path.join(root, "lib/crm/staged-creative-reclamation.ts")).href);
const sharp = createRequire(path.join(root, "package.json"))("sharp");
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", O = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bucket = "ad-creatives-staging", origin = "https://reclamation.fixture.invalid", secret = "SYNTHETIC_RECLAMATION_SERVICE_ROLE_12345";
const mimeTypes = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"];
type Row = Record<string, any>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Every transport is an explicit fake. No SDK client, credentials, env files, or real HTTP are used.
function fixture(t: TestContext, options: Row = {}) {
  const mime = options.mime ?? "image/jpeg", ext = options.ext ?? ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Row)[mime];
  const key = `${W}/staged/${O}/original.${ext.toLowerCase()}`, raw = new Map<string, Buffer>();
  if (!options.absentOriginal) raw.set(key, Buffer.alloc(4096, 65));
  const events: string[] = [], rpcCalls: Row[] = [], uploads: Row[] = [], downloads: Row[] = [];
  let claims = 0, completes = 0, quotaCommits = 0, buckets = 0, cancellations = 0;
  let fetchStarted!: () => void, uploadStarted!: () => void;
  const fetching = new Promise<void>(resolve => { fetchStarted = resolve; }), uploading = new Promise<void>(resolve => { uploadStarted = resolve; });
  let claimed: Row | undefined;
  const sdk: Row = {
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args: structuredClone(args) }); events.push(name);
      if (name === "claim_creative_upload_reclamation") {
        claims++;
        assert.deepEqual(Object.keys(args).sort(), ["p_claim_id", "p_limit", "p_workspace_id"]);
        assert.equal(args.p_workspace_id, W); assert.equal(args.p_limit, 1);
        assert.match(args.p_claim_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const now = Date.now();
        claimed ??= { operationId: O, workspaceId: W, fileName: `synthetic.${ext}`, mimeType: mime, fileSize: 4096,
          issuedAt: now - 1000, expiresAt: now + 7199000, claimId: args.p_claim_id, claimedUntil: new Date(now + 120000).toISOString(), ...options.claim };
        if (options.claimHang) return new Promise(() => {});
        if (claims <= (options.lostClaimAcks ?? 0)) throw new Error(secret);
        if (options.claimError) return { data: null, error: { code: options.claimError, message: secret } };
        return { data: Object.hasOwn(options, "claimData") ? options.claimData : options.empty ? [] : options.multiple ? [claimed, claimed] : [claimed], error: null };
      }
      assert.equal(name, "complete_creative_upload_reclamation"); completes++;
      assert.deepEqual(Object.keys(args).sort(), ["p_claim_id", "p_operation_id", "p_tombstone_sha256", "p_tombstone_size", "p_workspace_id"]);
      assert.equal(args.p_workspace_id, W); assert.equal(args.p_operation_id, O); assert.equal(args.p_claim_id, claimed!.claimId);
      assert.ok(events.includes("private-proof"), "No quota acknowledgment before private proof");
      if (options.completeError) return { data: null, error: { code: options.completeError, message: secret } };
      quotaCommits = 1;
      if (options.completeHang) return new Promise(() => {});
      if (completes <= (options.lostCompleteAcks ?? 0)) {
        options.onLostCompleteAck?.();
        throw new Error(secret);
      }
      return { data: { operationId: O, workspaceId: W, rawDeletedAt: new Date().toISOString(), cleanupKind: "tombstone",
        size: args.p_tombstone_size, sha256: args.p_tombstone_sha256, ...options.receipt }, error: null };
    },
    storage: {
      async getBucket(id: string) {
        buckets++; assert.equal(id, bucket); events.push("bucket");
        if (options.bucketHang) return new Promise(() => {});
        return { data: { id, name: id, public: false, file_size_limit: 100 * 1024 * 1024,
          allowed_mime_types: mimeTypes, ...options.bucket }, error: null };
      },
      from(id: string) {
        assert.equal(id, bucket);
        return {
          async upload(storagePath: string, bytes: Buffer, uploadOptions: Row) {
            uploads.push({ bucket: id, path: storagePath, bytes: Buffer.from(bytes), options: structuredClone(uploadOptions) });
            events.push("upsert"); uploadStarted();
            if (!options.noUploadCommit && uploads.length > (options.uncommittedUploads ?? 0)) raw.set(storagePath, Buffer.from(bytes));
            if (options.uploadHang) return new Promise(() => {});
            if (options.uploadAck === "throw" || uploads.length <= (options.uncommittedUploads ?? 0)) throw new Error(secret);
            if (options.uploadAck === "error") return { data: null, error: { message: secret } };
            return { data: { path: options.uploadAck === "wrongPath" ? "untrusted/path.jpg" : storagePath }, error: null };
          },
          remove() { assert.fail("A permanent tombstone must never be removed"); },
          getPublicUrl() { assert.fail("Private reclamation must never use a public URL"); },
        };
      },
    },
    from() { assert.fail("Eligibility must be decided by the claim RPC, never a table scan"); },
  };
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    const url = String(input);
    assert.equal(url, `${origin}/storage/v1/object/${bucket}/${key}`, "Only the derived, same-origin private key may be fetched");
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    assert.deepEqual(init.headers, { Authorization: `Bearer ${secret}`, apikey: secret }); assert.ok(init.signal);
    downloads.push({ url, init }); events.push("private-proof"); fetchStarted();
    if (options.fetchHook) return options.fetchHook();
    if (options.fetchHang) return new Promise(() => {});
    const original = raw.get(key) ?? Buffer.alloc(0);
    const bytes = options.proof === "hash" ? Buffer.alloc(original.length, 66) : options.proof === "short" ? original.subarray(1)
      : options.proof === "oversize" ? Buffer.alloc(2049) : original;
    const headers: Row = { "content-type": options.proof === "mime" ? "image/gif" : mime };
    if (!options.noContentLength) headers["content-length"] = options.proof === "length" ? "not-a-size" : options.proof === "wrongLength" ? "1" : String(bytes.length);
    let body: any = new Uint8Array(bytes);
    if (options.stalledBody) body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes.subarray(0, 1))); },
      cancel() { cancellations++; return new Promise(() => {}); } });
    const response = new Response(body, { status: options.proof === "status" ? 404 : options.proof === "redirectStatus" ? 302 : 200, headers });
    if (options.proof === "redirected") Object.defineProperty(response, "redirected", { value: true });
    if (options.proof === "url") Object.defineProperty(response, "url", { value: "https://elsewhere.fixture.invalid/private.jpg" });
    return response;
  });
  return { config: { supabase: sdk, origin, serviceRoleKey: secret }, events, rpcCalls, uploads, downloads, raw, key, fetching, uploading,
    run: () => reclaimStagedCreativeUploads({ supabase: sdk, origin, serviceRoleKey: secret }, W),
    counts: () => ({ claims, completes, quotaCommits, buckets, cancellations }),
    lateSignedUpload: () => raw.has(key) ? { error: "already_exists" } : (raw.set(key, Buffer.from("late raw bytes")), { error: null }) };
}

async function rejectsGeneric(promise: Promise<unknown>) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof Error); assert.equal(error.message, "creative_upload_reclamation_unconfirmed");
    assert.equal(JSON.stringify(error).includes(secret), false); return true;
  });
}

for (const mime of ["image/jpeg", "image/png", "image/webp"]) test(`${mime}: real Sharp decodes the permanent, tiny tombstone before exact quota receipt`, async t => {
  const f = fixture(t, { mime }); assert.deepEqual(await f.run(), { reclaimed: 1 });
  assert.equal(f.uploads.length, 1); const uploaded = f.uploads[0]!;
  assert.equal(uploaded.path, f.key); assert.deepEqual(uploaded.options, { contentType: mime, upsert: true });
  const bytes = f.raw.get(f.key)!; assert.ok(bytes.length > 0 && bytes.length <= 2048);
  const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true }), metadata = await sharp(bytes).metadata();
  assert.equal(decoded.info.width, 1); assert.equal(decoded.info.height, 1); assert.equal(decoded.data.length, 3);
  assert.equal(metadata.format, mime.slice(6) === "jpeg" ? "jpeg" : mime.slice(6)); assert.equal(metadata.exif, undefined);
  const args = f.rpcCalls.find(call => call.name === "complete_creative_upload_reclamation")!.args;
  assert.equal(args.p_tombstone_size, bytes.length); assert.equal(args.p_tombstone_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(f.events, ["claim_creative_upload_reclamation", "bucket", "upsert", "private-proof", "complete_creative_upload_reclamation"]);
  assert.deepEqual(f.lateSignedUpload(), { error: "already_exists" }); assert.deepEqual(f.raw.get(f.key), bytes);
});

test("JPEG extension is validated case-insensitively, then derived in canonical lowercase", async t => {
  const f = fixture(t, { ext: "JPEG" }); assert.deepEqual(await f.run(), { reclaimed: 1 }); assert.ok(f.uploads[0]!.path.endsWith("original.jpeg"));
});

test("absent raw bytes still leave a permanent occupied key", async t => {
  const f = fixture(t, { absentOriginal: true }); await f.run(); assert.deepEqual(f.lateSignedUpload(), { error: "already_exists" });
});

for (const uploadAck of ["throw", "error", "wrongPath"]) test(`lost/untrusted upload ACK (${uploadAck}) is reconciled against private bytes, never trusted itself`, async t => {
  const f = fixture(t, { uploadAck }); assert.deepEqual(await f.run(), { reclaimed: 1 });
  assert.equal(f.uploads.length, 1); assert.equal(f.downloads.length, 1); assert.equal(f.counts().quotaCommits, 1);
});

test("an unknown uncommitted upsert retries at most twice with identical path, options, and bytes", async t => {
  const f = fixture(t, { uncommittedUploads: 1 }); assert.deepEqual(await f.run(), { reclaimed: 1 });
  assert.equal(f.uploads.length, 2); assert.deepEqual(f.uploads[0], f.uploads[1]); assert.equal(f.counts().completes, 1);
});

test("two unknown upsert outcomes without tombstone proof never acknowledge quota", async t => {
  const f = fixture(t, { noUploadCommit: true, uploadAck: "throw" }); await rejectsGeneric(f.run());
  assert.equal(f.uploads.length, 2); assert.equal(f.downloads.length, 2); assert.equal(f.counts().completes, 0); assert.equal(f.counts().quotaCommits, 0);
});

for (const stage of ["Claim", "Complete"]) test(`one lost ${stage} ACK replays identical RPC arguments, not another operation`, async t => {
  const f = fixture(t, { [`lost${stage}Acks`]: 1 }); assert.deepEqual(await f.run(), { reclaimed: 1 });
  const calls = f.rpcCalls.filter(call => call.name === (stage === "Claim" ? "claim_creative_upload_reclamation" : "complete_creative_upload_reclamation"));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(f.uploads.length, 1); assert.equal(f.counts().quotaCommits, 1);
});

test("completion can reconcile an exact ACK replay even if the claim lease has since expired", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(t, { lostCompleteAcks: 1, onLostCompleteAck: () => t.mock.timers.setTime(Date.now() + 120001) });
  assert.deepEqual(await f.run(), { reclaimed: 1 });
  assert.equal(f.counts().completes, 2); assert.deepEqual(f.rpcCalls[1]!.args, f.rpcCalls[2]!.args);
});

for (const stage of ["Claim", "Complete"]) test(`two lost ${stage} ACKs remain uncertain and never produce a reclaimed response`, async t => {
  const f = fixture(t, { [`lost${stage}Acks`]: 2 }); await rejectsGeneric(f.run());
  assert.equal(stage === "Claim" ? f.counts().claims : f.counts().completes, 2);
  if (stage === "Claim") { assert.equal(f.uploads.length, 0); assert.equal(f.counts().quotaCommits, 0); }
  else { assert.equal(f.uploads.length, 1); assert.equal(f.counts().quotaCommits, 1, "Lost responses cannot prove the DB did not commit"); }
});

test("an empty server claim returns zero without inspecting storage", async t => {
  const f = fixture(t, { empty: true }); assert.deepEqual(await f.run(), { reclaimed: 0 }); assert.equal(f.counts().buckets, 0); assert.equal(f.downloads.length, 0);
});

for (const options of [{ multiple: true }, { claimData: {} }, { claimData: null }]) test(`malformed/oversized claim batch fails closed: ${JSON.stringify(options)}`, async t => {
  const f = fixture(t, options); await rejectsGeneric(f.run()); assert.equal(f.uploads.length, 0); assert.equal(f.counts().buckets, 0);
});

const badClaims: Row[] = [
  { workspaceId: O }, { operationId: W.toUpperCase() }, { operationId: "../../other" }, { operationId: "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb" },
  { claimId: O }, { fileName: "../raw.jpg" }, { fileName: "raw\\image.jpg" }, { fileName: "raw\u0000.jpg" }, { fileName: "" },
  { fileName: "x".repeat(252) + ".jpg" }, { fileName: "raw.png" }, { fileName: "raw" }, { mimeType: "image/JPEG" }, { mimeType: "video/mp4", fileName: "raw.mp4" },
  { mimeType: "__proto__" }, { fileSize: 0 }, { fileSize: 10485761 }, { fileSize: "4096" }, { issuedAt: -1 }, { expiresAt: 1 },
  { expiresAt: "7200000" }, { issuedAt: 0, expiresAt: 7199999 }, { issuedAt: 0, expiresAt: 7200001 },
  { claimedUntil: "tomorrow" }, { claimedUntil: "2000-01-01T00:00:00Z" }, { claimedUntil: "2099-01-01T00:00:00Z" },
];
for (const claim of badClaims) test(`invalid claim cannot touch storage: ${JSON.stringify(claim)}`, async t => {
  const f = fixture(t, { claim }); await rejectsGeneric(f.run()); assert.equal(f.counts().buckets, 0); assert.equal(f.downloads.length, 0); assert.equal(f.counts().completes, 0);
});

test("a future issuedAt cannot authorize a write even with an exact two-hour lifetime", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() }); const issuedAt = Date.now() + 1000;
  const f = fixture(t, { claim: { issuedAt, expiresAt: issuedAt + 7200000 } }); await rejectsGeneric(f.run());
  assert.equal(f.counts().buckets, 0); assert.equal(f.uploads.length, 0);
});

test("supplied paths and URLs are ignored; claim expiry alone is not client-side eligibility", async t => {
  const f = fixture(t, { claim: { storagePath: "other/raw.jpg", publicUrl: "https://elsewhere.fixture.invalid/raw.jpg", path: "../raw.jpg", issuedAt: 0, expiresAt: 7200000 } });
  assert.deepEqual(await f.run(), { reclaimed: 1 }); assert.equal(f.uploads[0]!.path, f.key);
});

test("native PostgreSQL fractional-second ISO timestamps with +00:00 remain valid", async t => {
  const timestamp = new Date(Date.now() + 120000).toISOString().replace(/(\.\d{3})Z$/, "$1123+00:00");
  const f = fixture(t, { claim: { claimedUntil: timestamp }, receipt: { rawDeletedAt: "2026-10-25T01:02:03.123456+00:00" } });
  assert.deepEqual(await f.run(), { reclaimed: 1 });
});

test("a 120s lease permits five seconds of clock skew but not a longer claim", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(t, { claim: { claimedUntil: new Date(Date.now() + 125000).toISOString() } });
  assert.deepEqual(await f.run(), { reclaimed: 1 });
});

test("a lease beyond the skew allowance is rejected before storage", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(t, { claim: { claimedUntil: new Date(Date.now() + 125001).toISOString() } });
  await rejectsGeneric(f.run()); assert.equal(f.counts().buckets, 0);
});

const badBuckets: Row[] = [
  { id: "ad-creatives" }, { name: "other" }, { public: true }, { public: null }, { file_size_limit: 104857601 }, { file_size_limit: 0 },
  { file_size_limit: "104857600" }, { allowed_mime_types: null }, { allowed_mime_types: ["image/png"] }, { allowed_mime_types: ["image/jpeg", "*"] },
  { versioning_status: "enabled" }, { versioning_status: "suspended" }, { versioning_status: null }, { versioning_status: "unknown" },
];
for (const badBucket of badBuckets) test(`unconfirmed bucket cannot write or acknowledge quota: ${JSON.stringify(badBucket)}`, async t => {
  const f = fixture(t, { bucket: badBucket }); await rejectsGeneric(f.run()); assert.equal(f.uploads.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.counts().quotaCommits, 0);
});

test("an explicit disabled versioning status is accepted; legacy absence is covered by the normal cases", async t => {
  const f = fixture(t, { bucket: { versioning_status: "disabled" } }); assert.deepEqual(await f.run(), { reclaimed: 1 });
});

for (const proof of ["hash", "short", "oversize", "mime", "length", "wrongLength", "status", "redirectStatus", "redirected", "url"]) test(`bad private proof (${proof}) never reaches quota completion, despite a successful SDK ACK`, async t => {
  const f = fixture(t, { proof }); await rejectsGeneric(f.run()); assert.equal(f.uploads.length, 1); assert.equal(f.counts().completes, 0); assert.equal(f.counts().quotaCommits, 0);
});

test("without Content-Length the bounded stream still proves exact length and SHA256", async t => {
  const f = fixture(t, { noContentLength: true }); assert.deepEqual(await f.run(), { reclaimed: 1 });
});

for (const receipt of [{ operationId: W }, { workspaceId: O }, { cleanupKind: "delete" }, { size: 0 }, { sha256: "0".repeat(64) },
  { rawDeletedAt: null }, { rawDeletedAt: "not-an-ISO-date" }, { size: "267" }, { extra: true }]) test(`a mismatched completion receipt is never reported as reclaimed: ${JSON.stringify(receipt)}`, async t => {
  const f = fixture(t, { receipt }); await rejectsGeneric(f.run()); assert.equal(f.counts().completes, 1, "An invalid received receipt is not an unknown transport outcome");
  assert.equal(f.uploads.length, 1); assert.ok(f.raw.has(f.key), "An unconfirmed receipt must never trigger tombstone removal");
});

for (const stage of ["claim", "complete"]) test(`${stage} SQL business refusal is generic and not retried`, async t => {
  const f = fixture(t, { [`${stage}Error`]: "P8901" }); await rejectsGeneric(f.run());
  assert.equal(stage === "claim" ? f.counts().claims : f.counts().completes, 1); assert.equal(f.counts().quotaCommits, 0);
});

for (const badOrigin of ["http://reclamation.fixture.invalid", `${origin}/`, `${origin}/other`, `${origin}?token=secret`, `${origin}#fragment`, "https://user:password@reclamation.fixture.invalid"]) test(`invalid origin is rejected before any transport: ${badOrigin}`, async t => {
  const f = fixture(t); await rejectsGeneric(reclaimStagedCreativeUploads({ ...f.config, origin: badOrigin }, W)); assert.equal(f.rpcCalls.length, 0);
});

test("invalid workspace/key cannot start a claim", async t => {
  const f = fixture(t); await rejectsGeneric(reclaimStagedCreativeUploads(f.config, "../../other"));
  await rejectsGeneric(reclaimStagedCreativeUploads({ ...f.config, serviceRoleKey: "short" }, W)); assert.equal(f.rpcCalls.length, 0);
});

test("the 10s proof deadline covers a stalled fetch and never acknowledges quota", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { fetchHang: true });
  const run = f.run(), rejected = rejectsGeneric(run); await f.fetching; t.mock.timers.tick(10000); await rejected;
  assert.equal(f.downloads[0]!.init.signal.aborted, true); assert.equal(f.counts().completes, 0);
});

test("a fetch ignoring abort has its late body cancelled without waiting for cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let releaseHeaders!: (value: Response) => void, cancellations = 0;
  const f = fixture(t, { fetchHook: () => new Promise<Response>(resolve => { releaseHeaders = resolve; }) });
  const rejected = rejectsGeneric(f.run()); await f.fetching; t.mock.timers.tick(10000); await rejected;
  releaseHeaders(new Response(new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } })));
  await flush(); assert.equal(cancellations, 1); assert.equal(f.counts().completes, 0);
});

test("an endless empty-chunk stream fails closed without starving the deadline timer", async t => {
  const f = fixture(t, { fetchHook: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(0)); } }),
    { headers: { "content-type": "image/jpeg" } }) });
  await rejectsGeneric(f.run()); assert.equal(f.counts().completes, 0);
});

test("a stream whose first chunk exceeds 2048 bytes is rejected even without Content-Length", async t => {
  const f = fixture(t, { proof: "oversize", noContentLength: true }); await rejectsGeneric(f.run()); assert.equal(f.counts().completes, 0);
});

test("the 10s deadline includes a stalled body; cancellation itself may hang without extending it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { stalledBody: true });
  const rejected = rejectsGeneric(f.run()); await f.fetching; await flush(); t.mock.timers.tick(10000); await rejected;
  assert.equal(f.counts().cancellations, 1); assert.equal(f.counts().completes, 0); assert.equal(f.downloads[0]!.init.signal.aborted, true);
});

test("headers and body share one 10s budget, not separate deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let releaseHeaders!: (value: Response) => void;
  const f = fixture(t, { fetchHook: () => new Promise<Response>(resolve => { releaseHeaders = resolve; }) });
  let settled = false; const rejected = rejectsGeneric(f.run()).then(() => { settled = true; }); await f.fetching;
  t.mock.timers.tick(6000);
  releaseHeaders(new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { headers: { "content-type": "image/jpeg" } }));
  await flush(); t.mock.timers.tick(3999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(f.counts().completes, 0);
});

test("a 20s lost upload ACK still reconciles exact private bytes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { uploadHang: true });
  const run = f.run(); await f.uploading; t.mock.timers.tick(20000); assert.deepEqual(await run, { reclaimed: 1 });
  assert.equal(f.uploads.length, 1); assert.equal(f.counts().completes, 1);
});

for (const stage of ["claim", "bucket"]) test(`${stage} waits are bounded to 20s with at most two attempts`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { [`${stage}Hang`]: true });
  const rejected = rejectsGeneric(f.run()); await flush(); t.mock.timers.tick(20000); await flush(); t.mock.timers.tick(20000); await rejected;
  assert.equal(stage === "claim" ? f.counts().claims : f.counts().buckets, 2); assert.equal(f.uploads.length, 0); assert.equal(f.counts().quotaCommits, 0);
});

test("completion ACK waits are bounded to two identical 20s attempts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { completeHang: true });
  const rejected = rejectsGeneric(f.run()); await f.fetching; await flush(); t.mock.timers.tick(20000); await flush(); t.mock.timers.tick(20000); await rejected;
  assert.equal(f.counts().completes, 2); assert.deepEqual(f.rpcCalls[1], f.rpcCalls[2]); assert.equal(f.uploads.length, 1);
});

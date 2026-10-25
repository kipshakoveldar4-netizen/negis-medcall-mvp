import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tickets = await import(pathToFileURL(path.join(root, "lib/crm/staged-creative-ticket.ts")).href);
const storage = await import(pathToFileURL(path.join(root, "lib/crm/staged-creative-storage.ts")).href);
const sharp = createRequire(path.join(root, "package.json"))("sharp");
const actor = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", secret = "SYNTHETIC_STAGING_SECRET_NEVER_REAL_123", now = 1792900000000;
const origin = "https://staging.fixture.invalid", privateMarker = "SYNTHETIC_PRIVATE_METADATA";
const bucket = { id: tickets.STAGED_CREATIVE_BUCKET, public: false, file_size_limit: 100 * 1024 * 1024,
  allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"] };
type Row = Record<string, any>;
const metadata = { ...actor, fileName: "synthetic.jpg", mimeType: "image/jpeg", fileSize: 100 };

function sdkFixture(options: Row = {}) {
  const calls: Row[] = [];
  const sdk = { storage: {
    async getBucket(name: string) { calls.push({ op: "bucket", name }); return { data: { ...bucket, ...options.bucket }, error: options.bucketError }; },
    from(name: string) {
      assert.equal(name, tickets.STAGED_CREATIVE_BUCKET, "This step must never choose a public bucket");
      return { async createSignedUploadUrl(key: string, opts: Row) {
        calls.push({ op: "signed", name, key, opts });
        return { data: { path: key, token: "SYNTHETIC_UPLOAD_TOKEN",
          signedUrl: `${origin}/storage/v1/object/upload/sign/${name}/${key}?token=SYNTHETIC_UPLOAD_TOKEN`, ...options.receipt }, error: options.signedError };
      } };
    },
  } };
  return { calls, config: { supabase: sdk, origin, serviceRoleKey: secret } };
}

test("ticket binds exact identity and intent; only immutable server-derived paths are returned", () => {
  const issued = tickets.issueStagedCreativeTicket(metadata, secret, now);
  const restored = tickets.readStagedCreativeTicket(issued.handle, actor, secret, now + 1);
  assert.deepEqual(restored, issued.ticket); assert.equal(Object.isFrozen(restored), true);
  assert.match(tickets.stagedCreativePath(restored), new RegExp(`^${actor.workspaceId}/staged/[a-f0-9-]{36}/original.jpg$`));
  const digest = "1".repeat(64), target = tickets.verifiedCreativeIdentity(restored, digest);
  assert.equal(target.id, restored.id); assert.equal(target.storageBucket, "ad-creatives");
  assert.equal(target.storagePath, `${actor.workspaceId}/verified/${restored.id}/${digest}.jpg`);
  assert.throws(() => tickets.verifiedCreativeIdentity(restored, "not-a-digest"));
  assert.notEqual(tickets.issueStagedCreativeTicket(metadata, secret, now).ticket.id, restored.id);
});

for (const [field, value] of [["workspaceId", other], ["userId", other], ["staffUserId", other]] as const) {
  test(`a valid ticket cannot be finalized under another ${field}`, () => {
    const issued = tickets.issueStagedCreativeTicket(metadata, secret, now);
    assert.throws(() => tickets.readStagedCreativeTicket(issued.handle, { ...actor, [field]: value }, secret, now), /creative_upload_ticket_unconfirmed/);
  });
}

test("signature, time and exact manifest are checked rather than trusted from JSON", () => {
  const issued = tickets.issueStagedCreativeTicket(metadata, secret, now);
  const [prefix, payload, mac] = issued.handle.split(".");
  const changed = Buffer.from(JSON.stringify({ ...issued.ticket, fileSize: 1 })).toString("base64url");
  for (const token of [`${prefix}.${changed}.${mac}`, `${prefix}.${payload}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`, "", null, { handle: issued.handle }, "x".repeat(2049)]) {
    assert.throws(() => tickets.readStagedCreativeTicket(token, actor, secret, now));
  }
  for (const clock of [now - 1, now + tickets.STAGED_CREATIVE_LIFETIME_MS, Infinity]) assert.throws(() => tickets.readStagedCreativeTicket(issued.handle, actor, secret, clock));
  assert.throws(() => tickets.readStagedCreativeTicket(issued.handle, actor, secret + "changed", now));
});

test("even a correctly signed noncanonical or malformed manifest refuses", () => {
  const issued = tickets.issueStagedCreativeTicket(metadata, secret, now);
  for (const candidate of [{ ...issued.ticket, extra: true }, { ...issued.ticket, v: 2 },
    { ...issued.ticket, fileSize: "100" }, { ...issued.ticket, expiresAt: now + 1 },
    { ...issued.ticket, issuedAt: now + 1 }, { ...issued.ticket, mimeType: "constructor" }]) {
    const payload = Buffer.from(JSON.stringify(candidate)).toString("base64url");
    const mac = createHmac("sha256", secret).update("medina:staged-creative:v1\n").update(payload).digest("base64url");
    assert.throws(() => tickets.readStagedCreativeTicket(`u1.${payload}.${mac}`, actor, secret, now));
  }
});

for (const [extension, mimeType] of [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"],
  ["mp4", "video/mp4"], ["mov", "video/quicktime"], ["webm", "video/webm"]]) {
  test(`the intended ${extension} format gets a private ticket`, async () => {
    const f = sdkFixture(); const result = await storage.prepareStagedCreativeUpload(f.config, { ...metadata, fileName: `synthetic.${extension}`, mimeType }, now);
    assert.equal(result.publicUrl, undefined); assert.equal(result.mimeType, mimeType);
    assert.equal(result.fileType, mimeType.startsWith("image/") ? "image" : "video");
  });
}

for (const [name, patch] of Object.entries({ zero: { fileSize: 0 }, fraction: { fileSize: 1.1 }, oversize: { fileSize: 10 * 1024 * 1024 + 1 },
  mismatch: { fileName: "synthetic.png" }, control: { fileName: "a\n.jpg" }, path: { fileName: "../a.jpg" },
  prototype: { mimeType: "constructor" }, unsupported: { mimeType: "image/svg+xml" }, longName: { fileName: "я".repeat(130) + ".jpg" } })) {
  test(`invalid ticket metadata ${name} refuses without SDK access`, async () => {
    const f = sdkFixture(); await assert.rejects(storage.prepareStagedCreativeUpload(f.config, { ...metadata, ...patch }, now));
    assert.deepEqual(f.calls, []);
  });
}

test("preparation mints only a create-only private ticket, without public URL, file, row or ready status", async () => {
  const f = sdkFixture(), receipt = await storage.prepareStagedCreativeUpload(f.config, metadata, now);
  assert.equal(receipt.bucket, tickets.STAGED_CREATIVE_BUCKET); assert.equal(receipt.publicUrl, undefined); assert.equal(receipt.status, undefined);
  assert.equal(receipt.asset, undefined); assert.equal(receipt.fileSize, 100);
  assert.deepEqual(f.calls.map(call => call.op), ["bucket", "signed"]); assert.deepEqual(f.calls[1].opts, { upsert: false });
  assert.equal(f.calls[1].key, tickets.stagedCreativePath(tickets.readStagedCreativeTicket(receipt.uploadHandle, actor, secret, now)));
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

for (const [name, options] of Object.entries({ public: { bucket: { public: true } }, wrongBucket: { bucket: { id: "ad-creatives" } },
  unbounded: { bucket: { file_size_limit: null } }, broadMime: { bucket: { allowed_mime_types: null } }, tooSmall: { bucket: { file_size_limit: 99 } },
  redirected: { receipt: { signedUrl: "https://other.invalid/upload" } }, wrongPath: { receipt: { path: "foreign/key" } },
  missingToken: { receipt: { token: "" } }, lostReceipt: { signedError: { message: secret } } })) {
  test(`private preparation refuses ${name} without exposing diagnostics`, async () => {
    const f = sdkFixture(options);
    await assert.rejects(storage.prepareStagedCreativeUpload(f.config, metadata, now), (error: Error) => !String(error).includes(secret));
  });
}

for (const format of ["jpeg", "png", "webp"] as const) test(`native ${format} normalization removes private metadata and applies orientation`, async t => {
  const mimeType = `image/${format}`, fileName = `synthetic.${format === "jpeg" ? "jpg" : format}`;
  const bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#35a870" } })
    .toFormat(format).withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: privateMarker } }).toBuffer();
  const f = sdkFixture(), issued = tickets.issueStagedCreativeTicket({ ...actor, fileName, mimeType, fileSize: bytes.length }, secret, now);
  t.mock.method(globalThis, "fetch", async (url: unknown, init: Row) => {
    assert.equal(url, `${origin}/storage/v1/object/${tickets.STAGED_CREATIVE_BUCKET}/${tickets.stagedCreativePath(issued.ticket)}`);
    assert.deepEqual(init.headers, { Authorization: `Bearer ${secret}`, apikey: secret }); assert.equal(init.redirect, "error");
    return new Response(bytes, { headers: { "content-type": mimeType, "content-length": String(bytes.length) } });
  });
  assert.ok(bytes.includes(Buffer.from(privateMarker)));
  const result = await storage.readAndNormalizeStagedCreativeImage(f.config, issued.handle, actor, { now });
  const info = await sharp(result.buffer).metadata(); assert.equal(info.width, 16); assert.equal(info.height, 32);
  for (const key of ["exif", "xmp", "iptc", "icc", "orientation"]) assert.equal(info[key], undefined);
  assert.equal(result.buffer.includes(Buffer.from(privateMarker)), false); assert.equal(info.format, format);
  assert.equal((await sharp(result.buffer).raw().toBuffer()).length, 32 * 16 * 3);
  assert.deepEqual(f.calls.map(call => call.op), ["bucket"], "No publication or persistence is performed by private verification");
  assert.notEqual(createHash("sha256").update(result.buffer).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
});

for (const fault of ["mime", "length", "short", "excess", "html", "corrupt"] as const) test(`staged image ${fault} never passes verification`, async t => {
  const bytes: Buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).jpeg().toBuffer();
  const f = sdkFixture(), issued = tickets.issueStagedCreativeTicket({ ...metadata, fileSize: bytes.length }, secret, now);
  t.mock.method(globalThis, "fetch", async () => new Response(fault === "html" ? Buffer.alloc(bytes.length, 65)
    : fault === "corrupt" ? Buffer.concat([bytes.subarray(0, bytes.length - 8), Buffer.alloc(8)])
    : fault === "short" ? bytes.subarray(0, 5) : fault === "excess" ? Buffer.concat([bytes, bytes]) : bytes,
  { headers: { "content-type": fault === "mime" ? "image/png" : "image/jpeg", ...(fault === "length" ? { "content-length": "1" } : {}) } }));
  await assert.rejects(storage.readAndNormalizeStagedCreativeImage(f.config, issued.handle, actor, { now }));
  assert.deepEqual(f.calls.map(call => call.op), ["bucket"]);
});

for (const where of ["headers", "body"] as const) test(`stalled ${where} aborts and cancels the private image read`, async t => {
  const f = sdkFixture(), issued = tickets.issueStagedCreativeTicket(metadata, secret, now);
  let signal: AbortSignal | undefined, cancelled = false;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: Row) => {
    signal = init.signal;
    return where === "headers" ? await new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "image/jpeg" } });
  });
  await assert.rejects(storage.readAndNormalizeStagedCreativeImage(f.config, issued.handle, actor, { now, timeoutMs: 40 }));
  assert.equal(signal?.aborted, true); if (where === "body") assert.equal(cancelled, true);
});

test("video ticket remains private and cannot enter the image API buffer/decoder", async t => {
  const f = sdkFixture(), receipt = await storage.prepareStagedCreativeUpload(f.config,
    { ...metadata, fileName: "synthetic.mp4", mimeType: "video/mp4" }, now);
  f.calls.length = 0; t.mock.method(globalThis, "fetch", async () => { assert.fail("Video belongs to the worker"); });
  await assert.rejects(storage.readAndNormalizeStagedCreativeImage(f.config, receipt.uploadHandle, actor, { now }), /creative_staged_video_requires_worker/);
  assert.deepEqual(f.calls, []);
});

test("canonical pixel encoding drops an appended payload as well as EXIF", async t => {
  const image: Buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).jpeg().toBuffer();
  const bytes = Buffer.concat([image, Buffer.from(privateMarker)]), f = sdkFixture();
  const issued = tickets.issueStagedCreativeTicket({ ...metadata, fileSize: bytes.length }, secret, now);
  t.mock.method(globalThis, "fetch", async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } }));
  const result = await storage.readAndNormalizeStagedCreativeImage(f.config, issued.handle, actor, { now });
  assert.equal(result.buffer.includes(Buffer.from(privateMarker)), false);
  assert.equal((await sharp(result.buffer).raw().toBuffer()).length, 12);
});

for (const stage of ["bucket", "signed"] as const) test(`SDK ${stage} deadline never advances to a public action or fake success`, async t => {
  const f = sdkFixture(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  if (stage === "bucket") f.config.supabase.storage.getBucket = async () => { entered(); return await new Promise<any>(() => {}); };
  else f.config.supabase.storage.from = () => ({ createSignedUploadUrl: async () => { entered(); return await new Promise<any>(() => {}); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const refused = assert.rejects(storage.prepareStagedCreativeUpload(f.config, metadata, now), /creative_staging_(bucket|ticket)_unconfirmed/);
    await ready; t.mock.timers.tick(10001); await refused;
  } finally { t.mock.timers.reset(); }
});

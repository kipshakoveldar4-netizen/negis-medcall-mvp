import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Actual browser helper -> actual server handlers/native Sharp. HTTP, auth,
// Storage and RPC persistence are explicit doubles; SQL authority is tested
// separately on disposable PostgreSQL, not copied into this fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const server = await load("lib/crm/server.ts"), factory = await load("lib/supabase/server.ts");
const browser = await load("artifacts/negis/src/lib/verified-creative-upload.ts");
const workflow = await load("lib/crm/staged-creative-workflow.ts");
const sharp = createRequire(path.join(root, "package.json"))("sharp");
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", U = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const origin = "https://staged-workflow.fixture.invalid", secret = "SYNTHETIC_SERVICE_ROLE_STAGED_WORKFLOW_123", marker = "SYNTHETIC_PRIVATE_IMAGE_METADATA";
type Row = Record<string, any>;
const actor = { workspaceId: W, userId: U, staffUserId: S, role: "owner", permissions: ["manage_marketing"] };

async function fixture(t: import("node:test").TestContext, options: Row = {}) {
  const old = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  Object.assign(process.env, { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: secret });
  const bytes: Buffer = await sharp({ create: { width: 8, height: 4, channels: 3, background: "#17996c" } }).jpeg()
    .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: marker } }).toBuffer();
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
  const raw = new Map<string, Buffer>(), published = new Map<string, Buffer>(), operations = new Map<string, Row>(), assets = new Map<string, Row>();
  const events: string[] = [], calls: Row[] = [];
  const member: Row = { id: S, workspace_id: W, auth_user_id: U, role: "owner", status: "active" };
  let commits = 0, finalizeCalls = 0, reserveCalls = 0;
  const sdk: Row = {
    from(table: string) {
      const filters: Row = {}, query: Row = {};
      Object.assign(query, { select: () => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        maybeSingle: async () => {
          calls.push({ table, filters: { ...filters } });
          const rows = table === "staff_users" ? [member] : table === "creative_upload_operations" ? [...operations.values()] : [...assets.values()];
          return { data: rows.find(row => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null };
        } }); return query;
    },
    async rpc(name: string, args: Row) {
      events.push(`rpc:${name}`);
      if (name === "reserve_creative_upload") {
        reserveCalls++;
        if (options.reserveError) return { data: null, error: { code: options.reserveError, message: secret } };
        let op = [...operations.values()].find(row => row.request_key === args.p_request_key);
        if (!op) { const at = Date.now(); op = { id: randomUUID(), workspace_id: W, staff_user_id: S, auth_user_id: U,
          request_key: args.p_request_key, file_name: args.p_file_name, mime_type: args.p_mime_type, file_size: args.p_file_size,
          source: args.p_source, issued_at: at, expires_at: at + 7200000, status: "reserved", result: null }; operations.set(op.id, op); }
        return { data: { ticket: { v: 1, id: op.id, workspaceId: op.workspace_id, userId: op.auth_user_id, staffUserId: op.staff_user_id,
          fileName: op.file_name, mimeType: op.mime_type, fileSize: op.file_size, issuedAt: op.issued_at, expiresAt: op.expires_at },
          requestKey: op.request_key, status: op.status }, error: null };
      }
      if (name === "reject_creative_upload") { operations.get(args.p_operation_id)!.status = "rejected"; return { data: null, error: null }; }
      assert.equal(name, "finalize_creative_image_upload"); finalizeCalls++;
      if (options.finalizeDenied || member.status !== "active") return { data: null, error: { code: "P8804", message: secret } };
      const op = operations.get(args.p_operation_id)!;
      const replayed = op.status === "finalized";
      if (!replayed) {
        const result = args.p_result;
        assets.set(op.id, { ...result, id: op.id, workspace_id: W, status: "uploaded", verified_upload_key: op.id,
          verified_upload_actor_id: U, verified_upload_sha256: result.sha256, metadata: { uploadMode: "verified-staged" } });
        op.status = "finalized"; op.asset_id = op.id; op.result = structuredClone(result); commits++;
      } else assert.deepEqual(args.p_result, op.result);
      if (options.lostCommitResponses && finalizeCalls <= options.lostCommitResponses) throw new Error(secret);
      return { data: { operationId: op.id, status: "finalized", asset: assets.get(op.id), replayed }, error: null };
    },
    storage: {
      async getBucket(id: string) { assert.equal(id, "ad-creatives-staging"); return { data: { id, public: false,
        file_size_limit: 100 * 1024 * 1024, allowed_mime_types: ["image/jpeg"] }, error: null }; },
      from(bucket: string) { return {
        async list(folder: string, opts: Row) {
          assert.equal(bucket, "ad-creatives-staging"); assert.equal(opts.limit, 2);
          const key = `${folder}/${opts.search}`;
          if (options.listError) return { data: null, error: { message: secret } };
          if (options.foreignListKey) return { data: [{ id: randomUUID(), name: "foreign.jpg" }], error: null };
          if (options.multipleListKeys) return { data: [{ id: randomUUID(), name: opts.search }, { id: randomUUID(), name: opts.search }], error: null };
          return { data: raw.has(key) ? [{ id: randomUUID(), name: opts.search }] : [], error: null };
        },
        async createSignedUploadUrl(key: string, opts: Row) {
          assert.equal(bucket, "ad-creatives-staging"); assert.deepEqual(opts, { upsert: false }); events.push("mint:private");
          assert.equal(raw.has(key), false, "Storage refuses a new create-only ticket for an occupied key");
          return { data: { path: key, token: "SYNTHETIC_TOKEN", signedUrl: `${origin}/storage/v1/object/upload/sign/${bucket}/${key}?token=SYNTHETIC_TOKEN` }, error: null };
        },
        async upload(key: string, buffer: Buffer, opts: Row) {
          assert.equal(bucket, "ad-creatives"); assert.deepEqual(opts, { contentType: "image/jpeg", upsert: false });
          events.push("upload:public");
          if (published.has(key)) return { data: null, error: { message: "Already exists" } };
          if (!options.noPublicCommit) published.set(key, Buffer.from(buffer));
          if (options.revokeAfterPublic) member.status = "inactive";
          if (options.lostPublicAck || options.noPublicCommit) throw new Error(secret);
          return { data: { path: key }, error: null };
        },
      }; },
    },
  };
  factory.setSupabaseServerClientFactoryForTests(() => sdk);
  t.after(() => {
    factory.setSupabaseServerClientFactoryForTests(null);
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  t.mock.method(globalThis, "fetch", async (url: unknown, init: Row) => {
    const value = String(url); assert.ok(value.startsWith(origin + "/storage/v1/object/"), "No external network");
    assert.equal(init.redirect, "error");
    if (value.startsWith(`${origin}/storage/v1/object/ad-creatives-staging/`)) {
      assert.equal(init.headers.Authorization, `Bearer ${secret}`); events.push("fetch:private");
      const key = value.slice(`${origin}/storage/v1/object/ad-creatives-staging/`.length), buffer = raw.get(key);
      if (options.revokeAfterPrivate) member.status = "inactive";
      return new Response(buffer ? new Uint8Array(buffer) : null, { status: buffer ? 200 : 404, headers: { "content-type": "image/jpeg" } });
    }
    const prefix = `${origin}/storage/v1/object/public/ad-creatives/`; assert.ok(value.startsWith(prefix));
    assert.equal(init.headers?.Authorization, undefined); events.push("fetch:public"); const buffer = published.get(value.slice(prefix.length));
    return new Response(buffer ? new Uint8Array(buffer) : null, { status: buffer ? 200 : 404, headers: { "content-type": "image/jpeg" } });
  });
  async function request(url: string, init: RequestInit = {}) {
    const req: Row = { method: init.method || "POST", query: {}, headers: {}, body: init.body ? JSON.parse(String(init.body)) : {} };
    server.attachWorkspaceContext(req, actor); const res: Row = { code: 0, body: null, headers: {},
      setHeader(key: string, value: string) { this.headers[key] = value; return this; }, status(code: number) { this.code = code; return this; },
      json(body: unknown) { this.body = body; return this; } };
    await (url.includes("finalize-upload") ? server.handleAdCreativeFinalizeUpload : server.handleAdCreativeSignedUpload)(req, res);
    assert.equal(JSON.stringify(res.body).includes(secret), false);
    if (res.code >= 400) throw Object.assign(new Error(res.body.code), { status: res.code });
    return res.body;
  }
  const key = randomUUID();
  const input = { workspaceId: W, file: blob, fileName: "synthetic.jpg", mimeType: "image/jpeg", requestKey: key,
    storageOrigin: origin, request,
    async upload(bucket: string, path: string, _token: string, file: Blob) {
      assert.equal(bucket, "ad-creatives-staging"); events.push("upload:private");
      if (raw.has(path)) return { error: { message: "Already exists" } };
      raw.set(path, options.corruptPrivate ? Buffer.alloc(bytes.length, 65) : Buffer.from(await file.arrayBuffer()));
      return { data: { path }, error: options.lostPrivateAck ? { message: secret } : null };
    }, assertCurrent: async () => {} };
  return { input, bytes, raw, published, assets, operations, events, calls, member,
    inline: (buffer = bytes) => workflow.finalizeInlineCreativeImage({ supabase: sdk, origin, serviceRoleKey: secret },
      { ...actor, requestKey: key, fileName: "synthetic.jpg", mimeType: "image/jpeg", buffer }),
    counts: () => ({ commits, finalizeCalls, reserveCalls }) };
}

test("actual client/server/native pipeline publishes only canonical bytes and exact replay creates no duplicate", async t => {
  const f = await fixture(t), saved = await browser.uploadVerifiedCreativeImage(f.input);
  assert.equal(f.assets.size, 1); assert.equal(f.operations.size, 1); assert.equal(f.raw.size, 1); assert.equal(f.published.size, 1);
  const bytes = f.published.get(saved.storagePath)!; assert.equal(bytes.includes(Buffer.from(marker)), false);
  const info = await sharp(bytes).metadata(); assert.equal(info.width, 4); assert.equal(info.height, 8); assert.equal(info.exif, undefined);
  assert.equal(saved.fileSize, bytes.length); assert.equal(saved.status, "uploaded");
  const hash = createHash("sha256").update(bytes).digest("hex"); assert.ok(saved.storagePath.endsWith(`/${hash}.jpg`));
  const fetched = f.events.filter(event => event === "fetch:private").length;
  assert.equal((await browser.uploadVerifiedCreativeImage(f.input)).id, saved.id);
  assert.equal(f.events.filter(event => event === "upload:public").length, 1); assert.equal(f.counts().commits, 1);
  assert.equal(f.events.filter(event => event === "fetch:private").length, fetched, "Replay must not decode/re-upload an existing receipt");
  assert.equal(f.events.filter(event => event === "mint:private").length, 1, "Completed replay must not mint against the occupied original key");
  assert.ok(f.raw.size, "Private source is retained until signed-token/cleanup reconciliation");
});

for (const option of ["lostPrivateAck", "lostPublicAck"] as const) test(`${option} is reconciled using the same operation and exact native output`, async t => {
  const f = await fixture(t, { [option]: true }); const saved = await browser.uploadVerifiedCreativeImage(f.input);
  assert.ok(saved.publicUrl); assert.equal(f.operations.size, 1); assert.equal(f.counts().commits, 1); assert.equal(f.published.size, 1);
});

test("one lost DB commit response repeats the exact atomic finalization, not a new upload", async t => {
  const f = await fixture(t, { lostCommitResponses: 1 }); await browser.uploadVerifiedCreativeImage(f.input);
  assert.equal(f.counts().finalizeCalls, 2); assert.equal(f.counts().commits, 1); assert.equal(f.events.filter(event => event === "upload:public").length, 1);
});

test("two lost DB commit responses remain uncertain, but the next client retry returns the same saved asset", async t => {
  const f = await fixture(t, { lostCommitResponses: 2 }); await assert.rejects(browser.uploadVerifiedCreativeImage(f.input), /creative_upload_unconfirmed/);
  assert.equal(f.counts().commits, 1); const prior = [...f.assets.keys()][0];
  assert.equal((await browser.uploadVerifiedCreativeImage(f.input)).id, prior); assert.equal(f.counts().commits, 1);
  assert.equal(f.events.filter(event => event === "upload:public").length, 1);
});

test("a reserved upload resumes the occupied private key without another token or byte upload", async t => {
  const options = { finalizeDenied: true }, f = await fixture(t, options);
  await assert.rejects(browser.uploadVerifiedCreativeImage(f.input));
  assert.equal(f.raw.size, 1); assert.equal(f.assets.size, 0); assert.equal(f.published.size, 1);
  options.finalizeDenied = false;
  const asset = await browser.uploadVerifiedCreativeImage(f.input);
  assert.equal(f.events.filter(event => event === "mint:private").length, 1);
  assert.equal(f.events.filter(event => event === "upload:private").length, 1);
  assert.equal(f.counts().commits, 1); assert.equal(f.assets.size, 1); assert.equal(f.published.size, 1);
  assert.ok(asset.publicUrl);
});

test("completed replay refuses changed public bytes without minting or uploading again", async t => {
  const f = await fixture(t), asset = await browser.uploadVerifiedCreativeImage(f.input);
  f.published.set(asset.storagePath, Buffer.from("corrupt stored public bytes"));
  await assert.rejects(browser.uploadVerifiedCreativeImage(f.input));
  assert.equal(f.events.filter(event => event === "mint:private").length, 1);
  assert.equal(f.events.filter(event => event === "upload:private").length, 1);
  assert.equal(f.events.filter(event => event === "upload:public").length, 1);
});

for (const option of ["listError", "foreignListKey", "multipleListKeys"] as const) test(`${option} never turns an uncertain private lookup into a fresh token`, async t => {
  const f = await fixture(t, { [option]: true });
  await assert.rejects(browser.uploadVerifiedCreativeImage(f.input), /creative_staging_listing_unconfirmed/);
  assert.equal(f.events.some(event => event === "mint:private" || event === "upload:private" || event === "upload:public"), false);
  assert.equal(f.assets.size, 0);
});

for (const option of ["corruptPrivate", "revokeAfterPrivate", "noPublicCommit", "revokeAfterPublic", "finalizeDenied"] as const) test(`${option} never becomes a verified asset response`, async t => {
  const f = await fixture(t, { [option]: true }); await assert.rejects(browser.uploadVerifiedCreativeImage(f.input));
  assert.equal(f.assets.size, 0); assert.equal(f.counts().commits, 0);
  if (["corruptPrivate", "revokeAfterPrivate"].includes(option)) assert.equal(f.published.size, 0);
  assert.equal(f.raw.size, 1);
});

test("an admission refusal cannot mint a signed token or upload either private/public bytes", async t => {
  const f = await fixture(t, { reserveError: "P8805" }); await assert.rejects(browser.uploadVerifiedCreativeImage(f.input), /creative_upload_capacity_exhausted/);
  assert.equal(f.events.filter(event => event === "rpc:reserve_creative_upload").length, 2);
  assert.equal(f.events.some(event => event === "mint:private" || event === "upload:public"), false);
  assert.equal(f.raw.size, 0); assert.equal(f.published.size, 0);
});

test("actual inline normalization uses the same durable receipt on replay without minting any Storage token", async t => {
  const f = await fixture(t), saved = await f.inline();
  assert.equal(saved.id, (await f.inline()).id);
  assert.equal(f.operations.size, 1); assert.equal(f.assets.size, 1); assert.equal(f.counts().commits, 1);
  assert.equal(f.events.filter(event => event === "upload:public").length, 1);
  assert.equal(f.events.some(event => event === "mint:private" || event === "fetch:private" || event === "upload:private"), false);
  const bytes = [...f.published.values()][0]!;
  assert.equal(bytes.includes(Buffer.from(marker)), false);
  assert.equal((await sharp(bytes).metadata()).exif, undefined);
});

test("actual corrupt inline input is rejected before public upload and receipt commit", async t => {
  const f = await fixture(t);
  await assert.rejects(f.inline(Buffer.from("synthetic corrupt image")), /creative_upload_image_invalid/);
  assert.equal(f.assets.size, 0); assert.equal(f.published.size, 0); assert.equal(f.counts().commits, 0);
  assert.equal([...f.operations.values()][0]?.status, "rejected");
});

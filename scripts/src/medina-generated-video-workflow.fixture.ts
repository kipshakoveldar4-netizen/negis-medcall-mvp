import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { EventEmitter } from "node:events";

// Production controller, provider parser and workflow run unchanged. Only
// HTTP, authorization, accounting and the Supabase SDK are explicit doubles.
// These RPC receipts are fixtures, not a second implementation of SQL 090;
// the disposable PostgreSQL suite is the authority for its concurrency rules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const factory = await load("lib/supabase/server.ts");
const requireRoot = createRequire(path.join(root, "package.json"));
const ts = requireRoot("typescript") as typeof import("typescript");
const routeFile = path.join(root, "api/content-studio/[...path].ts");
const W = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", U = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const origin = "https://generated-video.fixture.invalid";
const secret = "SYNTHETIC_GENERATED_VIDEO_SERVICE_ROLE_090";
const providerKey = "SYNTHETIC_PROVIDER_KEY_NEVER_NETWORKED";
const rawBucket = "ad-creatives-raw", outputBucket = "ad-creatives";
const RAW = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);
const OUTPUT = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 5, 6, 7, 8]);
const THUMBNAIL = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
type Row = Record<string, any>;
const actor = { workspaceId: W, userId: U, staffUserId: S, role: "owner", permissions: ["manage_marketing", "manage_ai_content"] };

async function fixture(t: TestContext, options: Row = {}) {
  const env = { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: secret, OPENAI_API_KEY: providerKey,
    CONTENT_STUDIO_VIDEO_MODEL: "synthetic-video-model", CONTENT_STUDIO_VIDEO_SECONDS: "4",
    VIDEO_OPTIMIZATION_ENABLED: "true", VIDEO_OPTIMIZATION_RAW_BUCKET: rawBucket,
    VIDEO_OPTIMIZATION_OUTPUT_BUCKET: outputBucket, VIDEO_OPTIMIZATION_BUCKET: outputBucket };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const operations = new Map<string, Row>(), assets = new Map<string, Row>(), jobs = new Map<string, Row>();
  const privateFiles = new Map<string, Buffer>(), publicFiles = new Map<string, Buffer>();
  const calls: Row[] = [], events: string[] = [], usageCalls: Row[] = [], completions: Row[] = [];
  const usageReceipts = new Map<string, Row>();
  async function reserveUsage(value: Row) {
    usageCalls.push(value); events.push("usage:reserve");
    if (options.beforeQuota) await options.beforeQuota(value);
    if (options.revokeAfterQuota) member.status = "inactive";
    let receipt = usageReceipts.get(value.requestKey);
    const duplicate = Boolean(receipt), allowed = !options.quotaDenied && !duplicate;
    if (allowed) {
      receipt = { id: randomUUID(), ...value, status: "reserved", createdAt: new Date().toISOString() };
      delete receipt.requestLifetime; usageReceipts.set(value.requestKey, receipt);
    }
    if (options.afterQuota) await options.afterQuota(receipt);
    const limit = options.quotaLimit ?? 40, used = receipt?.units ?? 0;
    return { allowed, tracked: true, duplicate, usageId: receipt?.id ?? "", kind: "video_seconds", used,
      limit, remaining: Math.max(0, limit - used), periodStart: "2026-10-01",
      reason: duplicate ? "duplicate_request" : options.quotaDenied ? "quota_exceeded" : null, warning: "" };
  }
  async function completeUsage(value: Row) {
    completions.push(value); if (options.beforeCompletion) await options.beforeCompletion(value);
    const receipt = [...usageReceipts.values()].find(row => row.id === value.reservation?.usageId);
    if (receipt?.status === "reserved") receipt.status = value.status;
  }
  const rpcCounts = new Map<string, number>();
  const member: Row = { id: S, workspace_id: W, auth_user_id: U, status: "active", role: "owner" };
  let providerCreates = 0, providerReads = 0, providerDownloads = 0;
  let actorChecks = 0;
  let currentActor = { ...actor };
  const envelope = (operation: Row | undefined) => operation ? structuredClone({ operation,
    job: jobs.get(operation.job_id) ?? null, asset: assets.get(operation.asset_id) ?? null }) : null;
  const denied = (code: string) => ({ data: null, error: { code, message: `${secret}: internal failure` } });
  const sdk: Row = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [], query: Row = {};
      const rows = () => table === "staff_users" ? [member] : table === "generated_video_workflows" ? [...operations.values()]
        : table === "video_processing_jobs" ? [...jobs.values()] : table === "ad_creative_assets" ? [...assets.values()] : [];
      const result = (single = false) => { calls.push({ kind: "select", table });
        const found = rows().filter(row => filters.every(matches => matches(row)));
        return { data: structuredClone(single ? found[0] ?? null : found), error: null }; };
      Object.assign(query, { select: () => query, order: () => query, limit: () => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
        is: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        maybeSingle: async () => result(true), single: async () => result(true),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        insert: () => { throw new Error("Producer must use atomic admission RPCs, not insert rows directly"); },
        update: () => { throw new Error("Producer must use atomic workflow RPCs, not update rows directly"); } });
      return query;
    },
    async rpc(name: string, args: Row) {
      calls.push({ kind: "rpc", name, args: structuredClone(args) }); events.push(name);
      const count = (rpcCounts.get(name) ?? 0) + 1; rpcCounts.set(name, count);
      assert.equal(args.p_workspace_id, W); assert.equal(args.p_staff_user_id, S); assert.equal(args.p_auth_user_id, U);
      if (options.beforeRpc) await options.beforeRpc(name, args, { member, operations, assets, jobs });
      if (member.status !== "active" || !["owner", "admin", "marketer"].includes(member.role)) return denied("P9004");
      if (options.rpcFailure?.name === name && count <= options.rpcFailure.count) {
        if (options.rpcFailure.code) return denied(options.rpcFailure.code);
        throw new Error(secret);
      }
      let op = operations.get(args.p_generation_key);
      let dispatchAccepted: boolean | undefined;
      if (name === "read_generated_video_workflow") {
        const data = envelope(op);
        return { data: options.transformRpc ? options.transformRpc(name, data, args) : data, error: null };
      }
      if (name === "admit_generated_video_workflow") {
        if (options.capacityDenied) return denied("P9005");
        if (options.legacyCollision && args.p_provider_job_id) return denied("P9002");
        if (op && (op.request_digest !== args.p_request_digest || op.key_digest !== args.p_key_digest)) return denied("P9002");
        if (!op) {
          const now = new Date().toISOString();
          op = { workspace_id: W, generation_key: args.p_generation_key, request_digest: args.p_request_digest,
            key_digest: args.p_key_digest, asset_id: args.p_asset_id, job_id: randomUUID(), file_name: args.p_file_name,
            created_by_staff_user_id: S, created_by_auth_user_id: U, status: args.p_provider_job_id ? "rendering" : "reserved",
            reserved_until: new Date(Date.now() + 120000).toISOString(), dispatch_id: null, provider_job_id: args.p_provider_job_id ?? null,
            input_size: null, input_sha256: null, raw_bucket: null, raw_path: null, result: null, created_at: now, updated_at: now };
          operations.set(op.generation_key, op);
        }
      } else {
        if (!op) return denied("P9003");
        if (name === "begin_generated_video_dispatch_with_usage") {
          const quota = usageReceipts.get(args.p_generation_key.slice(3));
          if (!quota || quota.id !== args.p_usage_id || quota.staffUserId !== S || quota.workspaceId !== W
            || quota.operation !== "generated_video" || quota.kind !== "video_seconds" || quota.units !== args.p_units
            || quota.provider !== "openai" || quota.model !== args.p_model || args.p_limit_units < args.p_units
            || op.created_by_staff_user_id !== S || op.created_by_auth_user_id !== U || op.request_digest !== args.p_request_digest
            || quota.createdAt < op.created_at || (op.quota_usage_id && op.quota_usage_id !== quota.id)) return denied("P9002");
          dispatchAccepted = op.status === "reserved" || (op.status === "dispatching" && op.dispatch_id === args.p_dispatch_id);
          if (dispatchAccepted && quota.status !== "reserved") return denied("P9002");
          if (op.status === "reserved" && Date.parse(op.reserved_until) <= Date.now()) return denied("P9003");
          if (op.status === "reserved") { op.status = "dispatching"; op.dispatch_id = args.p_dispatch_id; op.quota_usage_id = quota.id; }
        } else if (name === "link_generated_video_provider") {
          if (op.dispatch_id !== args.p_dispatch_id || (op.provider_job_id && op.provider_job_id !== args.p_provider_job_id)) return denied("P9002");
          op.provider_job_id = args.p_provider_job_id; op.status = "rendering";
        } else if (name === "cancel_generated_video_workflow") {
          if (op.provider_job_id || op.input_size !== null) return denied("P9002");
          if (op.status === "dispatching" && (!args.p_known_failure || op.dispatch_id !== args.p_dispatch_id)) return denied("P9002");
          op.status = "cancelled";
        } else if (name === "bind_generated_video_input") {
          if (op.input_size !== null && (op.input_size !== args.p_input_size || op.input_sha256 !== args.p_input_sha256
            || op.raw_bucket !== args.p_raw_bucket)) return denied("P9002");
          if (op.input_size === null) {
            Object.assign(op, { input_size: args.p_input_size, input_sha256: args.p_input_sha256, raw_bucket: args.p_raw_bucket,
              raw_path: `${W}/generated-raw/${op.key_digest}/original.mp4`, status: "awaiting_upload" });
            const now = new Date().toISOString();
            assets.set(op.asset_id, { id: op.asset_id, workspace_id: W, uploaded_by: U, file_name: op.file_name, file_type: "video",
              mime_type: "video/mp4", file_size: op.input_size, storage_bucket: op.raw_bucket, storage_path: op.raw_path,
              public_url: null, status: "uploaded", generated_key: null, generated_sha256: null, generated_video_job_id: null,
              metadata: { uploadMode: "native-generated-pending", kind: "generated-video-pending", generationKey: op.generation_key,
                contentSha256: op.input_sha256 }, created_at: now, updated_at: now });
            jobs.set(op.job_id, { id: op.job_id, workspace_id: W, asset_id: op.asset_id, status: "awaiting_upload", progress: 0,
              raw_bucket: op.raw_bucket, raw_path: op.raw_path, raw_public_url: null, raw_size: op.input_size, raw_deleted_at: null,
              source_file_name: op.file_name, source_mime_type: "video/mp4", output_bucket: outputBucket, optimized_bucket: outputBucket,
              promotion_receipt: null, metadata: { kind: "generated-video-native", generationKey: op.generation_key, inputSha256: op.input_sha256 },
              created_at: now, updated_at: now });
          }
        } else if (name === "queue_generated_video_workflow") {
          assert.equal(privateFiles.has(op.raw_path), true, "Queue cannot precede actual private object availability");
          assert.equal(hash(privateFiles.get(op.raw_path)!), op.input_sha256);
          if (op.status === "awaiting_upload") { op.status = "queued"; jobs.get(op.job_id)!.status = "queued"; }
        } else if (name === "finalize_generated_video_workflow") {
          const job = jobs.get(op.job_id)!, asset = assets.get(op.asset_id)!;
          assert.equal(job.status, "ready", "Only the separately supplied native-086 receipt permits final identity freeze");
          assert.ok(job.promotion_receipt?.result);
          const r = job.promotion_receipt.result;
          Object.assign(asset, { generated_key: `v1:${op.generation_key}`, generated_sha256: r.sha256, generated_video_job_id: op.job_id,
            metadata: { ...asset.metadata, uploadMode: "ai-generated", kind: "generated-video", jobId: op.generation_key, nativeValidated: true } });
          op.status = "ready"; op.result = { assetId: asset.id, validationJobId: job.id, nativeValidated: true,
            fileName: asset.file_name, mimeType: "video/mp4", fileSize: asset.file_size, storageBucket: asset.storage_bucket,
            storagePath: asset.storage_path, creativeUrl: asset.public_url, sha256: r.sha256, thumbnailUrl: r.thumbnail_public_url,
            thumbnailPath: r.thumbnail_path, thumbnailSize: r.thumbnail_size, thumbnailSha256: r.thumbnail_sha256 };
        } else throw new Error(`Unexpected workflow RPC ${name}`);
      }
      if (options.lostAck?.name === name && count <= options.lostAck.count) throw new Error(secret);
      let data = { ...envelope(op), ...(dispatchAccepted !== undefined ? { dispatchAccepted } : {}) };
      if (options.transformRpc) data = options.transformRpc(name, data, args);
      return { data, error: null };
    },
    storage: {
      async getBucket(bucket: string) {
        calls.push({ kind: "bucket", bucket });
        if (options.beforeBucket) await options.beforeBucket(bucket);
        if (options.bucketError) return { data: null, error: { message: secret } };
        return { data: { id: bucket, public: bucket === outputBucket || options.publicRaw === true,
          file_size_limit: 100 * 1024 * 1024, allowed_mime_types: bucket === rawBucket ? ["video/mp4"] : ["video/mp4", "image/jpeg"],
          ...(options.versioning ? { versioning: options.versioning } : {}) }, error: null };
      },
      from(bucket: string) { return {
        async upload(storagePath: string, buffer: Buffer, config: Row) {
          calls.push({ kind: "upload", bucket, storagePath, config });
          assert.equal(bucket, rawBucket, "Producer must never upload unvalidated video to the public bucket");
          assert.equal(config.upsert, false); assert.equal(config.contentType, "video/mp4");
          if (options.beforePrivateUpload) await options.beforePrivateUpload(storagePath);
          if (privateFiles.has(storagePath)) return { data: null, error: { message: "Already exists" } };
          if (!options.noPrivateCommit) privateFiles.set(storagePath, Buffer.from(buffer));
          if (options.revokeAfterPrivateUpload) member.status = "inactive";
          if (options.lostPrivateAck || options.noPrivateCommit) throw new Error(secret);
          if (options.uploadReply) return options.uploadReply(storagePath);
          return { data: { path: storagePath, fullPath: `${bucket}/${storagePath}` }, error: null };
        },
        async list(folder: string, config: Row) { return { data: privateFiles.has(`${folder}/${config.search}`)
          ? [{ id: randomUUID(), name: config.search }] : [], error: null }; },
      }; },
    },
  };
  factory.setSupabaseServerClientFactoryForTests(() => sdk);
  t.after(() => { factory.setSupabaseServerClientFactoryForTests(null);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(globalThis, "fetch", async (input: unknown, init: Row = {}) => {
    const url = String(input); calls.push({ kind: "fetch", url, method: init.method ?? "GET", headers: init.headers });
    if (url.startsWith("https://api.openai.com/v1/videos")) {
      assert.equal(init.headers.Authorization, `Bearer ${providerKey}`);
      if (init.method === "POST") {
        providerCreates++; events.push("provider:create");
        if (options.revokeAfterProviderCreate) member.status = "inactive";
        if (options.providerUnknown) throw new Error(providerKey);
        if (options.providerResponse) return options.providerResponse({ phase: "create", url, init });
        return new Response(JSON.stringify(options.providerFailure ? { error: { message: providerKey } }
          : { id: "synthetic_provider_job_090", status: "queued", progress: 0 }), { status: options.providerFailure ?? 200 });
      }
      if (url.includes("/content?")) { providerDownloads++;
        if (options.downloadResponse) return options.downloadResponse({ url, init });
        return new Response(new Uint8Array(RAW), { headers: { "content-type": "video/mp4" } }); }
      providerReads++;
      const requestedJob = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      if (options.providerResponse) return options.providerResponse({ phase: "poll", url, init, requestedJob });
      return new Response(JSON.stringify({ id: requestedJob, status: options.providerStatus ?? "completed", progress: 100 }));
    }
    assert.ok(url.startsWith(`${origin}/storage/v1/object/`), `Unapproved network destination ${url}`);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    let bytes: Buffer | undefined, contentType = "video/mp4";
    if (url.startsWith(`${origin}/storage/v1/object/public/`)) {
      assert.equal(init.headers?.Authorization, undefined, "Service credentials must never accompany public proof requests");
      const storagePath = url.slice(`${origin}/storage/v1/object/public/${outputBucket}/`.length);
      bytes = publicFiles.get(storagePath); if (storagePath.endsWith(".jpg")) contentType = "image/jpeg";
      if (options.corruptPublic && bytes) bytes = Buffer.alloc(bytes.length, 65);
      if (options.revokeAfterPublicProof) member.status = "inactive";
    } else {
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      const storagePath = url.replace(`${origin}/storage/v1/object/authenticated/${rawBucket}/`, "")
        .replace(`${origin}/storage/v1/object/${rawBucket}/`, "");
      assert.notEqual(storagePath, url);
      bytes = privateFiles.get(storagePath);
      if (options.corruptPrivate && bytes) bytes = Buffer.alloc(bytes.length, 65);
      if (options.revokeAfterPrivateProof) member.status = "inactive";
    }
    if (options.storageResponse) return options.storageResponse({ url, init, bytes, contentType });
    return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404,
      headers: { "content-type": contentType, ...(bytes ? { "content-length": String(bytes.length) } : {}) } });
  });
  const routeCode = ts.transpileModule(await readFile(routeFile, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Row = {};
  const requireRoute = createRequire(routeFile);
  class FixtureAuthError extends Error {
    constructor(readonly statusCode: number, message: string, readonly code: string) { super(message); }
  }
  new Script(routeCode, { filename: routeFile }).runInNewContext({ exports, Buffer, process, URL, fetch: globalThis.fetch,
    AbortController, setTimeout, clearTimeout, console,
    require(specifier: string) {
      if (specifier === "../../lib/auth/server") return {
        WorkspaceAdminAuthError: FixtureAuthError,
        requireWorkspaceAccess: async () => {
          actorChecks++;
          if (options.beforeActorCheck) await options.beforeActorCheck(actorChecks);
          if (member.status !== "active" || !["owner", "admin", "marketer"].includes(member.role)) {
            throw new FixtureAuthError(403, "Access denied", "workspace_access_denied");
          }
          return { ...currentActor };
        },
      };
      if (specifier === "../../lib/auth/route-guard") return {
        normalizeRouteSegment: (value: unknown) => Array.isArray(value) ? value.join("/") : String(value ?? ""),
        sendNotFound: (_req: unknown, res: Row) => res.status(404).json({ success: false }),
        authorizePrivateRoute: async (req: unknown, res: Row) => {
          if (options.beforeAuthorize) await options.beforeAuthorize(req, res);
          if (member.status !== "active" || member.auth_user_id !== currentActor.userId || !["owner", "admin", "marketer"].includes(member.role)) {
            res.status(403).json({ success: false }); return null;
          }
          return { ...currentActor };
        },
      };
      if (specifier === "../../lib/content-studio/usage") return {
        billableVideoSeconds: () => 4,
        reserveContentGeneration: reserveUsage,
        completeContentGeneration: completeUsage,
        getContentUsageSummary: async () => { throw new Error("Unused usage endpoint"); },
      };
      return requireRoute(specifier);
    },
  });
  async function request(resource: "generate-video" | "video-generation", extra: Row = {}) {
    const req = Object.assign(new EventEmitter(), { method: resource === "generate-video" ? "POST" : "GET", query: { path: resource, ...extra.query },
      headers: { "x-idempotency-key": extra.requestKey ?? requestKey }, body: { prompt: "Synthetic video fixture", format: "reels", ...extra.body } });
    const res: Row = Object.assign(new EventEmitter(), { code: 0, body: null, headers: {}, setHeader(this: Row, key: string, value: unknown) { this.headers[key] = value; return this; },
      status(this: Row, value: number) { this.code = value; return this; },
      json(this: Row, body: unknown) { this.body = body; this.writes = (this.writes ?? 0) + 1; this.headersSent = true; this.writableEnded = true;
        if (options.onResponse) options.onResponse(this); return this; }, end(this: Row) { this.writableEnded = true; return this; } });
    if (options.onRequest) options.onRequest(req, res);
    await exports.default(req, res);
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes(secret), false, "Service credentials cannot appear in responses");
    assert.equal(serialized.includes(providerKey), false, "Provider credentials cannot appear in responses");
    return res;
  }
  const requestKey = randomUUID();
  function supplyNativeReceipt() {
    const op = [...operations.values()][0]!; assert.ok(op); const job = jobs.get(op.job_id)!, asset = assets.get(op.asset_id)!;
    const outputPath = `optimized/${W}/${job.id}-${hash(OUTPUT).slice(0, 20)}.mp4`;
    const thumbPath = outputPath.slice(0, -4) + "-thumbnail.jpg";
    const url = (storagePath: string) => `${origin}/storage/v1/object/public/${outputBucket}/${storagePath}`;
    const receipt = { storage_origin: origin, storage_bucket: outputBucket, storage_path: outputPath, public_url: url(outputPath),
      file_size: OUTPUT.length, sha256: hash(OUTPUT), thumbnail_path: thumbPath, thumbnail_public_url: url(thumbPath),
      thumbnail_size: THUMBNAIL.length, thumbnail_sha256: hash(THUMBNAIL), input_size: RAW.length };
    publicFiles.set(outputPath, OUTPUT); publicFiles.set(thumbPath, THUMBNAIL);
    Object.assign(job, { status: "ready", progress: 100, output_bucket: outputBucket, output_path: outputPath, output_public_url: url(outputPath),
      optimized_bucket: outputBucket, optimized_path: outputPath, optimized_public_url: url(outputPath), output_size: OUTPUT.length,
      output_size_bytes: OUTPUT.length, input_size_bytes: RAW.length, input_mime_type: "video/mp4", output_mime_type: "video/mp4", thumbnail_path: thumbPath,
      thumbnail_public_url: url(thumbPath), thumbnail_url: url(thumbPath), promotion_receipt: { asset_version: asset.updated_at, result: receipt } });
    Object.assign(asset, { status: "ready", file_size: OUTPUT.length, storage_bucket: outputBucket, storage_path: outputPath, public_url: url(outputPath),
      metadata: { ...asset.metadata, optimized: true, optimizationStatus: "ready", contentSha256: hash(OUTPUT), inputSha256: hash(RAW),
        thumbnailUrl: url(thumbPath), thumbnailSource: "worker", thumbnailMimeType: "image/jpeg", inputSizeBytes: RAW.length, outputSizeBytes: OUTPUT.length } });
    return { op, job, asset, receipt };
  }
  return { request, requestKey, operations, assets, jobs, privateFiles, publicFiles, calls, events, usageCalls, completions, member,
    rpcCounts, sdk, usageReceipts, reserveUsage, completeUsage, supplyNativeReceipt, changeActor: () => { currentActor = { ...currentActor, userId: B }; },
    counts: () => ({ providerCreates, providerReads, providerDownloads }) };
}

export { fixture, W, U, S, B, origin, secret, providerKey, rawBucket, outputBucket, RAW, OUTPUT, THUMBNAIL, actor, hash, load };

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "789d896", "only the reviewed G5-C53 baseline is supported");
async function sourceFile(file: string, optional = false) {
  if (optional && baseline && !execFileSync("git", ["ls-tree", "--name-only", baseline, "--", file], {
    cwd: root, encoding: "utf8",
  }).trim()) return undefined;
  try {
    const source = baseline
      ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
      : await readFile(path.join(root, file), "utf8");
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Reuse the existing compiler/dependency-closure harness without importing its
// tests, fixtures or top-level integration setup. No validator is substituted.
const harness = (await sourceFile("scripts/src/medina-generated-media-response.test.ts"))!;
const utilities = ["compile", "select"].map((name) => {
  const matches = harness.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `reuse exactly one existing ${name} utility`);
  return matches[0]!.getText(harness);
}).join("\n");
const utilityCode = ts.transpileModule(utilities, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const { compile, select } = new Function("ts", "assert", "Script", "baseline",
  `${utilityCode}\nreturn { compile, select };`)(ts, assert, Script, baseline) as {
  compile(source: string, file: string): Script;
  select(ast: import("typescript").SourceFile, names: string[], boundaries?: string[]): Script;
};
const route = (await sourceFile("api/content-studio/[...path].ts"))!;
const server = (await sourceFile("lib/crm/server.ts"))!;
const generation = (await sourceFile("lib/content-studio/generation.ts"))!;
const usage = (await sourceFile("lib/content-studio/usage.ts"))!;
const guard = (await sourceFile("lib/auth/route-guard.ts"))!;
const identity = await sourceFile("lib/crm/generated-identity.ts", true);
const verification = await sourceFile("lib/crm/generated-storage-verification.ts", true);

// Narrow only the large config registry, retaining its actual mapper and all
// actual store/lookup/INSERT/proof declarations, including newly added helpers.
const configStatement = server.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === "configs"));
assert.ok(configStatement && ts.isVariableStatement(configStatement));
const configObject = configStatement.declarationList.declarations[0]!.initializer;
assert.ok(configObject && ts.isObjectLiteralExpression(configObject));
const creativeConfigs = configObject.properties.filter((node) => ts.isPropertyAssignment(node)
  && ts.isStringLiteral(node.name) && node.name.text === "ad-creatives");
assert.equal(creativeConfigs.length, 1);
const narrowServer = ts.createSourceFile(server.fileName,
  server.text.slice(0, configStatement.getStart(server))
    + `const configs = { ${creativeConfigs[0]!.getText(server)} };`
    + server.text.slice(configStatement.getEnd()), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const storeScript = select(narrowServer, ["storeGeneratedCreative"]);
const apiScript = compile(route.text, route.fileName);
const generationScript = compile(generation.text, generation.fileName);
const identityScript = identity ? compile(identity.text, identity.fileName) : undefined;
const verificationScript = verification ? compile(verification.text, verification.fileName) : undefined;
const usageScript = select(usage, ["billableVideoSeconds"]);
const guardScript = select(guard, ["normalizeRouteSegment", "sendNotFound"]);

type Json = Record<string, unknown>;
type Result = { data: unknown; error: unknown; count?: number | null };
type Query = { kind: "read" | "insert"; filters: Array<[string, unknown]>; row?: Json; limit?: number; range?: [number, number]; counted?: boolean };
type Response = { status(code: number): Response; setHeader(name: string, value: string): Response; json(body: unknown): void };
type Reply = { status: number; body: Json };
type Options = {
  rows?: Json[];
  objects?: Array<[string, Buffer]>;
  read?: (query: Query, rows: Json[]) => Result;
  insert?: "commit-error" | "malformed-no-commit";
  upload?: "commit-uncertain";
};
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const LEGACY_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_KEY = "55555555-5555-4555-8555-555555555555";
const JOB = "video_replay_fixture";
const KEY = `v1:${JOB}`;
const ORIGIN = "https://replay-storage.invalid";
const RAW = "SYNTHETIC_PRIVATE_REPLAY_DIAGNOSTIC policy=internal customer=synthetic";
const ENV = Object.freeze({ SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-signing-material",
  OPENAI_API_KEY: "synthetic-local-provider-key", CONTENT_STUDIO_VIDEO_MODEL: "synthetic-video-model", CONTENT_STUDIO_VIDEO_SECONDS: "4" });
// Signature-recognized transport bytes, not a real video decoder fixture.
const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
const SHA = crypto.createHash("sha256").update(MP4).digest("hex");
// Fixed independent identity vector from the published DNS/v5 + SHA256 contract.
const DIGEST = "48c2f6f37232e66f25726f72d8eb7d79e25716678dd245ea8c7de0880b39eba7";
const ASSET_ID = "f27dbd67-d15e-5b1e-97c5-ffa95bdbb39f";
const CANONICAL_NAME = `negis-video-${DIGEST.slice(0, 20)}.mp4`;
const CANONICAL_PATH = `${WORKSPACE}/generated/${DIGEST}`;
const OLD_NAME = "negis-video-1790812799000.mp4";
const OLD_PATH = `${WORKSPACE}/2026/09/${JOB}-${OLD_NAME}`;
const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const publicUrl = (key: string) => `${ORIGIN}/storage/v1/object/public/ad-creatives/${key.split("/").map(encodeURIComponent).join("/")}`;
function row(patch: Json = {}): Json {
  return { id: ASSET_ID, workspace_id: WORKSPACE, file_name: CANONICAL_NAME, file_type: "video", mime_type: "video/mp4",
    file_size: MP4.length, storage_bucket: "ad-creatives", storage_path: CANONICAL_PATH, public_url: publicUrl(CANONICAL_PATH),
    generated_key: KEY, generated_sha256: SHA, status: "uploaded", metadata: { source: "content-studio", kind: "generated-video",
      uploadMode: "ai-generated", jobId: JOB, generationKey: DIGEST, contentSha256: SHA },
    created_at: "2026-09-30T23:59:59.000Z", updated_at: "2026-09-30T23:59:59.000Z", ...patch };
}
function legacy(patch: Json = {}) {
  return row({ id: LEGACY_ID, file_name: OLD_NAME, storage_path: OLD_PATH, public_url: publicUrl(OLD_PATH),
    generated_sha256: null, metadata: { source: "content-studio", kind: "generated-video", uploadMode: "ai-generated", jobId: JOB }, ...patch });
}

function fixture(options: Options = {}) {
  let now = Date.parse("2026-09-30T23:59:59.000Z");
  const external: string[] = [];
  const rows = clone(options.rows ?? []);
  const objects = new Map((options.objects ?? []).map(([key, bytes]) => [key, Buffer.from(bytes)]));
  const queries: Query[] = [], reservations: Json[] = [], completions: Json[] = [], storeInputs: Json[] = [];
  const uploads: Array<{ key: string; options: Json }> = [], removals: string[][] = [];
  const providerCalls: Array<{ url: string; method: string }> = [];
  const storageReads: Array<{ url: string; init: Json; readBytes: number }> = [];
  const forbidden = (operation: string): never => { external.push(operation); throw new Error(operation); };
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  }
  function evaluate(script: Script, bindings: Json = {}): Json {
    const exports: Json = {};
    script.runInNewContext({ exports, Buffer, URL, Error, Date: ClockDate, AbortController, AbortSignal,
      Uint8Array, TextDecoder, setTimeout, clearTimeout, ...crypto,
      process: Object.freeze({ env: ENV }), console: { warn() {}, error() {} },
      require: (id: string) => forbidden(`unexpected import ${id}`),
      fetch: () => forbidden("unbound fetch"), ...bindings }, { timeout: 1000 });
    return exports;
  }
  const localRequire = (id: string) => id === "node:crypto" || id === "crypto" ? crypto : forbidden(`nonlocal import ${id}`);
  const actualGeneration = evaluate(generationScript, { require: localRequire });
  const actualIdentity = identityScript ? evaluate(identityScript, { require: localRequire }) : {};
  const column = (item: Json, name: string) => name.startsWith("metadata->>")
    ? record(item.metadata)[name.slice("metadata->>".length)] : item[name];
  const sdk = {
    from(table: string) {
      if (table !== "ad_creative_assets") return forbidden(`unexpected table ${table}`);
      const query: Query = { kind: "read", filters: [] };
      let executed = false;
      const execute = async (terminal: "single" | "maybeSingle" | "list"): Promise<Result> => {
        if (executed) return forbidden("query executed twice");
        executed = true;
        queries.push(clone(query));
        if (query.kind === "insert") {
          const inserted: Json = { id: LEGACY_ID, created_at: new ClockDate().toISOString(), ...clone(query.row) };
          if (options.insert === "malformed-no-commit") return { data: { id: "not-a-uuid", diagnostic: RAW }, error: null };
          if (rows.some((item) => item.id === inserted.id || (item.workspace_id === inserted.workspace_id
            && item.generated_key != null && item.generated_key === inserted.generated_key))) {
            return { data: null, error: { code: "23505", message: RAW } };
          }
          rows.push(inserted);
          if (options.insert === "commit-error") return { data: null, error: { message: RAW } };
          return { data: clone(inserted), error: null };
        }
        const matched = rows.filter((item) => query.filters.every(([key, value]) => column(item, key) === value));
        if (options.read) return options.read(clone(query), clone(matched));
        let found = clone(matched);
        if (query.range) found = found.slice(query.range[0], query.range[1] + 1);
        if (query.limit !== undefined) found = found.slice(0, query.limit);
        const count = query.counted ? matched.length : null;
        if (terminal !== "list") return found.length > 1 || (terminal === "single" && !found.length)
          ? { data: null, error: { message: RAW }, count } : { data: found[0] ?? null, error: null, count };
        return { data: found, error: null, count };
      };
      const chain = {
        select(_columns: string, settings?: Json) { query.counted = settings?.count === "exact"; return chain; },
        eq(key: string, value: unknown) { query.filters.push([key, value]); return chain; },
        limit(count: number) { query.limit = count; return chain; },
        range(start: number, end: number) { query.range = [start, end]; return chain; },
        insert(value: Json) { query.kind = "insert"; query.row = clone(value); return chain; },
        single: () => execute("single"), maybeSingle: () => execute("maybeSingle"),
        then: (resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) => execute("list").then(resolve, reject),
      };
      return chain;
    },
    storage: { from(bucket: string) {
      if (bucket !== "ad-creatives") return forbidden(`unexpected bucket ${bucket}`);
      return {
        getPublicUrl: (key: string) => ({ data: { publicUrl: publicUrl(key) } }),
        async upload(key: string, buffer: Buffer, settings: Json) {
          uploads.push({ key, options: clone(settings) });
          if (objects.has(key) && settings.upsert !== true) return { data: null, error: { statusCode: "409", message: RAW } };
          objects.set(key, Buffer.from(buffer));
          return options.upload === "commit-uncertain" ? { data: null, error: null } : { data: { path: key }, error: null };
        },
        async remove(keys: string[]) { removals.push([...keys]); keys.forEach((key) => objects.delete(key)); return { data: [], error: null }; },
      };
    } },
  };
  async function storageFetch(input: string | URL, init: Json = {}) {
    const url = String(input);
    const prefix = `${ORIGIN}/storage/v1/object/public/ad-creatives/`;
    if (!url.startsWith(prefix) || url.includes("?") || url.includes("#")) return forbidden(`non-own-storage verification ${url}`);
    const key = url.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (!key.startsWith(`${WORKSPACE}/`) || publicUrl(key) !== url) return forbidden(`nonexact object URL ${url}`);
    const bytes = objects.get(key);
    const call = { url, init, readBytes: 0 };
    storageReads.push(call);
    let offset = 0;
    return { ok: Boolean(bytes), status: bytes ? 200 : 404,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "video/mp4"
        : name.toLowerCase() === "content-length" ? String(bytes?.length ?? 0) : null },
      body: { getReader: () => ({
        async read() {
          if (!bytes || offset >= bytes.length) return { done: true, value: undefined };
          const value = bytes.subarray(offset, offset + 7);
          offset += value.length;
          call.readBytes += value.length;
          return { done: false, value };
        },
        async cancel() {}, releaseLock() {},
      }) },
      arrayBuffer: () => forbidden("Storage verification must stream, never arrayBuffer"),
    };
  }
  const actualVerification = verificationScript ? evaluate(verificationScript, { require: localRequire, fetch: storageFetch }) : {};
  const storeRuntime = record(evaluate(storeScript, {
    ...actualIdentity, ...actualVerification, fetch: storageFetch, getSupabaseServerClient: () => sdk,
  }).runtime);
  const billing = record(evaluate(usageScript).runtime);
  const actualGuard = record(evaluate(guardScript).runtime);
  const providerFetch = async (url: string, init: { method?: string } = {}) => {
    const method = init.method ?? "GET";
    providerCalls.push({ url, method });
    const json = (data: Json) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (method === "POST" && url === "https://api.openai.com/v1/videos") return json({ id: JOB, status: "queued", progress: 0 });
    if (method === "GET" && url === `https://api.openai.com/v1/videos/${JOB}`) return json({ id: JOB, status: "completed", progress: 100 });
    if (method === "GET" && url === `https://api.openai.com/v1/videos/${JOB}/content?variant=video`) {
      return { ok: true, status: 200, text: async () => "",
        arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.length) };
    }
    return forbidden(`unexpected provider dispatch ${method} ${url}`);
  };
  const api = evaluate(apiScript, { fetch: providerFetch, require(id: string) {
    if (id === "node:crypto") return crypto;
    if (id.endsWith("/generated-identity")) return actualIdentity;
    if (id === "../../lib/content-studio/generation") return actualGeneration;
    if (id === "../../lib/crm/server") return { ...storeRuntime, async storeGeneratedCreative(input: Json) {
      storeInputs.push(input);
      return (storeRuntime.storeGeneratedCreative as (value: Json) => Promise<unknown>)(input);
    } };
    if (id === "../../lib/content-studio/usage") return { ...billing,
      async reserveContentGeneration(input: Json) { reservations.push(clone(input)); return { allowed: true, tracked: true,
        usageId: REQUEST_KEY, kind: input.kind, used: input.units, limit: 100, remaining: 96, periodStart: "2026-09-01" }; },
      async completeContentGeneration(input: Json) { completions.push(clone(input)); },
    };
    if (id === "../../lib/auth/route-guard") return { ...actualGuard,
      // Authentication is synthetic; routing, handle signatures and handlers are actual.
      async authorizePrivateRoute(req: Json, _res: Response, authorization: { methods: string[] }) {
        assert.ok(authorization.methods.includes(String(req.method)));
        return { workspaceId: WORKSPACE, staffUserId: REQUEST_KEY, role: "owner", purpose: "clinic" };
      },
    };
    if (["../../lib/content-studio/core", "../../lib/meta/improve", "../../lib/ai/text-provider"].includes(id)) return {};
    return forbidden(`API import ${id}`);
  } });
  async function invoke(resource: "generate-video" | "video-generation", handle?: string): Promise<Reply> {
    let status = 0;
    const replies: Json[] = [];
    const res: Response = { status(code) { status = code; return this; }, setHeader() { return this; },
      json(value) { replies.push(clone(value) as Json); } };
    try {
      await (api.default as (req: Json, res: Response) => Promise<unknown>)({ method: resource === "generate-video" ? "POST" : "GET",
        query: { path: [resource], handle }, headers: { "x-idempotency-key": REQUEST_KEY },
        body: { prompt: "Synthetic replay transport", format: "reels" } }, res);
    } finally { assert.deepEqual(external, [], "no real network/imports, foreign object requests or hidden SDK assertion failures"); }
    assert.equal(replies.length, 1);
    return { status, body: replies[0]! };
  }
  return { rows, objects, queries, uploads, removals, providerCalls, storageReads, reservations, completions, storeInputs,
    advance(value: string) { now = Date.parse(value); },
    signedHandle: () => (actualGeneration.signVideoJobHandle as (value: Json) => string)({ workspaceId: WORKSPACE, jobId: JOB, secret: ENV.SUPABASE_SERVICE_ROLE_KEY }),
    poll: (handle: string) => invoke("video-generation", handle),
    async start() { const reply = await invoke("generate-video"); assert.equal(reply.status, 202); assert.equal(reply.body.success, true);
      return record(reply.body.data).handle as string; },
  };
}
type Fixture = ReturnType<typeof fixture>;
function assertPrivate(reply: Reply) {
  const text = JSON.stringify(reply.body);
  for (const value of [RAW, ENV.OPENAI_API_KEY, ENV.SUPABASE_SERVICE_ROLE_KEY]) assert.ok(!text.includes(value), "no raw diagnostics/credentials");
}
function assertReady(reply: Reply, fileName = CANONICAL_NAME, id = ASSET_ID, objectPath = CANONICAL_PATH) {
  assertPrivate(reply);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.success, true);
  const data = record(reply.body.data);
  assert.equal(data.status, "completed");
  assert.equal(data.fileName, fileName, "respond with the verified stored identity, never the current clock's name");
  assert.equal(data.assetId, id);
  assert.equal(data.creativeUrl, publicUrl(objectPath));
  assert.equal(data.fileSize, MP4.length);
  assert.equal(data.mimeType, "video/mp4");
}
function assertRefused(reply: Reply) {
  assertPrivate(reply);
  assert.equal(reply.status, 502);
  assert.equal(reply.body.success, false);
  const data = record(reply.body.data);
  assert.notEqual(data.status, "completed");
  assert.ok(!data.creativeUrl && !data.assetId);
  assert.match(String(reply.body.error), /\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e/);
}
function assertPaidOnce(f: Fixture) {
  assert.equal(f.reservations.length, 1);
  assert.equal(f.reservations[0]!.units, 4);
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0]!.status, "succeeded");
  assert.deepEqual(f.providerCalls.filter((call) => call.method === "POST"), [{ url: "https://api.openai.com/v1/videos", method: "POST" }]);
  assert.ok(f.storeInputs.every((input) => input.idempotencyKey === JOB));
}
function assertOwnStream(f: Fixture, objectPath: string) {
  assert.ok(f.storageReads.length > 0, "actual store must verify object bytes, not just trust the row or SDK error");
  for (const read of f.storageReads) {
    assert.equal(read.url, publicUrl(objectPath));
    assert.equal(read.init.redirect, "error");
    assert.equal(read.init.credentials, "omit");
    assert.equal(read.init.method ?? "GET", "GET");
    assert.ok(read.init.signal, "bounded verification has an abort signal");
    assert.equal(read.readBytes, MP4.length);
  }
}

test("same signed video job replays across clock/day/month/year with one canonical object, row and paid render", async () => {
  const f = fixture();
  const handle = await f.start();
  const replies: Reply[] = [];
  for (const time of ["2026-09-30T23:59:59.001Z", "2026-10-01T00:00:00.001Z", "2027-01-01T00:00:00.001Z"]) {
    f.advance(time);
    replies.push(await f.poll(handle));
  }
  assertPaidOnce(f);
  replies.forEach((reply) => assertReady(reply));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]!.id, ASSET_ID);
  assert.equal(f.rows[0]!.generated_key, KEY);
  assert.equal(f.rows[0]!.generated_sha256, SHA);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.key, CANONICAL_PATH);
  assert.equal(f.uploads[0]!.options.upsert, false);
  assert.equal(f.removals.length, 0);
});

test("concurrent polls reconcile the deterministic PK without another paid render or overwrite", async () => {
  const f = fixture();
  const handle = await f.start();
  const replies = await Promise.all([f.poll(handle), f.poll(handle)]);
  assertPaidOnce(f);
  replies.forEach((reply) => assertReady(reply));
  assert.equal(f.rows.length, 1);
  assert.ok(f.uploads.every((upload) => upload.key === CANONICAL_PATH && upload.options.upsert === false));
  assert.equal(f.removals.length, 0);
});

test("canonical replay survives legitimate metadata replacement using private key/hash proof", async () => {
  const f = fixture({ rows: [row({ metadata: { metaStatus: "ready" } })], objects: [[CANONICAL_PATH, MP4]] });
  assertReady(await f.poll(f.signedHandle()));
  assert.equal(f.uploads.length, 0);
  assert.equal(f.queries.filter((query) => query.kind === "insert").length, 0);
  assert.equal(f.reservations.length, 0);
  assert.ok(f.providerCalls.every((call) => call.method === "GET"));
});

test("one exact legacy video returns its old filename/id only after streamed own-object hash verification", async () => {
  const original = legacy();
  const f = fixture({ rows: [original], objects: [[OLD_PATH, MP4]] });
  for (const time of ["2026-10-01T00:00:01Z", "2027-01-01T00:00:01Z"]) {
    f.advance(time);
    assertReady(await f.poll(f.signedHandle()), OLD_NAME, LEGACY_ID, OLD_PATH);
  }
  assertOwnStream(f, OLD_PATH);
  assert.deepEqual(f.rows, [original], "no runtime hash backfill, cleanup or replacement of legacy identity");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removals.length, 0);
  assert.equal(f.reservations.length, 0);
  assert.equal(f.completions.length, 0);
  assert.ok(f.providerCalls.every((call) => call.method === "GET"));
});

for (const [label, patch] of [
  ["arbitrary filename", { file_name: "other.mp4" }],
  ["nonlegacy own path", { storage_path: `${WORKSPACE}/2026/09/other.mp4` }],
  ["foreign path", { storage_path: `${FOREIGN}/2026/09/${JOB}-${OLD_NAME}` }],
  ["foreign public URL", { public_url: "https://foreign.invalid/video.mp4" }],
  ["wrong MIME", { mime_type: "video/webm" }],
  ["wrong size", { file_size: MP4.length + 1 }],
  ["non-null mismatching private hash", { generated_sha256: "0".repeat(64) }],
] as Array<[string, Json]>) {
  test(`legacy ${label} is refused without writes, false ready or diagnostic disclosure`, async () => {
    const original = legacy(patch);
    const f = fixture({ rows: [original], objects: [[OLD_PATH, MP4]] });
    assertRefused(await f.poll(f.signedHandle()));
    assert.equal(f.uploads.length, 0);
    assert.equal(f.removals.length, 0);
    assert.deepEqual(f.rows, [original]);
    assert.equal(f.reservations.length, 0);
    assert.ok(f.providerCalls.every((call) => call.method === "GET"));
  });
}

test("legacy bytes differing from the completed provider file refuse without overwriting or deleting", async () => {
  const otherBytes = Buffer.from(MP4); otherBytes[otherBytes.length - 1] ^= 1;
  const f = fixture({ rows: [legacy()], objects: [[OLD_PATH, otherBytes]] });
  assertRefused(await f.poll(f.signedHandle()));
  assertOwnStream(f, OLD_PATH);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removals.length, 0);
  assert.deepEqual(f.objects.get(OLD_PATH), otherBytes);
});

test("duplicate legacy rows refuse instead of choosing one or creating a canonical duplicate", async () => {
  const originals = [legacy(), legacy({ id: SECOND_ID })];
  const f = fixture({ rows: originals, objects: [[OLD_PATH, MP4]] });
  assertRefused(await f.poll(f.signedHandle()));
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removals.length, 0);
  assert.deepEqual(f.rows, originals);
});

test("a foreign raw lookup receipt cannot authorize legacy replay", async () => {
  const f = fixture({ read: () => ({ data: [legacy({ workspace_id: FOREIGN })], error: null }) });
  assertRefused(await f.poll(f.signedHandle()));
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removals.length, 0);
});

test("missing key-column/read errors fail before upload and are not treated as absence", async () => {
  const f = fixture({ read: () => ({ data: null, error: { code: "42703", message: RAW } }) });
  assertRefused(await f.poll(f.signedHandle()));
  assert.equal(f.uploads.length, 0);
  assert.equal(f.removals.length, 0);
});

test("uncertain create-only upload acknowledgement is reconciled by exact own streamed bytes", async () => {
  const f = fixture({ upload: "commit-uncertain" });
  const handle = await f.start();
  const first = await f.poll(handle);
  f.advance("2027-01-01T00:00:01Z");
  const second = await f.poll(handle);
  assertPaidOnce(f);
  assertReady(first); assertReady(second);
  assertOwnStream(f, CANONICAL_PATH);
  assert.equal(f.rows.length, 1);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.options.upsert, false);
  assert.equal(f.removals.length, 0);
});

test("an INSERT error after commit reconciles the exact saved row, not a demo/fabricated success", async () => {
  const f = fixture({ insert: "commit-error" });
  const handle = await f.start();
  const reply = await f.poll(handle);
  assertPaidOnce(f);
  assertReady(reply);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]!.id, ASSET_ID);
  assert.equal(f.removals.length, 0);
});

test("malformed INSERT receipt without a matching committed row returns a private uncertainty response", async () => {
  const f = fixture({ insert: "malformed-no-commit" });
  const handle = await f.start();
  const reply = await f.poll(handle);
  assertPaidOnce(f);
  assertRefused(reply);
  assert.equal(f.rows.length, 0);
  assert.equal(f.removals.length, 0);
});

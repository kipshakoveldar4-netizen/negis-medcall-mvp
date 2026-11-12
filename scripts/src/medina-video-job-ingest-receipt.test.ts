import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Producer receipts only: no worker, decoder, SQL, environment files or services.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
async function sourceFile(file: string) {
  return ts.createSourceFile(file, await readFile(path.join(root, file), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// Reuse the repo's dependency-closure compiler without importing its tests.
const harness = await sourceFile("scripts/src/medina-generated-media-response.test.ts");
const utilitySource = ["compile", "select"].map((name) => {
  const matches = harness.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `exactly one existing ${name} harness utility`);
  return matches[0]!.getText(harness);
}).join("\n");
const { select } = new Function("ts", "assert", "Script", "baseline", `${ts.transpileModule(utilitySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText}\nreturn { select };`)(ts, assert, Script, undefined) as {
  select(ast: import("typescript").SourceFile, names: string[], boundaries?: string[]): Script;
};
const server = await sourceFile("lib/crm/server.ts");
const registry = server.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === "configs"));
assert.ok(registry && ts.isVariableStatement(registry));
const configObject = registry.declarationList.declarations[0]!.initializer;
assert.ok(configObject && ts.isObjectLiteralExpression(configObject));
const creativeConfig = configObject.properties.filter((node) => ts.isPropertyAssignment(node)
  && ts.isStringLiteral(node.name) && node.name.text === "ad-creatives");
assert.equal(creativeConfig.length, 1);
// Narrow only the unrelated registry, retaining actual handlers, mappers and helpers.
const narrowServer = ts.createSourceFile(server.fileName, server.text.slice(0, registry.getStart(server))
  + `const configs = { ${creativeConfig[0]!.getText(server)} };` + server.text.slice(registry.getEnd()),
ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const program = select(narrowServer, ["handleVideoJobs", "handleVideoProcessingJobs", "attachWorkspaceContext"]);

type Json = Record<string, unknown>;
type Result = { data: unknown; error: unknown };
type Query = { table: string; kind: "read" | "insert" | "update"; columns: string; filters: Array<[string, unknown]>;
  isFilters?: Array<[string, unknown]>; row?: Json };
type Fault = { data?: unknown; error?: unknown; commit?: boolean; throws?: boolean };
type Route = "ticket" | "processing";
type Reply = { status: number; body: Json };
type Options = {
  assets?: Json[];
  jobs?: Json[];
  sdkMissing?: boolean;
  bucket?: (bucket: string) => Result;
  signed?: (bucket: string, key: string) => Result;
  fault?: (query: Query, normal: Result) => Fault | undefined;
};
type Response = { status(code: number): Response; setHeader(name: string, value: string): Response; json(value: unknown): void };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const OTHER_ASSET = "55555555-5555-4555-8555-555555555555";
const OTHER_JOB = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://video-ingest.fixture.invalid";
const RAW_BUCKET = "ad-creatives-raw";
const RAW_PATH = `${WORKSPACE}/2026/10/synthetic-original.mov`;
const FILE_NAME = "Synthetic Original.mov";
const MIME = "video/quicktime";
const SIZE = 4096;
const NOW = "2026-10-25T03:00:00.000Z";
const PRIVATE = "SYNTHETIC_PRIVATE_INGEST_DIAGNOSTIC";
const ENV = Object.freeze({ SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-fixture-not-a-credential",
  VIDEO_OPTIMIZATION_ENABLED: "true", VIDEO_OPTIMIZATION_RAW_BUCKET: RAW_BUCKET,
  VIDEO_OPTIMIZATION_MAX_INPUT_MB: "500" });
const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function asset(patch: Json = {}): Json {
  return { id: ASSET, workspace_id: WORKSPACE, storage_bucket: RAW_BUCKET, storage_path: RAW_PATH,
    file_name: FILE_NAME, file_type: "video", mime_type: MIME, file_size: SIZE,
    status: "optimizing", updated_at: NOW, ...patch };
}
function job(patch: Json = {}): Json {
  return { id: JOB, workspace_id: WORKSPACE, asset_id: ASSET, status: "awaiting_upload", progress: 0,
    raw_bucket: RAW_BUCKET, raw_path: RAW_PATH, raw_size: SIZE,
    source_file_name: FILE_NAME, source_mime_type: MIME, created_at: NOW, updated_at: NOW, ...patch };
}
const ticketInput = (patch: Json = {}): Json => ({ fileName: FILE_NAME, mimeType: MIME, fileSize: SIZE, ...patch });
const processingInput = (patch: Json = {}): Json => ({ assetId: ASSET, rawPath: RAW_PATH,
  fileName: FILE_NAME, inputMimeType: MIME, inputSizeBytes: SIZE, ...patch });

function fixture(options: Options = {}) {
  const assets = clone(options.assets ?? []), jobs = clone(options.jobs ?? []);
  const queries: Query[] = [], signedCalls: Array<{ bucket: string; key: string }> = [];
  const bucketCalls: string[] = [];
  const external: string[] = [];
  const forbidden = (operation: string): never => { external.push(operation); throw new Error(operation); };
  const signedUrl = (bucket: string, key: string) => `${ORIGIN}/storage/v1/object/upload/sign/${bucket}/${key}?token=SYNTHETIC_TOKEN`;
  const sdk = {
    from(table: string) {
      if (!["ad_creative_assets", "video_processing_jobs"].includes(table)) return forbidden(`unexpected table ${table}`);
      const rows = table === "ad_creative_assets" ? assets : jobs;
      const query: Query = { table, kind: "read", columns: "*", filters: [] };
      let executed = false;
      const execute = async (terminal: "single" | "maybeSingle" | "list"): Promise<Result> => {
        if (executed) return forbidden("query executed twice");
        executed = true;
        queries.push(clone(query));
        const matched = rows.filter((item) => query.filters.every(([key, value]) => item[key] === value)
          // Omitted nullable fixture columns represent SQL NULL in snapshots.
          && (query.isFilters ?? []).every(([key, value]) => value === null ? item[key] == null : item[key] === value));
        const inserted: Json = { id: table === "ad_creative_assets" ? ASSET : JOB, created_at: NOW,
          updated_at: NOW, ...clone(query.row) };
        const candidates = query.kind === "insert" ? [inserted] : query.kind === "update"
          ? matched.map((item) => ({ ...clone(item), ...clone(query.row) })) : clone(matched);
        const projected = candidates.map((item) => query.columns === "*" ? item
          : Object.fromEntries(query.columns.split(",").map((key) => [key.trim(), item[key.trim()]])));
        const normal: Result = terminal === "list" ? { data: projected, error: null }
          : projected.length > 1 || (terminal === "single" && !projected.length)
            ? { data: null, error: { message: PRIVATE } } : { data: projected[0] ?? null, error: null };
        const fault = options.fault?.(clone(query), clone(normal));
        if (fault?.commit ?? !fault) {
          if (query.kind === "insert") rows.push(inserted);
          if (query.kind === "update") matched.forEach((item) => Object.assign(item, clone(query.row)));
        }
        if (fault?.throws) throw new Error(PRIVATE);
        return fault ? { data: has(fault, "data") ? clone(fault.data) : normal.data,
          error: has(fault, "error") ? clone(fault.error) : null } : normal;
      };
      const chain = {
        select(columns = "*") { query.columns = columns; return chain; },
        eq(key: string, value: unknown) { query.filters.push([key, value]); return chain; },
        is(key: string, value: unknown) { (query.isFilters ??= []).push([key, value]); return chain; },
        insert(row: Json) { query.kind = "insert"; query.row = clone(row); return chain; },
        update(row: Json) { query.kind = "update"; query.row = clone(row); return chain; },
        single: () => execute("single"), maybeSingle: () => execute("maybeSingle"),
        then: (resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) => execute("list").then(resolve, reject),
      };
      return chain;
    },
    storage: {
      async getBucket(bucket: string): Promise<Result> {
        bucketCalls.push(bucket);
        return options.bucket?.(bucket) ?? { data: { id: RAW_BUCKET, public: false,
          file_size_limit: 500 * 1024 * 1024, allowed_mime_types: ["video/mp4", "video/quicktime", "video/webm"] }, error: null };
      },
      from(bucket: string) { return {
      async createSignedUploadUrl(key: string) {
        signedCalls.push({ bucket, key });
        return options.signed?.(bucket, key)
          ?? { data: { path: key, token: "SYNTHETIC_TOKEN", signedUrl: signedUrl(bucket, key) }, error: null };
      },
    }; } },
  };
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? NOW); }
    static now() { return Date.parse(NOW); }
  }
  const exports: Json = {};
  program.runInNewContext({ exports, Buffer, Error, URL, Date: FixedDate, ...crypto,
    AbortController, AbortSignal, setTimeout, clearTimeout,
    process: Object.freeze({ env: ENV }), console: { warn() {}, error() {} },
    getSupabaseServerClient: () => options.sdkMissing ? null : sdk,
    require: (id: string) => forbidden(`unexpected import ${id}`),
    fetch: () => forbidden("fetch must not leave the local producer fixture"),
  }, { timeout: 1000 });
  const runtime = record(exports.runtime);
  async function invoke(route: Route, method: string, body: Json = {}, id?: string, authenticated = true): Promise<Reply> {
    let status = 0;
    const replies: Json[] = [];
    const req: Json = { method, body: clone(body), query: { id, workspaceId: FOREIGN }, headers: {} };
    if (authenticated) (runtime.attachWorkspaceContext as (req: Json, context: Json) => void)(req,
      { workspaceId: WORKSPACE, staffUserId: OTHER_ASSET, role: "owner" });
    const res: Response = { status(code) { status = code; return this; }, setHeader() { return this; },
      json(value) { replies.push(clone(value) as Json); } };
    try {
      const handler = runtime[route === "ticket" ? "handleVideoJobs" : "handleVideoProcessingJobs"] as
        (req: Json, res: Response, segments?: string[]) => Promise<unknown>;
      await handler(req, res, id ? [id] : []);
    } finally { assert.deepEqual(external, [], "no real fetch/imports or hidden SDK failures"); }
    assert.equal(replies.length, 1, "one response from the actual handler");
    return { status, body: replies[0]! };
  }
  return { assets, jobs, queries, bucketCalls, signedCalls, signedUrl, invoke };
}

type Fixture = ReturnType<typeof fixture>;
function assertPrivate(reply: Reply) {
  const text = JSON.stringify(reply.body);
  for (const value of [PRIVATE, ENV.SUPABASE_SERVICE_ROLE_KEY]) assert.ok(!text.includes(value), "no private SDK diagnostics in a browser receipt");
}
function assertRefused(reply: Reply, reason: string) {
  assertPrivate(reply);
  assert.ok(reply.status >= 400 && reply.status <= 599,
    `${reason}: got HTTP ${reply.status}, mode=${String(reply.body.mode)}, job=${JSON.stringify(record(reply.body.data).job)}`);
  assert.equal(reply.body.success, false, reason);
  assert.equal(record(reply.body.data).job, undefined, "an unconfirmed job must not be presented as saved");
  assert.equal(record(reply.body.data).signedUpload, undefined, "no usable upload authority after an unconfirmed producer receipt");
}
function assertJobReceipt(reply: Reply, f: Fixture) {
  assertPrivate(reply);
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.mode, "supabase");
  const returned = record(record(reply.body.data).job);
  const saved = f.jobs.find((item) => item.id === returned.id && item.workspace_id === WORKSPACE);
  assert.ok(saved, "success must identify an actual saved own-workspace job, not a generated demo id");
  assert.equal(returned.workspaceId, WORKSPACE);
  assert.equal(returned.assetId, saved.asset_id ?? "");
  assert.equal(returned.status, saved.status);
  assert.equal(returned.sourceFileName, saved.source_file_name);
  assert.equal(returned.sourceMimeType, saved.source_mime_type);
  assert.equal(returned.rawSize, saved.input_size_bytes ?? saved.raw_size ?? null);
  for (const field of ["rawPath", "raw_path", "rawBucket", "raw_bucket", "rawPublicUrl", "raw_public_url", "claimedBy", "claimed_by"]) {
    assert.equal(returned[field], undefined, `pollable job must not expose ${field}`);
  }
  return returned;
}
function assertNoUnconfirmedAsset(reply: Reply, f: Fixture) {
  assertPrivate(reply);
  if (reply.body.success !== true) return assertRefused(reply, "asset acknowledgement was not confirmed");
  const data = record(reply.body.data);
  assert.equal(data.assetId ?? "", "", "unconfirmed asset acknowledgement must not be advertised as a saved assetId");
  assert.equal(record(data.job).assetId, "", "unconfirmed asset acknowledgement must not authorize a job asset link");
  assert.equal(f.jobs[0]?.asset_id, null, "optional asset fallback must not persist an unconfirmed id");
  assertJobReceipt(reply, f);
}
const jobInsert = (q: Query) => q.table === "video_processing_jobs" && q.kind === "insert";
const assetInsert = (q: Query) => q.table === "ad_creative_assets" && q.kind === "insert";

test("canonical ticket -> queue -> poll keeps saved input MIME/size/name and server-owned ticket identity", async () => {
  const f = fixture();
  const created = await f.invoke("ticket", "POST", ticketInput({
    workspaceId: FOREIGN, workspace_id: FOREIGN, assetId: OTHER_ASSET, id: OTHER_JOB,
    rawPath: `${FOREIGN}/foreign.mov`, rawBucket: "ad-creatives", storageBucket: "ad-creatives",
    storagePath: `${FOREIGN}/foreign.mov`, source_mime_type: "video/webm", source_file_name: "foreign.webm",
  }));
  assert.equal(created.status, 201);
  assertJobReceipt(created, f);
  assert.equal(f.assets.length, 1);
  assert.equal(f.jobs.length, 1);
  const savedAsset = f.assets[0]!, savedJob = f.jobs[0]!, signed = record(record(created.body.data).signedUpload);
  assert.equal(savedAsset.workspace_id, WORKSPACE);
  assert.equal(savedAsset.file_name, FILE_NAME);
  assert.equal(savedAsset.mime_type, MIME);
  assert.equal(savedAsset.file_size, SIZE);
  assert.equal(savedAsset.storage_bucket, RAW_BUCKET);
  assert.equal(savedJob.asset_id, savedAsset.id);
  assert.equal(savedJob.workspace_id, WORKSPACE);
  assert.equal(savedJob.source_file_name, FILE_NAME);
  assert.equal(savedJob.source_mime_type, MIME);
  assert.equal(savedJob.status, "awaiting_upload");
  assert.equal(savedJob.raw_path, savedAsset.storage_path);
  assert.equal(savedJob.raw_bucket, RAW_BUCKET);
  assert.equal(signed.storagePath, savedJob.raw_path);
  assert.equal(signed.bucket, RAW_BUCKET);
  assert.equal(signed.storageBucket, RAW_BUCKET);
  assert.equal(signed.signedUrl, f.signedUrl(RAW_BUCKET, String(savedJob.raw_path)));
  assert.deepEqual(f.signedCalls, [{ bucket: RAW_BUCKET, key: savedJob.raw_path }]);
  assert.ok(String(signed.storagePath).startsWith(`${WORKSPACE}/`));
  const queued = await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE, workspaceId: FOREIGN,
    assetId: OTHER_ASSET, status: "ready", rawPath: `${FOREIGN}/foreign.mov`, rawBucket: "ad-creatives",
    source_file_name: "foreign.webm", source_mime_type: "video/webm" });
  assert.equal(queued.status, 200);
  assert.equal(assertJobReceipt(queued, f).status, "queued");
  assert.equal(savedJob.raw_size, savedAsset.file_size);
  assert.equal(savedJob.source_file_name, savedAsset.file_name);
  assert.equal(savedJob.source_mime_type, savedAsset.mime_type);
  for (const route of ["ticket", "processing"] as const) assertJobReceipt(await f.invoke(route, "GET", {}, JOB), f);
  const update = f.queries.find((q) => q.kind === "update")!;
  assert.ok(update.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE));
  assert.ok(update.filters.some(([key, value]) => key === "status" && value === "awaiting_upload"));
});

for (const [extension, mime] of [["mov", "video/quicktime"], ["webm", "video/webm"], ["mp4", "video/mp4"]]) {
  test(`processing producer canonical ${extension} input persists exact snake-case source fields`, async () => {
    const name = `Synthetic Original.${extension}`;
    const key = `${WORKSPACE}/2026/10/input.${extension}`;
    const f = fixture({ assets: [asset({ storage_path: key, file_name: name, mime_type: mime })] });
    const reply = await f.invoke("processing", "POST", { asset_id: ASSET, raw_path: key, file_name: name,
      input_mime_type: "application/octet-stream", input_size_bytes: SIZE, workspace_id: FOREIGN,
      raw_bucket: "ad-creatives", output_bucket: "foreign", status: "ready", id: OTHER_JOB });
    assert.equal(reply.status, 201);
    const returned = assertJobReceipt(reply, f);
    assert.equal(returned.sourceMimeType, mime);
    assert.equal(returned.inputMimeType, mime);
    assert.equal(returned.sourceFileName, name);
    assert.equal(returned.rawSize, SIZE);
    const saved = f.jobs[0]!;
    assert.equal(saved.source_mime_type, mime);
    assert.equal(saved.input_mime_type, mime);
    assert.equal(saved.source_file_name, name);
    assert.equal(saved.raw_size, SIZE);
    assert.equal(saved.input_size_bytes, SIZE);
    assert.equal(saved.raw_bucket, RAW_BUCKET);
    assert.equal(saved.raw_path, key);
    assert.equal(saved.output_bucket, "ad-creatives");
  });
}

// asset_id is optional in the existing worker contract. Losing an asset receipt
// may use that fallback, but must never manufacture a saved asset identity.
for (const [label, fault] of [
  ["empty acknowledgement", { data: null }],
  ["empty row", { data: {} }],
  ["error without commit", { data: null, error: { message: PRIVATE } }],
  ["lost acknowledgement after commit", { data: null, error: { message: PRIVATE }, commit: true }],
  ["thrown lost acknowledgement after commit", { throws: true, commit: true }],
  ["malformed id", { data: { id: "not-a-uuid" } }],
  ["foreign asset row", { data: asset({ id: OTHER_ASSET, workspace_id: FOREIGN }) }],
] as Array<[string, Fault]>) {
  test(`ticket asset ${label} never becomes an unconfirmed saved asset`, async () => {
    const f = fixture({ fault: (q) => assetInsert(q) ? fault : undefined });
    assertNoUnconfirmedAsset(await f.invoke("ticket", "POST", ticketInput()), f);
  });
}

for (const route of ["ticket", "processing"] as const) {
  for (const [label, change] of [
    ["null receipt", () => null],
    ["empty row", () => ({})],
    ["array instead of row", (row: Json) => [row]],
    ["invalid id", (row: Json) => ({ ...row, id: "not-a-uuid" })],
    ["foreign workspace", (row: Json) => ({ ...row, workspace_id: FOREIGN })],
    ["unrelated asset", (row: Json) => ({ ...row, asset_id: OTHER_ASSET })],
    ["foreign raw path", (row: Json) => ({ ...row, raw_path: `${FOREIGN}/foreign.mov` })],
    ["wrong raw bucket", (row: Json) => ({ ...row, raw_bucket: "ad-creatives" })],
    ["wrong source MIME", (row: Json) => ({ ...row, source_mime_type: "video/webm" })],
    ["wrong source name", (row: Json) => ({ ...row, source_file_name: "foreign.webm" })],
    ["wrong initial state", (row: Json) => ({ ...row, status: "ready" })],
  ] as Array<[string, (row: Json) => unknown]>) {
    test(`${route} INSERT ${label} cannot acknowledge a real saved job`, async () => {
      const f = fixture({ assets: route === "processing" ? [asset()] : [],
        fault: (q, normal) => jobInsert(q) ? { data: change(record(normal.data)) } : undefined });
      const reply = await f.invoke(route, "POST", route === "ticket" ? ticketInput() : processingInput());
      assert.equal(f.jobs.length, 0, "fault did not commit a job");
      assertRefused(reply, `${route} INSERT ${label} has no confirmed own job`);
    });
  }

  for (const [label, fault] of [
    ["error without commit", { data: null, error: { message: PRIVATE } }],
    ["error after commit", { data: null, error: { message: PRIVATE }, commit: true }],
    ["throw after commit", { throws: true, commit: true }],
  ] as Array<[string, Fault]>) {
    test(`${route} INSERT ${label} is either verified by lookup or explicitly unconfirmed`, async () => {
      const f = fixture({ assets: route === "processing" ? [asset()] : [],
        fault: (q) => jobInsert(q) ? fault : undefined });
      const reply = await f.invoke(route, "POST", route === "ticket" ? ticketInput() : processingInput());
      assert.equal(f.jobs.length, fault.commit ? 1 : 0);
      if (reply.body.success === true) {
        assertJobReceipt(reply, f);
        assert.ok(f.queries.some((q) => q.table === "video_processing_jobs" && q.kind === "read"
          && q.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE)),
        "lost INSERT response requires independent own-workspace persistence proof before success");
      } else assertRefused(reply, "unknown INSERT outcome must not become demo or fabricated success");
    });
  }

  test(`${route} INSERT null acknowledgement after commit cannot manufacture a demo identity`, async () => {
    const f = fixture({ assets: route === "processing" ? [asset()] : [],
      fault: (q) => jobInsert(q) ? { data: null, commit: true } : undefined });
    const reply = await f.invoke(route, "POST", route === "ticket" ? ticketInput() : processingInput());
    assert.equal(f.jobs.length, 1, "the write committed but its response was lost");
    if (reply.body.success === true) assertJobReceipt(reply, f);
    else assertRefused(reply, "the committed identity remains unconfirmed without a successful lookup");
  });
}

for (const [label, change] of [
  ["foreign path", (bucket: string, key: string, url: string) => ({ path: `${FOREIGN}/foreign.mov`, signedUrl: url })],
  ["foreign origin", (bucket: string, key: string) => ({ path: key, signedUrl: "https://foreign.fixture.invalid/upload" })],
  ["public bucket URL", (_bucket: string, key: string) => ({ path: key,
    signedUrl: `${ORIGIN}/storage/v1/object/upload/sign/ad-creatives/${key}?token=SYNTHETIC_TOKEN` })],
  ["other object URL", (bucket: string, key: string) => ({ path: key,
    signedUrl: `${ORIGIN}/storage/v1/object/upload/sign/${bucket}/${WORKSPACE}/other.mov?token=SYNTHETIC_TOKEN` })],
] as Array<[string, (bucket: string, key: string, url: string) => Json]>) {
  test(`signed raw ticket ${label} cannot authorize the server-derived job`, async () => {
    const f = fixture({ signed: (bucket, key) => ({ data: { token: "SYNTHETIC_TOKEN",
      ...change(bucket, key, `${ORIGIN}/storage/v1/object/upload/sign/${bucket}/${key}?token=SYNTHETIC_TOKEN`) }, error: null }) });
    assertRefused(await f.invoke("ticket", "POST", ticketInput()), `signed ticket ${label} is not bound to the exact private object`);
    assert.equal(f.jobs.length, 0, "bad upload authority must not create an awaiting job");
  });
}

test("own raw bucket/path/token is sufficient without the optional signed URL", async () => {
  const f = fixture({ signed: (_bucket, key) => ({ data: { path: key, token: "SYNTHETIC_TOKEN" }, error: null }) });
  const reply = await f.invoke("ticket", "POST", ticketInput());
  assert.equal(reply.status, 201);
  assertJobReceipt(reply, f);
  const signed = record(record(reply.body.data).signedUpload);
  assert.equal(signed.bucket, RAW_BUCKET);
  assert.equal(signed.storagePath, f.jobs[0]!.raw_path);
  assert.equal(signed.token, "SYNTHETIC_TOKEN");
});

test("signed raw ticket missing token fails without inserts", async () => {
  const f = fixture({ signed: () => ({ data: { token: "" }, error: null }) });
  assertRefused(await f.invoke("ticket", "POST", ticketInput()), "no signed token");
  assert.deepEqual(f.queries, []);
});

test("signed raw ticket transport error is private and cannot create saved rows", async () => {
  const f = fixture({ signed: () => ({ data: null, error: { message: PRIVATE } }) });
  assertRefused(await f.invoke("ticket", "POST", ticketInput()), "signed URL lookup failed");
  assert.deepEqual(f.queries, []);
});

test("processing POST refuses a caller's foreign raw path even with its own asset id", async () => {
  const f = fixture({ assets: [asset()] });
  assertRefused(await f.invoke("processing", "POST", processingInput({ rawPath: `${FOREIGN}/foreign.mov`, workspaceId: FOREIGN })),
    "raw path belongs to a different verified workspace");
  assert.deepEqual(f.queries, []);
});

test("processing POST foreign public URL cannot replace a missing private raw object path", async () => {
  const f = fixture({ assets: [asset()] });
  assertRefused(await f.invoke("processing", "POST", processingInput({ rawPath: "",
    rawPublicUrl: "https://foreign.fixture.invalid/foreign.mov" })), "no own private raw object was identified");
  assert.equal(f.jobs.length, 0);
});

for (const mode of ["filtered foreign asset", "foreign lookup receipt", "transient asset lookup"] as const) {
  test(`processing POST ${mode} cannot authorize a job asset`, async () => {
    const f = fixture({ assets: [asset({ workspace_id: mode === "filtered foreign asset" ? FOREIGN : WORKSPACE })],
      fault: (q) => q.table === "ad_creative_assets" && q.kind === "read" && mode !== "filtered foreign asset"
        ? mode === "foreign lookup receipt" ? { data: asset({ workspace_id: FOREIGN }) }
          : { data: null, error: { message: PRIVATE } } : undefined });
    const reply = await f.invoke("processing", "POST", processingInput({ workspaceId: FOREIGN }));
    assertRefused(reply, "asset ownership was not proved");
    assert.equal(reply.status, mode === "transient asset lookup" ? 502 : 404);
    assert.equal(f.jobs.length, 0);
    const lookup = f.queries[0]!;
    assert.ok(lookup.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE));
  });
}

for (const [label, patch] of [
  ["raw object", { rawPath: `${WORKSPACE}/another-original.mov` }],
  ["source MIME", { inputMimeType: "video/webm" }],
  ["input byte count", { inputSizeBytes: SIZE + 1 }],
] as Array<[string, Json]>) {
  test(`processing producer cannot acknowledge ${label} inconsistent with its linked saved asset`, async () => {
    const f = fixture({ assets: [asset()] });
    assertRefused(await f.invoke("processing", "POST", processingInput(patch)),
      "own asset id alone is not proof that this raw input belongs to that asset");
    assert.equal(f.jobs.length, 0);
  });
}

for (const rawSize of [undefined, 0, -1, SIZE + 1]) {
  test(`queue PATCH rawSize=${String(rawSize)} cannot replace the canonical saved input size`, async () => {
    const f = fixture({ assets: [asset()], jobs: [job()] });
    const reply = await f.invoke("ticket", "PATCH", { id: JOB, ...(rawSize === undefined ? {} : { rawSize }) });
    assertPrivate(reply);
    if (reply.body.success === true) {
      assert.equal(f.jobs[0]!.raw_size, SIZE, "queue acknowledgement must preserve the canonical asset's byte count");
      assertJobReceipt(reply, f);
    } else assertRefused(reply, "queue rejected inconsistent byte count");
    assert.equal(f.assets[0]!.file_size, SIZE);
  });
}

for (const [label, change] of [
  ["empty row", () => ({})],
  ["foreign workspace", (row: Json) => ({ ...row, workspace_id: FOREIGN })],
  ["other job id", (row: Json) => ({ ...row, id: OTHER_JOB })],
] as Array<[string, (row: Json) => unknown]>) {
  test(`queue PATCH ${label} receipt cannot acknowledge a saved queue transition`, async () => {
    const f = fixture({ assets: [asset()], jobs: [job()],
      fault: (q, normal) => q.kind === "update" ? { data: change(record(normal.data)) } : undefined });
    assertRefused(await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE }), "queue update receipt is unconfirmed");
    assert.equal(f.jobs[0]!.status, "awaiting_upload");
  });
}

test("queue PATCH lost acknowledgement after commit can return only a verified own current job", async () => {
  const f = fixture({ jobs: [job()], fault: (q) => q.kind === "update" ? { data: null, commit: true } : undefined });
  const reply = await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE });
  assert.equal(f.jobs[0]!.status, "queued");
  assert.equal(assertJobReceipt(reply, f).status, "queued");
  const lookup = f.queries.find((q) => q.kind === "read")!;
  assert.ok(lookup.filters.some(([key, value]) => key === "id" && value === JOB));
  assert.ok(lookup.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE));
});

for (const commit of [false, true]) {
  test(`queue PATCH transport error commit=${commit} is uncertainty, not a missing or fabricated job`, async () => {
    const f = fixture({ jobs: [job()],
      fault: (q) => q.kind === "update" ? { data: null, error: { message: PRIVATE }, commit } : undefined });
    const reply = await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE });
    if (reply.body.success === true) assertJobReceipt(reply, f);
    else {
      assertRefused(reply, "queue write outcome is unconfirmed");
      assert.ok(reply.status >= 500, `queue write uncertainty is not HTTP ${reply.status} absence`);
    }
  });
}

for (const [label, receipt] of [["foreign row", job({ workspace_id: FOREIGN })], ["empty row", {}]] as Array<[string, Json]>) {
  test(`queue fallback ${label} cannot replace an exact own-workspace saved receipt`, async () => {
    const f = fixture({ jobs: [job({ status: "queued" })], fault: (q) => q.kind === "read" ? { data: receipt } : undefined });
    assertRefused(await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE }), "queue readback did not confirm the requested own job");
  });
}

for (const route of ["ticket", "processing"] as const) {
  test(`${route} GET missing and foreign jobs remain indistinguishable`, async () => {
    for (const jobs of [[], [job({ workspace_id: FOREIGN })]]) {
      const f = fixture({ jobs });
      const reply = await f.invoke(route, "GET", {}, JOB);
      assertRefused(reply, "no own job exists");
      assert.equal(reply.status, 404);
    }
  });
  test(`${route} GET foreign row returned by SDK cannot become an own job receipt`, async () => {
    const f = fixture({ fault: () => ({ data: job({ workspace_id: FOREIGN }) }) });
    assertRefused(await f.invoke(route, "GET", {}, JOB), "returned row belongs to another workspace");
  });
  test(`${route} GET null single receipt is not a real saved job`, async () => {
    const f = fixture({ fault: () => ({ data: null }) });
    assertRefused(await f.invoke(route, "GET", {}, JOB), "single lookup returned no persistence proof");
  });
  test(`${route} GET transient lookup error is uncertainty, not authoritative absence`, async () => {
    const f = fixture({ jobs: [job()], fault: () => ({ data: null, error: { message: PRIVATE } }) });
    const reply = await f.invoke(route, "GET", {}, JOB);
    assertRefused(reply, "transient lookup failed");
    assert.ok(reply.status >= 500, `an existing job lookup failed transiently; HTTP ${reply.status} falsely reports absence`);
  });
  test(`${route} configured workspace cannot report POST demo success when the SDK is unavailable`, async () => {
    const f = fixture({ sdkMissing: true });
    assertRefused(await f.invoke(route, "POST", route === "ticket" ? ticketInput() : processingInput()), "configured real workspace lost its database client");
  });
  test(`${route} configured workspace cannot report GET demo success for a malformed job id`, async () => {
    const f = fixture();
    assertRefused(await f.invoke(route, "GET", {}, "not-a-uuid"), "invalid poll id is not a demo job");
  });
}

test("configured workspace cannot report queued demo success for a malformed PATCH id", async () => {
  const f = fixture();
  assertRefused(await f.invoke("ticket", "PATCH", { id: "not-a-uuid", rawSize: SIZE }), "invalid queue id is not a demo job");
});

test("queue fallback does not widen a foreign job lookup", async () => {
  const f = fixture({ jobs: [job({ workspace_id: FOREIGN })] });
  const reply = await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE, workspaceId: FOREIGN });
  assertRefused(reply, "foreign job is not queueable");
  assert.equal(reply.status, 404);
  assert.ok(f.queries.every((q) => q.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE)));
  assert.equal(f.jobs[0]!.status, "awaiting_upload");
});

test("queue fallback transient read error must not report a confirmed missing job", async () => {
  const f = fixture({ jobs: [job({ status: "queued" })],
    fault: (q) => q.kind === "read" ? { data: null, error: { message: PRIVATE } } : undefined });
  const reply = await f.invoke("ticket", "PATCH", { id: JOB, rawSize: SIZE });
  assertRefused(reply, "queue readback failed transiently");
  assert.ok(reply.status >= 500, `transient queue readback is unknown, not HTTP ${reply.status} absence`);
});

const READY_PATH = `optimized/${WORKSPACE}/${JOB}-1234567890abcdef1234.mp4`;
const READY_THUMB_PATH = `optimized/${WORKSPACE}/${JOB}-1234567890abcdef1234-thumbnail.jpg`;
const READY_URL = `${ORIGIN}/storage/v1/object/public/ad-creatives/${READY_PATH}`;
const READY_THUMB_URL = `${ORIGIN}/storage/v1/object/public/ad-creatives/${READY_THUMB_PATH}`;
const READY_NAME = "Synthetic Original.mp4";
const READY_SIZE = 1234;
function readyAsset(patch: Json = {}): Json {
  return asset({ file_name: READY_NAME, mime_type: "video/mp4", file_size: READY_SIZE,
    storage_bucket: "ad-creatives", storage_path: READY_PATH, public_url: READY_URL, status: "ready", ...patch });
}
function readyJob(patch: Json = {}): Json {
  return job({ status: "ready", progress: 100, input_mime_type: MIME, input_size_bytes: SIZE,
    output_bucket: "ad-creatives", optimized_bucket: "ad-creatives", output_path: READY_PATH, optimized_path: READY_PATH,
    output_public_url: READY_URL, optimized_public_url: READY_URL, output_mime_type: "video/mp4",
    output_size: READY_SIZE, output_size_bytes: READY_SIZE, thumbnail_path: READY_THUMB_PATH,
    thumbnail_url: READY_THUMB_URL, thumbnail_public_url: READY_THUMB_URL, thumbnail_source: "worker", completed_at: NOW, ...patch });
}
function assertReadyReadOnly(f: Fixture) {
  assert.ok(f.queries.length > 0);
  for (const query of f.queries) {
    assert.equal(query.kind, "read", "GET-ready verification cannot repair or fabricate persistence");
    assert.ok(query.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE), "every ready receipt lookup remains tenant-scoped");
    assert.ok(query.filters.some(([key, value]) => key === "id"
      && value === (query.table === "ad_creative_assets" ? ASSET : JOB)), "verify the exact requested job and linked asset");
  }
  assert.deepEqual(f.bucketCalls, [], "polling does not issue upload grants or inspect raw upload capacity");
  assert.deepEqual(f.signedCalls, []);
}
function assertUnconfirmedReady(reply: Reply, f: Fixture, reason: string) {
  assertRefused(reply, reason);
  assert.equal(reply.status, 502, "a persisted ready job with an unproved output is uncertainty, not a usable result or a missing job");
  assert.equal(reply.body.code, "video_job_unconfirmed");
  assertReadyReadOnly(f);
}

for (const route of ["ticket", "processing"] as const) {
  for (const status of ["ready", "uploaded"]) {
    test(`${route} GET-ready full matched ${status} asset returns a usable output receipt`, async () => {
      const savedAsset = readyAsset({ status }), savedJob = readyJob();
      const f = fixture({ assets: [savedAsset], jobs: [savedJob] });
      const reply = await f.invoke(route, "GET", {}, JOB);
      assert.equal(reply.status, 200);
      const returned = assertJobReceipt(reply, f);
      assert.equal(returned.status, "ready");
      assert.equal(returned.assetId, ASSET);
      assert.equal(returned.outputAssetId, ASSET);
      assert.equal(returned.outputFileName, READY_NAME);
      assert.equal(returned.outputMimeType, "video/mp4");
      assert.equal(returned.outputStorageBucket, "ad-creatives");
      assert.equal(returned.outputStoragePath, READY_PATH);
      assert.equal(returned.outputPublicUrl, READY_URL);
      assert.equal(returned.optimizedPublicUrl, READY_URL);
      assert.equal(returned.outputSize, READY_SIZE);
      assert.equal(returned.outputSizeBytes, READY_SIZE);
      assert.equal(returned.thumbnailPublicUrl, READY_THUMB_URL);
      assert.equal(returned.thumbnailUrl, READY_THUMB_URL);
      assert.equal(returned.thumbnailSource, "worker");
      assertReadyReadOnly(f);
      assert.equal(f.queries.filter((q) => q.table === "ad_creative_assets").length, 1, "ready success requires a confirmed matched asset row");
      assert.deepEqual(f.assets, [savedAsset]);
      assert.deepEqual(f.jobs, [savedJob]);
    });
  }

  for (const [label, assetId] of [["legacy asset-less worker ready", null], ["missing asset_id", undefined],
    ["malformed asset_id", "not-a-uuid"]] as Array<[string, unknown]>) {
    test(`${route} GET-ready ${label} is explicitly unconfirmed`, async () => {
      const f = fixture({ assets: [readyAsset()], jobs: [readyJob({ asset_id: assetId })] });
      assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, "a ready job without a UUID linked asset cannot be applied by the UI");
    });
  }

  for (const [label, assets] of [
    ["missing asset row", []], ["foreign persisted asset", [readyAsset({ workspace_id: FOREIGN })]],
  ] as Array<[string, Json[]]>) {
    test(`${route} GET-ready ${label} cannot authorize a usable output`, async () => {
      const f = fixture({ assets, jobs: [readyJob()] });
      assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, "ready requires an actual own-workspace output asset");
      assert.equal(f.queries.filter((q) => q.table === "ad_creative_assets").length, 1);
    });
  }

  for (const [label, patch] of [
    ["foreign asset receipt", { workspace_id: FOREIGN }],
    ["unrelated asset id", { id: OTHER_ASSET }],
    ["wrong asset file type", { file_type: "image" }],
    ["wrong asset MIME", { mime_type: "video/webm" }],
    ["wrong asset byte count", { file_size: READY_SIZE + 1 }],
    ["private raw asset bucket", { storage_bucket: RAW_BUCKET }],
    ["unrelated asset path", { storage_path: `optimized/${WORKSPACE}/other.mp4` }],
    ["foreign asset public URL", { public_url: READY_URL.replace(ORIGIN, "https://foreign.fixture.invalid") }],
    ["missing output filename", { file_name: "" }],
    ["unusable asset status", { status: "optimization_failed" }],
  ] as Array<[string, Json]>) {
    test(`${route} GET-ready ${label} cannot substitute for a full matched output asset`, async () => {
      const f = fixture({ assets: [readyAsset()], jobs: [readyJob()], fault: (q) =>
        q.table === "ad_creative_assets" && q.kind === "read" ? { data: readyAsset(patch) } : undefined });
      assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, "the raw SDK receipt must match the ready job's complete output identity");
    });
  }

  for (const [label, patch] of [
    ["private output bucket", { optimized_bucket: RAW_BUCKET, output_bucket: RAW_BUCKET }],
    ["malformed output path", { optimized_path: `optimized/${WORKSPACE}/../foreign.mp4`, output_path: `optimized/${WORKSPACE}/../foreign.mp4` }],
    ["foreign output path", { optimized_path: `optimized/${FOREIGN}/foreign.mp4`, output_path: `optimized/${FOREIGN}/foreign.mp4` }],
    ["wrong output MIME", { output_mime_type: "video/webm" }],
    ["empty output byte count", { output_size_bytes: 0, output_size: 0 }],
    ["malformed output URL", { optimized_public_url: "not a URL", output_public_url: "not a URL" }],
    ["foreign output origin", { optimized_public_url: READY_URL.replace(ORIGIN, "https://foreign.fixture.invalid"),
      output_public_url: READY_URL.replace(ORIGIN, "https://foreign.fixture.invalid") }],
    ["output URL query", { optimized_public_url: `${READY_URL}?token=synthetic`, output_public_url: `${READY_URL}?token=synthetic` }],
    ["missing thumbnail", { thumbnail_path: null, thumbnail_url: null, thumbnail_public_url: null }],
    ["wrong thumbnail extension", { thumbnail_path: READY_THUMB_PATH.replace(/\.jpg$/, ".png") }],
    ["foreign thumbnail path", { thumbnail_path: `optimized/${FOREIGN}/foreign.jpg` }],
    ["foreign thumbnail origin", { thumbnail_url: READY_THUMB_URL.replace(ORIGIN, "https://foreign.fixture.invalid"),
      thumbnail_public_url: READY_THUMB_URL.replace(ORIGIN, "https://foreign.fixture.invalid") }],
    ["conflicting output URL aliases", { output_public_url: READY_URL.replace(ORIGIN, "https://foreign.fixture.invalid") }],
    ["conflicting thumbnail URL aliases", { thumbnail_public_url: READY_THUMB_URL.replace(ORIGIN, "https://foreign.fixture.invalid") }],
  ] as Array<[string, Json]>) {
    test(`${route} GET-ready ${label} cannot escape as a usable output receipt`, async () => {
      const f = fixture({ assets: [readyAsset()], jobs: [readyJob(patch)] });
      assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, "every output URL exposed to the UI must name the validated own object");
    });
  }

  test(`${route} GET-ready transient asset lookup error remains private and unconfirmed`, async () => {
    const f = fixture({ assets: [readyAsset()], jobs: [readyJob()], fault: (q) =>
      q.table === "ad_creative_assets" && q.kind === "read" ? { data: null, error: { message: PRIVATE } } : undefined });
    assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, "transient asset lookup errors are not proof of a ready output");
  });
}

const readyOptionalAliases: Array<[string, unknown, unknown]> = [
  ["output_bucket", "ad-creatives", RAW_BUCKET],
  ["output_path", READY_PATH, `optimized/${WORKSPACE}/other.mp4`],
  ["outputSizeBytes", READY_SIZE, READY_SIZE + 1],
  ["optimizedSizeBytes", READY_SIZE, READY_SIZE + 1],
  ["optimized_size_bytes", READY_SIZE, READY_SIZE + 1],
  ["outputSize", READY_SIZE, READY_SIZE + 1],
  ["output_size", READY_SIZE, READY_SIZE + 1],
  ["outputMimeType", "video/mp4", "video/webm"],
  ["workspaceId", WORKSPACE, FOREIGN],
  ["assetId", ASSET, OTHER_ASSET],
  ["outputAssetId", ASSET, OTHER_ASSET],
  ["output_asset_id", ASSET, OTHER_ASSET],
];
for (const route of ["ticket", "processing"] as const) {
  for (const [alias, _matching, conflict] of readyOptionalAliases) {
    test(`${route} GET-ready conflicting ${alias} alias cannot override the verified output identity`, async () => {
      const f = fixture({ assets: [readyAsset()], jobs: [readyJob({ [alias]: conflict })] });
      assertUnconfirmedReady(await f.invoke(route, "GET", {}, JOB), f, `${alias} conflicts with the confirmed ready identity`);
    });
  }

  const nullAliases = Object.fromEntries(readyOptionalAliases.map(([alias]) => [alias, null]));
  for (const [label, patch] of [
    ["matching nonempty aliases", Object.fromEntries(readyOptionalAliases.map(([alias, matching]) => [alias, matching]))],
    ["null optional aliases", { ...nullAliases, outputPublicUrl: null, output_public_url: null, optimizedPublicUrl: null,
      thumbnailPublicUrl: null, thumbnail_public_url: null, thumbnailUrl: null }],
    ["null preferred storage aliases with confirmed fallbacks", { optimized_bucket: null, optimized_path: null,
      optimized_public_url: null, output_size_bytes: null, thumbnail_url: null }],
  ] as Array<[string, Json]>) {
    test(`${route} GET-ready ${label} preserve a full usable receipt`, async () => {
      const savedAsset = readyAsset(), savedJob = readyJob(patch);
      const f = fixture({ assets: [savedAsset], jobs: [savedJob] });
      const reply = await f.invoke(route, "GET", {}, JOB);
      assert.equal(reply.status, 200);
      const returned = assertJobReceipt(reply, f);
      assert.equal(returned.status, "ready");
      assert.equal(returned.workspaceId, WORKSPACE);
      assert.equal(returned.assetId, ASSET);
      assert.equal(returned.outputAssetId, ASSET);
      assert.equal(returned.outputFileName, READY_NAME);
      assert.equal(returned.outputStorageBucket, "ad-creatives");
      assert.equal(returned.outputStoragePath, READY_PATH);
      assert.equal(returned.outputMimeType, "video/mp4");
      assert.equal(returned.outputSize, READY_SIZE);
      assert.equal(returned.outputSizeBytes, READY_SIZE);
      assert.equal(returned.outputPublicUrl, READY_URL);
      assert.equal(returned.optimizedPublicUrl, READY_URL);
      assert.equal(returned.thumbnailPublicUrl, READY_THUMB_URL);
      assert.equal(returned.thumbnailUrl, READY_THUMB_URL);
      assertReadyReadOnly(f);
      assert.deepEqual(f.assets, [savedAsset]);
      assert.deepEqual(f.jobs, [savedJob]);
    });
  }
}

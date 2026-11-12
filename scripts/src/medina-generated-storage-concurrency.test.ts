import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const SERVER = "lib/crm/server.ts";
const IDENTITY = "lib/crm/generated-identity.ts";
const VERIFICATION = "lib/crm/generated-storage-verification.ts";
const scripts = new Map<string, Script>();

function compile(source: string, filename: string) {
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.deepEqual(result.diagnostics ?? [], [], `Actual ${filename} must transpile`);
  return new Script(result.outputText, { filename });
}

// Whole actual store/helper declarations, including real persistence and mapper.
// Only unrelated entries in the large CRM config registry are excluded.
const serverSource = await readFile(path.join(root, SERVER), "utf8");
const ast = ts.createSourceFile(SERVER, serverSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = new Map<string, import("typescript").Statement>();
for (const statement of ast.statements) {
  if (ts.isImportDeclaration(statement)) {
    if (statement.importClause?.name) declarations.set(statement.importClause.name.text, statement);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) declarations.set(binding.name.text, statement);
    }
  } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    declarations.set(statement.name.text, statement);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
    }
  }
}
const configStatement = declarations.get("configs");
assert.ok(configStatement && ts.isVariableStatement(configStatement));
const registry = configStatement.declarationList.declarations.find((declaration) =>
  ts.isIdentifier(declaration.name) && declaration.name.text === "configs")?.initializer;
assert.ok(registry && ts.isObjectLiteralExpression(registry));
const creativeEntries = registry.properties.filter((property) => ts.isPropertyAssignment(property)
  && ts.isStringLiteral(property.name) && property.name.text === "ad-creatives");
assert.equal(creativeEntries.length, 1);
const creativeEntry = creativeEntries[0]!;
const selected = new Set<import("typescript").Statement>();
function include(name: string) {
  const declaration = declarations.get(name);
  assert.ok(declaration, `Missing actual ${SERVER}:${name}`);
  if (selected.has(declaration)) return;
  selected.add(declaration);
  if (ts.isImportDeclaration(declaration)) return;
  const visit = (node: import("typescript").Node) => {
    if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
    ts.forEachChild(node, visit);
  };
  visit(name === "configs" ? creativeEntry : declaration);
}
include("storeGeneratedCreative");
scripts.set(SERVER, compile([
  ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement === configStatement
    ? `const configs = { ${creativeEntry.getText(ast)} };` : statement.getText(ast)),
  "exports.actualStore = storeGeneratedCreative;",
].join("\n"), SERVER));
for (const file of [IDENTITY, VERIFICATION]) scripts.set(file, compile(await readFile(path.join(root, file), "utf8"), file));

type Json = Record<string, any>;
type StoreInput = {
  workspaceId: string; fileName: string; mimeType: string; buffer: Buffer;
  idempotencyKey?: string; metadata?: Json;
};
type Stored = { publicUrl: string; asset: Json; mode: string; warning: string };
type Identity = { assetId: string; fileName: string; storagePath: string; keyDigest: string };
type Query = { actor: string; kind: "read" | "insert"; filters: Array<[string, unknown]>; row?: Json; limit?: number; range?: [number, number]; count: boolean };
type DbResult = { data: unknown; error: unknown; count?: number | null };
type Fault = "throw" | "error" | "malformed" | "before-commit";
type ProofFault = "wrong-type" | "wrong-length" | "redirect" | "oversize" | "short-stream" | "fetch-timeout" | "read-timeout" | "no-body" | "no-length";
type HttpCall = { actor: string; url: string; init: RequestInit; reads: number; canceled: boolean; arrayBuffers: number };
type Options = {
  raceUploads?: boolean; uploadFault?: Fault; insertFault?: Fault; proofFault?: ProofFault;
  readError?: string; projectRead?: (rows: Json[], query: Query) => Json[];
};

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "synthetic-video-job-42";
const ORIGIN = "https://own-generated-storage.invalid";
const PRIVATE_DETAIL = "synthetic-private-backend-detail";
const BYTES = Buffer.from("synthetic-generated-image-content-A");
const DIFFERENT_BYTES = Buffer.from("synthetic-generated-image-content-B");
const clone = <T,>(value: T): T => structuredClone(value);
const sha256 = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const ownUrl = (storagePath: string) => `${ORIGIN}/storage/v1/object/public/ad-creatives/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
function input(patch: Partial<StoreInput> = {}): StoreInput {
  return { workspaceId: WORKSPACE, idempotencyKey: KEY, fileName: "incoming-one.png", mimeType: "image/png",
    buffer: Buffer.from(BYTES), metadata: { kind: "generated-photo", source: "content-studio" }, ...patch };
}

class SharedBackend {
  readonly objects = new Map<string, { buffer: Buffer; mimeType: string }>();
  readonly rows = new Map<string, Json>();
  readonly uploads: Array<{ actor: string; bucket: string; path: string; buffer: Buffer; options: Json }> = [];
  readonly inserts: Query[] = [];
  readonly reads: Query[] = [];
  readonly http: HttpCall[] = [];
  readonly removals: unknown[] = [];
  readonly violations: string[] = [];
  readonly timerDelays: number[] = [];
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  objectCommits = 0;
  rowCommits = 0;
  private arrivals = 0;
  private releaseRace!: () => void;
  private readonly uploadRace = new Promise<void>((resolve) => { this.releaseRace = resolve; });
  private usedUploadFault = false;
  private usedInsertFault = false;
  constructor(readonly options: Options = {}) {}

  fail(message: string): never { this.violations.push(message); throw new Error(message); }
  setTimer = (callback: () => void, milliseconds: number) => {
    this.timerDelays.push(milliseconds);
    const accelerated = this.options.proofFault === "fetch-timeout" || this.options.proofFault === "read-timeout";
    const handle = setTimeout(() => { this.timers.delete(handle); callback(); }, accelerated ? 15 : milliseconds);
    this.timers.add(handle);
    // Keep the synthetic deadline referenced so an intentionally stuck read can
    // finish its timeout test; the production helper still requests 10 seconds.
    return { handle, unref() {} };
  };
  clearTimer = (timer: { handle: ReturnType<typeof setTimeout> }) => {
    clearTimeout(timer.handle); this.timers.delete(timer.handle);
  };

  sdk(actor: string) {
    return {
      storage: { from: (bucket: string) => ({
        getPublicUrl: (storagePath: string) => ({ data: { publicUrl: ownUrl(storagePath) } }),
        upload: async (storagePath: string, buffer: Buffer, options: Json) => {
          if (bucket !== "ad-creatives") return this.fail(`Unexpected Storage bucket ${bucket}`);
          this.uploads.push({ actor, bucket, path: storagePath, buffer: Buffer.from(buffer), options: clone(options) });
          if (this.options.raceUploads) {
            if (++this.arrivals === 2) this.releaseRace();
            await this.uploadRace;
          }
          const key = `${bucket}/${storagePath}`;
          if (this.objects.has(key)) return { data: null, error: { statusCode: "409", message: PRIVATE_DETAIL } };
          const fault = !this.usedUploadFault ? this.options.uploadFault : undefined;
          this.usedUploadFault = true;
          if (fault === "before-commit") return { data: null, error: { statusCode: "503", message: PRIVATE_DETAIL } };
          // Atomic create-only backend operation. Never emulate an overwrite,
          // even if the target accidentally requests one; assert the flag later.
          this.objects.set(key, { buffer: Buffer.from(buffer), mimeType: String(options.contentType) });
          this.objectCommits++;
          if (fault === "throw") throw new Error(PRIVATE_DETAIL);
          if (fault === "error") return { data: null, error: { statusCode: "502", message: PRIVATE_DETAIL } };
          if (fault === "malformed") return { data: {}, error: null };
          return { data: { path: storagePath }, error: null };
        },
        remove: async (paths: unknown) => {
          this.removals.push({ actor, bucket, paths: clone(paths) });
          return { data: null, error: null };
        },
      }) },
      from: (table: string) => {
        if (table !== "ad_creative_assets") return this.fail(`Unexpected DB table ${table}`);
        const query: Query = { actor, kind: "read", filters: [], count: false };
        let executed = false;
        const execute = async (single: boolean): Promise<DbResult> => {
          if (executed) return this.fail("Each fake SDK query must execute once");
          executed = true;
          if (query.kind === "insert") {
            this.inserts.push(clone(query));
            const raw = { id: crypto.randomUUID(), created_at: "2026-10-25T00:00:00Z", ...clone(query.row) };
            const id = String(raw.id);
            if (this.rows.has(id)) return { data: null, error: { code: "23505", message: PRIVATE_DETAIL } };
            const fault = !this.usedInsertFault ? this.options.insertFault : undefined;
            this.usedInsertFault = true;
            if (fault === "before-commit") return { data: null, error: { code: "XX000", message: PRIVATE_DETAIL } };
            this.rows.set(id, raw);
            this.rowCommits++;
            if (fault === "throw") throw new Error(PRIVATE_DETAIL);
            if (fault === "error") return { data: null, error: { code: "XX000", message: PRIVATE_DETAIL } };
            if (fault === "malformed") return { data: {}, error: null };
            return { data: clone(raw), error: null };
          }
          this.reads.push(clone(query));
          if (this.options.readError) return { data: null, error: { code: this.options.readError, message: PRIVATE_DETAIL } };
          let rows = [...this.rows.values()].filter((row) => query.filters.every(([column, value]) => row[column] === value)).map(clone);
          const count = rows.length;
          if (this.options.projectRead) rows = this.options.projectRead(rows, clone(query));
          if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
          if (query.limit !== undefined) rows = rows.slice(0, query.limit);
          if (single && rows.length > 1) return { data: null, error: { code: "PGRST116", message: PRIVATE_DETAIL } };
          return { data: single ? rows[0] ?? null : rows, error: null, count: query.count ? count : null };
        };
        const builder = {
          select: (_columns: string, options?: Json) => { query.count = options?.count === "exact"; return builder; },
          eq: (column: string, value: unknown) => { query.filters.push([column, value]); return builder; },
          limit: (limit: number) => { query.limit = limit; return builder; },
          range: (start: number, end: number) => { query.range = [start, end]; return builder; },
          insert: (row: Json) => { query.kind = "insert"; query.row = clone(row); return builder; },
          single: () => execute(true), maybeSingle: () => execute(true),
          then: (resolve: (value: DbResult) => unknown, reject: (error: unknown) => unknown) => execute(false).then(resolve, reject),
        };
        return builder;
      },
    };
  }

  fetch = async (actor: string, address: string, init: RequestInit = {}) => {
    const url = new URL(address);
    const prefix = "/storage/v1/object/public/ad-creatives/";
    if (url.origin !== ORIGIN || !url.pathname.startsWith(`${prefix}${WORKSPACE}/`)
      || url.search || url.hash || url.username || url.password) return this.fail(`Non-own-Storage fetch: ${address}`);
    const storagePath = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (address !== ownUrl(storagePath)) return this.fail("Storage proof must use the exact server-derived URL");
    const call: HttpCall = { actor, url: address, init, reads: 0, canceled: false, arrayBuffers: 0 };
    this.http.push(call);
    const fault = this.options.proofFault;
    if (fault === "fetch-timeout") return new Promise<never>(() => {});
    const object = this.objects.get(`ad-creatives/${storagePath}`);
    let bytes = object?.buffer ?? Buffer.alloc(0);
    if (fault === "oversize") bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (fault === "short-stream") bytes = bytes.subarray(0, Math.max(0, bytes.length - 1));
    const headers = new Headers({ "content-type": fault === "wrong-type" ? "image/jpeg" : object?.mimeType ?? "image/png" });
    if (!["oversize", "short-stream", "no-length"].includes(fault ?? "")) {
      headers.set("content-length", String(bytes.length + (fault === "wrong-length" ? 1 : 0)));
    }
    let offset = 0;
    return {
      status: object ? 200 : 404, redirected: fault === "redirect", headers,
      body: fault === "no-body" ? null : {
        getReader: () => ({
          read: async () => {
            call.reads++;
            if (fault === "read-timeout") return new Promise<never>(() => {});
            if (offset === bytes.length) return { done: true, value: undefined };
            const value = bytes.subarray(offset, Math.min(offset + 7, bytes.length));
            offset += value.length;
            return { done: false, value };
          },
          cancel: async () => { call.canceled = true; },
        }),
      },
      arrayBuffer: async () => { call.arrayBuffers++; return this.fail("Storage proof must hash a bounded stream, not arrayBuffer()"); },
    };
  };
}

function instance(backend: SharedBackend, actor: string, now: string) {
  const cache = new Map<string, Json>();
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return Date.parse(now); }
  }
  class FakeImageDecoderUnavailable extends Error {}
  const decoder = { CreativeImageValidationUnavailable: FakeImageDecoderUnavailable,
    // Intentional decoder test double: these are storage/receipt/hash tests.
    validateCreativeImageBytes: async () => [] };
  function load(file: string): Json {
    const cached = cache.get(file);
    if (cached) return cached;
    const exports: Json = {};
    cache.set(file, exports);
    const require = (name: string) => {
      if (name === "node:crypto") return crypto;
      if (name === "./generated-identity") return load(IDENTITY);
      if (name === "./generated-storage-verification") return load(VERIFICATION);
      if (name === "../supabase/server") return { getSupabaseServerClient: () => backend.sdk(actor) };
      if (name === "./creative-image") return decoder;
      return backend.fail(`Unexpected actual helper import from ${file}: ${name}`);
    };
    scripts.get(file)!.runInNewContext({
      exports, require, Buffer, Error, Date: FixedDate, URL, Headers, AbortController,
      process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: ORIGIN, VITE_SUPABASE_URL: "" }) }),
      fetch: (address: string, init: RequestInit) => backend.fetch(actor, address, init),
      setTimeout: backend.setTimer, clearTimeout: backend.clearTimer,
      console: { warn() {}, error() {} },
    }, { timeout: 1000 });
    return exports;
  }
  const identity = load(IDENTITY).generatedCreativeIdentity as (value: StoreInput) => Identity;
  const store = load(SERVER).actualStore as (value: StoreInput) => Promise<Stored>;
  assert.equal(typeof store, "function");
  assert.equal(typeof identity, "function");
  return { identity, store };
}

function fixture(options: Options = {}) {
  const backend = new SharedBackend(options);
  // Distinct evaluations and clocks, not two closures sharing module state.
  const first = instance(backend, "A", "2026-10-31T23:59:59.000Z");
  const second = instance(backend, "B", "2026-11-01T00:00:01.000Z");
  return { backend, first, second, identity: first.identity(input()) };
}

function seed(f: ReturnType<typeof fixture>, patch: Json = {}) {
  const identity = f.identity;
  const raw: Json = {
    id: identity.assetId, workspace_id: WORKSPACE, file_name: identity.fileName,
    file_type: "image", mime_type: "image/png", file_size: BYTES.length,
    storage_bucket: "ad-creatives", storage_path: identity.storagePath, public_url: ownUrl(identity.storagePath),
    generated_key: `v1:${KEY}`, generated_sha256: sha256(BYTES), status: "uploaded",
    metadata: { source: "content-studio", kind: "generated-photo", jobId: KEY, uploadMode: "ai-generated" },
    created_at: "2026-10-31T23:59:59Z", updated_at: "2026-10-31T23:59:59Z", ...patch,
  };
  f.backend.rows.set(String(raw.id), raw);
  f.backend.objects.set(`ad-creatives/${raw.storage_path}`, { buffer: Buffer.from(BYTES), mimeType: "image/png" });
  return raw;
}

function assertSaved(value: Stored, identity: Identity, bytes = BYTES) {
  assert.equal(value.mode, "supabase");
  assert.equal(value.warning, "");
  assert.equal(value.asset.id, identity.assetId);
  assert.equal(value.asset.workspaceId, WORKSPACE);
  assert.equal(value.asset.fileName, identity.fileName);
  assert.equal(value.asset.storagePath, identity.storagePath);
  assert.equal(value.asset.storageBucket, "ad-creatives");
  assert.equal(value.asset.mimeType, "image/png");
  assert.equal(value.asset.fileSize, bytes.length);
  assert.equal(value.publicUrl, ownUrl(identity.storagePath));
  assert.equal(value.asset.publicUrl, value.publicUrl);
}

async function assertRefused(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message);
    assert.equal(error.message.includes(PRIVATE_DETAIL), false);
    return true;
  });
}

function assertBoundaries(backend: SharedBackend) {
  assert.deepEqual(backend.violations, []);
  assert.deepEqual(backend.removals, [], "Never delete an ambiguous or previously existing object");
  assert.equal(backend.timers.size, 0, "The actual proof helper must clear its deadline");
  for (const upload of backend.uploads) assert.equal(upload.options.upsert, false, "Every generated upload is create-only");
  for (const read of backend.reads) {
    assert.ok(read.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE), "Every DB lookup is tenant-scoped");
  }
  for (const call of backend.http) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal);
    assert.equal(call.init.signal.aborted, true);
    assert.equal(call.arrayBuffers, 0);
  }
  for (const delay of backend.timerDelays) assert.equal(delay, 10_000, "Production verification has one 10-second total deadline");
}

test("two independent modules racing one key across dates and incoming names store one object and one deterministic row", { timeout: 5000 }, async () => {
  const f = fixture({ raceUploads: true });
  const values = await Promise.all([
    f.first.store(input({ fileName: "old-incoming-name.png", metadata: { uploadMode: "spoofed", generationKey: "spoofed", contentSha256: "spoofed", jobId: "spoofed" } })),
    f.second.store(input({ fileName: "different-incoming-name.png" })),
  ]);
  for (const value of values) assertSaved(value, f.identity);
  assert.equal(f.backend.uploads.length, 2, "Both independent requests reached the create-only collision");
  assert.equal(f.backend.objectCommits, 1);
  assert.equal(f.backend.rowCommits, 1);
  assert.equal(f.backend.objects.size, 1);
  assert.equal(f.backend.rows.size, 1);
  assert.ok(f.backend.http.length >= 1, "A collided upload must be proven by streamed own-Storage bytes");
  assert.match(f.identity.assetId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const raw = [...f.backend.rows.values()][0]!;
  assert.equal(raw.id, f.identity.assetId);
  assert.equal(raw.generated_key, `v1:${KEY}`);
  assert.equal(raw.generated_sha256, sha256(BYTES));
  assert.equal(raw.metadata.uploadMode, "ai-generated");
  assert.equal(raw.metadata.generationKey, f.identity.keyDigest);
  assert.equal(raw.metadata.contentSha256, sha256(BYTES));
  assert.equal(raw.metadata.jobId, "spoofed", "Image-only caller metadata cannot replace immutable generated key/hash columns");
  assertBoundaries(f.backend);
});

test("concurrent same-key different bytes has one winner and never overwrites its object", { timeout: 5000 }, async () => {
  const f = fixture({ raceUploads: true });
  const values = await Promise.allSettled([f.first.store(input()), f.second.store(input({ fileName: "another.png", buffer: DIFFERENT_BYTES }))]);
  assert.equal(values.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(values.filter((value) => value.status === "rejected").length, 1);
  const winnerIndex = values.findIndex((value) => value.status === "fulfilled");
  const winnerBytes = winnerIndex === 0 ? BYTES : DIFFERENT_BYTES;
  assert.equal(f.backend.objectCommits, 1);
  assert.equal(f.backend.rowCommits, 1);
  assert.deepEqual([...f.backend.objects.values()][0]!.buffer, winnerBytes);
  assert.equal([...f.backend.rows.values()][0]!.generated_sha256, sha256(winnerBytes));
  assertBoundaries(f.backend);
});

test("replay survives metadata being overwritten by Meta because private key and hash columns remain authoritative", async () => {
  const f = fixture();
  seed(f, { metadata: { changedBy: "synthetic-meta-updater" } });
  assertSaved(await f.second.store(input({ fileName: "new-day-name.png" })), f.identity);
  assert.equal(f.backend.http.length, 1);
  assert.deepEqual(f.backend.uploads, []);
  assert.deepEqual(f.backend.inserts, []);
  assertBoundaries(f.backend);
});

test("missing or different bytes behind a matching existing row refuse before any writes", async (t) => {
  for (const missing of [false, true]) {
    await t.test(missing ? "missing object" : "same-length wrong bytes", async () => {
      const f = fixture();
      seed(f);
      const key = `ad-creatives/${f.identity.storagePath}`;
      if (missing) f.backend.objects.delete(key);
      else f.backend.objects.set(key, { buffer: Buffer.from(DIFFERENT_BYTES), mimeType: "image/png" });
      await assertRefused(f.second.store(input({ fileName: "retry.png" })));
      assert.equal(f.backend.http.length, 1);
      assert.deepEqual(f.backend.uploads, []);
      assert.deepEqual(f.backend.inserts, []);
      assert.equal(f.backend.rows.size, 1);
      if (!missing) assert.deepEqual(f.backend.objects.get(key)!.buffer, DIFFERENT_BYTES);
      assertBoundaries(f.backend);
    });
  }
});

test("canonical raw keyed receipts cannot hide foreign identity or absent/wrong durable hash columns", async (t) => {
  for (const [label, patch] of [
    ["foreign tenant", { workspace_id: FOREIGN }], ["wrong id", { id: "11111111-1111-4111-8111-111111111111" }],
    ["missing generated key", { generated_key: undefined }], ["wrong generated key", { generated_key: "v1:other-job" }],
    ["missing hash", { generated_sha256: undefined }], ["null hash on canonical path", { generated_sha256: null }],
    ["wrong hash", { generated_sha256: sha256(DIFFERENT_BYTES) }],
    ["foreign path", { storage_path: `${FOREIGN}/generated/other` }], ["foreign URL", { public_url: `${ORIGIN}/foreign` }],
  ] as Array<[string, Json]>) {
    await t.test(label, async () => {
      const f = fixture({ projectRead: (rows) => rows.map((row) => ({ ...row, ...patch })) });
      seed(f);
      await assertRefused(f.second.store(input()));
      assert.deepEqual(f.backend.uploads, []);
      assert.deepEqual(f.backend.inserts, []);
      assertBoundaries(f.backend);
    });
  }
});

test("old-schema lookup errors cannot mean absent and must fail before Storage upload", async (t) => {
  for (const readError of ["42703", "PGRST204", "XX000"]) {
    await t.test(readError, async () => {
      const f = fixture({ readError });
      await assertRefused(f.first.store(input()));
      assert.deepEqual(f.backend.uploads, []);
      assert.deepEqual(f.backend.inserts, []);
      assert.ok(f.backend.reads[0]!.filters.some(([key, value]) => key === "generated_key" && value === `v1:${KEY}`));
      assertBoundaries(f.backend);
    });
  }
});

test("upload committed but response lost recovers by streaming exact bytes and supports a free next-day retry", async (t) => {
  for (const uploadFault of ["throw", "error", "malformed"] as const) {
    await t.test(uploadFault, async () => {
      const f = fixture({ uploadFault });
      assertSaved(await f.first.store(input()), f.identity);
      assertSaved(await f.second.store(input({ fileName: "retry-name.png" })), f.identity);
      assert.equal(f.backend.objectCommits, 1);
      assert.equal(f.backend.rowCommits, 1);
      assert.equal(f.backend.uploads.length, 1);
      assert.ok(f.backend.http.length >= 2);
      assertBoundaries(f.backend);
    });
  }
});

test("failed uncommitted upload cannot fake a saved row, but a retry may create it without regeneration", async () => {
  const f = fixture({ uploadFault: "before-commit" });
  await assertRefused(f.first.store(input()));
  assert.equal(f.backend.objects.size, 0);
  assert.equal(f.backend.rows.size, 0);
  assert.deepEqual(f.backend.inserts, []);
  assert.equal(f.backend.http.length, 1);
  assertSaved(await f.second.store(input({ fileName: "free-retry.png" })), f.identity);
  assert.equal(f.backend.objectCommits, 1);
  assert.equal(f.backend.rowCommits, 1);
  assertBoundaries(f.backend);
});

test("DB insert committed but response lost reconciles its exact matching deterministic row", async (t) => {
  for (const insertFault of ["throw", "error", "malformed"] as const) {
    await t.test(insertFault, async () => {
      const f = fixture({ insertFault });
      assertSaved(await f.first.store(input()), f.identity);
      assertSaved(await f.second.store(input({ fileName: "free-retry.png" })), f.identity);
      assert.equal(f.backend.objectCommits, 1);
      assert.equal(f.backend.rowCommits, 1);
      assert.equal(f.backend.inserts.length, 1);
      assert.ok(f.backend.reads.length >= 3);
      assertBoundaries(f.backend);
    });
  }
});

test("DB failure without commit is not success, and retry reconciles the orphan object without overwriting it", async () => {
  const f = fixture({ insertFault: "before-commit" });
  await assertRefused(f.first.store(input()));
  assert.equal(f.backend.objects.size, 1);
  assert.equal(f.backend.rows.size, 0);
  assertSaved(await f.second.store(input({ fileName: "free-retry.png" })), f.identity);
  assert.equal(f.backend.objectCommits, 1);
  assert.equal(f.backend.rowCommits, 1);
  assert.ok(f.backend.http.length >= 1);
  assertBoundaries(f.backend);
});

test("an orphan object with wrong bytes cannot be reconciled into a new DB row after a create-only collision", async () => {
  const f = fixture();
  const key = `ad-creatives/${f.identity.storagePath}`;
  f.backend.objects.set(key, { buffer: Buffer.from(DIFFERENT_BYTES), mimeType: "image/png" });
  await assertRefused(f.first.store(input()));
  assert.equal(f.backend.uploads.length, 1, "Exercise create-only collision recovery, not an existing-row fast path");
  assert.equal(f.backend.http.length, 1);
  assert.deepEqual(f.backend.inserts, [], "Neither a collision nor matching size establishes byte identity");
  assert.equal(f.backend.rows.size, 0);
  assert.deepEqual(f.backend.objects.get(key)!.buffer, DIFFERENT_BYTES);
  assertBoundaries(f.backend);
});

test("a DB error cannot reconcile success from a foreign or mismatched raw readback", async () => {
  const f = fixture({ insertFault: "error", projectRead: (rows) => rows.map((row) => ({ ...row, generated_sha256: sha256(DIFFERENT_BYTES) })) });
  await assertRefused(f.first.store(input()));
  assert.equal(f.backend.objectCommits, 1);
  assert.equal(f.backend.rowCommits, 1);
  assert.equal(f.backend.inserts.length, 1);
  assertBoundaries(f.backend);
});

test("actual streamed proof rejects wrong type/length, redirects, oversize, missing body and stalled fetch/read", async (t) => {
  for (const proofFault of ["wrong-type", "wrong-length", "redirect", "oversize", "short-stream", "no-body", "fetch-timeout", "read-timeout"] as const) {
    await t.test(proofFault, { timeout: 2000 }, async () => {
      const f = fixture({ proofFault });
      seed(f);
      await assertRefused(f.second.store(input()));
      assert.deepEqual(f.backend.uploads, []);
      assert.deepEqual(f.backend.inserts, []);
      assert.equal(f.backend.http.length, 1);
      assert.equal(f.backend.timerDelays.length, 1);
      assertBoundaries(f.backend);
    });
  }
});

test("stream proof accepts absent Content-Length only after exact bounded byte count and SHA-256", async () => {
  const f = fixture({ proofFault: "no-length" });
  seed(f);
  assertSaved(await f.second.store(input()), f.identity);
  assert.ok(f.backend.http[0]!.reads > 2, "Digest must cover streamed chunks, not a metadata-only check");
  assert.equal(f.backend.http[0]!.canceled, true);
  assertBoundaries(f.backend);
});

test("the direct generated writer refuses every video type before any SDK or public object access", async () => {
  const f = fixture();
  for (const mimeType of ["video/mp4", "video/quicktime", "video/webm"]) {
    await assert.rejects(f.first.store(input({ mimeType, fileName: "unvalidated.mp4" })), /generated_video_native_validation_required/);
  }
  assert.deepEqual(f.backend.reads, []); assert.deepEqual(f.backend.uploads, []); assert.deepEqual(f.backend.inserts, []);
  assert.equal(f.backend.http.length, 0); assertBoundaries(f.backend);
});


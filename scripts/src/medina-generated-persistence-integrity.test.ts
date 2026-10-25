import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.find((argument) => argument.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "b301f1f", "Only the reviewed local baseline is supported");
const sourcePath = "lib/crm/server.ts";
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${sourcePath}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, sourcePath), "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Keep whole actual declarations and their local dependencies. Narrow only the
// config registry to its unchanged ad-creatives entry, not a replacement mapper.
const declarations = new Map<string, import("typescript").Statement>();
for (const statement of ast.statements) {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    declarations.set(statement.name.text, statement);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
    }
  }
}
const configStatement = declarations.get("configs");
assert.ok(configStatement && ts.isVariableStatement(configStatement));
const configInitializer = configStatement.declarationList.declarations.find((declaration) =>
  ts.isIdentifier(declaration.name) && declaration.name.text === "configs")?.initializer;
assert.ok(configInitializer && ts.isObjectLiteralExpression(configInitializer));
const creativeConfigs = configInitializer.properties.filter((property) => ts.isPropertyAssignment(property)
  && ts.isStringLiteral(property.name) && property.name.text === "ad-creatives");
assert.equal(creativeConfigs.length, 1, "Select the actual ad-creatives config exactly once");
const creativeConfig = creativeConfigs[0]!;
const selected = new Set<import("typescript").Statement>();
function include(name: string) {
  const declaration = declarations.get(name);
  assert.ok(declaration, `Actual ${sourcePath}:${name} must exist`);
  if (selected.has(declaration)) return;
  selected.add(declaration);
  const visit = (node: import("typescript").Node) => {
    if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
    ts.forEachChild(node, visit);
  };
  visit(name === "configs" ? creativeConfig : declaration);
}
include("storeGeneratedCreative");
const allowedModules = new Map([
  ["./generated-identity", "lib/crm/generated-identity.ts"],
  ["./generated-storage-verification", "lib/crm/generated-storage-verification.ts"],
]);
const used = new Set<string>();
for (const statement of selected) {
  const visit = (node: import("typescript").Node) => {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(statement === configStatement ? creativeConfig : statement);
}
const imports = ast.statements.filter(ts.isImportDeclaration).flatMap(statement => {
  if (!ts.isStringLiteral(statement.moduleSpecifier) || !allowedModules.has(statement.moduleSpecifier.text)) return [];
  const bindings = statement.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings), "Pure generated helpers must use explicit named imports");
  const names = bindings.elements.filter(binding => used.has(binding.name.text));
  return names.length ? [`import { ${names.map(binding => binding.getText(ast)).join(", ")} } from ${JSON.stringify(statement.moduleSpecifier.text)};`] : [];
});
const compiled = ts.transpileModule([
  ...imports,
  ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement === configStatement
    ? `const configs = { ${creativeConfig.getText(ast)} };` : statement.getText(ast)),
  "exports.actual = { storeGeneratedCreative };",
].join("\n"), {
  fileName: "generated-persistence-integrity.actual.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compiled.diagnostics ?? [], [], "Actual storage and persistence code must transpile");
const script = new Script(compiled.outputText, { filename: `${baseline ?? "working-tree"}:${sourcePath}:storeGeneratedCreative` });

type Json = Record<string, unknown>;
type Result = { data: unknown; error: unknown; count?: number | null };
type Query = {
  table: string;
  kind: "lookup" | "insert";
  filters: Array<[string, unknown]>;
  selections: unknown[][];
  row?: Json;
  limit?: number;
  range?: [number, number];
  terminal?: "single" | "maybeSingle" | "list";
};
type Stored = { publicUrl: string; asset: Json; mode: string; warning: string };
type StoreInput = {
  workspaceId: string; fileName: string; mimeType: string; buffer: Buffer;
  metadata?: Json; idempotencyKey?: string;
};
type Outcome = { value: Stored; error?: undefined } | { value?: undefined; error: unknown };
type Options = {
  lookup?: (query: Query) => Result | Promise<Result>;
  insert?: (query: Query) => Result | Promise<Result>;
  upload?: (upload: RecordingSdk["uploads"][number]) => Result | Promise<Result>;
  fetch?: (url: string, init: RequestInit) => unknown | Promise<unknown>;
  now?: string;
  expireDeadline?: boolean;
};

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const SECOND_ASSET = "44444444-4444-4444-8444-444444444444";
const STAMP = "2026-10-25T12:00:00.000Z";
const ORIGIN = "https://generated-storage.invalid";
const PRIVATE_DETAIL = "synthetic-private-persistence-detail";
const KEY = "synthetic-render-1", GENERATED_KEY = `v1:${KEY}`;
// Fixed independent contract vector, not output obtained from the helper under test.
const DIGEST = "8fb7bdc82870eb03a5941acd76ea41f29fa1fbe1869b4d7ba8ec3ad8a5644043";
const CANONICAL_ID = "fda70de5-673d-57ed-8cfd-7aa74a193832";
const CANONICAL_PATH = `${WORKSPACE}/generated/${DIGEST}`;
const CANONICAL_NAME = `negis-image-${DIGEST.slice(0, 20)}.jpg`;
// A real, fixed 2x2 JPEG fixture. The decoder below is deliberately synthetic:
// these tests prove persistence receipts, not JPEG decoding or byte validation.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=",
  "base64",
);
const clone = <T,>(value: T): T => structuredClone(value);
const publicUrl = (storagePath: string) => `${ORIGIN}/storage/v1/object/public/ad-creatives/${storagePath}`;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = sha256(JPEG);

function input(patch: Partial<StoreInput> = {}): StoreInput {
  return { workspaceId: WORKSPACE, fileName: "generated.jpg", mimeType: "image/jpeg",
    buffer: Buffer.from(JPEG), metadata: { source: "synthetic-generation" }, ...patch };
}

function lookupPath(query: Query): string {
  assert.ok(query.filters.some(([column, value]) => column === "workspace_id" && value === WORKSPACE), "Key lookup must be tenant scoped");
  assert.ok(query.filters.some(([column, value]) => column === "generated_key" && value === GENERATED_KEY), "Use the private exact key column, not mutable metadata or a date-based path");
  return CANONICAL_PATH;
}

function row(storagePath: string, patch: Json = {}): Json {
  return {
    id: ASSET, workspace_id: WORKSPACE, launch_id: null, uploaded_by: null,
    file_name: "generated.jpg", file_type: "image", mime_type: "image/jpeg", file_size: JPEG.length,
    storage_bucket: "ad-creatives", storage_path: storagePath, public_url: publicUrl(storagePath),
    meta_asset_id: null, meta_video_id: null, status: "uploaded",
    generated_key: storagePath === CANONICAL_PATH ? GENERATED_KEY : null,
    generated_sha256: storagePath === CANONICAL_PATH ? HASH : null,
    metadata: { source: "synthetic-generation", uploadMode: "ai-generated", contentSha256: HASH },
    ...(storagePath === CANONICAL_PATH ? { id: CANONICAL_ID, file_name: CANONICAL_NAME } : {}),
    created_at: STAMP, updated_at: STAMP, ...patch,
  };
}

class RecordingSdk {
  queries: Query[] = [];
  insertAttempts: Json[] = [];
  uploads: Array<{ bucket: string; path: string; buffer: Buffer; options: Json }> = [];
  removals: Array<{ bucket: string; paths: string[] }> = [];
  violations: string[] = [];
  constructor(private options: Options) {}
  storage = {
    from: (bucket: string) => ({
      upload: async (storagePath: string, buffer: Buffer, options: Json) => {
        const upload = { bucket, path: storagePath, buffer: Buffer.from(buffer), options: clone(options) };
        this.uploads.push(upload);
        if (this.options.upload) return this.options.upload(upload);
        return { data: { path: storagePath }, error: null };
      },
      getPublicUrl: (storagePath: string) => ({ data: { publicUrl: publicUrl(storagePath) } }),
      remove: async (paths: string[]) => {
        this.removals.push({ bucket, paths: clone(paths) });
        return { data: null, error: null };
      },
    }),
  };
  from(table: string) {
    if (table !== "ad_creative_assets") {
      this.violations.push(`Unexpected table: ${table}`);
      throw new Error(`Unexpected table: ${table}`);
    }
    const query: Query = { table, kind: "lookup", filters: [], selections: [] };
    let executed = false;
    const execute = async (terminal: Query["terminal"]): Promise<Result> => {
      assert.equal(executed, false, "Each SDK query executes once");
      executed = true;
      query.terminal = terminal;
      this.queries.push(clone(query));
      if (query.kind === "insert") {
        if (this.options.insert) return this.options.insert(clone(query));
        // An SDK INSERT receipt, not a replacement for the actual toRow/fromRow.
        return { data: { id: ASSET, created_at: STAMP, ...clone(query.row) }, error: null };
      }
      let result: Result;
      try { result = this.options.lookup ? await this.options.lookup(clone(query)) : { data: [], error: null }; }
      catch (error) {
        if (error instanceof assert.AssertionError) this.violations.push(error.message);
        throw error;
      }
      if (result.error || !Array.isArray(result.data)) return result;
      const allRows = clone(result.data);
      let data = query.range ? allRows.slice(query.range[0], query.range[1] + 1) : allRows;
      // Honor the SDK cap so limit(1) really hides the second existing row. The
      // store itself must obtain cardinality proof; the fake must not invent it.
      if (query.limit !== undefined) data = data.slice(0, query.limit);
      const counted = query.selections.some((args) => (args[1] as Json | undefined)?.count === "exact");
      const count = counted ? allRows.length : null;
      if (terminal === "single" || terminal === "maybeSingle") {
        if (data.length > 1 || (terminal === "single" && data.length !== 1)) {
          return { data: null, error: { code: "PGRST116", message: PRIVATE_DETAIL }, count };
        }
        return { data: data[0] ?? null, error: null, count };
      }
      return { data, error: null, count };
    };
    const builder = {
      select(...args: unknown[]) { query.selections.push(args); return this; },
      eq(column: string, value: unknown) { query.filters.push([column, value]); return this; },
      limit(count: number) { query.limit = count; return this; },
      range(start: number, end: number) { query.range = [start, end]; return this; },
      insert: (value: Json) => {
        query.kind = "insert";
        query.row = clone(value);
        this.insertAttempts.push(clone(value));
        return builder;
      },
      single: () => execute("single"),
      maybeSingle: () => execute("maybeSingle"),
      then: (resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) => execute("list").then(resolve, reject),
    };
    return builder;
  }
}

function fixture(options: Options = {}) {
  const sdk = new RecordingSdk(options);
  const decoderCalls: Array<{ buffer: Buffer; fileName: string; mimeType: string }> = [];
  const externalCalls: string[] = [];
  const forbidden = (operation: string): never => {
    externalCalls.push(operation);
    throw new Error(`Forbidden external operation: ${operation}`);
  };
  class FakeDecoderUnavailable extends Error {}
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const pendingTimers = new Map<ReturnType<typeof setTimeout>, number>();
  const deadlineTimers: number[] = [];
  const fakeFetch = async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    // The fake has no native HTTP fallback, even for this synthetic Storage host.
    if (!target.startsWith(`${ORIGIN}/storage/v1/object/public/ad-creatives/${WORKSPACE}/`)
      || new URL(target).origin !== ORIGIN || new URL(target).search || new URL(target).hash) return forbidden("non-own Storage fetch");
    fetches.push({ url: target, init });
    if (init.method !== "GET" || init.redirect !== "error" || init.credentials !== "omit" || !init.signal) {
      return forbidden("unsafe Storage verification request");
    }
    if (!options.fetch) return forbidden("unexpected Storage verification");
    return options.fetch(target, init);
  };
  const modules = new Map<string, unknown>();
  const load = (name: string): unknown => {
    if (name === "node:crypto") return crypto;
    const file = allowedModules.get(name);
    if (!file) return forbidden(`application import: ${name}`);
    if (modules.has(name)) return modules.get(name);
    const exports = {};
    modules.set(name, exports);
    const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
      fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Script(code, { filename: file }).runInNewContext({ exports, Buffer, Error, URL, AbortController, AbortSignal,
      require: load, fetch: fakeFetch,
      setTimeout(callback: () => void, ms: number) {
        deadlineTimers.push(ms);
        const timer = setTimeout(callback, options.expireDeadline ? 10 : ms); pendingTimers.set(timer, ms); return timer;
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) { pendingTimers.delete(timer); clearTimeout(timer); },
    }, { timeout: 1000 });
    return exports;
  };
  const fixedNow = options.now ? Date.parse(options.now) : undefined;
  class Clock extends Date {
    constructor(value: string | number = fixedNow ?? Date.now()) { super(value); }
    static now() { return fixedNow ?? Date.now(); }
  }
  const exported: { actual?: { storeGeneratedCreative(input: StoreInput): Promise<Stored> } } = {};
  script.runInNewContext({
    exports: exported, Buffer, Error, URL, Date: Clock, createHash: crypto.createHash, randomUUID: crypto.randomUUID,
    getSupabaseServerClient: () => sdk,
    // Deliberately fake. No sharp/native decoder is loaded in this receipt suite.
    validateCreativeImageBytes: async (value: { buffer: Buffer; fileName: string; mimeType: string }) => {
      decoderCalls.push({ ...value, buffer: Buffer.from(value.buffer) });
      return [];
    },
    CreativeImageValidationUnavailable: FakeDecoderUnavailable,
    process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: ORIGIN, VITE_SUPABASE_URL: "" }) }),
    console: { warn() {}, error() {} },
    require: load,
    fetch: fakeFetch,
  }, { timeout: 1000 });
  assert.ok(exported.actual);
  const actual = exported.actual;
  return {
    sdk, decoderCalls, fetches, deadlineTimers,
    async invoke(value = input()): Promise<Outcome> {
      try {
        return { value: await actual.storeGeneratedCreative(value) };
      } catch (error) {
        return { error };
      } finally {
        assert.deepEqual(externalCalls, [], "No integrations, real environment, decoder, generation or network");
        assert.deepEqual(sdk.violations, [], "Only the recording creative SDK may be used");
        for (const query of sdk.queries.filter(query => query.kind === "lookup")) {
          assert.ok(query.filters.some(([column, expected]) => column === "workspace_id" && expected === value.workspaceId.toLowerCase()), "Every lookup stays tenant scoped");
          assert.ok(query.filters.some(([column, expected]) => column === "generated_key" && expected === `v1:${value.idempotencyKey}`), "Every lookup uses the immutable exact key column");
        }
        assert.equal(pendingTimers.size, 0, "Verification deadlines must be cleared on every outcome");
        assert.ok(sdk.uploads.every(upload => upload.options.upsert === false), "Generated Storage is always create-only");
        assert.deepEqual(sdk.removals, [], "Never delete an ambiguous preexisting object");
      }
    },
  };
}

function assertNotSaved(outcome: Outcome) {
  assert.equal(outcome.value, undefined, "An unconfirmed generated receipt must reject, not return saved or demo success");
  assert.ok(outcome.error instanceof Error);
  assert.ok(outcome.error.message.length > 0);
  assert.equal(outcome.error.message.includes(PRIVATE_DETAIL), false, "Backend failure detail must not escape");
}

function assertSaved(outcome: Outcome, storagePath: string, assetId = storagePath === CANONICAL_PATH ? CANONICAL_ID : ASSET,
  fileName = storagePath === CANONICAL_PATH ? CANONICAL_NAME : "generated.jpg", mimeType = "image/jpeg", size = JPEG.length) {
  assert.equal(outcome.error, undefined, outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
  assert.ok(outcome.value);
  const saved = outcome.value;
  assert.equal(saved.mode, "supabase");
  assert.equal(saved.warning, "");
  assert.equal(saved.publicUrl, publicUrl(storagePath));
  assert.equal(saved.asset.id, assetId);
  assert.equal(saved.asset.workspaceId, WORKSPACE);
  assert.equal(saved.asset.storageBucket, "ad-creatives");
  assert.equal(saved.asset.storagePath, storagePath);
  assert.equal(saved.asset.fileName, fileName);
  assert.equal(saved.asset.fileType, mimeType.startsWith("video/") ? "video" : "image");
  assert.equal(saved.asset.mimeType, mimeType);
  assert.equal(saved.asset.fileSize, size);
}

test("real JPEG input stores through actual persistence and actual row mapping with a fake SDK/decoder", async () => {
  const f = fixture();
  const value = input();
  const bytes = Buffer.from(value.buffer);
  const outcome = await f.invoke(value);
  assert.equal(f.sdk.uploads.length, 1);
  const upload = f.sdk.uploads[0]!;
  assert.equal(upload.bucket, "ad-creatives");
  assert.ok(upload.path.startsWith(`${WORKSPACE}/`));
  assert.match(upload.path, /-generated\.jpg$/);
  assert.deepEqual(upload.buffer, JPEG);
  assert.deepEqual(upload.options, { contentType: "image/jpeg", upsert: false });
  assert.deepEqual(value.buffer, bytes, "The real JPEG fixture is not modified");
  assert.equal(f.sdk.insertAttempts.length, 1);
  assert.equal(f.sdk.insertAttempts[0]!.workspace_id, WORKSPACE);
  assert.equal(f.sdk.insertAttempts[0]!.storage_path, upload.path);
  assert.equal(f.sdk.insertAttempts[0]!.file_size, JPEG.length);
  assert.deepEqual(f.sdk.insertAttempts[0]!.metadata, { source: "synthetic-generation", uploadMode: "ai-generated", contentSha256: HASH });
  assertSaved(outcome, upload.path);
});

test("exact existing asset is a successful idempotent replay without inserting another row", async () => {
  const f = fixture({ lookup: (query) => ({ data: [row(lookupPath(query))], error: null }), fetch: () => streamedReply().response });
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await f.invoke(input({ idempotencyKey: KEY }));
    const lookup = f.sdk.queries.filter((query) => query.kind === "lookup").at(-1)!;
    assert.ok(lookup.filters.some(([column, value]) => column === "workspace_id" && value === WORKSPACE));
    assertSaved(outcome, lookupPath(lookup));
  }
  assert.equal(f.sdk.queries.filter((query) => query.kind === "lookup").length, 2);
  assert.deepEqual(f.sdk.insertAttempts, []);
  assert.deepEqual(f.sdk.uploads, [], "A proven existing asset is reused without overwriting its object");
});

test("a proven empty idempotent lookup permits one ordinary insert", async () => {
  const f = fixture();
  const outcome = await f.invoke(input({ idempotencyKey: KEY }));
  const lookups = f.sdk.queries.filter((query) => query.kind === "lookup");
  assert.equal(lookups.length, 1);
  assert.equal(f.sdk.insertAttempts.length, 1);
  assert.equal(f.sdk.uploads.length, 1);
  assert.equal(f.sdk.uploads[0]!.options.upsert, false);
  assert.equal(f.sdk.insertAttempts[0]!.id, CANONICAL_ID);
  assert.equal(f.sdk.insertAttempts[0]!.generated_key, GENERATED_KEY);
  assert.equal(f.sdk.insertAttempts[0]!.generated_sha256, HASH);
  assertSaved(outcome, lookupPath(lookups[0]!));
});

test("duplicate existing rows cannot be hidden by limit(1) and acknowledged as an idempotent success", async (t) => {
  for (const mixedWorkspace of [false, true]) {
    await t.test(mixedWorkspace ? "matching row followed by a foreign row" : "two matching rows with distinct ids", async () => {
      const f = fixture({ lookup: (query) => {
        const storagePath = lookupPath(query);
        return { data: [row(storagePath), row(storagePath, { id: SECOND_ASSET,
          ...(mixedWorkspace ? { workspace_id: FOREIGN_WORKSPACE } : {}) })], error: null };
      } });
      const outcome = await f.invoke(input({ idempotencyKey: KEY }));
      assert.deepEqual(f.sdk.uploads, [], "Ambiguous lookup must fail before any Storage upload/upsert");
      assert.deepEqual(f.sdk.insertAttempts, [], "Ambiguous existence must not trigger another insert");
      assertNotSaved(outcome);
    });
  }
});

const invalidRows: Array<[string, Json]> = [
  ["foreign workspace", { workspace_id: FOREIGN_WORKSPACE }],
  ["foreign storage path", { storage_path: `${FOREIGN_WORKSPACE}/other.jpg` }],
  ["different own-workspace path", { storage_path: `${WORKSPACE}/other.jpg` }],
  ["different bucket", { storage_bucket: "other-bucket" }],
  ["foreign public URL", { public_url: `${ORIGIN}/foreign-object.jpg` }],
  ["missing public URL", { public_url: undefined }],
  ["null public URL", { public_url: null }],
  ["wrong MIME", { mime_type: "image/png" }],
  ["wrong byte size", { file_size: JPEG.length + 1 }],
  ["missing byte size", { file_size: undefined }],
  ["wrong file type", { file_type: "video" }],
  ["wrong file name", { file_name: "different.jpg" }],
  ["missing asset id", { id: undefined }],
  ["empty asset id", { id: "" }],
  ["non-database asset id", { id: "ad-creative-synthetic-demo" }],
  ["missing workspace identity", { workspace_id: undefined }],
  ["missing storage path", { storage_path: undefined }],
  ["missing bucket", { storage_bucket: undefined }],
  ["missing MIME", { mime_type: undefined }],
];

test("existing-asset proof validates raw identity and metadata before defaults can disguise a mismatch", async (t) => {
  for (const [label, patch] of invalidRows) {
    await t.test(label, async () => {
      const f = fixture({ lookup: (query) => ({ data: [row(lookupPath(query), patch)], error: null }) });
      const outcome = await f.invoke(input({ idempotencyKey: KEY }));
      assert.deepEqual(f.sdk.uploads, [], "Unproven existing row must not have its object overwritten");
      assert.deepEqual(f.sdk.insertAttempts, [], "An unproven existing row is not proof of absence");
      assertNotSaved(outcome);
    });
  }
});

test("lookup database and transport errors cannot be swallowed into a duplicate insert", async (t) => {
  for (const kind of ["database error", "transport rejection", "rows accompanied by database error"]) {
    await t.test(kind, async () => {
      const f = fixture({ lookup: (query) => {
        if (kind === "transport rejection") throw new Error(PRIVATE_DETAIL);
        return { data: kind === "rows accompanied by database error" ? [row(lookupPath(query))] : null,
          error: { code: "XX000", message: PRIVATE_DETAIL } };
      } });
      const outcome = await f.invoke(input({ idempotencyKey: KEY }));
      assert.deepEqual(f.sdk.uploads, [], "Failed lookup must stop before any Storage upload/upsert");
      assert.deepEqual(f.sdk.insertAttempts, [], "Failed lookup is not a successful empty lookup");
      assertNotSaved(outcome);
    });
  }
});

test("malformed existing-lookup payloads do not establish absence or saved success", async (t) => {
  for (const [label, data] of [["object", {}], ["text", "not-rows"], ["empty row", [{}]]] as Array<[string, unknown]>) {
    await t.test(label, async () => {
      const f = fixture({ lookup: () => ({ data, error: null }) });
      const outcome = await f.invoke(input({ idempotencyKey: KEY }));
      assert.deepEqual(f.sdk.uploads, [], "Malformed lookup must stop before any Storage upload/upsert");
      assert.deepEqual(f.sdk.insertAttempts, []);
      assertNotSaved(outcome);
    });
  }
});

test("insert success must prove the real asset identity, authorized tenant and exact stored-file metadata", async (t) => {
  for (const [label, patch] of invalidRows) {
    await t.test(label, async () => {
      const f = fixture({ insert: (query) => ({ data: row(String(query.row!.storage_path), patch), error: null }) });
      const outcome = await f.invoke();
      assert.equal(f.sdk.insertAttempts.length, 1, "Exercise the actual INSERT receipt, not an existing-row fast path");
      assertNotSaved(outcome);
    });
  }
});

test("null, empty, partial or array INSERT receipts cannot become invented saved assets", async (t) => {
  for (const [label, data] of [
    ["null", null], ["undefined", undefined], ["empty object", {}], ["empty array", []],
    ["id only", { id: ASSET }], ["array instead of single row", [row(`${WORKSPACE}/unexpected.jpg`)]],
  ] as Array<[string, unknown]>) {
    await t.test(label, async () => {
      const f = fixture({ insert: () => ({ data, error: null }) });
      const outcome = await f.invoke();
      assert.equal(f.sdk.insertAttempts.length, 1);
      assertNotSaved(outcome);
    });
  }
});

test("INSERT database failure does not expose backend detail or claim a saved library row", async () => {
  const f = fixture({ insert: () => ({ data: null, error: { code: "XX000", message: PRIVATE_DETAIL } }) });
  assertNotSaved(await f.invoke());
  assert.equal(f.sdk.insertAttempts.length, 1);
});

const invalidKeyedRows: Array<[string, Json]> = [
  ["wrong deterministic id", { id: ASSET }],
  ["missing private key", { generated_key: undefined }], ["null private key", { generated_key: null }],
  ["foreign exact key", { generated_key: "v1:other-render" }], ["digest in place of exact key", { generated_key: DIGEST }],
  ["padded private key", { generated_key: ` ${GENERATED_KEY}` }],
  ["missing raw hash", { generated_sha256: undefined }], ["null canonical hash", { generated_sha256: null }],
  ["wrong raw hash", { generated_sha256: "0".repeat(64) }], ["uppercase raw hash", { generated_sha256: HASH.toUpperCase() }],
  ["nontext raw hash", { generated_sha256: { contentSha256: HASH } }],
];
for (const phase of ["lookup", "insert"] as const) {
  test(`canonical ${phase} requires private key, raw SHA-256 and deterministic primary key`, async t => {
    for (const [label, patch] of invalidKeyedRows) await t.test(label, async () => {
      const f = fixture(phase === "lookup"
        ? { lookup: query => ({ data: [row(lookupPath(query), patch)], error: null }) }
        : { insert: query => ({ data: { ...clone(query.row), ...patch }, error: null }) });
      assertNotSaved(await f.invoke(input({ idempotencyKey: KEY })));
      assert.equal(f.sdk.uploads.length, phase === "lookup" ? 0 : 1);
      assert.equal(f.sdk.insertAttempts.length, phase === "lookup" ? 0 : 1);
      assert.deepEqual(f.fetches, [], "Invalid critical fields must not trigger byte fetches or provider fallback");
    });
  });
}

test("canonical replay survives a legitimate Meta metadata overwrite without weakening the raw column proof", async () => {
  const f = fixture({ lookup: query => ({ data: [row(lookupPath(query), {
    metadata: { metaVideoProcessingStatus: "ready" }, status: "meta_uploaded", meta_asset_id: "synthetic-meta-id",
  })], error: null }), fetch: () => streamedReply().response });
  assertSaved(await f.invoke(input({ idempotencyKey: KEY })), CANONICAL_PATH);
  assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []); assert.equal(f.fetches.length, 1);
});

test("same key with different bytes cannot reuse or overwrite a previously proven canonical image", async () => {
  const f = fixture({ lookup: query => ({ data: [row(lookupPath(query))], error: null }) });
  const changed = Buffer.from(JPEG); changed[changed.length - 3] ^= 1;
  assertNotSaved(await f.invoke(input({ idempotencyKey: KEY, buffer: changed })));
  assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []);
});

test("canonical path and v5 id ignore incoming filename, UTC date and MIME identity forks", async () => {
  for (const [mimeType, extension] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
    ["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"]]) {
    for (const now of ["2026-10-31T23:59:59.000Z", "2027-01-01T00:00:00.000Z"]) {
      const f = fixture({ now });
      const outcome = await f.invoke(input({ idempotencyKey: KEY, fileName: "../../ignored-caller-name.bin", mimeType,
        metadata: { generationKey: "forged", contentSha256: "forged", uploadMode: "forged", jobId: "forged" } }));
      if (mimeType.startsWith("video/")) {
        assertNotSaved(outcome);
        assert.match(String(outcome.error), /generated_video_native_validation_required/);
        assert.deepEqual(f.sdk.queries, []); assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.fetches, []);
        continue;
      }
      const fileName = `negis-${mimeType.startsWith("video/") ? "video" : "image"}-${DIGEST.slice(0, 20)}.${extension}`;
      assertSaved(outcome, CANONICAL_PATH, CANONICAL_ID, fileName, mimeType);
      const saved = f.sdk.insertAttempts[0];
      assert.equal(saved.id, CANONICAL_ID); assert.equal(saved.generated_key, GENERATED_KEY); assert.equal(saved.generated_sha256, HASH);
      assert.equal(saved.storage_path, CANONICAL_PATH);
      assert.equal((saved.metadata as Json).generationKey, DIGEST); assert.equal((saved.metadata as Json).contentSha256, HASH);
      assert.equal((saved.metadata as Json).uploadMode, "ai-generated");
      if (mimeType.startsWith("video/")) assert.equal((saved.metadata as Json).jobId, KEY);
    }
  }
});

test("canonical identity lowercases a valid UUID tenant before key lookup and storage", async () => {
  const workspace = "ABCDEFAB-1234-4234-8234-ABCDEFABCDEF", lower = workspace.toLowerCase();
  const digest = "6b217cfa3fd515cb3709e736de4d681331fa7381fb209386f72ccef1f6ea34e2";
  const f = fixture();
  const outcome = await f.invoke(input({ workspaceId: workspace, idempotencyKey: KEY }));
  assert.equal(outcome.error, undefined); assert.ok(outcome.value);
  assert.equal(f.sdk.uploads[0].path, `${lower}/generated/${digest}`);
  assert.equal(f.sdk.insertAttempts[0].workspace_id, lower);
  assert.equal(f.sdk.insertAttempts[0].id, "74c55d69-30a4-5c8f-ae01-45d05cd751b0");
  assert.equal(outcome.value.asset.workspaceId, lower);
});

test("invalid provided keys never silently fall back to random unkeyed storage", async t => {
  for (const key of [null, 1, {}, [], "", " ", "\trender", "render ", "k".repeat(513)]) {
    await t.test(JSON.stringify(key), async () => {
      const f = fixture();
      assertNotSaved(await f.invoke(input({ idempotencyKey: key as string })));
      assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []); assert.deepEqual(f.sdk.queries, []);
    });
  }
});

test("missing private-column migration is a lookup failure before any upload", async () => {
  const f = fixture({ lookup: () => ({ data: null, error: { code: "42703", message: PRIVATE_DETAIL } }) });
  assertNotSaved(await f.invoke(input({ idempotencyKey: KEY })));
  assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []); assert.deepEqual(f.fetches, []);
});

function streamedReply(options: { bytes?: Buffer; mimeType?: string; length?: string | null; status?: number;
  redirected?: boolean; readError?: boolean; stall?: boolean; noBody?: boolean } = {}) {
  const bytes = options.bytes ?? JPEG;
  let offset = 0, reads = 0, cancels = 0, readers = 0, wholeBodyCalls = 0;
  const headers = new Headers({ "Content-Type": options.mimeType ?? "image/jpeg" });
  if (options.length !== null) headers.set("Content-Length", options.length ?? String(bytes.length));
  const response = { status: options.status ?? 200, redirected: options.redirected ?? false, headers,
    body: options.noBody ? null : { getReader() {
      readers++;
      return {
        async read() {
          reads++;
          if (options.readError) throw new Error(PRIVATE_DETAIL);
          if (options.stall) return new Promise<never>(() => {});
          if (offset === bytes.length) return { done: true, value: undefined };
          const value = bytes.subarray(offset, offset = Math.min(offset + 7, bytes.length));
          return { done: false, value };
        },
        async cancel() { cancels++; },
      };
    } },
    async arrayBuffer() { wholeBodyCalls++; throw new Error("Whole-object buffering is forbidden"); },
    async blob() { wholeBodyCalls++; throw new Error("Whole-object buffering is forbidden"); },
  };
  return { response, metrics: () => ({ reads, cancels, readers, wholeBodyCalls }) };
}

for (const uploadFailure of ["collision", "transport rejection", "uncertain receipt"] as const) {
  test(`create-only ${uploadFailure} reconciles only after exact own-Storage streamed bytes prove the object`, async () => {
    const reply = streamedReply();
    const f = fixture({ upload: () => {
      if (uploadFailure === "transport rejection") throw new Error(PRIVATE_DETAIL);
      return uploadFailure === "collision" ? { data: null, error: { message: PRIVATE_DETAIL } } : { data: {}, error: null };
    }, fetch: () => reply.response });
    assertSaved(await f.invoke(input({ idempotencyKey: KEY })), CANONICAL_PATH);
    assert.equal(f.sdk.uploads.length, 1); assert.equal(f.sdk.insertAttempts.length, 1);
    assert.equal(f.fetches.length, 1); assert.equal(f.fetches[0].url, publicUrl(CANONICAL_PATH));
    assert.deepEqual(f.deadlineTimers, [10_000]);
    assert.equal(f.fetches[0].init.signal!.aborted, true, "Completion also disposes the deadline controller");
    const metrics = reply.metrics();
    assert.ok(metrics.reads > 2); assert.equal(metrics.cancels, 1); assert.equal(metrics.wholeBodyCalls, 0);
  });
}

const badObjects: Array<[string, Parameters<typeof streamedReply>[0]]> = [
  ["wrong same-length bytes", { bytes: Buffer.alloc(JPEG.length, 0x61) }],
  ["short stream", { bytes: JPEG.subarray(0, JPEG.length - 1), length: String(JPEG.length) }],
  ["oversize stream without length", { bytes: Buffer.concat([JPEG, Buffer.from([0])]), length: null }],
  ["wrong declared length", { length: String(JPEG.length + 1) }], ["malformed length", { length: "n/a" }],
  ["wrong MIME", { mimeType: "image/png" }], ["HTTP failure", { status: 503 }],
  ["partial response", { status: 206 }], ["redirected response", { redirected: true }],
  ["missing body", { noBody: true }], ["stream rejection", { readError: true }],
];
test("uncertain Storage failure never overwrites, deletes or inserts on unproven object bytes", async t => {
  for (const [label, options] of badObjects) await t.test(label, async () => {
    const reply = streamedReply(options);
    const f = fixture({ upload: () => ({ data: null, error: { message: PRIVATE_DETAIL } }), fetch: () => reply.response });
    assertNotSaved(await f.invoke(input({ idempotencyKey: KEY })));
    assert.equal(f.sdk.uploads.length, 1); assert.deepEqual(f.sdk.insertAttempts, []);
    assert.equal(f.fetches.length, 1); assert.equal(reply.metrics().wholeBodyCalls, 0);
  });
});

for (const stall of ["headers", "body"] as const) {
  test(`own-Storage ${stall} stall uses the actual total 10-second deadline and refuses safely`, async () => {
    const reply = streamedReply({ stall: true });
    const f = fixture({ expireDeadline: true, upload: () => ({ data: null, error: { message: PRIVATE_DETAIL } }),
      fetch: () => stall === "headers" ? new Promise<never>(() => {}) : reply.response });
    assertNotSaved(await f.invoke(input({ idempotencyKey: KEY })));
    assert.deepEqual(f.deadlineTimers, [10_000], "Only the timer scheduler is accelerated; the actual helper chooses the bound");
    assert.equal(f.fetches[0].init.signal!.aborted, true); assert.deepEqual(f.sdk.insertAttempts, []);
  });
}

for (const failure of ["database error", "transport rejection"] as const) {
  test(`deterministic INSERT ${failure} reconciles an exact committed row, never a fabricated success`, async () => {
    let lookups = 0;
    const f = fixture({ lookup: query => ({ data: ++lookups === 1 ? [] : [row(lookupPath(query))], error: null }),
      fetch: () => streamedReply().response,
      insert: () => { if (failure === "transport rejection") throw new Error(PRIVATE_DETAIL);
        return { data: null, error: { code: "23505", message: PRIVATE_DETAIL } }; } });
    assertSaved(await f.invoke(input({ idempotencyKey: KEY })), CANONICAL_PATH);
    assert.equal(lookups, 2); assert.equal(f.sdk.insertAttempts.length, 1); assert.equal(f.sdk.uploads.length, 1);
  });
}

test("failed deterministic INSERT cannot reconcile absence, a foreign row, raw hash mismatch or database error", async t => {
  for (const reason of ["absent", "foreign", "hash", "error", "duplicates"]) await t.test(reason, async () => {
    let lookups = 0;
    const f = fixture({ lookup: query => {
      if (++lookups === 1) return { data: [], error: null };
      const path = lookupPath(query);
      return { data: reason === "absent" ? [] : reason === "error" ? null : reason === "duplicates"
        ? [row(path), row(path, { id: SECOND_ASSET })] : [row(path, reason === "foreign"
          ? { workspace_id: FOREIGN_WORKSPACE } : { generated_sha256: "0".repeat(64) })],
        error: reason === "error" ? { message: PRIVATE_DETAIL } : null };
    }, insert: () => ({ data: null, error: { code: "XX000", message: PRIVATE_DETAIL } }) });
    assertNotSaved(await f.invoke(input({ idempotencyKey: KEY })));
    assert.equal(lookups, 2); assert.equal(f.sdk.insertAttempts.length, 1); assert.equal(f.sdk.uploads.length, 1);
  });
});

// Deliberately synthetic video bytes: only Storage identity/stream proof is tested here, not a video decoder.
const VIDEO = Buffer.from("QA synthetic in-memory video bytes");
const LEGACY_NAME = "negis-video-1761393600000.mp4";
const LEGACY_PATH = `${WORKSPACE}/2026/10/${KEY}-${LEGACY_NAME}`;
function legacyRow(patch: Json = {}) {
  return row(LEGACY_PATH, { file_name: LEGACY_NAME, file_type: "video", mime_type: "video/mp4", file_size: VIDEO.length,
    generated_key: GENERATED_KEY, generated_sha256: null,
    metadata: { uploadMode: "ai-generated", kind: "generated-video", jobId: KEY }, ...patch });
}
function videoInput() {
  return input({ idempotencyKey: KEY, fileName: "ignored-new-name.mp4", mimeType: "video/mp4", buffer: VIDEO,
    metadata: { uploadMode: "forged", kind: "generated-video", jobId: "forged" } });
}

test("a legacy public video cannot bypass the private native workflow through the direct writer", async () => {
  const reply = streamedReply({ bytes: VIDEO, mimeType: "video/mp4" });
  const f = fixture({ lookup: query => { lookupPath(query); return { data: [legacyRow()], error: null }; }, fetch: () => reply.response });
  const outcome = await f.invoke(videoInput());
  assertNotSaved(outcome); assert.match(String(outcome.error), /generated_video_native_validation_required/);
  assert.equal(f.fetches.length, 0); assert.equal(reply.metrics().wholeBodyCalls, 0); assert.equal(reply.metrics().reads, 0);
  assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []);
  assert.equal(f.sdk.queries.filter(query => query.kind !== "lookup").length, 0, "No runtime backfill or UPDATE");
});

test("legacy video raw fields, exact old filename/path and key/hash null semantics are fail-closed", async t => {
  for (const [label, patch] of [...invalidRows, ["missing private key", { generated_key: undefined }],
    ["wrong private key", { generated_key: "v1:foreign" }], ["missing raw hash", { generated_sha256: undefined }],
    ["wrong nonnull raw hash", { generated_sha256: "0".repeat(64) }],
    ["padded id", { id: ` ${ASSET}` }], ["padded tenant", { workspace_id: ` ${WORKSPACE}` }],
    ["arbitrary returned filename", { file_name: "generated.mp4" }],
    ["filename/path disagree", { file_name: "negis-video-1761393600001.mp4" }],
    ["other job path", { storage_path: `${WORKSPACE}/2026/10/foreign-${LEGACY_NAME}` }],
  ] as Array<[string, Json]>) await t.test(label, async () => {
    // Some shared image mismatches equal the legitimate video field; choose a genuinely different value.
    const changed = label === "wrong file type" ? { file_type: "image" }
      : label === "wrong byte size" ? { file_size: VIDEO.length + 1 } : patch;
    const reply = streamedReply({ bytes: VIDEO, mimeType: "video/mp4" });
    const f = fixture({ lookup: () => ({ data: [legacyRow(changed)], error: null }), fetch: () => reply.response });
    assertNotSaved(await f.invoke(videoInput()));
    assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []);
    assert.deepEqual(f.fetches, [], "Malformed legacy identity must fail before any object read");
  });
});

test("duplicate legacy rows refuse before byte reads or mutation, including a foreign second row", async t => {
  for (const foreign of [false, true]) await t.test(foreign ? "foreign second row" : "second legacy id", async () => {
    const f = fixture({ lookup: () => ({ data: [legacyRow(), legacyRow({ id: SECOND_ASSET,
      ...(foreign ? { workspace_id: FOREIGN_WORKSPACE } : {}) })], error: null }) });
    assertNotSaved(await f.invoke(videoInput()));
    assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []); assert.deepEqual(f.fetches, []);
  });
});

test("exact legacy identity with wrong stored bytes cannot be acknowledged or rewritten", async () => {
  const reply = streamedReply({ bytes: Buffer.alloc(VIDEO.length, 0x61), mimeType: "video/mp4" });
  const f = fixture({ lookup: () => ({ data: [legacyRow()], error: null }), fetch: () => reply.response });
  assertNotSaved(await f.invoke(videoInput()));
  assert.equal(f.fetches.length, 0); assert.deepEqual(f.sdk.uploads, []); assert.deepEqual(f.sdk.insertAttempts, []);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const compiled = ts.transpileModule([
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
};

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const SECOND_ASSET = "44444444-4444-4444-8444-444444444444";
const STAMP = "2026-10-25T12:00:00.000Z";
const ORIGIN = "https://generated-storage.invalid";
const PRIVATE_DETAIL = "synthetic-private-persistence-detail";
// A real, fixed 2x2 JPEG fixture. The decoder below is deliberately synthetic:
// these tests prove persistence receipts, not JPEG decoding or byte validation.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=",
  "base64",
);
const clone = <T,>(value: T): T => structuredClone(value);
const publicUrl = (storagePath: string) => `${ORIGIN}/storage/v1/object/public/ad-creatives/${storagePath}`;

function input(patch: Partial<StoreInput> = {}): StoreInput {
  return { workspaceId: WORKSPACE, fileName: "generated.jpg", mimeType: "image/jpeg",
    buffer: Buffer.from(JPEG), metadata: { source: "synthetic-generation" }, ...patch };
}

function lookupPath(query: Query): string {
  const value = query.filters.find(([column]) => column === "storage_path")?.[1];
  assert.equal(typeof value, "string", "The actual lookup must target its server-chosen storage path");
  return value as string;
}

function row(storagePath: string, patch: Json = {}): Json {
  return {
    id: ASSET, workspace_id: WORKSPACE, launch_id: null, uploaded_by: null,
    file_name: "generated.jpg", file_type: "image", mime_type: "image/jpeg", file_size: JPEG.length,
    storage_bucket: "ad-creatives", storage_path: storagePath, public_url: publicUrl(storagePath),
    meta_asset_id: null, meta_video_id: null, status: "uploaded",
    metadata: { source: "synthetic-generation", uploadMode: "ai-generated" },
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
        this.uploads.push({ bucket, path: storagePath, buffer: Buffer.from(buffer), options: clone(options) });
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
      const result = this.options.lookup ? await this.options.lookup(clone(query)) : { data: [], error: null };
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
  const exported: { actual?: { storeGeneratedCreative(input: StoreInput): Promise<Stored> } } = {};
  script.runInNewContext({
    exports: exported, Buffer, Error, URL,
    getSupabaseServerClient: () => sdk,
    // Deliberately fake. No sharp/native decoder is loaded in this receipt suite.
    validateCreativeImageBytes: async (value: { buffer: Buffer; fileName: string; mimeType: string }) => {
      decoderCalls.push({ ...value, buffer: Buffer.from(value.buffer) });
      return [];
    },
    CreativeImageValidationUnavailable: FakeDecoderUnavailable,
    process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: ORIGIN, VITE_SUPABASE_URL: "" }) }),
    console: { warn() {}, error() {} },
    require: () => forbidden("application import"),
    fetch: () => forbidden("network"),
  }, { timeout: 1000 });
  assert.ok(exported.actual);
  const actual = exported.actual;
  return {
    sdk, decoderCalls,
    async invoke(value = input()): Promise<Outcome> {
      try {
        return { value: await actual.storeGeneratedCreative(value) };
      } catch (error) {
        return { error };
      } finally {
        assert.deepEqual(externalCalls, [], "No integrations, real environment, decoder, generation or network");
        assert.deepEqual(sdk.violations, [], "Only the recording creative SDK may be used");
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

function assertSaved(outcome: Outcome, storagePath: string, assetId = ASSET) {
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
  assert.equal(saved.asset.fileName, "generated.jpg");
  assert.equal(saved.asset.fileType, "image");
  assert.equal(saved.asset.mimeType, "image/jpeg");
  assert.equal(saved.asset.fileSize, JPEG.length);
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
  assert.deepEqual(f.sdk.insertAttempts[0]!.metadata, { source: "synthetic-generation", uploadMode: "ai-generated" });
  assertSaved(outcome, upload.path);
});

test("exact existing asset is a successful idempotent replay without inserting another row", async () => {
  const f = fixture({ lookup: (query) => ({ data: [row(lookupPath(query))], error: null }) });
  // Sequential reuse only: no cross-request atomicity or cross-date key proof.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-1" }));
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
  const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-new" }));
  const lookups = f.sdk.queries.filter((query) => query.kind === "lookup");
  assert.equal(lookups.length, 1);
  assert.equal(f.sdk.insertAttempts.length, 1);
  assert.equal(f.sdk.uploads.length, 1);
  assert.equal(f.sdk.uploads[0]!.options.upsert, true);
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
      const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-duplicate" }));
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
      const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-unproven" }));
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
      const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-lookup-error" }));
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
      const outcome = await f.invoke(input({ idempotencyKey: "synthetic-render-malformed-lookup" }));
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

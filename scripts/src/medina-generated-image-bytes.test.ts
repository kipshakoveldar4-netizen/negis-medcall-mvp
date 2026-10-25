import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const sharp = requireFromRoot("sharp") as typeof import("sharp").default;
const serverFile = "lib/crm/server.ts";
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "b301f1f", "only the reviewed local baseline may be loaded");
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${serverFile}`], { cwd: root, encoding: "utf8", windowsHide: true })
  : await readFile(path.join(root, serverFile), "utf8");
const helperSource = await readFile(path.join(root, "lib/crm/creative-image.ts"), "utf8");

type Json = Record<string, unknown>;
type Image = { buffer: Buffer; fileName: string; mimeType: string };
type StoreInput = Image & { workspaceId: string; metadata?: Json; idempotencyKey?: string };
type StoreResult = { publicUrl: string; asset: Json; mode: string; warning: string };
type ImageHelper = {
  validateCreativeImageBytes(input: Image): Promise<string[]>;
  CreativeImageValidationUnavailable: new () => Error;
};
type Runtime = {
  storeGeneratedCreative(input: StoreInput): Promise<StoreResult>;
  MAX_IMAGE_BYTES: number;
};
// The helper, sniffer and native Sharp decoder are real. Only Supabase is a
// recording test double; no provider, network, generation or .env is involved.
const actualHelper = await import(pathToFileURL(path.join(root, "lib/crm/creative-image.ts")).href) as ImageHelper;
const actualSniffer = await import(pathToFileURL(path.join(root, "lib/content-studio/generation.ts")).href) as {
  sniffImageMimeType(buffer: Uint8Array): string | null;
};
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const LIMIT = 10 * 1024 * 1024;
const ORIGIN = "https://generated-image-storage.invalid";
const PRIVATE_DETAIL = "SYNTHETIC_PRIVATE_GENERATED_IMAGE_DIAGNOSTIC";
const KEY = "synthetic-render-1";
const DIGEST = "8fb7bdc82870eb03a5941acd76ea41f29fa1fbe1869b4d7ba8ec3ad8a5644043";
const CANONICAL_ID = "fda70de5-673d-57ed-8cfd-7aa74a193832";
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const observe = <T,>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Existing synthetic 2x2 RGB fixtures, not generated through a paid API.
const images = [
  { format: "JPEG", fileName: "synthetic.jpg", mimeType: "image/jpeg", base64:
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=" },
  { format: "PNG", fileName: "synthetic.png", mimeType: "image/png", base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNUXxDJwMDAwgAGAA2GASZkY9I0AAAAAElFTkSuQmCC" },
  { format: "WebP", fileName: "synthetic.webp", mimeType: "image/webp", base64:
    "UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoCAAIAAgA0JaACdAF1AAD+34A1VT1+N3/zYH/t5/4I9pQA" },
].map(image => ({ ...image, buffer: Buffer.from(image.base64, "base64") }));
const [jpeg, png, webp] = images;

function compile(text: string, fileName: string) {
  const result = ts.transpileModule(text, { fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual(result.diagnostics ?? [], [], `actual ${fileName} must transpile`);
  return result.outputText;
}

// Retain complete actual declarations and transitive local dependencies. This
// includes the real persistence/config toRow/fromRow implementation, not a
// replacement persistence function or a copied store/validation algorithm.
const ast = ts.createSourceFile(serverFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
const selected = new Set<import("typescript").Statement>();
function include(name: string) {
  const statement = declarations.get(name);
  assert.ok(statement, `actual ${serverFile}:${name} must exist`);
  if (selected.has(statement)) return;
  selected.add(statement);
  const visit = (node: import("typescript").Node) => {
    if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
    ts.forEachChild(node, visit);
  };
  visit(statement);
}
include("storeGeneratedCreative");
include("MAX_IMAGE_BYTES");
for (const name of ["validateCreativeAssetBody", "persistAdCreativeAsset", "configs", "makeAdCreativeAsset", "buildAdCreativeStoragePath"]) {
  assert.ok(selected.has(declarations.get(name)!), `execute actual ${name}, never a behavior stub`);
}
const storeScript = new Script(compile([
  ...ast.statements.filter(ts.isImportDeclaration).filter(statement => ts.isStringLiteral(statement.moduleSpecifier)
    && ["./generated-identity", "./generated-storage-verification"].includes(statement.moduleSpecifier.text)).map(statement => statement.getText(ast)),
  ...ast.statements.filter(statement => selected.has(statement)).map(statement => statement.getText(ast)),
  "exports.runtime = { storeGeneratedCreative, MAX_IMAGE_BYTES };",
].join("\n"), "generated-image-bytes.actual.ts"), { filename: `${baseline ?? "working-tree"}:generated-image-bytes.actual.cjs` });

type Upload = { bucket: string; key: string; buffer: Buffer; options: Json };
function fixture(options: { helper?: ImageHelper; uploadError?: boolean; persistenceError?: boolean } = {}) {
  const helper = options.helper ?? actualHelper;
  const events: string[] = [], sdkEvents: string[] = [], logs: string[] = [], forbidden: string[] = [];
  const uploaded: Upload[] = [], inserted: Array<{ table: string; row: Json }> = [], validationInputs: Image[] = [];
  const lookups: Array<Array<[string, unknown]>> = [];
  const fail = (name: string): never => { forbidden.push(name); throw new Error(`Forbidden test boundary: ${name}`); };
  const sdk = {
    storage: {
      from(bucket: string) {
        sdkEvents.push("storage.from");
        return {
          async upload(key: string, buffer: Buffer, uploadOptions: Json) {
            sdkEvents.push("upload"); events.push("upload");
            uploaded.push({ bucket, key, buffer: Buffer.from(buffer), options: plain(uploadOptions) });
            return { data: { path: key }, error: options.uploadError ? new Error(PRIVATE_DETAIL) : null };
          },
          getPublicUrl(key: string) {
            sdkEvents.push("publicUrl");
            const encoded = key.split("/").map(encodeURIComponent).join("/");
            return { data: { publicUrl: `${ORIGIN}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encoded}` } };
          },
          async remove() { return fail("unexpected Storage cleanup"); },
        };
      },
    },
    from(table: string) {
      sdkEvents.push("table.from");
      assert.equal(table, "ad_creative_assets");
      return {
        select(columns: string) {
          assert.equal(columns, "*");
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(column: string, value: unknown) { filters.push([column, value]); return this; },
            limit(count: number) { assert.ok(count >= 2, "Do not hide duplicate keyed rows"); return this; },
            then(resolve: (result: { data: unknown[]; error: null }) => unknown, reject: (error: unknown) => unknown) {
              lookups.push(filters);
              assert.ok(filters.some(([column, value]) => column === "generated_key" && value === `v1:${KEY}`));
              assert.ok(filters.some(([column, value]) => column === "workspace_id" && value === WORKSPACE));
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return query;
        },
        insert(row: Json) {
          sdkEvents.push("insert"); events.push("insert");
          inserted.push({ table, row: plain(row) });
          return { select(columns: string) {
            assert.equal(columns, "*");
            return { async single() {
              return { data: { ...plain(row), id: row.id ?? ASSET, created_at: "2026-10-25T00:00:00.000Z" },
                error: options.persistenceError ? new Error(PRIVATE_DETAIL) : null };
            } };
          } };
        },
      };
    },
  };
  const helpers = new Map<string, Json>();
  const load = (name: string): unknown => {
    if (name === "node:crypto") return crypto;
    if (!["./generated-identity", "./generated-storage-verification"].includes(name)) return fail(`unexpected application import: ${name}`);
    if (helpers.has(name)) return helpers.get(name);
    const exported: Json = {};
    helpers.set(name, exported);
    new Script(compile(readFileSync(path.join(root, "lib/crm", `${name.slice(2)}.ts`), "utf8"), `${name}.actual.ts`)).runInNewContext({
      exports: exported, Buffer, Error, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
      require: load,
      fetch(url: string, init: RequestInit) {
        assert.ok(options.uploadError, "Only the upload-error fixture may verify a synthetic object");
        assert.equal(url, sdk.storage.from(uploaded[0].bucket).getPublicUrl(uploaded[0].key).data.publicUrl);
        assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    }, { timeout: 1000 });
    return exported;
  };
  const exported: { runtime?: Runtime } = {};
  storeScript.runInNewContext({
    exports: exported, Buffer, Error, URL, createHash: crypto.createHash, randomUUID: crypto.randomUUID,
    CreativeImageValidationUnavailable: helper.CreativeImageValidationUnavailable,
    async validateCreativeImageBytes(input: Image) {
      events.push("validate:start");
      validationInputs.push(input);
      const details = await helper.validateCreativeImageBytes(input);
      events.push(details.length ? "validate:invalid" : "validate:ok");
      return details;
    },
    getSupabaseServerClient: () => sdk,
    process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: ORIGIN }) }),
    fetch: () => fail("network"), require: load,
    console: { warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")), error: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
  }, { timeout: 1000 });
  assert.ok(exported.runtime);
  const runtime = exported.runtime;
  assert.equal(runtime.MAX_IMAGE_BYTES, LIMIT);
  return { uploaded, inserted, events, sdkEvents, validationInputs, logs, lookups,
    async call(input: Image, workspaceId = WORKSPACE, metadata: Json = { source: "synthetic-generated-image", actorId: ACTOR }, idempotencyKey?: string) {
      try { return await runtime.storeGeneratedCreative({ ...input, workspaceId, metadata, idempotencyKey }); }
      finally { assert.deepEqual(forbidden, [], "no real SDK, imports, HTTP or external services"); }
    },
  };
}

function noWrites(ctx: ReturnType<typeof fixture>) {
  assert.deepEqual({ uploads: ctx.uploaded.length, inserts: ctx.inserted.length }, { uploads: 0, inserts: 0 },
    "invalid generated IMAGE bytes must be refused before public Storage upload AND actual metadata persistence");
  assert.deepEqual(ctx.sdkEvents, [], "rejection must precede selecting a bucket or metadata table");
}
function safeFailure(error: unknown) {
  assert.ok(error instanceof Error, "refuse with a safe error, never a successful creative URL");
  assert.ok(error.message.length > 0);
  for (const value of [PRIVATE_DETAIL, WORKSPACE, OTHER_WORKSPACE, ACTOR, ORIGIN, "SYNTHETIC_DECODER_IMPORT_FAILURE"]) {
    assert.equal(error.message.includes(value), false, "no private byte, scope, SDK or module-loader diagnostics in the caller error");
  }
  assert.doesNotMatch(error.message, /libvips|jpegload|pngload|webpload|Input buffer|premature end|corrupt header|node_modules/i);
}

const corrupt: Array<Image & { name: string }> = [
  { name: "arbitrary provider bytes", ...jpeg, buffer: Buffer.from(`not-a-real-jpeg ${PRIVATE_DETAIL}`) },
  { name: "HTML labelled JPEG", ...jpeg, buffer: Buffer.from(`<!doctype html><title>${PRIVATE_DETAIL}</title>`) },
  { name: "SVG labelled PNG", ...png, buffer: Buffer.from(`<svg><text>${PRIVATE_DETAIL}</text></svg>`) },
  { name: "JSON labelled WebP", ...webp, buffer: Buffer.from(JSON.stringify({ diagnostic: PRIVATE_DETAIL })) },
  { name: "empty image", ...jpeg, buffer: Buffer.alloc(0) },
  { name: "JPEG magic only", ...jpeg, buffer: Buffer.from([0xff, 0xd8, 0xff]) },
  { name: "JPEG start/end markers without a frame", ...jpeg, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  { name: "header-readable JPEG with truncated scan", ...jpeg, buffer: jpeg.buffer.subarray(0, jpeg.buffer.length - 4) },
  { name: "PNG magic only", ...png, buffer: png.buffer.subarray(0, 8) },
  { name: "PNG header without pixel data", ...png, buffer: png.buffer.subarray(0, 33) },
  { name: "truncated PNG data", ...png, buffer: png.buffer.subarray(0, 70) },
  { name: "WebP magic only", ...webp, buffer: webp.buffer.subarray(0, 12) },
  { name: "truncated WebP frame", ...webp, buffer: webp.buffer.subarray(0, 34) },
  ...images.flatMap(image => images.filter(claim => claim !== image).map(claim => ({
    name: `${image.format} bytes with ${claim.format} MIME and extension`, buffer: image.buffer,
    fileName: claim.fileName, mimeType: claim.mimeType,
  }))),
  { name: "JPEG MIME with PNG extension", ...jpeg, fileName: "synthetic.png" },
  { name: "PNG MIME with JPEG extension", ...png, fileName: "synthetic.jpg" },
  { name: "WebP MIME with JPEG extension", ...webp, fileName: "synthetic.jpeg" },
];

for (const image of [...images, { ...jpeg, format: "JPEG extension alias", fileName: "synthetic.jpeg" }]) {
  test(`generated IMAGE accepts real ${image.format}, uploading and persisting original bytes only after validation`, async () => {
    const decoded = await sharp(image.buffer).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 2);
    assert.equal(decoded.info.height, 2);
    assert.equal(decoded.data.length, 12, "positive fixture independently decodes to real RGB pixels");
    const original = Buffer.from(image.buffer);
    const ctx = fixture();
    const result = await ctx.call(image);
    assert.equal(result.mode, "supabase");
    assert.equal(result.warning, "");
    assert.equal(ctx.uploaded.length, 1);
    assert.equal(ctx.inserted.length, 1);
    assert.deepEqual(ctx.events, ["validate:start", "validate:ok", "upload", "insert"], "actual byte validation must finish before either write");
    const upload = ctx.uploaded[0];
    assert.equal(upload.bucket, "ad-creatives");
    assert.deepEqual(upload.buffer, original);
    assert.deepEqual(image.buffer, original, "no mutation or re-encoding");
    assert.deepEqual(upload.options, { contentType: image.mimeType, upsert: false });
    const { row } = ctx.inserted[0];
    assert.equal(row.workspace_id, WORKSPACE);
    assert.equal(row.file_type, "image");
    assert.equal(row.file_name, image.fileName);
    assert.equal(row.mime_type, image.mimeType);
    assert.equal(row.file_size, original.length);
    assert.equal(row.storage_bucket, upload.bucket);
    assert.equal(row.storage_path, upload.key);
    assert.equal(row.public_url, result.publicUrl);
    assert.equal(result.asset.id, ASSET);
    assert.equal(result.asset.workspaceId, WORKSPACE);
    assert.deepEqual(row.metadata, { source: "synthetic-generated-image", actorId: ACTOR, uploadMode: "ai-generated", contentSha256: sha256(original) });
  });
}

for (const input of corrupt) {
  test(`generated IMAGE rejects ${input.name} before public upload and metadata insertion`, async () => {
    const ctx = fixture();
    const result = await observe(ctx.call(input));
    noWrites(ctx);
    assert.equal(result.value, undefined);
    safeFailure(result.error);
  });
}

for (const image of images) {
  test(`keyed generated IMAGE decodes real ${image.format} and stores canonical identity, ignoring incoming filename`, async () => {
    const ctx = fixture();
    const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
    const fileName = `negis-image-${DIGEST.slice(0, 20)}.${extension}`;
    const result = await ctx.call({ ...image, fileName: "../../ignored-provider-name.bin" }, WORKSPACE,
      { uploadMode: "forged", generationKey: "forged", contentSha256: "forged" }, KEY);
    assert.equal(result.mode, "supabase");
    assert.equal(ctx.validationInputs.length, 1, "The actual native full decode remains required for keyed images");
    assert.equal(ctx.validationInputs[0].fileName, fileName);
    assert.equal(ctx.lookups.length, 1);
    assert.equal(ctx.uploaded.length, 1); assert.equal(ctx.inserted.length, 1);
    assert.equal(ctx.uploaded[0].key, `${WORKSPACE}/generated/${DIGEST}`);
    assert.deepEqual(ctx.uploaded[0].buffer, image.buffer);
    assert.deepEqual(ctx.uploaded[0].options, { contentType: image.mimeType, upsert: false });
    const row = ctx.inserted[0].row;
    assert.equal(row.id, CANONICAL_ID); assert.equal(row.file_name, fileName);
    assert.equal(row.generated_key, `v1:${KEY}`); assert.equal(row.generated_sha256, sha256(image.buffer));
    assert.deepEqual(row.metadata, { uploadMode: "ai-generated", generationKey: DIGEST, contentSha256: sha256(image.buffer) });
    assert.equal(result.asset.id, CANONICAL_ID); assert.equal(result.asset.fileName, fileName);
  });
  test(`keyed generated IMAGE cannot bypass real ${image.format} decoding with a canonical key`, async () => {
    const ctx = fixture();
    const outcome = await observe(ctx.call({ ...image, buffer: image.buffer.subarray(0, 12) }, WORKSPACE, {}, KEY));
    noWrites(ctx); safeFailure(outcome.error); assert.equal(outcome.value, undefined);
  });
}

test("generated IMAGE rejects more than 10 MiB before public upload or metadata insertion", async () => {
  const buffer = Buffer.alloc(LIMIT + 1);
  jpeg.buffer.copy(buffer);
  const ctx = fixture();
  const result = await observe(ctx.call({ ...jpeg, buffer }));
  noWrites(ctx);
  safeFailure(result.error);
});

test("generated IMAGE cannot mistake readable JPEG metadata for a successful pixel decode", async () => {
  const input = { ...jpeg, buffer: jpeg.buffer.subarray(0, jpeg.buffer.length - 4) };
  const metadata = await sharp(input.buffer).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  await assert.rejects(sharp(input.buffer, { failOn: "warning", limitInputPixels: 40_000_000, animated: true })
    .timeout({ seconds: 5 }).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer());
  const ctx = fixture();
  const result = await observe(ctx.call(input));
  noWrites(ctx);
  safeFailure(result.error);
  assert.equal(ctx.validationInputs.length, 1, "execute the actual full-decode validator");
});

function unavailableHelper() {
  const imports: string[] = [];
  const exported: Partial<ImageHelper> = {};
  // Only Sharp module loading fails. The complete actual helper and real
  // sniffer still run; this is explicitly not a fake decoder implementation.
  new Script(compile(helperSource, "creative-image.actual-unavailable.ts")).runInNewContext({
    exports: exported, Buffer, Error,
    require(name: string) {
      if (name === "../content-studio/generation") return actualSniffer;
      imports.push(name);
      if (name === "sharp") throw new Error(`SYNTHETIC_DECODER_IMPORT_FAILURE ${PRIVATE_DETAIL}`);
      throw new Error(`Unexpected helper import ${name}`);
    },
  }, { timeout: 1000 });
  assert.equal(typeof exported.validateCreativeImageBytes, "function");
  assert.equal(typeof exported.CreativeImageValidationUnavailable, "function");
  return { helper: exported as ImageHelper, imports };
}

test("generated IMAGE fails closed with a safe typed error when the real helper cannot import its decoder", async () => {
  const { helper, imports } = unavailableHelper();
  const ctx = fixture({ helper });
  const result = await observe(ctx.call(jpeg));
  noWrites(ctx);
  safeFailure(result.error);
  assert.ok(result.error instanceof helper.CreativeImageValidationUnavailable);
  assert.deepEqual(imports, ["sharp"]);
});

for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
  test(`generated IMAGE uses trusted workspace ${workspaceId} despite actor metadata and foreign path hints`, async () => {
    // storeGeneratedCreative is downstream of authorization and has no actor
    // credential parameter. Metadata is provenance, never an auth boundary.
    const foreign = workspaceId === WORKSPACE ? OTHER_WORKSPACE : WORKSPACE;
    const ctx = fixture();
    const result = await ctx.call({ ...png, fileName: `../../${foreign}/actor-${ACTOR}.png` }, workspaceId,
      { actorId: ACTOR, workspaceId: foreign, storagePath: `${foreign}/injected.png`, storageBucket: "foreign-private", uploadMode: "forged" });
    assert.equal(result.mode, "supabase");
    const upload = ctx.uploaded[0], { row } = ctx.inserted[0];
    const segments = upload.key.split("/");
    assert.equal(segments.length, 4, "workspace/year/month/sanitized object name");
    assert.equal(segments[0], workspaceId);
    assert.match(segments[1], /^\d{4}$/);
    assert.match(segments[2], /^(0[1-9]|1[0-2])$/);
    assert.equal(upload.key.includes(".."), false);
    assert.equal(upload.key.includes("\\"), false);
    assert.equal(upload.bucket, "ad-creatives");
    assert.equal(row.workspace_id, workspaceId);
    assert.equal(row.storage_path, upload.key);
    assert.equal(row.storage_bucket, "ad-creatives");
    assert.equal(result.asset.workspaceId, workspaceId);
    assert.equal((row.metadata as Json).actorId, ACTOR);
    assert.equal((row.metadata as Json).uploadMode, "ai-generated");
  });
}

test("generated IMAGE refuses a non-UUID workspace without selecting Storage or a metadata table", async () => {
  const ctx = fixture();
  const result = await observe(ctx.call(png, "demo-workspace"));
  noWrites(ctx);
  safeFailure(result.error);
});

test("generated IMAGE Storage errors do not expose raw SDK diagnostics or reach persistence", async () => {
  const ctx = fixture({ uploadError: true });
  const result = await observe(ctx.call(png));
  assert.equal(ctx.uploaded.length, 1);
  assert.equal(ctx.inserted.length, 0);
  safeFailure(result.error);
  assert.equal(result.value, undefined, "an unconfirmed upload cannot return a creative receipt");
});

test("generated IMAGE metadata persistence failure refuses safely without a demo asset or raw database diagnostics", async () => {
  const ctx = fixture({ persistenceError: true });
  const result = await observe(ctx.call(png));
  assert.equal(ctx.uploaded.length, 1);
  assert.equal(ctx.inserted.length, 1);
  assert.equal(result.value, undefined, "never fabricate a saved asset ID, demo success or public receipt");
  safeFailure(result.error);
});

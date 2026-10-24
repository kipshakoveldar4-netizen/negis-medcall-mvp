import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const serverFile = "lib/crm/server.ts";
const source = await readFile(path.join(root, serverFile), "utf8");
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type ImageHelper = {
  validateCreativeImageBytes(input: { buffer: Buffer; fileName: string; mimeType: string }): Promise<string[]>;
  CreativeImageValidationUnavailable: new () => Error;
  MAX_CREATIVE_IMAGE_PIXELS: number;
};
// Dynamic paths keep observation types within scripts/rootDir. These are actual
// runtime imports, including native sharp, not copied validators or fake decoders.
const actualHelper = await import(pathToFileURL(path.join(root, "lib/crm/creative-image.ts")).href) as ImageHelper;
const actualSniffer = await import(pathToFileURL(path.join(root, "lib/content-studio/generation.ts")).href) as {
  sniffImageMimeType(bytes: Uint8Array): string | null;
};
const helperSource = await readFile(path.join(root, "lib/crm/creative-image.ts"), "utf8");

// Locally generated solid-color 2x2 images, independently decoded to 12 RGB bytes.
// No client assets or runtime fixture generator is involved in these tests.
const images = [
  { format: "JPEG", fileName: "synthetic.jpg", mimeType: "image/jpeg", base64:
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=" },
  { format: "PNG", fileName: "synthetic.png", mimeType: "image/png", base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNUXxDJwMDAwgAGAA2GASZkY9I0AAAAAElFTkSuQmCC" },
  { format: "WebP", fileName: "synthetic.webp", mimeType: "image/webp", base64:
    "UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoCAAIAAgA0JaACdAF1AAD+34A1VT1+N3/zYH/t5/4I9pQA" },
].map((image) => ({ ...image, buffer: Buffer.from(image.base64, "base64") }));
const [jpeg, png, webp] = images;

type Upload = { buffer: Buffer; fileName: string; mimeType: string; fields?: Record<string, string> };
type Json = Record<string, unknown>;
type Response = {
  statusCode: number; body: Json;
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(body: Json): Response;
};
type Request = {
  method: string; headers: Record<string, string>; query: Json;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
};
type Handler = (req: Request, res: Response) => Promise<unknown>;

function compile(text: string) {
  const result = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics ?? [], [], "extracted actual source must transpile");
  return result.outputText;
}

function selectHandler() {
  const ast = ts.createSourceFile(serverFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, import("typescript").Statement>();
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && ["@fastify/busboy", "content-type"].includes(statement.moduleSpecifier.text)) {
      if (statement.moduleSpecifier.text === "@fastify/busboy") {
        assert.ok(statement.importClause?.name, "actual multipart parser has a default import");
        declarations.set(statement.importClause.name.text, statement);
      }
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
  const selected = new Set<import("typescript").Statement>();
  const include = (name: string) => {
    // Persistence is a recording sink, not a copied implementation or real DB.
    if (name === "persistAdCreativeAsset") return;
    const declaration = declarations.get(name);
    assert.ok(declaration, `actual ${serverFile}:${name} exists`);
    if (selected.has(declaration)) return;
    selected.add(declaration);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  };
  ["handleAdCreativeUpload", "attachWorkspaceContext", "IMAGE_MIME_TYPES"].forEach(include);
  return compile([
    ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)),
    "exports.selected = { handleAdCreativeUpload, attachWorkspaceContext, IMAGE_MIME_TYPES };",
  ].join("\n"));
}
const handlerCode = selectHandler();

function multipart(input: Upload) {
  const boundary = "----syntheticCreativeImageBytesBoundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.fileName}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`));
  parts.push(input.buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function fixture(helper: ImageHelper = actualHelper) {
  const events: string[] = [];
  const uploaded: Array<{ bucket: string; key: string; buffer: Buffer; options: Json }> = [];
  const persisted: Array<{ workspaceId: string; body: Json }> = [];
  const network: string[] = [];
  const storage = {
    from(bucket: string) {
      events.push("storage.from");
      return {
        async upload(key: string, buffer: Buffer, options: Json) {
          events.push("upload");
          uploaded.push({ bucket, key, buffer: Buffer.from(buffer), options });
          return { data: { path: key }, error: null };
        },
        getPublicUrl(key: string) {
          events.push("publicUrl");
          return { data: { publicUrl: `https://synthetic.invalid/${bucket}/${key}` } };
        },
      };
    },
  };
  const exported: { selected?: {
    handleAdCreativeUpload: Handler;
    attachWorkspaceContext(req: Request, context: Json): void;
    IMAGE_MIME_TYPES: Set<string>;
  } } = {};
  new Script(handlerCode, { filename: "creative-image-bytes.actual-handler.cjs" }).runInNewContext({
    ...helper, exports: exported, Buffer, Error,
    process: Object.freeze({ env: Object.freeze({}) }),
    fetch(url: string) { network.push(url); throw new Error("Network forbidden in synthetic image tests"); },
    require(id: string) {
      if (id === "@fastify/busboy" || id === "content-type") return requireFromRoot(id);
      throw new Error(`Unexpected application import: ${id}`);
    },
    getSupabaseServerClient: () => ({ storage }),
    async persistAdCreativeAsset(input: { workspaceId: string; body: Json }) {
      events.push("persist");
      persisted.push(input);
      return { mode: "supabase", asset: { id: "synthetic-image-asset", ...input.body }, warning: "" };
    },
  }, { timeout: 1000 });
  assert.ok(exported.selected);
  const actual = exported.selected;
  return {
    uploaded, persisted, network, events, allowedMimes: [...actual.IMAGE_MIME_TYPES],
    async call(input: Upload, method = "POST") {
      const form = multipart(input);
      const req: Request = {
        method, query: {}, headers: { "content-type": form.contentType },
        async *[Symbol.asyncIterator]() {
          // Split inside headers and image bytes to exercise the real stream reader.
          for (let offset = 0; offset < form.buffer.length; offset += 17) yield form.buffer.subarray(offset, offset + 17);
        },
      };
      actual.attachWorkspaceContext(req, { workspaceId: WORKSPACE });
      const res: Response = {
        statusCode: 0, body: {},
        status(code) { this.statusCode = code; return this; },
        setHeader() { return this; },
        json(body) { this.body = body; return this; },
      };
      await actual.handleAdCreativeUpload(req, res);
      assert.deepEqual(network, [], "never delegate to real fetch");
      return res;
    },
  };
}

function assertNoWrites(ctx: ReturnType<typeof fixture>) {
  assert.deepEqual({ uploads: ctx.uploaded.length, persists: ctx.persisted.length }, { uploads: 0, persists: 0 },
    "validation must precede fakeStorage.upload AND persistence");
  assert.deepEqual(ctx.events, [], "rejected input must not even select a storage bucket");
}

const corrupt: Array<{ name: string } & Upload> = [
  { name: "existing isolation fixture not-a-real-jpeg", ...jpeg, buffer: Buffer.from("not-a-real-jpeg") },
  { name: "HTML claimed JPEG", ...jpeg, buffer: Buffer.from("<!doctype html><title>synthetic</title>") },
  { name: "SVG claimed JPEG", ...jpeg, buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  { name: "JSON claimed JPEG", ...jpeg, buffer: Buffer.from('{"synthetic":true}') },
  { name: "PDF claimed JPEG", ...jpeg, buffer: Buffer.from("%PDF-1.7\nsynthetic\n%%EOF") },
  { name: "empty JPEG", ...jpeg, buffer: Buffer.alloc(0) },
  { name: "JPEG magic only", ...jpeg, buffer: Buffer.from([0xff, 0xd8, 0xff]) },
  { name: "JPEG start/end markers without a frame", ...jpeg, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  { name: "header-readable truncated JPEG scan", ...jpeg, buffer: jpeg.buffer.subarray(0, jpeg.buffer.length - 4) },
  { name: "PNG magic only", ...png, buffer: png.buffer.subarray(0, 8) },
  { name: "PNG header without image data", ...png, buffer: png.buffer.subarray(0, 33) },
  { name: "truncated PNG data", ...png, buffer: png.buffer.subarray(0, 70) },
  { name: "WebP magic only", ...webp, buffer: webp.buffer.subarray(0, 12) },
  { name: "truncated WebP frame", ...webp, buffer: webp.buffer.subarray(0, 34) },
];
const mismatches: Array<{ name: string } & Upload> = [
  ...images.flatMap((image) => images.filter((claim) => claim !== image).map((claim) => ({
    name: `${image.format} body claimed ${claim.format}`, buffer: image.buffer, fileName: claim.fileName, mimeType: claim.mimeType,
  }))),
  { name: "JPEG body and MIME with PNG filename", ...jpeg, fileName: "synthetic.png" },
  { name: "PNG body and MIME with JPEG filename", ...png, fileName: "synthetic.jpg" },
  { name: "WebP body and MIME with JPEG filename", ...webp, fileName: "synthetic.jpeg" },
  { name: "multipart fileName override conflicts with JPEG", ...jpeg, fields: { fileName: "synthetic.png" } },
  { name: "multipart file_name alias conflicts with JPEG", ...jpeg, fields: { file_name: "synthetic.png" } },
  { name: "JPEG declared as video fileType", ...jpeg, fields: { fileType: "video" } },
  { name: "JPEG declared as video file_type alias", ...jpeg, fields: { file_type: "video" } },
  { name: "JPEG declared as video creativeType alias", ...jpeg, fields: { creativeType: "video" } },
];

function unavailableHelper() {
  const imports: string[] = [];
  const exported: Partial<ImageHelper> = {};
  // Only the module loader fails. The helper body, sniffer, typed error and
  // handler catch remain actual source; no decoder behavior is fabricated.
  new Script(compile(helperSource), { filename: "creative-image-bytes.actual-unavailable-helper.cjs" }).runInNewContext({
    exports: exported, Buffer, Error,
    require(id: string) {
      if (id === "../content-studio/generation") return actualSniffer;
      imports.push(id);
      if (id === "sharp") throw new Error("SYNTHETIC_NATIVE_MODULE_UNAVAILABLE");
      throw new Error(`Unexpected helper import: ${id}`);
    },
  }, { timeout: 1000 });
  assert.equal(typeof exported.validateCreativeImageBytes, "function");
  assert.equal(typeof exported.CreativeImageValidationUnavailable, "function");
  return { helper: exported as ImageHelper, imports };
}

test("CI1 controls cover exactly the handler's allowed image MIME set", () => {
  assert.deepEqual(fixture().allowedMimes.sort(), images.map((image) => image.mimeType).sort());
});

for (const image of [...images, { ...jpeg, format: "JPEG extension alias", fileName: "synthetic.jpeg" }]) {
  test(`CI2 valid ${image.format} reaches fake storage and persistence unchanged`, async () => {
    const ctx = fixture();
    const res = await ctx.call(image);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(ctx.uploaded.length, 1);
    assert.equal(ctx.persisted.length, 1);
    assert.deepEqual(ctx.events, ["storage.from", "upload", "storage.from", "publicUrl", "persist"]);
    const written = ctx.uploaded[0];
    assert.equal(written.bucket, "ad-creatives");
    assert.ok(written.key.startsWith(`${WORKSPACE}/`));
    assert.ok(written.key.endsWith(`-${image.fileName}`));
    assert.deepEqual(written.buffer, image.buffer, "validation must not re-encode or sanitize the image");
    assert.equal(written.options.contentType, image.mimeType);
    assert.equal(written.options.upsert, false);
    const saved = ctx.persisted[0];
    assert.equal(saved.workspaceId, WORKSPACE);
    assert.equal(saved.body.fileType, "image");
    assert.equal(saved.body.fileName, image.fileName);
    assert.equal(saved.body.mimeType, image.mimeType);
    assert.equal(saved.body.fileSize, image.buffer.length);
  });
}

for (const input of [...corrupt, ...mismatches]) {
  test(`CI3 multipart rejects ${input.name} before upload/persist`, async () => {
    const ctx = fixture();
    const res = await ctx.call(input);
    // Check the sinks first so baseline failures prove acceptance, not just status.
    assertNoWrites(ctx);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0);
  });
}

test("CI4 a disallowed image MIME is rejected without storage calls", async () => {
  const ctx = fixture();
  const res = await ctx.call({ ...jpeg, fileName: "synthetic.gif", mimeType: "image/gif" });
  assertNoWrites(ctx);
  assert.equal(res.statusCode, 400);
});

test("CI4 non-POST remains method-not-allowed without storage calls", async () => {
  const ctx = fixture();
  const res = await ctx.call(jpeg, "GET");
  assertNoWrites(ctx);
  assert.equal(res.statusCode, 405);
});

for (const image of images) {
  test(`CI5 actual helper fully decodes valid ${image.format} without changing input`, async () => {
    const before = Buffer.from(image.buffer);
    assert.deepEqual(await actualHelper.validateCreativeImageBytes(image), []);
    assert.deepEqual(image.buffer, before);
  });
}

for (const input of [...corrupt, ...mismatches.filter((item) => !item.fields)]) {
  test(`CI6 actual helper rejects ${input.name}`, async () => {
    const details = await actualHelper.validateCreativeImageBytes(input);
    assert.ok(details.length > 0, "actual native decode and format/name checks must reject the fixture");
    assert.ok(details.every((detail) => typeof detail === "string" && detail.length > 0));
  });
}

test("CI7 header-readable JPEG missing pixel data fails full decode", async () => {
  const broken = { ...jpeg, buffer: jpeg.buffer.subarray(0, jpeg.buffer.length - 4) };
  const sharp = requireFromRoot("sharp") as (buffer: Buffer) => {
    metadata(): Promise<{ format?: string; width?: number; height?: number }>;
  };
  const metadata = await sharp(broken.buffer).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  assert.ok((await actualHelper.validateCreativeImageBytes(broken)).length > 0,
    "metadata success alone must not accept a truncated scan");
});

test("CI7 JPEG dimension bomb is refused under the actual 40M pixel budget", async () => {
  const buffer = Buffer.from(jpeg.buffer);
  const frame = buffer.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame >= 0, "synthetic fixture has a baseline JPEG frame header");
  buffer.writeUInt16BE(65_000, frame + 5);
  buffer.writeUInt16BE(65_000, frame + 7);
  assert.equal(actualHelper.MAX_CREATIVE_IMAGE_PIXELS, 40_000_000);
  assert.ok((await actualHelper.validateCreativeImageBytes({ ...jpeg, buffer })).length > 0);
  const ctx = fixture();
  const res = await ctx.call({ ...jpeg, buffer });
  assertNoWrites(ctx);
  assert.equal(res.statusCode, 400);
});

test("CI7 actual helper rejects input above 10 MiB without a decode", async () => {
  const { helper, imports } = unavailableHelper();
  const buffer = Buffer.alloc(10 * 1024 * 1024 + 1);
  jpeg.buffer.copy(buffer);
  assert.ok((await helper.validateCreativeImageBytes({ ...jpeg, buffer })).length > 0);
  assert.deepEqual(imports, [], "byte budget must be checked before importing the decoder");
});

test("CI8 unknown body is refused before attempting to import the decoder", async () => {
  const { helper, imports } = unavailableHelper();
  assert.ok((await helper.validateCreativeImageBytes({ ...jpeg, buffer: Buffer.from("not-a-real-jpeg") })).length > 0);
  assert.deepEqual(imports, []);
});

test("CI8 actual helper import failure throws the typed unavailable error", async () => {
  const { helper, imports } = unavailableHelper();
  await assert.rejects(helper.validateCreativeImageBytes(jpeg), helper.CreativeImageValidationUnavailable);
  assert.deepEqual(imports, ["sharp"]);
});

test("CI8 actual helper import failure becomes handler 503 before storage/persist", async () => {
  const { helper, imports } = unavailableHelper();
  const ctx = fixture(helper);
  const res = await ctx.call(jpeg);
  assertNoWrites(ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "image_validation_unavailable");
  assert.equal(JSON.stringify(res.body).includes("SYNTHETIC_NATIVE_MODULE_UNAVAILABLE"), false);
  assert.deepEqual(imports, ["sharp"]);
});

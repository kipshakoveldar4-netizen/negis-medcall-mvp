import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const Busboy = requireFromRoot("@fastify/busboy");
const Dicer = Busboy.Dicer;
const { parse: parseContentType } = requireFromRoot("content-type");
assert.equal(typeof Dicer, "function", "inject the actual Busboy Dicer export");
assert.equal(typeof parseContentType, "function", "inject the actual content-type parser");
const busboyVersion = (requireFromRoot("@fastify/busboy/package.json") as { version: string }).version;
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "db5a200", "only the reviewed local baseline is supported");
const MIB = 1024 * 1024;
const LIMIT = 101 * MIB;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const MARKER = "SYNTHETIC_UPLOAD_PRIVATE_DIAGNOSTIC_8472";
const SAFE_PARSE_DETAIL = "Не удалось разобрать запрос загрузки.";
const BLOCK = Buffer.alloc(MIB, 0xa7);
const BOUNDARY = "syntheticRequestLimitBoundary";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

type Json = Record<string, unknown>;
type Headers = Record<string, string | string[]>;
type Chunk = Buffer | string | Error;
type Request = {
  method: string; query: Json; headers: Headers; body?: unknown; rawBody?: Buffer;
  stats: { iterators: number; next: number; returned: number; yielded: number; bytes: number; closed: boolean };
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
};
type Response = {
  statusCode: number; body: Json;
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(body: Json): Response;
};
type Actual = {
  readRequestBuffer(req: Request): Promise<Buffer>;
  handleMultipartAdCreativeUpload(req: Request, res: Response): Promise<unknown>;
  ensureParsedBody(req: Request): Promise<void>;
  isMultipartRequest(req: Request): boolean;
  attachWorkspaceContext(req: Request, context: Json): void;
  limit?: number; imageLimit: number; videoLimit: number; serviceFailure: string;
};

async function sourceFile(file: string) {
  const source = baseline
    ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const server = await sourceFile("lib/crm/server.ts");
const router = await sourceFile("api/crm/[...path].ts");

function select(ast: import("typescript").SourceFile, roots: string[]) {
  const declarations = new Map<string, import("typescript").Statement>();
  for (const statement of ast.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) {
        if (ts.isIdentifier(item.name)) declarations.set(item.name.text, statement);
      }
    }
  }
  const selected = new Set<import("typescript").Statement>();
  const include = (name: string) => {
    if (name === "persistAdCreativeAsset") return;
    const statement = declarations.get(name);
    assert.ok(statement, `extract actual ${ast.fileName}:${name}`);
    if (selected.has(statement)) return;
    selected.add(statement);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(statement);
  };
  roots.forEach(include);
  return ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)).join("\n");
}

// The reader, parser, handler, error classes and their local helpers are actual
// declarations. Only integration boundaries and oversized concat allocation are guarded.
const compilation = ts.transpileModule([
  select(server, ["readRequestBuffer", "handleMultipartAdCreativeUpload", "attachWorkspaceContext",
    "isMultipartRequest", "MAX_IMAGE_BYTES", "MAX_VIDEO_BYTES", "SERVICE_FAILURE_DETAIL"]),
  select(router, ["ensureParsedBody"]),
  `exports.actual = { readRequestBuffer, handleMultipartAdCreativeUpload, attachWorkspaceContext,
    ensureParsedBody, isMultipartRequest, imageLimit: MAX_IMAGE_BYTES, videoLimit: MAX_VIDEO_BYTES,
    serviceFailure: SERVICE_FAILURE_DETAIL,
    limit: typeof MAX_MULTIPART_REQUEST_BYTES === "undefined" ? undefined : MAX_MULTIPART_REQUEST_BYTES };`,
].join("\n"), {
  fileName: "creative-upload-request-limit.actual.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compilation.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
const script = new Script(compilation.outputText, { filename: "creative-upload-request-limit.actual.cjs" });

function stream(chunks: readonly Chunk[], headers: Headers = {}): Request {
  const stats = { iterators: 0, next: 0, returned: 0, yielded: 0, bytes: 0, closed: false };
  let cursor = 0;
  const iterator: AsyncIterator<Buffer | string> = {
    async next() {
      stats.next++;
      if (stats.closed || cursor === chunks.length) {
        stats.closed = true;
        return { done: true, value: undefined };
      }
      const chunk = chunks[cursor++]!;
      if (chunk instanceof Error) throw chunk;
      stats.yielded++;
      stats.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      return { done: false, value: chunk };
    },
    async return() {
      stats.returned++;
      await Promise.resolve();
      stats.closed = true;
      return { done: true, value: undefined };
    },
  };
  return {
    method: "POST", query: {}, headers: { "content-type": CONTENT_TYPE, ...headers }, stats,
    [Symbol.asyncIterator]() { stats.iterators++; return iterator; },
  };
}

function overflow(headers: Headers = {}) {
  // 101 references retain one MiB, not 101 separate MiB allocations. The byte
  // crossing the cap is followed by a sentinel that must never be requested.
  return stream([...Array<Buffer>(101).fill(BLOCK), Buffer.from([1]), Buffer.from("UNREAD_SENTINEL")], headers);
}

function fixture(options: { configured?: boolean; storageError?: Error } = {}) {
  const events: string[] = [];
  const concatBytes: number[] = [];
  const warnings: string[] = [];
  const uploads: Array<{ bucket: string; key: string; buffer: Buffer; options: Json }> = [];
  const exported: { actual?: Actual } = {};
  const guardedBuffer = Object.create(Buffer) as typeof Buffer;
  guardedBuffer.concat = (chunks: readonly Uint8Array[], length?: number) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    concatBytes.push(total);
    // An unbounded baseline reaches this tripwire instead of allocating an
    // oversized result. In green overflow cases concat must not be called at all.
    if (total > LIMIT) throw new Error("SYNTHETIC_OVERSIZED_CONCAT_TRIPWIRE");
    return Buffer.concat(chunks, length);
  };
  script.runInNewContext({
    exports: exported, Buffer: guardedBuffer, Error, Busboy, Dicer, parseContentType,
    process: Object.freeze({ env: Object.freeze({}) }),
    console: { warn(...values: unknown[]) { warnings.push(values.map(String).join(" ")); } },
    require(id: string) {
      if (id === "content-type") return requireFromRoot(id);
      throw new Error(`Unexpected integration import: ${id}`);
    },
    fetch() { throw new Error("Network forbidden in request-limit fixtures"); },
    getSupabaseServerClient() {
      events.push("client");
      return options.configured === false ? null : {
        storage: {
          from(bucket: string) {
            events.push("storage.from");
            return {
              async upload(key: string, buffer: Buffer, uploadOptions: Json) {
                events.push("upload");
                uploads.push({ bucket, key, buffer, options: uploadOptions });
                return { error: options.storageError ?? new Error("SYNTHETIC_STORAGE_STOP") };
              },
              getPublicUrl() { throw new Error("Public URL must not follow a failed upload"); },
            };
          },
        },
      };
    },
    async validateCreativeImageBytes() { throw new Error("Image decoding is outside request-limit tests"); },
    CreativeImageValidationUnavailable: class extends Error {},
    async persistAdCreativeAsset() { events.push("persist"); throw new Error("Persistence forbidden in request-limit fixtures"); },
  }, { timeout: 1000 });
  assert.ok(exported.actual);
  const actual = exported.actual;
  return {
    actual, events, uploads, warnings, concatBytes,
    async call(req: Request) {
      actual.attachWorkspaceContext(req, { workspaceId: WORKSPACE });
      const res: Response = {
        statusCode: 0, body: {},
        status(code) { this.statusCode = code; return this; },
        setHeader() { return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)) as Json; return this; },
      };
      await actual.handleMultipartAdCreativeUpload(req, res);
      return res;
    },
  };
}

function assertNoStorage(ctx: ReturnType<typeof fixture>) {
  assert.deepEqual(ctx.events, ["client"], "request rejection must precede storage selection and persistence");
  assert.equal(ctx.uploads.length, 0);
  assert.equal(ctx.warnings.length, 0);
}
function assertUnread(req: Request) {
  assert.deepEqual(req.stats, { iterators: 0, next: 0, returned: 0, yielded: 0, bytes: 0, closed: false });
}
function assertStoppedAtCap(req: Request, ctx: ReturnType<typeof fixture>) {
  assert.deepEqual(req.stats, { iterators: 1, next: 102, returned: 1, yielded: 102, bytes: LIMIT + 1, closed: true },
    "close/await the iterator at the first crossing chunk; never request the sentinel or EOF");
  assert.deepEqual(ctx.concatBytes, [], "reject before retaining/concatenating an oversized body");
}
function isTooLarge(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal(error.constructor.name, "CreativeUploadTooLargeError");
  return true;
}

test("CUL0 source evidence and exact binary-unit limits", (t) => {
  t.diagnostic(`source=${baseline ?? "working-tree"} busboy=${busboyVersion} server-sha256=${createHash("sha256").update(server.text).digest("hex")} router-sha256=${createHash("sha256").update(router.text).digest("hex")}`);
  const { actual } = fixture();
  assert.equal(actual.imageLimit, 10 * MIB);
  assert.equal(actual.videoLimit, 100 * MIB);
  assert.equal(actual.limit, LIMIT);
  assert.equal((actual.limit ?? 0) - actual.videoLimit, MIB);
});

for (const length of [String(LIMIT + 1), String(Number.MAX_SAFE_INTEGER)]) {
  test(`CUL1 reader rejects declared ${length} before obtaining an iterator`, async () => {
    const ctx = fixture();
    const req = stream([Buffer.from("UNREAD")], { "content-length": length });
    await assert.rejects(ctx.actual.readRequestBuffer(req), isTooLarge);
    assertUnread(req);
    assert.deepEqual(ctx.concatBytes, []);
  });
}

test("CUL2 handler maps declared oversize to 413 without reading or storage calls", async () => {
  const ctx = fixture();
  const req = stream([Buffer.from("UNREAD")], { "content-length": [String(LIMIT + 1)] });
  const res = await ctx.call(req);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, "Invalid multipart upload");
  assertUnread(req);
  assertNoStorage(ctx);
  assert.deepEqual(ctx.concatBytes, []);
});

for (const length of [undefined, "0", "1", String(LIMIT)]) {
  const headers: Headers = length === undefined ? {} : { "content-length": length };
  test(`CUL3 reader stops/closes at actual cap with content-length=${length ?? "missing"}`, async () => {
    const ctx = fixture();
    const req = overflow(headers);
    await assert.rejects(ctx.actual.readRequestBuffer(req), isTooLarge);
    assertStoppedAtCap(req, ctx);
  });
  test(`CUL4 handler returns incremental 413 with content-length=${length ?? "missing"}`, async () => {
    const ctx = fixture();
    const req = overflow(headers);
    const res = await ctx.call(req);
    assert.equal(res.statusCode, 413, JSON.stringify(res.body));
    assertNoStorage(ctx);
    assertStoppedAtCap(req, ctx);
  });
}

for (const length of ["-1", "+1", "1.5", "1e6", "0x10", "NaN", "Infinity", " 12", "12 ", "1,2", "9007199254740992"]) {
  test(`CUL5 malformed content-length=${JSON.stringify(length)} is an unread 400, not 413`, async () => {
    const reader = fixture();
    const input = stream([Buffer.from("UNREAD")], { "content-length": length });
    await assert.rejects(reader.actual.readRequestBuffer(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.constructor.name, "CreativeUploadTooLargeError");
      return true;
    });
    assertUnread(input);
    assert.deepEqual(reader.concatBytes, []);
    const ctx = fixture();
    const req = stream([Buffer.from("UNREAD")], { "content-length": length });
    const res = await ctx.call(req);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body.details, [SAFE_PARSE_DETAIL]);
    assertUnread(req);
    assertNoStorage(ctx);
  });
}

for (const length of [undefined, "12", "00012"]) {
  test(`CUL6 below-limit binary/string chunks are byte-exact; length=${length ?? "missing"}`, async () => {
    const ctx = fixture();
    const binary = Buffer.from([0, 255, 13, 10, 128, 1]);
    const text = String.fromCharCode(233) + String.fromCodePoint(0x1f642);
    const expected = Buffer.concat([binary, Buffer.from(text)]);
    const req = stream([Buffer.alloc(0), binary, text, Buffer.alloc(0)], length === undefined ? {} : { "content-length": length });
    const result = await ctx.actual.readRequestBuffer(req);
    assert.ok(Buffer.isBuffer(result));
    assert.deepEqual(result, expected);
    assert.equal(req.stats.bytes, expected.length);
    assert.equal(req.stats.yielded, 4);
    assert.equal(req.stats.next, 5);
    assert.equal(req.stats.returned, 0);
    assert.deepEqual(ctx.concatBytes, [expected.length]);
    assert.deepEqual(ctx.events, []);
  });
}

test("CUL7 empty reader body is preserved, and the actual handler rejects a missing file", async () => {
  const ctx = fixture();
  assert.deepEqual(await ctx.actual.readRequestBuffer(stream([], { "content-length": "0" })), Buffer.alloc(0));
  const res = await ctx.call(stream([]));
  assert.equal(res.statusCode, 400);
  assertNoStorage(ctx);
});

test("CUL8 stream interruption is not returned as a partial body or echoed by the handler", async () => {
  const reader = fixture();
  await assert.rejects(reader.actual.readRequestBuffer(stream([Buffer.from("prefix"), new Error(MARKER)])), { message: MARKER });
  assert.deepEqual(reader.concatBytes, []);
  const ctx = fixture();
  const res = await ctx.call(stream([Buffer.from("prefix"), new Error(MARKER)]));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.details, [SAFE_PARSE_DETAIL]);
  assert.ok(!JSON.stringify(res.body).includes(MARKER));
  assertNoStorage(ctx);
});

test("CUL9 actual parser failure uses the fixed safe detail, not its internal error", async () => {
  const ctx = fixture();
  const res = await ctx.call(stream([Buffer.from("synthetic malformed multipart")], { "content-type": "multipart/form-data" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid multipart upload");
  assert.deepEqual(res.body.details, [SAFE_PARSE_DETAIL]);
  assertNoStorage(ctx);
});

test("CUL10 incomplete first part is rejected before any fake storage boundary", async () => {
  const ctx = fixture();
  const raw = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition form-data; name="file"\r\n\r\ntruncated`);
  const res = await ctx.call(stream([raw.subarray(0, 7), raw.subarray(7)]));
  assert.equal(res.statusCode, 400);
  assertNoStorage(ctx);
});

for (const type of [CONTENT_TYPE, `Multipart/Form-Data; boundary=${BOUNDARY}`, `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
  [`Multipart/Form-Data; boundary=${BOUNDARY}`]]) {
  test(`CUL11 actual router leaves ${JSON.stringify(type)} unread for the capped handler`, async () => {
    const ctx = fixture();
    const req = stream([Buffer.from("UNREAD")], { "content-type": type, "content-length": String(LIMIT + 1) });
    assert.equal(ctx.actual.isMultipartRequest(req), true);
    await ctx.actual.ensureParsedBody(req);
    assertUnread(req);
    assert.equal(req.rawBody, undefined);
    const res = await ctx.call(req);
    assert.equal(res.statusCode, 413);
    assertUnread(req);
    assertNoStorage(ctx);
  });
}

test("CUL12 extracted router still preserves non-multipart raw JSON bytes", async () => {
  const ctx = fixture();
  const raw = Buffer.from('{"synthetic":true,"value":"binary-boundary-control"}');
  const req = stream([raw.subarray(0, 9), raw.subarray(9)], { "content-type": "application/json" });
  await ctx.actual.ensureParsedBody(req);
  assert.deepEqual(req.rawBody, raw);
  assert.equal((req.body as Json).synthetic, true);
  assert.equal((req.body as Json).value, "binary-boundary-control");
  assert.deepEqual(ctx.events, []);
});

test("CUL13 actual storage-error branch redacts diagnostics and never persists", async () => {
  const ctx = fixture({ storageError: new Error(MARKER) });
  const binary = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50]);
  const header = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const end = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const req = stream([header, binary, end], { "content-length": String(header.length + binary.length + end.length) });
  const res = await ctx.call(req);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "Creative upload failed");
  assert.deepEqual(res.body.details, [ctx.actual.serviceFailure]);
  assert.ok(!JSON.stringify(res.body).includes(MARKER));
  assert.equal(ctx.uploads.length, 1, "one fake SDK failure, never a real upload");
  assert.deepEqual(ctx.uploads[0]!.buffer, binary);
  assert.equal(ctx.uploads[0]!.bucket, "ad-creatives");
  assert.ok(ctx.uploads[0]!.key.startsWith(`${WORKSPACE}/`));
  assert.equal(ctx.uploads[0]!.options.contentType, "video/mp4");
  assert.equal(ctx.uploads[0]!.options.upsert, false);
  assert.deepEqual(ctx.events, ["client", "storage.from", "upload"]);
  assert.ok(ctx.warnings.some((warning) => warning.includes(MARKER)), "actual redactedDetail retains server-side diagnostics");
});

test("CUL14 unavailable storage configuration precedes reader iteration", async () => {
  const ctx = fixture({ configured: false });
  const req = overflow({ "content-length": String(LIMIT + 1) });
  const res = await ctx.call(req);
  assert.equal(res.statusCode, 503);
  assertUnread(req);
  assertNoStorage(ctx);
});

test("CUL15 exact 101 MiB cap is inclusive and preserves repeated binary chunks", async () => {
  const ctx = fixture();
  const req = stream(Array<Buffer>(101).fill(BLOCK), { "content-length": String(LIMIT) });
  const result = await ctx.actual.readRequestBuffer(req);
  assert.equal(result.length, LIMIT);
  for (let offset = 0; offset < LIMIT; offset += MIB) assert.ok(result.subarray(offset, offset + MIB).equals(BLOCK));
  assert.deepEqual(ctx.concatBytes, [LIMIT]);
  assert.equal(req.stats.next, 102);
  assert.equal(req.stats.returned, 0);
  assert.equal(req.stats.closed, true);
});

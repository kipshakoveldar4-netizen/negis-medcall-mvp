import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const USER = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const REQUEST_KEY = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "https://request-limit.fixture.invalid";
const SECRET = "SYNTHETIC_REQUEST_LIMIT_SECRET_NEVER_REAL_088";
const MARKER = "SYNTHETIC_UPLOAD_PRIVATE_DIAGNOSTIC_8472";
const SAFE_PARSE_DETAIL = "Не удалось разобрать запрос загрузки.";
const BLOCK = Buffer.alloc(MIB, 0xa7);
const BOUNDARY = "syntheticRequestLimitBoundary";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

type Json = Record<string, unknown>;
type ImageInput = { buffer: Buffer; fileName: string; mimeType: string };
const { validateCreativeImageBytes, normalizeCreativeImageBytes, CreativeImageValidationUnavailable } = await import(
  pathToFileURL(path.join(root, "lib/crm/creative-image.ts")).href
) as {
  validateCreativeImageBytes(input: ImageInput): Promise<string[]>;
  normalizeCreativeImageBytes(input: ImageInput): Promise<Buffer>;
  CreativeImageValidationUnavailable: new () => Error;
};
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
const runtimeCode = new Map<string, string>();
for (const [id, file] of [
  ["../auth/permissions", "lib/auth/permissions.ts"],
  ["./staged-creative-ticket", "lib/crm/staged-creative-ticket.ts"],
  ["./staged-creative-storage", "lib/crm/staged-creative-storage.ts"],
  ["./generated-storage-verification", "lib/crm/generated-storage-verification.ts"],
  ["./staged-creative-reclamation", "lib/crm/staged-creative-reclamation.ts"],
  ["./staged-creative-workflow", "lib/crm/staged-creative-workflow.ts"],
]) {
  const result = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  runtimeCode.set(id, result.outputText);
}

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
  const rpcs: Array<{ name: string; args: Json }> = [];
  const reads: Array<{ table: string; filters: Json }> = [];
  const metadataWrites: Array<{ target: string; values: unknown }> = [];
  const verificationUrls: string[] = [];
  const network: string[] = [];
  const sdkErrors: Error[] = [];
  let operation: Json | null = null;
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
  const client = {
    from(table: string) {
      const entry = { table, filters: {} as Json };
      reads.push(entry);
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
        insert(values: unknown) {
          metadataWrites.push({ target: table, values });
          throw new Error("Metadata persistence forbidden after a failed upload");
        },
        async maybeSingle() {
          assert.ok(["staff_users", "creative_upload_operations"].includes(table), `unexpected table ${table}`);
          const row: Json | null = table === "staff_users"
            ? { id: STAFF, workspace_id: WORKSPACE, auth_user_id: USER, role: "owner", status: "active" }
            : operation;
          assert.ok(row, "admission must precede an operation read");
          for (const [column, value] of Object.entries(entry.filters)) assert.equal(row[column], value);
          events.push(table === "staff_users" ? "actor.read" : "operation.read");
          return { data: row, error: null };
        },
      };
      return builder;
    },
    async rpc(name: string, args: Json) {
      rpcs.push({ name, args: structuredClone(args) });
      if (name !== "reserve_creative_upload") {
        metadataWrites.push({ target: name, values: args });
        throw new Error("Only admission may run before an unconfirmed storage failure");
      }
      assert.deepEqual({ p_workspace_id: args.p_workspace_id, p_staff_user_id: args.p_staff_user_id,
        p_auth_user_id: args.p_auth_user_id }, { p_workspace_id: WORKSPACE, p_staff_user_id: STAFF, p_auth_user_id: USER });
      assert.equal(args.p_request_key, REQUEST_KEY);
      assert.equal(args.p_source, "inline");
      events.push("reserve");
      const issuedAt = Date.now();
      const ticket = { v: 1, id: OPERATION, workspaceId: WORKSPACE, userId: USER, staffUserId: STAFF,
        fileName: args.p_file_name, mimeType: args.p_mime_type, fileSize: args.p_file_size,
        issuedAt, expiresAt: issuedAt + 7_200_000 };
      operation = { id: OPERATION, workspace_id: WORKSPACE, staff_user_id: STAFF, auth_user_id: USER,
        request_key: REQUEST_KEY, file_name: args.p_file_name, mime_type: args.p_mime_type, file_size: args.p_file_size,
        source: "inline", status: "reserved", issued_at: issuedAt, expires_at: issuedAt + 7_200_000 };
      return { data: { ticket, requestKey: REQUEST_KEY, status: "reserved" }, error: null };
    },
    storage: {
      from(bucket: string) {
        events.push("storage.from");
        return {
          async upload(key: string, buffer: Buffer, uploadOptions: Json) {
            events.push("upload");
            uploads.push({ bucket, key, buffer: Buffer.from(buffer), options: uploadOptions });
            const error = options.storageError ?? new Error("SYNTHETIC_STORAGE_STOP");
            sdkErrors.push(error);
            return { data: null, error };
          },
          getPublicUrl() { throw new Error("Public URL must not follow a failed upload"); },
        };
      },
    },
  };
  const isolatedGlobals = {
    Buffer, Error, URL, AbortController, setTimeout, clearTimeout,
    process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: SECRET }) }),
    console: { warn(...values: unknown[]) { warnings.push(values.map(String).join(" ")); } },
    async fetch(url: string, init?: RequestInit) {
      const uploaded = uploads[0];
      const expected = uploaded && `${ORIGIN}/storage/v1/object/public/${uploaded.bucket}/${uploaded.key}`;
      if (!uploaded || url !== expected) {
        network.push(url);
        throw new Error("Network forbidden in request-limit fixtures");
      }
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      verificationUrls.push(url);
      events.push("verify");
      // A failed fake SDK write leaves no public object. The real verifier
      // must reject this synthetic 404, never commit a metadata-only asset.
      return new globalThis.Response(MARKER, { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
  const modules = new Map<string, Json>([["./creative-image", {
    validateCreativeImageBytes, normalizeCreativeImageBytes, CreativeImageValidationUnavailable,
  }]]);
  function loadRuntime(id: string): Json {
    if (id === "node:crypto") return { createHash, createHmac, randomUUID, timingSafeEqual };
    const cached = modules.get(id);
    if (cached) return cached;
    const code = runtimeCode.get(id);
    assert.ok(code, `unexpected workflow import ${id}`);
    const exports: Json = {};
    modules.set(id, exports);
    new Script(code, { filename: `request-limit.actual-${id.split("/").at(-1)}.cjs` }).runInNewContext({
      ...isolatedGlobals, exports, require: loadRuntime,
    }, { timeout: 1000 });
    return exports;
  }
  const workflow = loadRuntime("./staged-creative-workflow");
  script.runInNewContext({
    ...isolatedGlobals, ...workflow, exports: exported, Buffer: guardedBuffer, Busboy, Dicer, parseContentType, randomUUID,
    validateCreativeImageBytes, CreativeImageValidationUnavailable,
    hasPermission: loadRuntime("../auth/permissions").hasPermission,
    StagedCreativeTicketError: loadRuntime("./staged-creative-ticket").StagedCreativeTicketError,
    StagedCreativeStorageError: loadRuntime("./staged-creative-storage").StagedCreativeStorageError,
    require(id: string) {
      if (id === "content-type") return requireFromRoot(id);
      throw new Error(`Unexpected integration import: ${id}`);
    },
    getSupabaseServerClient() { events.push("client"); return options.configured === false ? null : client; },
    async persistAdCreativeAsset(input: unknown) {
      events.push("persist");
      metadataWrites.push({ target: "persistAdCreativeAsset", values: input });
      throw new Error("Persistence forbidden in request-limit fixtures");
    },
  }, { timeout: 1000 });
  assert.ok(exported.actual);
  const actual = exported.actual;
  return {
    actual, events, uploads, warnings, concatBytes, rpcs, reads, metadataWrites, verificationUrls, network, sdkErrors,
    async call(req: Request) {
      actual.attachWorkspaceContext(req, { workspaceId: WORKSPACE, userId: USER, staffUserId: STAFF,
        role: "owner", permissions: ["manage_marketing"] });
      const res: Response = {
        statusCode: 0, body: {},
        status(code) { this.statusCode = code; return this; },
        setHeader() { return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)) as Json; return this; },
      };
      await actual.handleMultipartAdCreativeUpload(req, res);
      assert.deepEqual(network, [], "never delegate any request to real fetch");
      return res;
    },
  };
}

function assertNoStorage(ctx: ReturnType<typeof fixture>) {
  assert.deepEqual(ctx.events, ["client"], "request rejection must precede storage selection and persistence");
  assert.equal(ctx.uploads.length, 0);
  assert.equal(ctx.warnings.length, 0);
  assert.deepEqual(ctx.reads, []);
  assert.deepEqual(ctx.rpcs, []);
  assert.deepEqual(ctx.metadataWrites, []);
  assert.deepEqual(ctx.verificationUrls, []);
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
  const sdkFailure = new Error(MARKER);
  const ctx = fixture({ storageError: sdkFailure });
  // Videos intentionally stop before storage now. This bounded, valid image
  // reaches the actual inline admission, normalization and failed publication.
  const binary = Buffer.from(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAABAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCMABEP/9k=",
    "base64",
  );
  const header = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="requestKey"\r\n\r\n${REQUEST_KEY}\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const end = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const req = stream([header, binary, end], { "content-length": String(header.length + binary.length + end.length) });
  const res = await ctx.call(req);
  // The workflow reconciles an SDK failure with the exact public object. With
  // that object absent, the result is a fixed unavailable error, not old 502.
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    success: false, code: "creative_upload_unconfirmed", details: [],
    error: "Сохранение файла не подтверждено. Повторите проверку, не создавая новую загрузку.",
  });
  assert.ok(!JSON.stringify(res.body).includes(MARKER));
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
  assert.equal(ctx.uploads.length, 1, "one fake SDK failure, never a real upload");
  assert.deepEqual(ctx.sdkErrors, [sdkFailure], "the SDK actually returns the private diagnostic, rather than failing at auth/admission");
  const uploaded = ctx.uploads[0]!;
  assert.deepEqual(await validateCreativeImageBytes({ buffer: uploaded.buffer, fileName: "synthetic.jpg", mimeType: "image/jpeg" }), []);
  assert.equal(uploaded.bucket, "ad-creatives");
  const digest = createHash("sha256").update(uploaded.buffer).digest("hex");
  assert.equal(uploaded.key, `${WORKSPACE}/verified/${OPERATION}/${digest}.jpg`);
  assert.equal(uploaded.options.contentType, "image/jpeg");
  assert.equal(uploaded.options.upsert, false);
  assert.deepEqual(ctx.verificationUrls, [`${ORIGIN}/storage/v1/object/public/ad-creatives/${uploaded.key}`]);
  assert.deepEqual(ctx.rpcs, [{ name: "reserve_creative_upload", args: {
    p_workspace_id: WORKSPACE, p_staff_user_id: STAFF, p_auth_user_id: USER, p_request_key: REQUEST_KEY,
    p_file_name: "synthetic.jpg", p_mime_type: "image/jpeg", p_file_size: binary.length, p_source: "inline",
  } }], "failed publication must not invoke the atomic asset commit");
  assert.deepEqual(ctx.reads, [
    { table: "creative_upload_operations", filters: { id: OPERATION, workspace_id: WORKSPACE, auth_user_id: USER, staff_user_id: STAFF } },
    { table: "staff_users", filters: { id: STAFF, workspace_id: WORKSPACE, auth_user_id: USER } },
  ]);
  assert.deepEqual(ctx.metadataWrites, [], "neither a generic insert nor a receipt RPC may persist metadata after the failed upload");
  assert.deepEqual(ctx.events, ["client", "client", "reserve", "operation.read", "actor.read", "storage.from", "upload", "verify"]);
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

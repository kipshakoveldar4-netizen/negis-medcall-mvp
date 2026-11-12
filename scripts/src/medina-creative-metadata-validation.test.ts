import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Only the SDK boundary is synthetic. Execute the actual handlers, validator,
// config and PATCH mapper without importing integrations or reading real env.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "db5a200", "only the reviewed local baseline is supported");
async function sourceFile(file: string) {
  const source = baseline
    ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(ast: import("typescript").SourceFile, name: string) {
  const matches = ast.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
    return ts.isVariableStatement(node) && node.declarationList.declarations.some(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
  });
  assert.equal(matches.length, 1, `extract exactly one actual declaration: ${name}`);
  return matches[0]!;
}
function select(ast: import("typescript").SourceFile, names: string[]) {
  return names.map((name) => declaration(ast, name).getText(ast)).join("\n");
}
function compile(source: string, filename: string) {
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}
const server = await sourceFile("lib/crm/server.ts");
const privacy = await sourceFile("lib/crm/contact-privacy.ts");
const journal = await sourceFile("lib/crm/change-journal.ts");
const configStatement = declaration(server, "configs");
assert.ok(ts.isVariableStatement(configStatement));
const initializer = configStatement.declarationList.declarations[0]!.initializer;
assert.ok(initializer && ts.isObjectLiteralExpression(initializer));
const creativeConfigs = initializer.properties.filter((property) => ts.isPropertyAssignment(property)
  && ts.isStringLiteral(property.name) && property.name.text === "ad-creatives");
assert.equal(creativeConfigs.length, 1, "extract the actual ad-creatives config, not a fixture mapping");
const compiledServer = compile([
  select(server, [
    "DEMO_WORKSPACE_ID", "uuidPattern", "WORKSPACE_CONTEXT_KEY", "SERVER_OWNED_COLUMNS",
    "SERVICE_FAILURE_DETAIL", "BOOKKEEPING_COLUMNS", "IMAGE_MIME_TYPES", "VIDEO_MIME_TYPES",
    "IMAGE_EXTENSIONS", "VIDEO_EXTENSIONS", "MAX_IMAGE_BYTES", "MAX_VIDEO_BYTES",
    "CrmReferenceValidationError", "MortgageSelfLeadError", "AppointmentConflictError",
    "AppointmentOutsideScheduleError", "AppointmentServicesSchemaError", "AppointmentRequestError",
    ...(server.statements.some((node) => ts.isClassDeclaration(node) && node.name?.text === "SaleRequestError") ? ["SaleRequestError"] : []),
    "isUuid", "asRecord", "readString", "readQueryString", "readNumber", "readNullableNumber", "firstString", "readJsonArray", "hasAnyKey",
    "stripServerOwnedColumns", "buildPatchRow", "hasOnlyBookkeeping", "nextDemoId", "sendJson", "success", "errorBody",
    "attachWorkspaceContext", "readWorkspaceContext", "readWorkspaceId", "validationDetails",
    "resourceValidationDetails", "appointmentServicesValidationDetails", "hasContactFields", "redactedDetail",
    "fileExtension", "inferMimeType", "normalizeCreativeFileType", "buildSupabaseStoragePublicUrl", "resolveAdCreativePublicUrl",
    ...(server.statements.some((node) => ts.isFunctionDeclaration(node)
      && node.name?.text === "creativeMetadataShapeErrors") ? ["creativeMetadataShapeErrors"] : []),
    "makeAdCreativeAsset", "validateCreativeAssetBody", "validateSignedUploadBody",
    ...(server.statements.some((node) => ts.isFunctionDeclaration(node)
      && node.name?.text === "handleAdCreativeFinalizeUpload") ? ["handleAdCreativeFinalizeUpload"] : []),
    "createItem", "patchItem",
  ]),
  select(journal, ["RESOURCE_ENTITY", "journaledEntityFor"]),
  `const configs = { ${creativeConfigs[0]!.getText(server)} };`,
  "exports.runtime = { createItem, patchItem, attachWorkspaceContext, validateSignedUploadBody, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES };",
].join("\n"), "creative-metadata.actual-server.ts");
const compiledPrivacy = compile(privacy.text, privacy.fileName);

type RecordValue = Record<string, unknown>;
type Reply = { status: number; body: RecordValue; headers: Record<string, string> };
type FakeResponse = {
  status(code: number): FakeResponse;
  setHeader(name: string, value: string): FakeResponse;
  json(body: unknown): void;
};
type Runtime = {
  createItem(resource: "ad-creatives", req: RecordValue, res: FakeResponse): Promise<unknown>;
  patchItem(resource: "ad-creatives", req: RecordValue, res: FakeResponse): Promise<unknown>;
  attachWorkspaceContext(req: RecordValue, context: RecordValue): void;
  validateSignedUploadBody(body: RecordValue): { details: string[]; normalized: RecordValue };
  MAX_IMAGE_BYTES: number;
  MAX_VIDEO_BYTES: number;
};
type Query = {
  kind: "read" | "insert" | "update";
  row: RecordValue | null;
  filters: Array<[string, unknown]>;
  nullColumns: string[];
  terminal?: "single" | "maybeSingle";
};
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const FOREIGN_ASSET = "44444444-4444-4444-8444-444444444444";
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const VERSION_A = "2026-10-25T00:00:00.000Z";
const VERSION_B = "2026-10-25T00:00:01.000Z";
const clone = <T,>(value: T): T => structuredClone(value);
function metadata(patch: RecordValue = {}): RecordValue {
  return {
    fileName: "synthetic.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 1024,
    publicUrl: "https://creative.invalid/synthetic.jpg", status: "uploaded", ...clone(patch),
  };
}
function storedRow(patch: RecordValue = {}): RecordValue {
  return {
    id: ASSET, workspace_id: WORKSPACE, file_name: "synthetic.jpg", file_type: "image",
    mime_type: "image/jpeg", file_size: 1024, public_url: "https://creative.invalid/synthetic.jpg",
    status: "uploaded", metadata: {}, created_at: VERSION_A, updated_at: VERSION_A, ...clone(patch),
  };
}

class FakeSdk {
  rows: RecordValue[];
  attempts: Query[] = [];
  queries: Query[] = [];
  writes: Query[] = [];
  violations: string[] = [];
  constructor(private options: {
    row?: RecordValue; readError?: boolean; readThrows?: boolean;
    beforeUpdate?: (rows: RecordValue[]) => void; now?: number;
    afterRead?: (snapshot: RecordValue) => Promise<void>;
  } = {}) {
    this.rows = [clone(options.row ?? storedRow()), storedRow({ id: FOREIGN_ASSET, workspace_id: FOREIGN_WORKSPACE })];
  }
  check(condition: unknown, message: string): asserts condition {
    if (condition) return;
    this.violations.push(message);
    throw new Error(message);
  }
  from(table: string) {
    this.check(table === "ad_creative_assets", `unexpected table: ${table}`);
    const query: Query = { kind: "read", row: null, filters: [], nullColumns: [] };
    let executed = false;
    const execute = async (terminal: "single" | "maybeSingle") => {
      this.check(!executed, "execute each SDK query once");
      executed = true;
      query.terminal = terminal;
      const captured = clone(query);
      this.queries.push(captured);
      if (query.kind === "insert") {
        this.check(query.row?.workspace_id === WORKSPACE, "INSERT must use the authorized workspace");
      } else {
        this.check(query.filters.some(([key, value]) => key === "workspace_id" && value === WORKSPACE),
          "every read/update must be tenant-scoped");
        this.check(query.filters.some(([key]) => key === "id"), "read/update must target the exact asset");
      }
      if (query.kind === "read") {
        if (this.options.readThrows) throw new Error("synthetic metadata read transport failure");
        if (this.options.readError) return { data: null, error: { message: "synthetic metadata read failure" } };
      }
      if (query.kind === "insert") {
        const row = { id: ASSET, created_at: "2026-10-25T00:00:00Z", ...clone(query.row) };
        this.rows.push(row);
        this.writes.push(captured);
        return { data: clone(row), error: null };
      }
      if (query.kind === "update") this.options.beforeUpdate?.(this.rows);
      const row = this.rows.find((item) => query.filters.every(([key, value]) => item[key] === value));
      if (!row) return { data: null, error: null };
      if (query.kind === "update") {
        Object.assign(row, clone(query.row));
        this.writes.push(captured);
      }
      const snapshot = clone(row);
      if (query.kind === "read") await this.options.afterRead?.(snapshot);
      return { data: snapshot, error: null };
    };
    const mutate = (kind: "insert" | "update", row: RecordValue) => {
      this.check(query.kind === "read" && !executed, "one mutation per query");
      query.kind = kind;
      query.row = clone(row);
      this.attempts.push(query);
      return chain;
    };
    const chain = {
      insert: (row: RecordValue) => mutate("insert", row),
      update: (row: RecordValue) => mutate("update", row),
      select: (_columns: string) => chain,
      eq: (key: string, value: unknown) => {
        this.check(["id", "workspace_id", "updated_at", "file_name", "file_type", "mime_type", "file_size"].includes(key),
          `unexpected filter: ${key}`);
        this.check(value !== null, "SQL NULL needs IS NULL, not equality");
        this.check(!query.filters.some(([column]) => column === key), `duplicate filter: ${key}`);
        query.filters.push([key, value]);
        return chain;
      },
      is: (key: string, value: unknown) => {
        this.check(["updated_at", "file_name", "file_type", "mime_type", "file_size"].includes(key) && value === null,
          "only captured null metadata/version values use IS NULL");
        this.check(!query.filters.some(([column]) => column === key), `duplicate filter: ${key}`);
        query.filters.push([key, value]);
        query.nullColumns.push(key);
        return chain;
      },
      single: () => execute("single"),
      maybeSingle: () => execute("maybeSingle"),
    };
    return chain;
  }
}

function fixture(options: ConstructorParameters<typeof FakeSdk>[0] = {}) {
  const sdk = new FakeSdk(options);
  const frozenNow = options.now ?? Date.now();
  class FrozenDate extends Date {
    constructor(value?: number | string) { super(value === undefined ? frozenNow : value); }
    static now() { return frozenNow; }
  }
  const externalCalls: string[] = [];
  const forbidden = (name: string): never => {
    externalCalls.push(name);
    throw new Error(`Forbidden access: ${name}`);
  };
  const privacyExports: Record<string, unknown> = {};
  new Script(compiledPrivacy, { filename: "creative-metadata.actual-privacy.cjs" }).runInNewContext({
    exports: privacyExports, require: () => forbidden("privacy import"), fetch: () => forbidden("network"),
  }, { timeout: 1000 });
  const exports: { runtime?: Runtime } = {};
  new Script(compiledServer, { filename: `${baseline ?? "working-tree"}:creative-metadata.actual-server.cjs` }).runInNewContext({
    exports, Error, Date: options.now === undefined ? Date : FrozenDate, ...privacyExports, getSupabaseServerClient: () => sdk,
    require: () => forbidden("server import"), fetch: () => forbidden("network"),
    creativeUploadContext: () => forbidden("upload actor lookup without a handle"),
    creativeUploadConfig: () => forbidden("upload configuration without a handle"),
    finalizeCreativeImageUpload: () => forbidden("upload finalization without a handle"),
    // The actual URL mapper can consult these explicit synthetic values, never host env.
    process: { env: Object.freeze({ SUPABASE_URL: "https://storage.invalid", VITE_SUPABASE_URL: "" }) },
    console: { warn() {}, error() {} },
  }, { timeout: 1000 });
  assert.ok(exports.runtime);
  const runtime = exports.runtime;
  assert.equal(runtime.MAX_IMAGE_BYTES, IMAGE_LIMIT, "retain the existing 10 MiB image policy");
  assert.equal(runtime.MAX_VIDEO_BYTES, VIDEO_LIMIT, "retain the existing 100 MiB video policy");
  return {
    sdk,
    validateSignedUploadBody: runtime.validateSignedUploadBody,
    async invoke(method: "POST" | "PATCH", body: RecordValue, id = ASSET): Promise<Reply> {
      const req: RecordValue = { method, body: clone(body), query: method === "PATCH" ? { id } : {} };
      runtime.attachWorkspaceContext(req, { workspaceId: WORKSPACE, role: "owner", permissions: [] });
      const replies: RecordValue[] = [];
      const headers: Record<string, string> = {};
      let status = 0;
      const res: FakeResponse = {
        status(code) { status = code; return this; },
        setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
        json(value) { replies.push(clone(value) as RecordValue); },
      };
      try {
        await (method === "POST" ? runtime.createItem : runtime.patchItem)("ad-creatives", req, res);
      } finally {
        assert.deepEqual(externalCalls, [], "no real imports, network or external side effects");
        assert.deepEqual(sdk.violations, [], "caught SDK assertions must not masquerade as validation failures");
      }
      assert.equal(replies.length, 1, "exactly one handler reply");
      return { status, body: replies[0]!, headers };
    },
  };
}
function assertRefused(reply: Reply, sdk: FakeSdk, status = 400) {
  assert.equal(sdk.attempts.length, 0, "refuse before calling SDK INSERT/UPDATE");
  assert.equal(sdk.writes.length, 0, "invalid metadata must not write");
  assert.equal(reply.status, status);
  assert.equal(reply.body.success, false);
  assert.equal(reply.body.data, undefined);
  assert.notEqual(reply.body.mode, "demo", "a refusal must not become demo success");
  if (status === 400) assert.ok(Array.isArray(reply.body.details) && reply.body.details.length > 0);
}
function assertHandleRequired(reply: Reply, sdk: FakeSdk) {
  assert.equal(reply.status, 400);
  assert.equal(reply.body.success, false);
  assert.equal(reply.body.code, "creative_upload_verification_required");
  assert.equal(reply.body.error, "Для файла требуется подтверждённая защищённая загрузка.");
  assert.equal(reply.body.data, undefined);
  assert.equal(reply.body.mode, undefined, "a missing handle cannot produce a stored or demo receipt");
  assert.equal(reply.headers["cache-control"], "private, no-store");
  assert.equal(sdk.queries.length, 0, "handle validation must precede all SDK access");
  assert.equal(sdk.attempts.length, 0, "handle-less metadata must never reach INSERT/UPDATE");
  assert.equal(sdk.writes.length, 0);
}
function assertSaved(reply: Reply, sdk: FakeSdk, method: "POST" | "PATCH") {
  assert.equal(reply.status, method === "POST" ? 201 : 200);
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.mode, "supabase");
  assert.equal(sdk.attempts.length, 1);
  assert.equal(sdk.writes.length, 1);
  assert.equal(sdk.writes[0]!.kind, method === "POST" ? "insert" : "update");
  const data = reply.body.data as RecordValue;
  const item = data.item as RecordValue;
  assert.equal(item.workspaceId, WORKSPACE);
  return item;
}
function assertMetadataCas(query: Query, snapshot: RecordValue) {
  const expected: Array<[string, unknown]> = [["id", ASSET], ["workspace_id", WORKSPACE],
    ...["updated_at", "file_name", "file_type", "mime_type", "file_size"].map(
      (key): [string, unknown] => [key, snapshot[key]],
    )];
  const sort = (entries: Array<[string, unknown]>) => [...entries].sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(sort(query.filters), sort(expected), "CAS must compare tenant/id/version and all four validated metadata columns");
  assert.deepEqual([...query.nullColumns].sort(), expected.filter(([, value]) => value === null).map(([key]) => key).sort());
  assert.equal(query.terminal, "maybeSingle", "a false CAS must be distinguishable from an SDK error");
}

const invalidCreate: Array<[string, RecordValue]> = [
  ["HTML MIME despite a JPG name", metadata({ mimeType: "text/html" })],
  ["unknown image MIME", metadata({ mimeType: "image/x-synthetic" })],
  ["image above 10 MiB", metadata({ fileSize: IMAGE_LIMIT + 1 })],
  ["empty metadata", {}],
  ["empty filename", metadata({ fileName: "" })],
  ["unsupported extension without MIME", metadata({ fileName: "synthetic.html", mimeType: "" })],
  ["MIME/extension disagreement", metadata({ fileName: "synthetic.png" })],
  ["explicit unknown file type", metadata({ fileType: "document" })],
  ["video type with image MIME/extension", metadata({ fileType: "video" })],
  ["numeric MIME", metadata({ mimeType: 123 })],
  ["object MIME", metadata({ mimeType: {} })],
  ["numeric file type", metadata({ fileType: 123 })],
];
const invalidSizes: Array<[string, unknown]> = [
  ["zero", 0], ["negative", -1], ["fractional", 1.5], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["nonnumeric", "not-a-byte-count"], ["empty string", ""],
  ["object", {}], ["boolean", true],
];
for (const [label, value] of invalidSizes) invalidCreate.push([`${label} byte count`, metadata({ fileSize: value })]);
for (const [label, body] of invalidCreate) {
  test(`metadata-only POST rejects ${label} without a verified upload handle`, async () => {
    const f = fixture();
    const before = clone(f.sdk.rows);
    const reply = await f.invoke("POST", body);
    assertHandleRequired(reply, f.sdk);
    assert.deepEqual(f.sdk.rows, before);
    assert.equal(f.sdk.queries.length, 0, "create validation precedes SDK access");
  });
  test(`signed-upload validation rejects ${label} before issuing a private ticket`, () => {
    const f = fixture();
    const result = f.validateSignedUploadBody(body);
    assert.ok(result.details.length > 0, "the private entry point retains strict metadata validation");
    assert.equal(f.sdk.queries.length, 0);
    assert.equal(f.sdk.writes.length, 0);
  });
}

for (const [label, body] of [
  ["JPEG at image limit", metadata({ fileSize: IMAGE_LIMIT })],
  ["MP4 at video limit", metadata({ fileName: "synthetic.mp4", fileType: "video", mimeType: "video/mp4", fileSize: VIDEO_LIMIT })],
  ["extension fallback without MIME", metadata({ mimeType: "" })],
  ["unknown null size", metadata({ fileSize: null })],
  ["unknown omitted size", Object.fromEntries(Object.entries(metadata()).filter(([key]) => key !== "fileSize"))],
] as Array<[string, RecordValue]>) {
  test(`metadata-only POST refuses otherwise valid ${label}, including a forged tenant`, async () => {
    const f = fixture();
    const before = clone(f.sdk.rows);
    assertHandleRequired(await f.invoke("POST", { ...body, workspaceId: FOREIGN_WORKSPACE, workspace_id: FOREIGN_WORKSPACE }), f.sdk);
    assert.deepEqual(f.sdk.rows, before);
  });
}

for (const uploadHandle of [undefined, null, "", false, 0, {}, []]) {
  test(`metadata-only POST refuses a missing/non-string handle: ${JSON.stringify(uploadHandle)}`, async () => {
    const f = fixture();
    const before = clone(f.sdk.rows);
    assertHandleRequired(await f.invoke("POST", metadata({ uploadHandle })), f.sdk);
    assert.deepEqual(f.sdk.rows, before);
  });
}

test("private ticket validation retains the image limit and canonical MIME inference", () => {
  const f = fixture();
  for (const mimeType of ["image/jpeg", ""]) {
    const result = f.validateSignedUploadBody(metadata({ mimeType, fileSize: IMAGE_LIMIT }));
    assert.equal(result.details.length, 0);
    assert.deepEqual(clone(result.normalized), {
      fileName: "synthetic.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: IMAGE_LIMIT,
    });
  }
  for (const fileSize of [undefined, null]) {
    assert.ok(f.validateSignedUploadBody(metadata({ fileSize })).details.includes("fileSize is required"),
      "unknown size is not enough to issue a private upload ticket");
  }
  assert.equal(f.sdk.queries.length, 0);
  assert.equal(f.sdk.writes.length, 0);
});

const invalidPatches: Array<[string, RecordValue]> = [
  ["HTML MIME only", { mimeType: "text/html" }],
  ["unknown MIME alias only", { mime_type: "image/x-synthetic" }],
  ["image above limit without resupplying type", { fileSize: IMAGE_LIMIT + 1 }],
  ["oversized size alias only", { file_size: IMAGE_LIMIT + 1 }],
  ["empty filename", { fileName: "" }],
  ["filename extension disagreement", { file_name: "synthetic.png" }],
  ["file type disagreement", { fileType: "video" }],
  ["creative type disagreement", { creativeType: "video" }],
  ["unknown file type alias", { file_type: "document" }],
  ["numeric MIME", { mimeType: 123 }],
  ["object MIME alias", { mime_type: {} }],
  ["numeric file type", { fileType: 123 }],
  ["unknown creative type alias", { creative_type: "document" }],
];
for (const [label, fileSize] of invalidSizes) invalidPatches.push([`${label} byte count`, { fileSize }]);
for (const [label, updates] of invalidPatches) {
  test(`generic PATCH rejects ${label} using stored metadata before UPDATE`, async () => {
    const f = fixture();
    const before = clone(f.sdk.rows);
    assertRefused(await f.invoke("PATCH", { id: ASSET, updates }), f.sdk);
    assert.deepEqual(f.sdk.rows, before);
    assert.equal(f.sdk.queries.filter((query) => query.kind === "read").length, 1, "validate merged persisted metadata");
  });
}

for (const [label, patch] of [
  ["status only", { status: "ready" }],
  ["legacy title only", { title: "Synthetic label" }],
  ["title plus status", { title: "Synthetic label", status: "ready" }],
  ["Meta id only", { metaAssetId: "synthetic-meta-asset" }],
  ["metadata object only", { metadata: { synthetic: true } }],
  ["upload link only", { publicUrl: "https://creative.invalid/relinked.jpg", storagePath: `${WORKSPACE}/synthetic.jpg` }],
] as Array<[string, RecordValue]>) {
  test(`generic PATCH ${label} preserves partial semantics without reading metadata`, async () => {
    const f = fixture({ row: storedRow({ mime_type: "application/x-legacy", file_size: null }) });
    const item = assertSaved(await f.invoke("PATCH", { ...patch, workspaceId: FOREIGN_WORKSPACE, workspace_id: FOREIGN_WORKSPACE }), f.sdk, "PATCH");
    assert.equal(f.sdk.queries.filter((query) => query.kind === "read").length, 0);
    assert.deepEqual([...f.sdk.writes[0]!.filters].sort(), [["id", ASSET], ["workspace_id", WORKSPACE]]);
    assert.deepEqual(f.sdk.writes[0]!.nullColumns, []);
    assert.equal(item.mimeType, "application/x-legacy", "unrelated legacy metadata is not retroactively rejected");
    const { updated_at: updatedAt, ...writtenPatch } = f.sdk.writes[0]!.row!;
    assert.equal(typeof updatedAt, "string");
    assert.deepEqual(writtenPatch, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.metaAssetId ? { meta_asset_id: patch.metaAssetId } : {}),
      ...(patch.metadata ? { metadata: patch.metadata } : {}),
      ...(patch.publicUrl ? { public_url: patch.publicUrl, storage_path: patch.storagePath } : {}),
    });
    assert.equal(f.sdk.rows[1]!.workspace_id, FOREIGN_WORKSPACE);
    assert.equal(f.sdk.rows[1]!.status, "uploaded");
  });
}

for (const [label, row, patch] of [
  ["JPEG size only at limit", storedRow(), { file_size: IMAGE_LIMIT }],
  ["MP4 size only above the image limit", storedRow({ file_name: "synthetic.mp4", file_type: "video", mime_type: "video/mp4" }), { fileSize: VIDEO_LIMIT }],
  ["complete MP4 metadata transition", storedRow(), { fileName: "synthetic.mp4", fileType: "video", mimeType: "video/mp4", fileSize: VIDEO_LIMIT }],
  ["null remains unknown size", storedRow(), { fileSize: null }],
] as Array<[string, RecordValue, RecordValue]>) {
  test(`generic PATCH accepts ${label} after reading exact authorized row`, async () => {
    const f = fixture({ row });
    assertSaved(await f.invoke("PATCH", { id: ASSET, updates: patch, workspaceId: FOREIGN_WORKSPACE }), f.sdk, "PATCH");
    const read = f.sdk.queries.filter((query) => query.kind === "read");
    assert.equal(read.length, 1);
    assert.deepEqual([...read[0]!.filters].sort(), [["id", ASSET], ["workspace_id", WORKSPACE]]);
    assertMetadataCas(f.sdk.writes[0]!, row);
  });
}

for (const [label, id, options, status] of [
  ["foreign asset", FOREIGN_ASSET, {}, 404],
  ["missing asset", "55555555-5555-4555-8555-555555555555", {}, 404],
  ["failed metadata read", ASSET, { readError: true }, 503],
  ["throwing metadata read", ASSET, { readThrows: true }, 503],
  ["absent metadata version", ASSET, { row: storedRow({ updated_at: undefined }) }, 503],
  ["invalid metadata version", ASSET, { row: storedRow({ updated_at: "not-a-timestamp" }) }, 503],
] as Array<[string, string, ConstructorParameters<typeof FakeSdk>[0], number]>) {
  test(`generic PATCH refuses ${label} before UPDATE`, async () => {
    const f = fixture(options);
    const before = clone(f.sdk.rows);
    assertRefused(await f.invoke("PATCH", { fileSize: 2048, workspaceId: FOREIGN_WORKSPACE }, id), f.sdk, status);
    assert.deepEqual(f.sdk.rows, before);
    assert.equal(f.sdk.queries.filter((query) => query.kind === "read").length, 1);
  });
}

for (const version of [VERSION_A, null]) {
  test(`generic PATCH refuses a raced ${version === null ? "null" : "timestamp"} metadata version without overwriting the concurrent edit`, async () => {
    const f = fixture({ row: storedRow({ updated_at: version }), beforeUpdate(rows) {
      const row = rows.find((item) => item.id === ASSET && item.workspace_id === WORKSPACE)!;
      row.updated_at = VERSION_B;
      row.file_size = 4096;
    } });
    const reply = await f.invoke("PATCH", { fileSize: 2048, workspaceId: FOREIGN_WORKSPACE });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.success, false);
    assert.equal(reply.body.code, "creative_metadata_conflict");
    assert.equal(reply.body.data, undefined);
    assert.equal(f.sdk.attempts.length, 1, "exercise the actual conditional UPDATE, not a pre-read-only refusal");
    assert.equal(f.sdk.writes.length, 0, "the false CAS must perform zero writes");
    const update = f.sdk.queries.find((query) => query.kind === "update")!;
    assertMetadataCas(update, storedRow({ updated_at: version }));
    assert.equal(f.sdk.rows[0]!.updated_at, VERSION_B);
    assert.equal(f.sdk.rows[0]!.file_size, 4096);
    assert.deepEqual(f.sdk.rows[1], storedRow({ id: FOREIGN_ASSET, workspace_id: FOREIGN_WORKSPACE }));
  });
}

test("generic PATCH accepts legacy null metadata version with a scoped IS NULL CAS", async () => {
  const f = fixture({ row: storedRow({ updated_at: null }) });
  const item = assertSaved(await f.invoke("PATCH", { fileSize: 2048 }), f.sdk, "PATCH");
  const update = f.sdk.writes[0]!;
  assertMetadataCas(update, storedRow({ updated_at: null }));
  assert.equal(item.fileSize, 2048);
});

test("generic PATCH advances metadata version even within the captured millisecond", async () => {
  const f = fixture({ now: Date.parse(VERSION_A) });
  assertSaved(await f.invoke("PATCH", { fileSize: 2048 }), f.sdk, "PATCH");
  const updatedAt = f.sdk.writes[0]!.row!.updated_at;
  assert.equal(typeof updatedAt, "string");
  assert.ok(Date.parse(updatedAt as string) > Date.parse(VERSION_A), "a successful update must invalidate its captured version");
});

for (const [label, patch] of [
  ["uppercase creativeType", { creativeType: "VIDEO" }],
  ["null creativeType inferred from merged MP4", { creativeType: null }],
  ["uppercase file_type alias", { file_type: "VIDEO" }],
] as Array<[string, RecordValue]>) {
  test(`generic PATCH persists canonical video type for ${label}`, async () => {
    const row = storedRow({ file_name: "synthetic.mp4", file_type: "video", mime_type: "video/mp4" });
    const f = fixture({ row });
    const item = assertSaved(await f.invoke("PATCH", patch), f.sdk, "PATCH");
    assertMetadataCas(f.sdk.writes[0]!, row);
    assert.equal(f.sdk.writes[0]!.row!.file_type, "video", "persist the same canonical type used during validation");
    assert.equal(f.sdk.rows[0]!.file_type, "video");
    assert.equal(item.fileType, "video");
  });
}

test("metadata-only POST refuses unknown null size equally for camel and snake aliases", async () => {
  for (const key of ["fileSize", "file_size"]) {
    const body = metadata();
    delete body.fileSize;
    body[key] = null;
    const f = fixture();
    const before = clone(f.sdk.rows);
    assertHandleRequired(await f.invoke("POST", body), f.sdk);
    assert.deepEqual(f.sdk.rows, before, `${key}: no handle means no row, even with a valid URL`);
  }
});

test("generic PATCH persists a validated numeric string as a numeric byte count", async () => {
  const f = fixture();
  const item = assertSaved(await f.invoke("PATCH", { fileSize: "1e3" }), f.sdk, "PATCH");
  assertMetadataCas(f.sdk.writes[0]!, storedRow());
  assert.equal(f.sdk.writes[0]!.row!.file_size, 1000, "the SDK must receive the validated number, not its input spelling");
  assert.equal(f.sdk.rows[0]!.file_size, 1000);
  assert.equal(item.fileSize, 1000);
});

test("generic PATCH uses IS NULL for every null metadata snapshot column", async () => {
  const row = storedRow({ updated_at: null, file_name: null, file_type: null, mime_type: null, file_size: null });
  const f = fixture({ row });
  const item = assertSaved(await f.invoke("PATCH", {
    fileName: "synthetic.jpg", fileType: "IMAGE", mimeType: "IMAGE/JPEG", fileSize: "1e3",
  }), f.sdk, "PATCH");
  assertMetadataCas(f.sdk.writes[0]!, row);
  assert.equal(f.sdk.writes[0]!.row!.file_type, "image");
  assert.equal(f.sdk.writes[0]!.row!.mime_type, "image/jpeg");
  assert.equal(f.sdk.writes[0]!.row!.file_size, 1000);
  assert.equal(item.fileSize, 1000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("generic PATCH rejects stale video metadata after an actual status writer reuses its timestamp", async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  const row = storedRow({ file_name: "synthetic.mp4", file_type: "video", mime_type: "video/mp4" });
  let reads = 0;
  const f = fixture({ row, now: Date.parse(VERSION_A), async afterRead() {
    if (++reads !== 1) return;
    readStarted.resolve();
    await releaseRead.promise;
  } });
  const staleRequest = f.invoke("PATCH", { fileSize: 50 * 1024 * 1024 });
  let staleReply: Reply | undefined;
  try {
    assert.equal(await Promise.race([
      readStarted.promise.then(() => true), staleRequest.then(() => false),
    ]), true, "the stale request must actually read and capture the original video metadata");
    assertSaved(await f.invoke("PATCH", {
      fileName: "synthetic.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 1024,
    }), f.sdk, "PATCH");
    assert.equal(f.sdk.rows[0]!.updated_at, "2026-10-25T00:00:00.001Z");
    const readsBeforeStatus = f.sdk.queries.filter((query) => query.kind === "read").length;
    const statusReply = await f.invoke("PATCH", { status: "ready" });
    assert.equal(statusReply.status, 200);
    assert.equal(statusReply.body.success, true);
    assert.equal(f.sdk.queries.filter((query) => query.kind === "read").length, readsBeforeStatus,
      "the actual unrelated status writer must remain read-free");
    assert.equal(f.sdk.rows[0]!.updated_at, VERSION_A, "exercise timestamp reuse, not just a newer-version conflict");
  } finally {
    releaseRead.resolve();
    staleReply = await staleRequest;
  }
  assert.equal(staleReply.status, 409);
  assert.equal(staleReply.body.code, "creative_metadata_conflict");
  assert.equal(staleReply.body.success, false);
  assert.equal(staleReply.body.data, undefined);
  assert.equal(f.sdk.attempts.length, 3, "exercise all three actual writers including the stale conditional UPDATE");
  assert.equal(f.sdk.writes.length, 2, "only the image conversion and unrelated status edit may apply");
  const staleUpdate = f.sdk.queries.filter((query) => query.kind === "update").at(-1)!;
  assertMetadataCas(staleUpdate, row);
  assert.equal(f.sdk.rows[0]!.file_type, "image");
  assert.equal(f.sdk.rows[0]!.file_size, 1024, "the stale 50 MiB video edit must not corrupt the final image row");
  assert.equal(f.sdk.rows[0]!.status, "ready");
  assert.deepEqual(f.sdk.rows[1], storedRow({ id: FOREIGN_ASSET, workspace_id: FOREIGN_WORKSPACE }));
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Metadata/ticket tests only: the browser uploads bytes directly to Signed
// Storage afterwards. Issuing a ticket does not verify those bytes or their size.
// Run this same rejection contract against --baseline=1bc3622 or the working tree;
// known gate gaps must remain failures until the actual handler is fixed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "1bc3622", "only the reviewed local baseline is supported");
const serverFile = "lib/crm/server.ts";
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${serverFile}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, serverFile), "utf8");
// Retain whole actual declarations and their local dependencies, including the
// validator and private admission workflow. Only SDK boundaries are replaced;
// no application imports, image decoding, real network or working env are used.
function compileDeclarations(file: string, text: string, names: string[]) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
    const declaration = declarations.get(name);
    assert.ok(declaration, `actual ${file}:${name} must exist`);
    if (selected.has(declaration)) return;
    selected.add(declaration);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  names.forEach(include);
  const compiled = ts.transpileModule([
    ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)),
    `exports.runtime = { ${names.join(", ")} };`,
  ].join("\n"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(compiled.diagnostics ?? [], [], `actual ${file} must transpile`);
  return { declarations, selected, script: new Script(compiled.outputText, { filename: `${baseline ?? "working-tree"}:${file}.cjs` }) };
}
const { script, selected, declarations } = compileDeclarations(serverFile, source,
  ["handleAdCreativeSignedUpload", "attachWorkspaceContext", "MAX_IMAGE_BYTES", "MAX_VIDEO_BYTES"]);
assert.ok(selected.has(declarations.get("validateSignedUploadBody")!), "execute the actual signed-upload validator");
async function actualDeclarations(file: string, names: string[]) {
  return compileDeclarations(file, await readFile(path.join(root, file), "utf8"), names).script;
}
const permissionScript = await actualDeclarations("lib/auth/permissions.ts", ["hasPermission"]);
const ticketScript = await actualDeclarations("lib/crm/staged-creative-ticket.ts", ["StagedCreativeTicketError",
  "issueStagedCreativeTicket", "readStagedCreativeTicket", "sealStagedCreativeTicket", "stagedCreativePath",
  "stagedCreativeKind", "STAGED_CREATIVE_BUCKET", "STAGED_CREATIVE_LIFETIME_MS"]);
const storageScript = await actualDeclarations("lib/crm/staged-creative-storage.ts",
  ["StagedCreativeStorageError", "prepareOrResumeStagedCreativeUpload"]);
const workflowScript = await actualDeclarations("lib/crm/staged-creative-workflow.ts",
  ["CreativeUploadWorkflowError", "prepareCreativeImageUpload"]);

type Json = Record<string, unknown>;
type Reply = { status: number; body: Json };
type Response = {
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(body: unknown): void;
};
type Runtime = {
  handleAdCreativeSignedUpload(req: Json, res: Response): Promise<unknown>;
  attachWorkspaceContext(req: Json, context: Json): void;
  MAX_IMAGE_BYTES: number;
  MAX_VIDEO_BYTES: number;
};
type Ticket = { bucket: string; args: unknown[] };
type Admission = { args: Json; ticket: Json };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";
const REQUEST_KEY = "55555555-5555-4555-8555-555555555555";
const NONCE = "66666666-6666-4666-8666-666666666666";
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const STORAGE_ORIGIN = "https://signed-storage.invalid";
const TOKEN = "synthetic-ticket-token";
const SYNTHETIC_KEY = "SYNTHETIC_METADATA_ADMISSION_KEY_NEVER_REAL";
const PRIVATE_BUCKET = "ad-creatives-staging";
const clone = <T,>(value: T): T => structuredClone(value);

class FakeSdk {
  buckets: string[] = [];
  bucketReads: string[] = [];
  tickets: Ticket[] = [];
  admissions: Admission[] = [];
  actors: Json[] = [];
  receiptPatch: Json = {};
  async rpc(name: string, args: Json) {
    assert.equal(name, "reserve_creative_upload", "only private admission is allowed; no asset persistence");
    assert.equal(args.p_source, "signed");
    const issuedAt = Date.now();
    const ticket = { v: 1, id: NONCE, workspaceId: args.p_workspace_id, userId: args.p_auth_user_id,
      staffUserId: args.p_staff_user_id, fileName: args.p_file_name, mimeType: args.p_mime_type,
      fileSize: args.p_file_size, issuedAt, expiresAt: issuedAt + 2 * 60 * 60 * 1000 };
    this.admissions.push({ args: clone(args), ticket: clone(ticket) });
    return { data: { requestKey: args.p_request_key, status: "reserved", ticket }, error: null };
  }
  from(table: string) {
    assert.equal(table, "staff_users", "only the live actor may be read; no creative row is written");
    const filters: Json = {};
    const query = {
      select(columns: string) { assert.equal(columns, "id,workspace_id,auth_user_id,role,status"); return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      maybeSingle: async () => {
        this.actors.push(clone(filters));
        return { data: { ...filters, role: "owner", status: "active" }, error: null };
      },
    };
    return query;
  }
  storage = {
    getBucket: async (bucket: string) => {
      this.bucketReads.push(bucket);
      assert.equal(bucket, PRIVATE_BUCKET);
      return { data: { id: PRIVATE_BUCKET, public: false, file_size_limit: VIDEO_LIMIT,
        allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }, error: null };
    },
    from: (bucket: string) => {
      this.buckets.push(bucket);
      return {
        list: async (_folder: string, options: Json) => {
          assert.equal(options.limit, 2); return { data: [], error: null };
        },
        createSignedUploadUrl: async (...args: unknown[]) => {
          this.tickets.push({ bucket, args: clone(args) });
          return {
            data: {
              signedUrl: `${STORAGE_ORIGIN}/storage/v1/object/upload/sign/${bucket}/${args[0]}?token=${TOKEN}`,
              token: TOKEN,
              path: args[0],
              ...this.receiptPatch,
            },
            error: null,
          };
        },
      };
    },
  };
}

function fixture() {
  const sdk = new FakeSdk();
  const externalCalls: string[] = [];
  const forbidden = (operation: string): never => {
    externalCalls.push(operation);
    throw new Error(`Forbidden external operation: ${operation}`);
  };
  function evaluate<T>(code: Script, bindings: Json = {}): T {
    const exported: { runtime?: T } = {};
    code.runInNewContext({
      exports: exported, ...crypto, Buffer, URL, setTimeout, clearTimeout,
      getSupabaseServerClient: () => sdk,
      process: Object.freeze({ env: Object.freeze({ SUPABASE_URL: STORAGE_ORIGIN, VITE_SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: SYNTHETIC_KEY }) }),
      require: () => forbidden("application import"),
      fetch: () => forbidden("network"),
      console: { warn() {}, error() {} },
      ...bindings,
    }, { timeout: 1000 });
    assert.ok(exported.runtime);
    return exported.runtime;
  }
  const permissions = evaluate<Json>(permissionScript);
  const tickets = evaluate<Json>(ticketScript);
  const storage = evaluate<Json>(storageScript, tickets);
  const workflow = evaluate<Json>(workflowScript, { ...permissions, ...tickets, ...storage });
  const actual = evaluate<Runtime>(script, { ...permissions, ...tickets, ...storage, ...workflow });
  assert.equal(actual.MAX_IMAGE_BYTES, IMAGE_LIMIT, "retain the 10 MiB image cap");
  assert.equal(actual.MAX_VIDEO_BYTES, VIDEO_LIMIT, "retain the 100 MiB video cap");
  return {
    sdk,
    async invoke(body: Json, workspaceId = WORKSPACE): Promise<Reply> {
      const req: Json = {
        method: "POST", headers: { "content-type": "application/json" },
        body: { requestKey: REQUEST_KEY, ...clone(body) }, query: { workspaceId: FOREIGN_WORKSPACE },
      };
      // Authorization belongs to the router; exercise the signed handler with
      // the context it receives, not a browser-controlled workspace selector.
      actual.attachWorkspaceContext(req, { workspaceId, userId: USER, staffUserId: STAFF, role: "owner", permissions: [] });
      let status = 0;
      const replies: Json[] = [];
      const headers: Record<string, string> = {};
      const res: Response = {
        status(code) { status = code; return this; },
        setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
        json(value) { replies.push(clone(value) as Json); },
      };
      try {
        await actual.handleAdCreativeSignedUpload(req, res);
      } finally {
        assert.deepEqual(externalCalls, [], "never import integrations, fetch, or consult real credentials");
      }
      assert.equal(replies.length, 1, "exactly one actual handler reply");
      assert.equal(headers["content-type"], "application/json; charset=utf-8");
      if (!baseline) assert.equal(headers["cache-control"], "private, no-store");
      return { status, body: replies[0]! };
    },
  };
}

function metadata(patch: Json = {}): Json {
  return { fileName: "synthetic.jpg", fileType: "image", mimeType: "image/jpeg", fileSize: 1024, ...patch };
}
function aliased(body: Json, canonical: string, alias: string, value: unknown): Json {
  const result = clone(body);
  delete result[canonical];
  result[alias] = clone(value);
  return result;
}
function assertRefused(reply: Reply, sdk: FakeSdk) {
  assert.deepEqual(sdk.admissions, [], "invalid metadata must refuse before admission");
  assert.deepEqual(sdk.actors, [], "invalid metadata must refuse before actor lookup");
  assert.deepEqual(sdk.bucketReads, [], "invalid metadata must refuse before private Storage inspection");
  assert.equal(sdk.tickets.length, 0, "invalid metadata must not mint a signed-upload ticket");
  assert.deepEqual(sdk.buckets, [], "refuse before selecting a Storage bucket");
  assert.equal(reply.status, 400);
  assert.equal(reply.body.success, false);
  assert.equal(reply.body.error, "Validation error");
  assert.ok(Array.isArray(reply.body.details) && reply.body.details.length > 0, "return validation details");
  assert.equal(reply.body.data, undefined);
  assert.notEqual(reply.body.mode, "demo", "validation failure cannot become demo success");
}
function assertTicket(reply: Reply, sdk: FakeSdk, expected: Json, workspaceId = WORKSPACE) {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.mode, "supabase");
  assert.deepEqual(sdk.buckets, [PRIVATE_BUCKET]);
  assert.deepEqual(sdk.bucketReads, [PRIVATE_BUCKET]);
  assert.equal(sdk.admissions.length, 1, "reserve one private image operation, not a ready asset");
  assert.deepEqual(sdk.admissions[0]!.args, { p_workspace_id: workspaceId, p_auth_user_id: USER,
    p_staff_user_id: STAFF, p_request_key: REQUEST_KEY, p_source: "signed",
    p_file_name: expected.fileName, p_mime_type: expected.mimeType, p_file_size: expected.fileSize });
  assert.deepEqual(sdk.actors, [{ id: STAFF, workspace_id: workspaceId, auth_user_id: USER }]);
  assert.equal(sdk.tickets.length, 1, "mint exactly one private ticket, not a byte upload or creative row");
  const ticket = sdk.tickets[0]!;
  assert.equal(ticket.bucket, PRIVATE_BUCKET);
  assert.deepEqual(ticket.args[1], { upsert: false }, "private uploads are create-only");
  const storagePath = ticket.args[0];
  assert.equal(typeof storagePath, "string");
  const segments = (storagePath as string).split("/");
  assert.equal(segments.length, 4, "server-admitted workspace/staged/nonce/original key");
  assert.equal(segments[0], workspaceId);
  assert.equal(segments[1], "staged");
  assert.equal(segments[2], NONCE);
  assert.equal(segments[3], `original.${String(expected.fileName).split(".").at(-1)!.toLowerCase()}`);
  const data = reply.body.data as Json;
  assert.match(String(data.uploadHandle), /^u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(data.publicUrl, undefined, "admission must never publish an unverified image");
  assert.equal(data.asset, undefined); assert.equal(data.item, undefined); assert.equal(data.status, undefined);
  assert.deepEqual(reply.body.data, {
    bucket: PRIVATE_BUCKET, storageBucket: PRIVATE_BUCKET, storagePath,
    signedUrl: `${STORAGE_ORIGIN}/storage/v1/object/upload/sign/${PRIVATE_BUCKET}/${storagePath}?token=${TOKEN}`,
    token: TOKEN, uploadHandle: data.uploadHandle, expiresAt: sdk.admissions[0]!.ticket.expiresAt,
    ...expected,
  }, "return only a private ticket and exact normalized request metadata");
}

function assertVideoWorkerRequired(reply: Reply, sdk: FakeSdk) {
  assert.equal(reply.status, 409);
  assert.equal(reply.body.success, false);
  assert.equal(reply.body.code, "creative_video_worker_required");
  assert.equal(reply.body.data, undefined);
  assert.notEqual(reply.body.mode, "demo");
  assert.deepEqual(sdk.admissions, []); assert.deepEqual(sdk.actors, []);
  assert.deepEqual(sdk.bucketReads, []); assert.deepEqual(sdk.buckets, []); assert.deepEqual(sdk.tickets, []);
}

const formats = [
  { extension: "jpg", mimeType: "image/jpeg", fileType: "image", cap: IMAGE_LIMIT },
  { extension: "jpeg", mimeType: "image/jpeg", fileType: "image", cap: IMAGE_LIMIT },
  { extension: "png", mimeType: "image/png", fileType: "image", cap: IMAGE_LIMIT },
  { extension: "webp", mimeType: "image/webp", fileType: "image", cap: IMAGE_LIMIT },
  { extension: "mp4", mimeType: "video/mp4", fileType: "video", cap: VIDEO_LIMIT },
  { extension: "mov", mimeType: "video/quicktime", fileType: "video", cap: VIDEO_LIMIT },
  { extension: "webm", mimeType: "video/webm", fileType: "video", cap: VIDEO_LIMIT },
];
for (const format of formats) {
  const { extension, mimeType, fileType, cap } = format;
  for (const fileSize of [1, cap]) {
    test(`signed metadata routes valid ${extension.toUpperCase()} at ${fileSize} declared bytes to ${fileType === "image" ? "private admission" : "the video worker"}`, async () => {
      const f = fixture();
      const body = { fileName: `synthetic.${extension}`, fileType, mimeType, fileSize };
      const reply = await f.invoke(body);
      if (fileType === "image") assertTicket(reply, f.sdk, body);
      else assertVideoWorkerRequired(reply, f.sdk);
    });
  }
  test(`signed metadata rejects ${extension.toUpperCase()} one byte above its ${cap} cap`, async () => {
    const f = fixture();
    assertRefused(await f.invoke({ fileName: `synthetic.${extension}`, fileType, mimeType, fileSize: cap + 1 }), f.sdk);
  });
  for (const fallback of [undefined, "", "application/octet-stream"]) {
    test(`signed metadata infers ${extension.toUpperCase()} with ${String(fallback)} MIME and omitted fileType`, async () => {
      const f = fixture();
      const expected = { fileName: `synthetic.${extension}`, fileType, mimeType, fileSize: 1024 };
      const body: Json = { fileName: expected.fileName, fileSize: expected.fileSize };
      if (fallback !== undefined) body.mimeType = fallback;
      const reply = await f.invoke(body);
      if (fileType === "image") assertTicket(reply, f.sdk, expected);
      else assertVideoWorkerRequired(reply, f.sdk);
    });
  }
}

const invalidSizes: Array<[string, unknown]> = [
  ["true boolean", true], ["false boolean", false],
  ["plain object", {}], ["byte-count object", { bytes: 1024 }],
  ["single-element array object", [1024]], ["empty array object", []],
  ["fractional number", 1.5], ["fractional string", "1.5"],
  // Unsafe integers necessarily exceed both caps; refusal alone does not prove
  // the handler has a distinct safe-integer check.
  ["unsafe integer (also over cap)", Number.MAX_SAFE_INTEGER + 1],
  ["unsafe integer string (also over cap)", "9007199254740993"],
  ["zero", 0], ["zero string", "0"], ["negative", -1], ["negative string", "-1"],
  ["empty string", ""], ["whitespace string", "  "], ["nonnumeric string", "not-bytes"],
  ["null", null], ["missing", undefined],
];
for (const alias of ["fileSize", "file_size"]) {
  for (const [label, value] of invalidSizes) {
    test(`signed metadata rejects ${alias} ${label} before a ticket`, async () => {
      const f = fixture();
      const body = aliased(metadata(), "fileSize", alias, value);
      if (value === undefined) delete body[alias];
      assertRefused(await f.invoke(body), f.sdk);
    });
  }
  for (const value of ["1024", "1e3", " 2048 "]) {
    test(`signed metadata retains numeric-string ${alias} control ${JSON.stringify(value)}`, async () => {
      const f = fixture();
      assertTicket(await f.invoke(aliased(metadata(), "fileSize", alias, value)), f.sdk,
        metadata({ fileSize: Number(value) }));
    });
  }
}

for (const alias of ["fileType", "file_type", "creativeType", "creative_type"]) {
  for (const [label, value] of [
    ["unknown type", "document"], ["format instead of type", "jpg"],
    ["object type", {}], ["boolean type", true], ["numeric type", 7],
  ] as Array<[string, unknown]>) {
    test(`signed metadata rejects explicit ${alias} ${label}`, async () => {
      const f = fixture();
      assertRefused(await f.invoke(aliased(metadata(), "fileType", alias, value)), f.sdk);
    });
  }
  test(`signed metadata rejects explicit image ${alias} with matching video MIME/extension`, async () => {
    const f = fixture();
    const video = metadata({ fileName: "synthetic.mp4", mimeType: "video/mp4" });
    assertRefused(await f.invoke(aliased(video, "fileType", alias, "image")), f.sdk);
  });
  test(`signed metadata cannot borrow the video cap for explicit image ${alias}`, async () => {
    const f = fixture();
    const video = metadata({ fileName: "synthetic.mp4", mimeType: "video/mp4", fileSize: IMAGE_LIMIT + 1 });
    assertRefused(await f.invoke(aliased(video, "fileType", alias, "image")), f.sdk);
  });
  test(`signed metadata rejects explicit video ${alias} with matching image MIME/extension`, async () => {
    const f = fixture();
    assertRefused(await f.invoke(aliased(metadata(), "fileType", alias, "video")), f.sdk);
  });
  test(`signed metadata canonicalizes supported uppercase ${alias}`, async () => {
    const f = fixture();
    const expected = metadata({ fileName: "synthetic.JPG" });
    assertTicket(await f.invoke(aliased(expected, "fileType", alias, " IMAGE ")), f.sdk, expected);
  });
}

for (const alias of ["mimeType", "mime_type"]) {
  for (const [fileName, mimeType, fileType] of [
    ["synthetic.jpg", "image/png", "image"],
    ["synthetic.png", "image/jpeg", "image"],
    ["synthetic.webp", "image/jpeg", "image"],
    ["synthetic.mp4", "video/quicktime", "video"],
    ["synthetic.mov", "video/webm", "video"],
    ["synthetic.webm", "video/mp4", "video"],
    ["synthetic.jpg", "video/mp4", "video"],
    ["synthetic.mp4", "image/jpeg", "image"],
  ]) {
    test(`signed metadata rejects ${alias} ${mimeType} disagreeing with ${fileName}`, async () => {
      const f = fixture();
      assertRefused(await f.invoke(aliased(metadata({ fileName, fileType }), "mimeType", alias, mimeType)), f.sdk);
    });
  }
  for (const mimeType of ["text/html", "image/x-synthetic", "image/jpg", "image/x-png"]) {
    test(`signed metadata rejects unknown ${alias} ${mimeType}`, async () => {
      const f = fixture();
      assertRefused(await f.invoke(aliased(metadata(), "mimeType", alias, mimeType)), f.sdk);
    });
  }
  test(`signed metadata rejects unknown video ${alias} video/mov`, async () => {
    const f = fixture();
    const video = metadata({ fileName: "synthetic.mov", fileType: "video" });
    assertRefused(await f.invoke(aliased(video, "mimeType", alias, "video/mov")), f.sdk);
  });
  for (const value of [123, {}, true]) {
    test(`signed metadata rejects nontext ${alias} ${JSON.stringify(value)} despite a known extension`, async () => {
      const f = fixture();
      assertRefused(await f.invoke(aliased(metadata(), "mimeType", alias, value)), f.sdk);
    });
  }
  test(`signed metadata normalizes supported uppercase ${alias}`, async () => {
    const f = fixture();
    assertTicket(await f.invoke(aliased(metadata(), "mimeType", alias, " IMAGE/JPEG ")), f.sdk, metadata());
  });
}

for (const alias of ["fileName", "file_name"]) {
  for (const [fileName, mimeType, fileType] of [
    ["synthetic.html", "image/jpeg", "image"],
    ["synthetic.svg", "image/jpeg", "image"],
    ["synthetic.gif", "image/jpeg", "image"],
    ["synthetic.avi", "video/mp4", "video"],
  ]) {
    test(`signed metadata rejects unknown ${fileName} extension in ${alias} despite allowed MIME`, async () => {
      const f = fixture();
      assertRefused(await f.invoke(aliased(metadata({ mimeType, fileType }), "fileName", alias, fileName)), f.sdk);
    });
  }
  for (const value of [undefined, "", "  ", 123, {}]) {
    test(`signed metadata rejects missing/nontext ${alias} ${JSON.stringify(value)}`, async () => {
      const f = fixture();
      const body = aliased(metadata(), "fileName", alias, value);
      if (value === undefined) delete body[alias];
      assertRefused(await f.invoke(body), f.sdk);
    });
  }
}

for (const [label, patch] of [
  ["object fileName with a valid file_name fallback", { fileName: {}, file_name: "synthetic.jpg" }],
  ["object file_name behind valid fileName", { file_name: {} }],
  ["object mimeType with a valid mime_type fallback", { mimeType: {}, mime_type: "image/jpeg" }],
  ["object mime_type behind valid mimeType", { mime_type: {} }],
  ["object file_type behind valid fileType", { file_type: {} }],
  ["object creativeType behind valid fileType", { creativeType: {} }],
  ["boolean creative_type behind valid fileType", { creative_type: true }],
  ["boolean file_size behind valid fileSize", { file_size: true }],
  ["object file_size behind valid fileSize", { file_size: { bytes: 1024 } }],
] as Array<[string, Json]>) {
  test(`signed metadata rejects malformed aliases: ${label}`, async () => {
    const f = fixture();
    assertRefused(await f.invoke(metadata(patch)), f.sdk);
  });
}

test("signed metadata rejects an empty body before a ticket", async () => {
  const f = fixture();
  assertRefused(await f.invoke({}), f.sdk);
});

test("signed metadata validates all-snake-case video metadata then requires the video worker", async () => {
  const f = fixture();
  assertVideoWorkerRequired(await f.invoke({
    file_name: "synthetic.mov", file_type: "video", mime_type: "video/quicktime", file_size: "1024",
  }), f.sdk);
});

test("signed metadata rejects an unknown extension when MIME is also unavailable", async () => {
  const f = fixture();
  assertRefused(await f.invoke(metadata({ fileName: "synthetic.html", mimeType: "" })), f.sdk);
});

test("signed metadata ignores browser bucket/path/workspace overrides for a valid UI request", async () => {
  for (const workspaceId of [WORKSPACE, FOREIGN_WORKSPACE]) {
    const f = fixture();
    const untrustedPath = "untrusted/../../foreign-overwrite.jpg";
    assertTicket(await f.invoke(metadata({
      workspaceId: "untrusted-workspace", workspace_id: "untrusted-workspace",
      bucket: "ad-creatives-raw", storageBucket: "foreign-bucket", storage_bucket: "foreign-bucket",
      storagePath: untrustedPath, storage_path: untrustedPath,
      publicUrl: "https://untrusted.invalid/overwrite.jpg", token: "untrusted-token",
      signedUrl: "https://untrusted.invalid/upload",
    }), workspaceId), f.sdk, metadata(), workspaceId);
    assert.notEqual(f.sdk.tickets[0]!.args[0], untrustedPath);
  }
});

test("private image admission rejects a foreign SDK path instead of returning a public fallback", async () => {
  const f = fixture();
  f.sdk.receiptPatch = { path: `${FOREIGN_WORKSPACE}/sdk-echo-must-not-be-used.jpg` };
  const reply = await f.invoke(metadata());
  assert.equal(reply.status, 503);
  assert.equal(reply.body.success, false);
  assert.equal(reply.body.code, "creative_staging_ticket_unconfirmed");
  assert.equal(reply.body.data, undefined);
  assert.notEqual(reply.body.mode, "demo");
  assert.equal(f.sdk.admissions.length, 1);
  assert.deepEqual(f.sdk.bucketReads, [PRIVATE_BUCKET]);
  assert.deepEqual(f.sdk.buckets, [PRIVATE_BUCKET]);
  assert.equal(f.sdk.tickets.length, 1);
  assert.equal(f.sdk.tickets[0]!.args[0], `${WORKSPACE}/staged/${NONCE}/original.jpg`);
});

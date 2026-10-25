import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual photo/start/poll handlers and storage helper. Provider HTTP, Storage
// SDK, usage and library persistence are recording doubles, never real services.
// Image validation is different: the actual helper uses the real local sharp
// decoder. The synthetic MP4 below is a transport fixture, not decoded video.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || ["b301f1f", "fc597ad"].includes(baseline), "only reviewed local baselines are supported");

async function sourceFile(file: string) {
  const source = baseline
    ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function compile(source: string, file: string) {
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics ?? [], [], `actual ${file} must transpile`);
  return new Script(result.outputText, { filename: `${baseline ?? "working-tree"}:${file}.cjs` });
}
function select(ast: import("typescript").SourceFile, names: string[], boundaries: string[] = []) {
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
  const include = (name: string) => {
    if (boundaries.includes(name)) return;
    const declaration = declarations.get(name);
    assert.ok(declaration, `actual ${ast.fileName}:${name} must exist`);
    if (selected.has(declaration)) return;
    selected.add(declaration);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  };
  names.forEach(include);
  return compile([
    ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)),
    `exports.runtime = { ${names.join(", ")} };`,
  ].join("\n"), ast.fileName);
}

const route = await sourceFile("api/content-studio/[...path].ts");
const server = await sourceFile("lib/crm/server.ts");
const generation = await sourceFile("lib/content-studio/generation.ts");
const imageHelper = await sourceFile("lib/crm/creative-image.ts");
const identityHelper = await sourceFile("lib/crm/generated-identity.ts");
const verificationHelper = await sourceFile("lib/crm/generated-storage-verification.ts");
const usage = await sourceFile("lib/content-studio/usage.ts");
const handlerScript = select(route, ["handleGeneratePhoto", "handleGenerateVideo", "handleVideoGeneration"]);
const storeScript = select(server, [
  "storeGeneratedCreative", "makeAdCreativeAsset", "buildAdCreativeStoragePath", "buildSupabaseStoragePublicUrl", "configs",
], ["persistAdCreativeAsset"]);
const generationScript = compile(generation.text, generation.fileName);
const decoderScript = compile(imageHelper.text, imageHelper.fileName);
const identityScript = compile(identityHelper.text, identityHelper.fileName);
const verificationScript = compile(verificationHelper.text, verificationHelper.fileName);
const billingScript = select(usage, ["billableVideoSeconds"]);

type Json = Record<string, unknown>;
type Kind = "photo" | "video";
type Reply = { status: number; body: Json };
type Response = {
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(body: unknown): void;
};
type Handler = (req: Json, res: Response, context: Json) => Promise<unknown>;
type StoreInput = { workspaceId: string; fileName: string; mimeType: string; buffer: Buffer; metadata?: Json; idempotencyKey?: string };
type DecoderInput = { buffer: Buffer; fileName: string; mimeType: string };
type LibraryInput = { workspaceId: string; body: Json };
type Options = {
  imageBytes?: Buffer;
  stored?: (input: StoreInput, saved: Json) => unknown;
  upload?: (key: string) => unknown;
  publicUrl?: (key: string) => unknown;
  persist?: (input: LibraryInput, saved: Json) => unknown;
  ownStorageBytes?: Buffer;
  lookup?: () => unknown;
};
type Identity = { assetId: string; fileName: string; storagePath: string; keyDigest: string };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const REQUEST_KEY = "44444444-4444-4444-8444-444444444444";
const USAGE_ID = "55555555-5555-4555-8555-555555555555";
const JOB = "video_synthetic_job";
const ORIGIN = "https://generated-media.invalid";
const RAW = "RAW_DIAGNOSTIC synthetic_internal_policy customer=synthetic";
const SYNTHETIC_ENV = Object.freeze({
  OPENAI_API_KEY: "synthetic-provider-key-not-a-credential",
  CONTENT_STUDIO_IMAGE_MODEL: "synthetic-image-model",
  CONTENT_STUDIO_VIDEO_MODEL: "synthetic-video-model",
  CONTENT_STUDIO_VIDEO_SECONDS: "4",
  SUPABASE_URL: ORIGIN,
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-signing-material-not-a-credential",
});
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWOQq9giV7GFAUIBACHOBSl+UhuwAAAAAElFTkSuQmCC", "base64",
);
const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
const clone = <T,>(value: T): T => structuredClone(value);
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

function fixture(options: Options = {}) {
  const events: string[] = [];
  const external: string[] = [];
  const providerCalls: Array<{ url: string; method: string }> = [];
  const reservations: Json[] = [];
  const completions: Json[] = [];
  const stores: StoreInput[] = [];
  const uploads: Array<{ bucket: string; key: string; buffer: Buffer; options: Json }> = [];
  const libraryAttempts: LibraryInput[] = [];
  const libraryRows = new Map<string, Json>();
  const objects = new Map<string, Buffer>();
  const storageReads: Array<{ url: string; init: Json }> = [];
  const lookups: Json[] = [];
  const decoderCalls: DecoderInput[] = [];
  let now = "2026-10-25T03:00:00.000Z";
  const forbidden = (operation: string): never => {
    external.push(operation);
    throw new Error(`Forbidden external operation: ${operation}`);
  };
  class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return Date.parse(now); }
  }
  function evaluate(program: Script, bindings: Json = {}): Json {
    const exports: Json = {};
    program.runInNewContext({
      exports, Buffer, Error, Date: FixedDate, URL, AbortController, setTimeout, clearTimeout,
      process: Object.freeze({ env: SYNTHETIC_ENV }),
      fetch: () => forbidden("real/global fetch"),
      require: (id: string) => forbidden(`unexpected import ${id}`),
      console: { warn() {}, error() {} },
      ...bindings,
    }, { timeout: 1000 });
    return exports;
  }
  const actualGeneration = evaluate(generationScript, {
    require: (id: string) => id === "node:crypto" ? requireFromRoot(id) : forbidden(`generation import ${id}`),
  });
  const actualIdentity = evaluate(identityScript, {
    require: (id: string) => id === "node:crypto" ? requireFromRoot(id) : forbidden(`identity import ${id}`),
  }) as {
    generatedCreativeIdentity(input: { workspaceId: unknown; idempotencyKey: unknown; mimeType: unknown }): Identity;
    isLegacyGeneratedVideoIdentity(input: Json): boolean;
  };
  const actualVerification = evaluate(verificationScript, {
    require: (id: string) => id === "node:crypto" ? requireFromRoot(id) : forbidden(`verification import ${id}`),
    async fetch(url: string, init: Json) {
      const identity = actualIdentity.generatedCreativeIdentity({ workspaceId: WORKSPACE, idempotencyKey: JOB, mimeType: "video/mp4" });
      assert.equal(url, `${ORIGIN}/storage/v1/object/public/ad-creatives/${identity.storagePath}`,
        "only the exact server-derived own-Storage URL may be read for reconciliation");
      storageReads.push({ url, init });
      events.push("storage.read");
      const bytes = options.ownStorageBytes ?? objects.get(identity.storagePath);
      const response = new globalThis.Response(bytes ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 7));
          controller.enqueue(bytes.subarray(7));
          controller.close();
        },
      }) : null, { status: bytes ? 200 : 404, headers: bytes
        ? { "content-type": "video/mp4", "content-length": String(bytes.length) } : {} });
      Object.defineProperties(response, {
        arrayBuffer: { value: () => forbidden("buffered own-Storage reconciliation") },
        text: { value: () => forbidden("text own-Storage reconciliation") },
      });
      return response;
    },
  });
  const actualDecoder = evaluate(decoderScript, {
    require: (id: string) => {
      if (id === "../content-studio/generation") return actualGeneration;
      if (id === "sharp") return requireFromRoot(id);
      return forbidden(`decoder import ${id}`);
    },
  }) as { validateCreativeImageBytes(input: DecoderInput): Promise<string[]>; CreativeImageValidationUnavailable: unknown };
  const sdk = {
    storage: {
      from(bucket: string) {
        return {
          async upload(key: string, buffer: Buffer, uploadOptions: Json) {
            events.push("sdk.upload");
            uploads.push({ bucket, key, buffer: Buffer.from(buffer), options: clone(uploadOptions) });
            const reply = options.upload ? await options.upload(key) : objects.has(key)
              ? { data: null, error: { message: "synthetic object already exists" } }
              : { data: { path: key }, error: null };
            if (!record(reply).error && record(record(reply).data).path === key) objects.set(key, Buffer.from(buffer));
            return reply;
          },
          getPublicUrl(key: string) {
            events.push("sdk.publicUrl");
            return options.publicUrl ? options.publicUrl(key)
              : { data: { publicUrl: `${ORIGIN}/storage/v1/object/public/${bucket}/${key}` } };
          },
          async remove(_keys: string[]) { events.push("sdk.remove"); return { data: [], error: null }; },
        };
      },
    },
    from(table: string) {
      assert.equal(table, "ad_creative_assets", "only the generated library lookup is simulated");
      const filters: Json = {};
      const query = {
        select(columns: string) { assert.equal(columns, "*"); return query; },
        eq(column: string, value: unknown) {
          assert.ok(["workspace_id", "generated_key"].includes(column), `unexpected lookup filter ${column}`);
          assert.ok(!Object.hasOwn(filters, column), "lookup filters must not be replaced");
          filters[column] = value;
          return query;
        },
        async limit(limit: number) {
          assert.equal(limit, 2, "duplicate keys must remain detectable");
          assert.deepEqual(filters, { workspace_id: WORKSPACE, generated_key: `v1:${JOB}` },
            "every service-role lookup pins the tenant and exact private generation key");
          lookups.push(clone(filters));
          events.push("library.lookup");
          return options.lookup ? options.lookup() : { data: [...libraryRows.values()].filter((row) =>
            row.workspace_id === filters.workspace_id && row.generated_key === filters.generated_key), error: null };
        },
      };
      return query;
    },
  };
  const actualStore = record(evaluate(storeScript, {
    ...actualDecoder, ...actualIdentity, ...actualVerification, createHash,
    async validateCreativeImageBytes(input: DecoderInput) {
      decoderCalls.push(input);
      return actualDecoder.validateCreativeImageBytes(input);
    },
    getSupabaseServerClient: () => sdk,
    async persistAdCreativeAsset(input: LibraryInput) {
      events.push("library.persist");
      libraryAttempts.push(clone(input));
      const asset = actualStore.makeAdCreativeAsset({ ...clone(input.body),
        id: input.body.generatedAssetId ?? input.body.id ?? ASSET, workspaceId: input.workspaceId });
      const saved = { asset, mode: "supabase", warning: "" };
      const reply = options.persist ? await options.persist(input, saved) : saved;
      if (record(reply).mode === "supabase" && record(record(reply).asset).id === asset.id) {
        const row = actualStore.configs["ad-creatives"].toRow(input.body, input.workspaceId);
        libraryRows.set(String(input.body.storagePath), { ...clone(row), id: asset.id,
          ...(input.body.generatedKey ? { generated_key: input.body.generatedKey, generated_sha256: input.body.generatedSha256 } : {}) });
      }
      return reply;
    },
  }).runtime) as {
    storeGeneratedCreative(input: StoreInput): Promise<unknown>;
    makeAdCreativeAsset(body: Json): Json;
    buildAdCreativeStoragePath(input: { workspaceId: string; fileName: string; stableId?: string }): string;
    buildSupabaseStoragePublicUrl(input: { bucket: string; storagePath: string }): string;
    configs: { "ad-creatives": { toRow(body: Json, workspaceId: string): Json } };
  };

  async function providerFetch(url: string, init?: { method?: string }) {
    const method = init?.method ?? "GET";
    providerCalls.push({ url, method });
    const json = (body: Json) => ({ ok: true, status: 200, text: async () => JSON.stringify(body),
      arrayBuffer: () => forbidden("unexpected provider JSON as bytes") });
    if (url === "https://api.openai.com/v1/images/generations" && method === "POST") {
      events.push("provider.image");
      return json({ data: [{ b64_json: (options.imageBytes ?? PNG).toString("base64") }] });
    }
    if (url === "https://api.openai.com/v1/videos" && method === "POST") {
      events.push("provider.start");
      return json({ id: JOB, status: "queued", progress: 0 });
    }
    if (url === `https://api.openai.com/v1/videos/${JOB}` && method === "GET") {
      events.push("provider.poll");
      return json({ id: JOB, status: "completed", progress: 100, error: { message: RAW } });
    }
    if (url === `https://api.openai.com/v1/videos/${JOB}/content?variant=video` && method === "GET") {
      events.push("provider.file");
      return { ok: true, status: 200, text: async () => "",
        arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength) };
    }
    return forbidden(`unrecognized provider request ${method} ${url}`);
  }
  const billing = record(evaluate(billingScript).runtime);
  const handlers = record(evaluate(handlerScript, {
    ...actualGeneration, ...actualIdentity, ...billing, fetch: providerFetch,
    async reserveContentGeneration(input: Json) {
      events.push("usage.reserve");
      reservations.push(clone(input));
      return { allowed: true, tracked: true, duplicate: false, usageId: USAGE_ID, kind: input.kind,
        used: input.units, limit: 100, remaining: 100 - Number(input.units), periodStart: "2026-10-01" };
    },
    async completeContentGeneration(input: Json) {
      events.push(`usage.${input.status}`);
      completions.push(clone(input));
    },
    async storeGeneratedCreative(input: StoreInput) {
      events.push("store");
      stores.push(input);
      if (!options.stored) return actualStore.storeGeneratedCreative(input);
      // Build a complete boundary receipt using actual path/URL/DTO helpers;
      // each malformed case can then change only its targeted evidence.
      const identity = input.idempotencyKey === undefined ? undefined : actualIdentity.generatedCreativeIdentity({
        workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, mimeType: input.mimeType,
      });
      const storagePath = identity?.storagePath ?? actualStore.buildAdCreativeStoragePath({
        workspaceId: input.workspaceId, fileName: input.fileName, stableId: input.idempotencyKey,
      });
      const publicUrl = actualStore.buildSupabaseStoragePublicUrl({ bucket: "ad-creatives", storagePath });
      const asset = actualStore.makeAdCreativeAsset({
        ...input, id: identity?.assetId ?? ASSET, fileName: identity?.fileName ?? input.fileName,
        fileSize: input.buffer.length, storageBucket: "ad-creatives", storagePath, publicUrl,
        metadata: { ...input.metadata, uploadMode: "ai-generated", ...(identity ? {
          generationKey: identity.keyDigest, contentSha256: createHash("sha256").update(input.buffer).digest("hex"), jobId: input.idempotencyKey,
        } : {}) }, status: "uploaded",
      });
      return options.stored(input, { publicUrl, asset, mode: "supabase", warning: "" });
    },
  }).runtime) as Record<string, Handler>;

  async function invoke(action: "photo" | "start" | "poll", handle?: string): Promise<Reply> {
    const req: Json = {
      method: action === "poll" ? "GET" : "POST",
      headers: { "x-idempotency-key": REQUEST_KEY }, query: { handle },
      body: { prompt: "Synthetic clinic interior", format: "reels" },
    };
    const replies: Json[] = [];
    let status = 0;
    const res: Response = {
      status(value) { status = value; return this; },
      setHeader() { return this; },
      json(value) { replies.push(clone(value) as Json); },
    };
    const name = action === "photo" ? "handleGeneratePhoto" : action === "start" ? "handleGenerateVideo" : "handleVideoGeneration";
    try {
      await handlers[name]!(req, res, { workspaceId: WORKSPACE, staffUserId: STAFF, role: "owner" });
    } finally {
      assert.deepEqual(external, [], "no real network, credentials, provider jobs or database access");
    }
    assert.equal(replies.length, 1, "one actual handler response");
    return { status, body: replies[0]! };
  }
  return {
    events, providerCalls, reservations, completions, stores, uploads, libraryAttempts, libraryRows, decoderCalls, storageReads, lookups,
    identity: actualIdentity.generatedCreativeIdentity,
    advanceMonth() { now = "2026-11-25T03:00:00.000Z"; },
    decode: (input: DecoderInput) => actualDecoder.validateCreativeImageBytes(input),
    invoke,
    async start() {
      const reply = await invoke("start");
      assert.equal(reply.status, 202);
      assert.equal(reply.body.success, true);
      const handle = record(reply.body.data).handle;
      assert.equal(typeof handle, "string");
      return handle as string;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function assertCharged(f: Fixture, kind: Kind) {
  assert.ok(!f.events.includes("sdk.remove"), "uncertain storage must never delete a possibly existing object");
  assert.equal(f.reservations.length, 1, "one reservation for the accepted paid provider request");
  assert.equal(f.reservations[0]!.workspaceId, WORKSPACE);
  assert.equal(f.reservations[0]!.staffUserId, STAFF);
  assert.equal(f.reservations[0]!.requestKey, REQUEST_KEY);
  assert.equal(f.reservations[0]!.kind, kind === "photo" ? "image" : "video_seconds");
  assert.equal(f.reservations[0]!.units, kind === "photo" ? 1 : 4);
  assert.equal(f.completions.length, 1, "storage rejection must not refund or re-charge a completed provider request");
  assert.equal(f.completions[0]!.status, "succeeded");
  assert.equal(f.completions[0]!.workspaceId, WORKSPACE);
  assert.equal(record(f.completions[0]!.reservation).usageId, USAGE_ID);
  assert.equal(f.completions[0]!.errorCode, undefined);
  assert.ok(f.events.indexOf("usage.succeeded") < f.events.indexOf("store"), "provider charge precedes storage");
  const paid = f.providerCalls.filter((call) => call.method === "POST");
  assert.deepEqual(paid, [{ method: "POST", url: `https://api.openai.com/v1/${kind === "photo" ? "images/generations" : "videos"}` }]);
}
function assertRedacted(reply: Reply) {
  const serialized = JSON.stringify(reply.body);
  assert.ok(!serialized.includes(RAW), "raw SDK/library/provider diagnostics must not reach the operator");
  assert.ok(!serialized.includes(SYNTHETIC_ENV.OPENAI_API_KEY));
  assert.ok(!serialized.includes(SYNTHETIC_ENV.SUPABASE_SERVICE_ROLE_KEY));
}
function assertNotSaved(reply: Reply, kind: Kind) {
  assertRedacted(reply);
  assert.equal(reply.status, 502, "an unconfirmed generated file must not be reported ready");
  assert.equal(reply.body.success, false);
  const data = record(reply.body.data);
  assert.ok(!data.creativeUrl && !data.publicUrl && !data.assetId, "no public creative or library identity on rejection");
  assert.ok(!["ready", "completed", "uploaded"].includes(String(data.status)));
  assert.notEqual(data.librarySaved, true);
  assert.notEqual(data.saved, true);
  assert.ok(Array.isArray(reply.body.details) && reply.body.details.length > 0);
  // Preserve the paid/rendered stage, not a claim that generation never ran.
  assert.match(String(reply.body.error), kind === "photo"
    ? /\u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u043e\u0432\u0430\u043d\u043e/
    : /\u043e\u0442\u0440\u0435\u043d\u0434\u0435\u0440\u0435\u043d/);
  assert.match(String(reply.body.error),
    /, \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e$/,
    "storage errors must express unconfirmed persistence, not definite absence");
  assert.doesNotMatch(JSON.stringify(reply.body),
    /\u043d\u0435\s+\u0441\u043e\u0445\u0440\u0430\u043d(?:\u0435\u043d\u043e?|\u0451\u043d)/i,
    "no public error, detail or hint may claim the generated file definitely was not saved");
  assert.match(String(reply.body.hint), /\u043e\u043f\u043b\u0430\u0447\u0435\u043d/);
  if (kind === "video") assert.match(String(reply.body.hint), /\u043e\u043f\u0440\u043e\u0441/);
}
function assertSaved(reply: Reply, kind: Kind, f: Fixture) {
  assertRedacted(reply);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.mode, "openai");
  const data = record(reply.body.data);
  const identity = f.identity({ workspaceId: WORKSPACE, idempotencyKey: JOB, mimeType: "video/mp4" });
  assert.equal(data.assetId, kind === "photo" ? ASSET : identity.assetId);
  assert.equal(typeof data.creativeUrl, "string");
  assert.ok(String(data.creativeUrl).startsWith(`${ORIGIN}/`));
  assert.equal(data.mimeType, kind === "photo" ? "image/png" : "video/mp4");
  assert.equal(data.fileSize, kind === "photo" ? PNG.length : MP4.length);
  if (kind === "photo") assert.match(String(data.fileName), /^negis-photo-\d+\.png$/);
  else {
    assert.equal(data.fileName, identity.fileName);
    assert.equal(data.creativeUrl, `${ORIGIN}/storage/v1/object/public/ad-creatives/${identity.storagePath}`);
    assert.equal(data.status, "completed");
  }
}
async function produce(f: Fixture, kind: Kind) {
  if (kind === "photo") return f.invoke("photo");
  return f.invoke("poll", await f.start());
}
for (const kind of ["photo", "video"] as const) {
  test(`generated ${kind} positive control reaches actual storage and confirms the library receipt`, async () => {
    const f = fixture();
    assert.equal((await f.decode({ buffer: PNG, fileName: "fixture.png", mimeType: "image/png" })).length, 0,
      "real decoder accepts fixture");
    const reply = await produce(f, kind);
    assertCharged(f, kind);
    assertSaved(reply, kind, f);
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0]!.bucket, "ad-creatives");
    assert.ok(f.uploads[0]!.key.startsWith(`${WORKSPACE}/`));
    assert.equal(f.uploads[0]!.options.upsert, false, "generated objects are create-only, including keyed video");
    assert.equal(f.libraryRows.size, 1);
    if (kind === "video") {
      const identity = f.identity({ workspaceId: WORKSPACE, idempotencyKey: JOB, mimeType: "video/mp4" });
      assert.equal(f.stores[0]!.fileName, identity.fileName, "the actual API derives identity before storage");
      assert.equal(f.uploads[0]!.key, identity.storagePath);
      const body = f.libraryAttempts[0]!.body;
      assert.equal(body.generatedAssetId, identity.assetId);
      assert.equal(body.generatedKey, `v1:${JOB}`);
      assert.equal(body.generatedSha256, createHash("sha256").update(MP4).digest("hex"));
      assert.equal(record(body.metadata).generationKey, identity.keyDigest);
      assert.equal(record(body.metadata).contentSha256, body.generatedSha256);
      assert.equal(record(body.metadata).uploadMode, "ai-generated");
      assert.equal(record(body.metadata).jobId, JOB);
    }
  });

  test(`generated ${kind} caller accepts the complete positive boundary receipt`, async () => {
    const f = fixture({ stored: (_input, saved) => saved });
    const reply = await produce(f, kind);
    assertCharged(f, kind);
    assertSaved(reply, kind, f);
    assert.equal(f.uploads.length, 0, "the DTO double must be valid before individual malformed-receipt mutations");
  });

  const malformedReceipts: Array<[string, NonNullable<Options["stored"]>]> = [
    ["undefined receipt", () => undefined], ["null receipt", () => null], ["empty receipt", () => ({})],
    ["empty public URL", (_input, saved) => ({ ...saved, publicUrl: "" })],
    ["whitespace public URL", (_input, saved) => ({ ...saved, publicUrl: " \n\t " })],
    ["numeric public URL", (_input, saved) => ({ ...saved, publicUrl: 17 })],
    ["object public URL", (_input, saved) => ({ ...saved, publicUrl: { url: ORIGIN } })],
    ["missing library identity", (_input, saved) => ({ ...saved, asset: { ...record(saved.asset), id: "" } })],
    ["declined persistence with raw warning", (_input, saved) => ({ ...saved, mode: "demo", warning: RAW })],
  ];
  for (const [label, result] of malformedReceipts) {
    test(`generated ${kind} caller rejects malformed storage result: ${label}`, async () => {
      const f = fixture({ stored: result });
      const reply = await produce(f, kind);
      assertCharged(f, kind);
      assert.equal(f.uploads.length, 0, "this case substitutes the store boundary, not a decoder or SDK");
      assertNotSaved(reply, kind);
    });
  }

  test(`generated ${kind} caller redacts a post-provider validation rejection without refunding`, async () => {
    const f = fixture({ stored: () => { throw new Error(RAW); } });
    const reply = await produce(f, kind);
    assertCharged(f, kind);
    assertNotSaved(reply, kind);
  });

  const storageCases: Array<[string, Options]> = [
    ["upload has no acknowledgement", { upload: () => ({}) }],
    ["upload has null data without an error", { upload: () => ({ data: null, error: null }) }],
    ["upload acknowledgement lacks its path", { upload: () => ({ data: {}, error: null }) }],
    ["upload returns an SDK error", { upload: () => ({ data: null, error: { message: RAW } }) }],
    ["upload throws a raw transport error", { upload: () => { throw new Error(RAW); } }],
    ["public URL response has null data", { publicUrl: () => ({ data: null }) }],
    ["public URL is whitespace", { publicUrl: () => ({ data: { publicUrl: " \n\t " } }) }],
    ["public URL is numeric", { publicUrl: () => ({ data: { publicUrl: 17 } }) }],
    ["public URL is an object", { publicUrl: () => ({ data: { publicUrl: { url: ORIGIN } } }) }],
    ["library declines persistence", { persist: () => ({ mode: "demo", asset: { id: ASSET }, warning: RAW }) }],
    ["library returns no saved identity", { persist: () => ({ mode: "supabase", asset: {}, warning: "" }) }],
    ["library throws a raw persistence error", { persist: () => { throw new Error(RAW); } }],
  ];
  for (const [label, options] of storageCases) {
    test(`generated ${kind} actual store rejects: ${label}`, async () => {
      const f = fixture(options);
      const reply = await produce(f, kind);
      assertCharged(f, kind);
      assert.equal(f.stores.length, 1, "the actual handler reaches the actual storage helper");
      assert.equal(f.uploads.length, label.startsWith("public URL") ? 0 : 1,
        "invalid public URLs must be refused before an SDK upload; SDK attempts are not byte validation");
      assertNotSaved(reply, kind);
    });
  }

  test(`generated ${kind} rejects an empty SDK public URL before upload instead of guessing a fallback`, async () => {
    const f = fixture({ publicUrl: () => ({ data: { publicUrl: "" } }) });
    const reply = await produce(f, kind);
    assertCharged(f, kind);
    assertNotSaved(reply, kind);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.libraryAttempts.length, 0);
  });
}

for (const [format, mimeType, buffer] of [
  ["PNG", "image/png", Buffer.from("89504e470d0a1a0a", "hex")],
  ["JPEG", "image/jpeg", Buffer.from("ffd8ff", "hex")],
  ["WEBP", "image/webp", Buffer.from("524946460400000057454250", "hex")],
] as Array<[string, string, Buffer]>) {
  test(`generated photo rejects ${format} signature-only bytes after the provider returned a file`, async () => {
    const f = fixture({ imageBytes: buffer });
    const extension = format === "JPEG" ? "jpg" : format.toLowerCase();
    assert.ok((await f.decode({ buffer, fileName: `fixture.${extension}`, mimeType })).length > 0,
      "the real decoder, not a test-double verdict, rejects the fixture");
    const reply = await f.invoke("photo");
    assertCharged(f, "photo");
    assert.equal(f.stores.length, 1, "provider parsing returned a signature-recognized file to the actual handler");
    assertNotSaved(reply, "photo");
    assert.equal(f.uploads.length, 0, "rejected bytes must not reach the public Storage SDK");
    assert.equal(f.libraryAttempts.length, 0, "rejected bytes must not create a library row");
    assert.equal(f.decoderCalls.length, 1, "the production storage path must call the real byte validator");
  });
}

test("generated photo rejects the actual metadata size limit after provider success", async () => {
  const oversized = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1 - PNG.length)]);
  const f = fixture({ imageBytes: oversized });
  const reply = await f.invoke("photo");
  assertCharged(f, "photo");
  assertNotSaved(reply, "photo");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.libraryAttempts.length, 0);
});

for (const failedStage of ["upload", "library"] as const) {
  test(`generated video safely repolls the same paid job after ${failedStage} rejection`, async () => {
    let reject = true;
    const f = fixture(failedStage === "upload" ? {
      upload: (key) => reject ? { data: null, error: { message: RAW } } : { data: { path: key }, error: null },
    } : {
      persist: (_input, saved) => reject ? { mode: "demo", asset: {}, warning: RAW } : saved,
    });
    const handle = await f.start();
    const accountingAtStart = clone({ reservations: f.reservations, completions: f.completions });
    const refused = await f.invoke("poll", handle);
    reject = false;
    const recovered = await f.invoke("poll", handle);
    assertCharged(f, "video");
    assert.deepEqual({ reservations: f.reservations, completions: f.completions }, accountingAtStart,
      "failed storage and successful same-job repoll must preserve the original consumed provider accounting");
    assert.deepEqual(f.stores.map((input) => input.idempotencyKey), [JOB, JOB], "repoll retains the original job identity");
    assert.equal(f.providerCalls.filter((call) => call.method === "GET").length, 4, "two status/file reads, no paid creation");
    assertSaved(recovered, "video", f);
    assertNotSaved(refused, "video");
  });
}

test("actual generated identity pins the versioned digest and UUID, not date, filename or MIME", () => {
  const f = fixture();
  const expected = {
    assetId: "82911a71-364f-59a4-97cf-0aed9e5416e0",
    keyDigest: "91adad4e1dd2964fc28214b1b0437f2ceca721ed69c117b98dee88398440b4e5",
    fileName: "negis-video-91adad4e1dd2964fc282.mp4",
    storagePath: `${WORKSPACE}/generated/91adad4e1dd2964fc28214b1b0437f2ceca721ed69c117b98dee88398440b4e5`,
  };
  const input = { workspaceId: WORKSPACE, idempotencyKey: JOB, mimeType: "video/mp4", fileName: "caller-first.mp4" };
  assert.deepEqual({ ...f.identity(input) }, expected);
  f.advanceMonth();
  const renamed = { ...input, fileName: "caller-renamed.mp4" };
  assert.deepEqual({ ...f.identity(renamed) }, expected);
  const otherMime = f.identity({ ...input, mimeType: "image/png" });
  assert.equal(otherMime.assetId, expected.assetId);
  assert.equal(otherMime.keyDigest, expected.keyDigest);
  assert.equal(otherMime.storagePath, expected.storagePath);
  assert.equal(otherMime.fileName, "negis-image-91adad4e1dd2964fc282.png");
  const uppercase = { ...input, workspaceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" };
  assert.deepEqual({ ...f.identity(uppercase) }, { ...f.identity({ ...uppercase, workspaceId: uppercase.workspaceId.toLowerCase() }) });
  assert.notEqual(f.identity({ ...input, idempotencyKey: `${JOB}X` }).keyDigest, expected.keyDigest);
  assert.notEqual(f.identity(uppercase).keyDigest, expected.keyDigest);
  assert.match(f.identity({ ...input, idempotencyKey: "x".repeat(512) }).keyDigest, /^[a-f0-9]{64}$/);
  for (const idempotencyKey of [undefined, null, 1, {}, "", " ", ` ${JOB}`, `${JOB}\n`, "x".repeat(513)]) {
    assert.throws(() => f.identity({ ...input, idempotencyKey }), /generated_identity_invalid/);
  }
  for (const workspaceId of [null, "demo", ` ${WORKSPACE}`, "00000000-0000-0000-0000-000000000000"]) {
    assert.throws(() => f.identity({ ...input, workspaceId }), /generated_identity_invalid/);
  }
  for (const mimeType of [undefined, "", "VIDEO/MP4", "video/mp4;codecs=avc1", "__proto__"]) {
    assert.throws(() => f.identity({ ...input, mimeType }), /generated_identity_invalid/);
  }
  assert.equal(f.uploads.length, 0);
  assert.equal(f.providerCalls.length, 0);
});

test("completed video repolls across a month boundary using private proof after metadata replacement", async () => {
  const f = fixture();
  const handle = await f.start();
  const first = await f.invoke("poll", handle);
  assertSaved(first, "video", f);
  const accounting = clone({ reservations: f.reservations, completions: f.completions });
  const row = [...f.libraryRows.values()][0]!;
  row.metadata = { metaStatus: "ready" };
  row.status = "ready";
  f.advanceMonth();
  const repeated = await f.invoke("poll", handle);
  assertSaved(repeated, "video", f);
  assertCharged(f, "video");
  assert.deepEqual(record(repeated.body.data), record(first.body.data));
  assert.deepEqual({ reservations: f.reservations, completions: f.completions }, accounting);
  assert.equal(f.uploads.length, 1, "an exact existing keyed row must be verified before any new write");
  assert.equal(f.libraryAttempts.length, 1);
  assert.equal(f.libraryRows.size, 1);
  assert.equal(f.storageReads.length, 1, "existing canonical receipt still requires streamed own-object byte proof");
  assert.equal(f.lookups.length, 2);
});

test("lost video upload acknowledgement recovers only after exact streamed own-Storage verification", async () => {
  const f = fixture({ upload: () => { throw new Error(RAW); }, ownStorageBytes: MP4 });
  const reply = await produce(f, "video");
  assertCharged(f, "video");
  assertSaved(reply, "video", f);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.options.upsert, false);
  assert.equal(f.storageReads.length, 1);
  const read = f.storageReads[0]!;
  assert.equal(read.init.method, "GET");
  assert.equal(read.init.redirect, "error");
  assert.equal(read.init.credentials, "omit");
  assert.equal(read.init.cache, "no-store");
  assert.equal((read.init.signal as AbortSignal).aborted, true, "verification lifetime ends after reading");
  assert.ok(f.events.indexOf("storage.read") < f.events.indexOf("library.persist"));
  assert.equal(f.libraryAttempts.length, 1);
});

test("video upload collision with same-size different bytes remains unconfirmed without insert or delete", async () => {
  const different = Buffer.from(MP4);
  different[different.length - 1] ^= 1;
  const f = fixture({ upload: () => ({ data: null, error: { message: RAW } }), ownStorageBytes: different });
  const reply = await produce(f, "video");
  assertCharged(f, "video");
  assertNotSaved(reply, "video");
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.options.upsert, false);
  assert.equal(f.storageReads.length, 1);
  assert.equal(f.libraryAttempts.length, 0);
  assert.equal(f.libraryRows.size, 0);
});

test("missing private-key columns cannot be treated as absent keyed video before upload", async () => {
  const f = fixture({ lookup: () => ({ data: null, error: { message: `column generated_key does not exist: ${RAW}` } }) });
  const reply = await produce(f, "video");
  assertCharged(f, "video");
  assertNotSaved(reply, "video");
  assert.equal(f.lookups.length, 1);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.storageReads.length, 0);
  assert.equal(f.libraryAttempts.length, 0);
});

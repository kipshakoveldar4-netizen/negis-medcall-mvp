import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
const { generatedVideoRequestDigest } = createRequire(import.meta.url)("../../lib/content-studio/generated-video-handle.ts") as {
  generatedVideoRequestDigest(prompt: unknown, format: unknown): string;
};
const { VideoRequestLifetime } = await import(new URL("../../lib/content-studio/video-request-lifetime.ts", import.meta.url).href);
const { generatedCreativeIdentity, isLegacyGeneratedVideoIdentity } = createRequire(import.meta.url)("../../lib/crm/generated-identity.ts") as {
  generatedCreativeIdentity(input: { workspaceId: unknown; idempotencyKey: unknown; mimeType: unknown }): {
    assetId: string; fileName: string; storagePath: string; keyDigest: string;
  };
  isLegacyGeneratedVideoIdentity(input: { workspaceId: string; idempotencyKey: string; fileName: unknown; storagePath: unknown }): boolean;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiPath = "api/content-studio/[...path].ts";
// Opt-in red proof only. Default runs always execute the current working API.
const baselineRef = process.env.MEDINA_CONTENT_PRIVACY_BASELINE_REF;
const markers = {
  url: "https://synthetic-provider.invalid/SYNTHETIC_PRIVATE_URL_G5_C46",
  token: "SYNTHETIC_NOT_A_REAL_TOKEN_G5_C46",
  customer: "SYNTHETIC_CUSTOMER_REQUEST_G5_C46",
  db: "SYNTHETIC_DB_ERROR_ECHO_G5_C46",
};
const privateEcho = Object.values(markers).join("; ");
const context = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
  userId: "66666666-6666-4666-8666-666666666666",
};
const requestKey = "33333333-3333-4333-8333-333333333333";
const videoId = "44444444-4444-4444-8444-444444444444";
const storageOrigin = "https://synthetic-assets.invalid";
const storagePath = `${context.workspaceId}/public-fixture`;
const safeUrl = `${storageOrigin}/storage/v1/object/public/ad-creatives/${storagePath}`;
const assetId = "55555555-5555-4555-8555-555555555555";
const textData = { prompt: "Synthetic safe output", negativePrompt: "Synthetic negative output", hook: "Synthetic hook" };
const config = Object.freeze({ apiKey: markers.token, imageModel: "synthetic-image", videoModel: "synthetic-video", videoSeconds: "8" });
const reservation = {
  allowed: true, tracked: true, duplicate: false, usageId: "synthetic-receipt",
  kind: "text_request", used: 1, limit: 10, remaining: 9, periodStart: "2026-10-01",
};
const handlerNames = [
  "handleGeneratePackage", "handleImproveAdText", "handleGenerateScript",
  "handleGenerateAvatarPrompt", "handleGenerateTapNowPrompt",
  "handleGeneratePhoto", "handleGenerateVideo", "handleVideoGeneration",
] as const;
type HandlerName = typeof handlerNames[number];
type Request = { body: Record<string, unknown>; headers: Record<string, string>; query: Record<string, string> };
type PublicJson = {
  success: boolean; error?: string; details?: string[]; hint?: string; code?: string;
  mode?: string; data?: Record<string, unknown>; accepted?: boolean;
};
type Response = {
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(payload: unknown): PublicJson;
};
type Selected = Record<HandlerName, (req: Request, res: Response, ctx: typeof context, lifetime?: unknown) => Promise<unknown>> & {
  sendProviderFailure(res: Response, error: unknown, subject: string): unknown;
  GenerationProviderError: new (status: number, message: string) => Error & { status: number };
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function compileActualDeclarations() {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const source = baselineRef
    ? execFileSync("git", ["show", `${baselineRef}:${apiPath}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, apiPath), "utf8");
  const ast = ts.createSourceFile(apiPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, import("typescript").Statement>();
  for (const statement of ast.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      assert.equal(declarations.has(statement.name.text), false, "unique actual declaration");
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
  }
  // Follow local AST dependencies, including helpers added by the fix, but never imports.
  const selected = new Set<import("typescript").Statement>();
  const include = (name: string) => {
    const declaration = declarations.get(name);
    assert.ok(declaration, `actual ${name} declaration exists`);
    if (selected.has(declaration)) return;
    selected.add(declaration);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  };
  for (const name of ["sendProviderFailure", ...handlerNames]) include(name);
  const generation = await readFile(path.join(root, "lib/content-studio/generation.ts"), "utf8");
  const generationAst = ts.createSourceFile("generation.ts", generation, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = generationAst.statements.filter((node) => ts.isClassDeclaration(node) && node.name?.text === "GenerationProviderError");
  assert.equal(classes.length, 1, "execute the actual provider error class, not a lookalike");
  const bundle = [
    classes[0].getText(generationAst),
    ...ast.statements.filter((node) => selected.has(node)).map((node) => node.getText(ast)),
    `exports.selected = { GenerationProviderError, sendProviderFailure, ${handlerNames.join(", ")} };`,
  ].join("\n");
  return ts.transpileModule(bundle, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const compiled = await compileActualDeclarations();

type Options = {
  failAt?: "reserve" | "text" | "provider" | "store";
  failure?: unknown;
  providerStatus?: number;
  jobStatus?: "queued" | "completed" | "failed";
};

function fixture(options: Options = {}) {
  const events: string[] = [];
  const reserves: Record<string, unknown>[] = [], completions: Record<string, unknown>[] = [];
  const stores: Record<string, unknown>[] = [], patches: Record<string, unknown>[] = [];
  const calls = { text: 0, image: 0, create: 0, poll: 0, download: 0, network: 0 };
  const exported: { selected?: Selected } = {};
  let selected: Selected;
  const generationKey = `v2:${requestKey}`;
  const nativeIdentity = generatedCreativeIdentity({ workspaceId: context.workspaceId, idempotencyKey: generationKey, mimeType: "video/mp4" });
  const nativePath = `optimized/${context.workspaceId}/${videoId}-${"a".repeat(20)}.mp4`;
  let native: Record<string, unknown> | null = null;
  let nativeReady = false;
  const pending = (status: string, providerJobId: string | null = "synthetic-job") => ({ status, generationKey,
    requestDigest: generatedVideoRequestDigest(markers.customer, "universal"), providerJobId,
    validationJobId: ["queued", "ready"].includes(status) ? videoId : null, progress: 0, needInput: status === "rendering" });
  const fail = () => {
    throw options.providerStatus !== undefined
      ? new selected.GenerationProviderError(options.providerStatus, privateEcho)
      : options.failure ?? new Error(privateEcho);
  };
  const generateText = async () => {
    calls.text++;
    events.push("text");
    if (options.failAt === "text") fail();
    return { mode: "synthetic", data: { ...textData } };
  };
  const dependencies = {
    generatedCreativeIdentity, isLegacyGeneratedVideoIdentity,
    generatedVideoRequestDigest,
    WorkspaceAdminAuthError: class extends Error {},
    requireWorkspaceAccess: async () => ({ ...context }),
    generatedVideoWorkflowConfig: () => ({}),
    requireGeneratedVideoWorkflowReady: async () => { events.push("native.preflight"); },
    readGeneratedVideoWorkflow: async () => { events.push("native.read"); return native; },
    admitGeneratedVideoWorkflow: async () => { events.push("native.admit"); return native = pending("reserved", null); },
    beginGeneratedVideoDispatch: async () => { events.push("native.dispatch"); return native = { ...pending("dispatching", null), dispatchAccepted: true }; },
    ackGeneratedVideoProviderFailure: async () => { events.push("native.provider-failed"); return native = { ...pending("cancelled"), failureCode: "generated_video_provider_failed" }; },
    cancelGeneratedVideoWorkflow: async () => { events.push("native.cancel"); return native = pending("cancelled", null); },
    linkGeneratedVideoProvider: async () => { events.push("native.link"); return native = pending("rendering"); },
    resumeGeneratedVideoWorkflow: async () => {
      events.push("native.resume");
      if (!nativeReady) return native ?? pending("rendering");
      return { ...pending("ready"), nativeValidated: true, asset: { id: nativeIdentity.assetId, workspaceId: context.workspaceId,
        fileName: nativeIdentity.fileName, fileType: "video", mimeType: "video/mp4", fileSize: 3,
        storageBucket: "ad-creatives", storagePath: nativePath, publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${nativePath}`,
        status: "ready", sha256: "a".repeat(64), thumbnailUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${nativePath.slice(0, -4)}-thumbnail.jpg`,
        thumbnailPath: `${nativePath.slice(0, -4)}-thumbnail.jpg`, thumbnailSize: 2, thumbnailSha256: "b".repeat(64) } };
    },
    receiveGeneratedVideoInput: async (...args: unknown[]) => {
      events.push("native.receive");
      assert.equal(args[2], generationKey);
      assert.deepEqual(Array.from(args[3] as Uint8Array), [4, 5, 6]);
      if (options.failAt === "store") fail();
      return native = pending("queued");
    },
    randomUUID: () => requestKey,
    resolveTextProvider: () => "openai",
    readGenerationConfig: () => config,
    imageGenerationRefusal: () => null,
    videoGenerationRefusal: () => null,
    normalizePrompt: (value: unknown) => typeof value === "string" ? value.trim() : "",
    imageSizeForFormat: () => "1024x1536",
    videoSizeForFormat: () => "720x1280",
    billableVideoSeconds: () => 8,
    videoFormatWasSubstituted: () => false,
    signGeneratedVideoJobHandle: () => "synthetic-signed-handle",
    readGeneratedVideoJobHandle: () => ({ workspaceId: context.workspaceId, generationKey, providerJobId: "synthetic-job", legacy: false }),
    async reserveContentGeneration(input: Record<string, unknown>) {
      events.push("reserve");
      const { requestLifetime: _lifetime, ...data } = input;
      reserves.push(plain(data));
      if (options.failAt === "reserve") fail();
      return { ...reservation, kind: input.kind };
    },
    async completeContentGeneration(input: Record<string, unknown>) {
      events.push(`complete:${input.status}`);
      completions.push(plain(input));
    },
    demoContentPackage: () => ({ ...textData }),
    demoScriptPackage: () => ({ ...textData }),
    demoAvatarPrompt: () => ({ ...textData }),
    demoTapNowPrompt: () => ({ ...textData }),
    normalizeContentPackage: (value: unknown) => value,
    normalizeScriptPackage: (value: unknown) => value,
    normalizePromptPackage: (value: unknown) => value,
    generateOpenAIJson: generateText,
    async improveAdText(input: { generate(value: unknown): Promise<unknown> }) {
      await input.generate({ system: "Synthetic system", user: {} });
      return {
        mode: "synthetic", fields: { text: "Synthetic safe rewrite" }, status: "safe",
        issues: [], changed: true, before: { text: "Synthetic original" }, candidates: [],
      };
    },
    updateContentVideo(id: string, patch: Record<string, unknown>) {
      events.push("local-patch");
      patches.push(plain({ id, patch }));
    },
    async persistContentVideoPatchIfAvailable(input: Record<string, unknown>) {
      events.push("persistent-patch");
      patches.push(plain(input));
      return true;
    },
    async generateImage() {
      calls.image++;
      events.push("image");
      if (options.failAt === "provider") fail();
      return { mimeType: "image/png", buffer: new Uint8Array([1, 2, 3]), model: config.imageModel };
    },
    async createVideoJob() {
      calls.create++;
      events.push("create");
      if (options.failAt === "provider") fail();
      return { id: "synthetic-job", status: "queued", progress: 0 };
    },
    async fetchVideoJob() {
      calls.poll++;
      events.push("poll");
      return { id: "synthetic-job", status: options.jobStatus ?? "completed", progress: 37, error: privateEcho };
    },
    async downloadVideoContent() {
      calls.download++;
      events.push("download");
      return new Uint8Array([4, 5, 6]);
    },
    async storeGeneratedCreative(input: Record<string, unknown>) {
      events.push("store");
      stores.push(plain(input));
      if (options.failAt === "store") fail();
      const identity = input.idempotencyKey === undefined ? null : generatedCreativeIdentity(input as { workspaceId: unknown; idempotencyKey: unknown; mimeType: unknown });
      const objectPath = identity?.storagePath || storagePath;
      const url = `${storageOrigin}/storage/v1/object/public/ad-creatives/${objectPath}`;
      return { publicUrl: url, mode: "supabase", warning: "", asset: {
        id: identity?.assetId || assetId, workspaceId: input.workspaceId, fileName: input.fileName,
        fileType: String(input.mimeType).startsWith("image/") ? "image" : "video",
        mimeType: input.mimeType, fileSize: (input.buffer as Uint8Array).length,
        storageBucket: "ad-creatives", storagePath: objectPath, publicUrl: url,
      } };
    },
    fetch() { calls.network++; assert.fail("real network must never be reached"); },
  };
  // No require, application imports, auth/DB clients or real process/environment enter this VM.
  new Script(compiled, { filename: "content-error-privacy.fixture.cjs" }).runInNewContext({
    ...dependencies, Error, exports: exported,
    process: { env: Object.freeze({ SUPABASE_URL: storageOrigin, SUPABASE_SERVICE_ROLE_KEY: markers.token }) },
  }, { timeout: 1000 });
  selected = exported.selected!;
  assert.equal(typeof selected?.GenerationProviderError, "function");
  const request: Request = {
    body: { prompt: markers.customer, headline: markers.customer, videoId },
    headers: { "x-idempotency-key": requestKey }, query: { handle: "synthetic-signed-handle" },
  };
  const capture = async (invoke: (res: Response) => unknown) => {
    let status = 0;
    const headers: Record<string, string> = {}, replies: PublicJson[] = [];
    const res: Response = {
      status(value) { status = value; return this; },
      setHeader(name, value) { headers[name] = value; return this; },
      json(payload) { const wire = plain(payload) as PublicJson; replies.push(wire); return wire; },
    };
    const returned = await invoke(res);
    assert.equal(replies.length, 1, "exactly one actual public JSON response");
    assert.strictEqual(returned, replies[0], "handler returns the captured public JSON");
    assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(calls.network, 0);
    return { status, headers, reply: replies[0] };
  };
  return {
    selected, events, reserves, completions, stores, patches, calls,
    finishNative: () => { nativeReady = true; },
    invoke: (name: HandlerName) => {
      if (name === "handleVideoGeneration" && native === null) native = pending("rendering");
      return capture(async (res) => {
        const lifetime = new VideoRequestLifetime();
        try { return await selected[name](request, res, context, lifetime); }
        finally { lifetime.close(); }
      });
    },
    providerFailure: (error: unknown) => capture((res) => selected.sendProviderFailure(res, error, "Synthetic generation failure")),
  };
}
type Fixture = ReturnType<typeof fixture>;
type Result = Awaited<ReturnType<Fixture["invoke"]>>;

function assertPrivate(result: Result) {
  const serialized = JSON.stringify(result);
  for (const [name, marker] of Object.entries(markers)) {
    assert.equal(serialized.includes(marker), false, `public JSON must not echo synthetic ${name}`);
  }
}

function assertFailure(result: Result, status: number, hint = false) {
  assert.equal(result.status, status);
  assert.equal(result.reply.success, false);
  assert.ok(result.reply.error?.trim(), "failure remains explicit");
  assert.ok(result.reply.details?.length && result.reply.details.every((value) => typeof value === "string" && value.trim()), "safe stage diagnostics remain nonempty");
  assert.equal(Object.hasOwn(result.reply, "data"), false, "failure cannot advertise a generated asset");
  if (hint) assert.ok(result.reply.hint?.trim(), "actionable hint survives redaction");
}

function assertNoAssetWrites(f: Fixture) {
  assert.deepEqual(f.stores, [], "no asset storage after an earlier failure");
  assert.deepEqual(f.patches, [], "no local or persistent readiness promotion");
  assert.equal(f.calls.network, 0);
}

const providerCases = [
  { name: "typed 429", upstream: 429, status: 429, hint: true },
  { name: "typed 400", upstream: 400, status: 422, hint: true },
  { name: "typed 422", upstream: 422, status: 422, hint: true },
  { name: "typed 401", upstream: 401, status: 502, hint: false },
  { name: "typed 500", upstream: 500, status: 502, hint: false },
  { name: "generic Error", upstream: undefined, status: 502, hint: false },
  { name: "unknown object", upstream: undefined, status: 502, hint: false },
  { name: "unknown string", upstream: undefined, status: 502, hint: false },
];
for (const scenario of providerCases) {
  test(`content privacy: sendProviderFailure ${scenario.name} preserves HTTP classification without raw errors`, async () => {
    const f = fixture();
    const error = scenario.upstream !== undefined
      ? new f.selected.GenerationProviderError(scenario.upstream, privateEcho)
      : scenario.name === "unknown object" ? { message: privateEcho, stack: privateEcho, raw: privateEcho }
      : scenario.name === "unknown string" ? privateEcho : new Error(privateEcho);
    if (scenario.upstream !== undefined) assert.ok(error instanceof f.selected.GenerationProviderError);
    const result = await f.providerFailure(error);
    assertFailure(result, scenario.status, scenario.hint);
    assert.deepEqual(f.events, []);
    assertPrivate(result);
  });
}

const textHandlers = [
  ["handleGeneratePackage", "content_package", undefined],
  ["handleImproveAdText", "ad_text_improvement", undefined],
  ["handleGenerateScript", "video_script", "script_ready"],
  ["handleGenerateAvatarPrompt", "avatar_prompt", "avatar_ready"],
  ["handleGenerateTapNowPrompt", "tapnow_prompt", "avatar_ready"],
] as const;
for (const [name, operation, readyStatus] of textHandlers) {
  for (const phase of ["reserve", "text"] as const) {
    test(`content privacy: ${name} rejected ${phase} returns safe catch JSON and negative cleanup`, async () => {
      const f = fixture({ failAt: phase });
      const result = await f.invoke(name);
      assertFailure(result, 500);
      assert.equal(f.reserves.length, 1);
      assert.equal(f.reserves[0].operation, operation);
      assert.equal(f.reserves[0].workspaceId, context.workspaceId);
      assert.equal(f.calls.text, phase === "text" ? 1 : 0);
      assert.equal(f.completions.length, 1, "one accounting cleanup, no duplicate completion");
      assert.equal(f.completions[0].status, "unknown");
      assert.equal(f.completions[0].errorCode, "request_unknown");
      assert.deepEqual(f.completions[0].reservation, phase === "reserve" ? null : reservation);
      assert.deepEqual(f.events, phase === "reserve" ? ["reserve", "complete:unknown"] : ["reserve", "text", "complete:unknown"]);
      assertNoAssetWrites(f);
      assertPrivate(result);
    });
  }
  test(`content privacy: ${name} positive control still returns generated data and correct readiness`, async () => {
    const f = fixture();
    const result = await f.invoke(name);
    assert.equal(result.status, 200);
    assert.equal(result.reply.success, true);
    assert.equal(result.reply.mode, "synthetic");
    assert.equal(f.calls.text, 1);
    assert.equal(f.reserves[0].operation, operation);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, "succeeded");
    assert.equal(Object.hasOwn(f.completions[0], "errorCode"), false);
    if (name === "handleImproveAdText") {
      assert.deepEqual(result.reply.data?.fields, { text: "Synthetic safe rewrite" });
      assert.equal(result.reply.data?.changed, true);
    } else assert.deepEqual(result.reply.data, textData);
    assert.equal(f.patches.length, readyStatus ? 2 : 0);
    if (readyStatus) {
      assert.equal((f.patches[0].patch as Record<string, unknown>).status, readyStatus);
      assert.equal(f.patches[1].workspaceId, context.workspaceId);
      assert.equal(f.patches[1].videoId, videoId);
    }
    assert.deepEqual(f.stores, []);
    assertPrivate(result);
  });
}

for (const [name, kind, units] of [
  ["handleGeneratePhoto", "image", 1], ["handleGenerateVideo", "video_seconds", 8],
] as const) {
  test(`content privacy: ${name} quota infrastructure rejection stays 503 with zero provider calls`, async () => {
    const f = fixture({ failAt: "reserve" });
    const result = await f.invoke(name);
    assertFailure(result, 503);
    assert.equal(result.reply.code, "generation_usage_unavailable");
    assert.equal(f.reserves.length, 1);
    assert.equal(f.reserves[0].kind, kind);
    assert.equal(f.reserves[0].units, units);
    assert.equal(f.reserves[0].requestKey, requestKey);
    assert.deepEqual(f.calls, { text: 0, image: 0, create: 0, poll: 0, download: 0, network: 0 });
    assert.deepEqual(f.completions, [], "no receipt to bill or finalize");
    assert.deepEqual(f.events, name === "handleGenerateVideo"
      ? ["native.read", "native.preflight", "native.admit", "reserve"] : ["reserve"]);
    assertNoAssetWrites(f);
    assertPrivate(result);
  });
}

for (const scenario of [
  { name: "known provider rejection", upstream: 400, status: 422, accounting: "failed", code: "provider_rejected" },
  { name: "uncertain provider Error", upstream: undefined, status: 502, accounting: "unknown", code: "request_unknown" },
]) {
  test(`content privacy: photo ${scenario.name} keeps true billing classification without storage`, async () => {
    const f = fixture({ failAt: "provider", providerStatus: scenario.upstream });
    const result = await f.invoke("handleGeneratePhoto");
    assertFailure(result, scenario.status, scenario.upstream === 400);
    assert.equal(f.reserves.length, 1);
    assert.equal(f.calls.image, 1);
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].status, scenario.accounting);
    assert.equal(f.completions[0].errorCode, scenario.code);
    assert.deepEqual(f.events, ["reserve", "image", `complete:${scenario.accounting}`]);
    assertNoAssetWrites(f);
    assertPrivate(result);
  });
}

test("content privacy: post-generation photo storage failure remains paid, stage-specific and never regenerates", async () => {
  const f = fixture({ failAt: "store" });
  const result = await f.invoke("handleGeneratePhoto");
  assertFailure(result, 502, true);
  assert.match(result.reply.error!, /сгенерирован.*сохранение не подтверждено/iu);
  assert.match(result.reply.hint!, /оплачен/iu);
  assert.match(result.reply.hint!, /повтор/iu);
  assert.deepEqual(f.events, ["reserve", "image", "complete:succeeded", "store"]);
  assert.equal(f.reserves.length, 1);
  assert.equal(f.calls.image, 1, "storage failure must not generate or charge a second image");
  assert.equal(f.completions.length, 1);
  assert.equal(f.completions[0].status, "succeeded", "already-paid generation cannot become failed/unknown");
  assert.equal(Object.hasOwn(f.completions[0], "errorCode"), false);
  assert.equal(f.stores.length, 1);
  assert.equal(f.stores[0].workspaceId, context.workspaceId);
  assert.deepEqual(f.patches, []);
  assertPrivate(result);
});

test("content privacy: photo positive control preserves the actual stored asset receipt", async () => {
  const f = fixture();
  const result = await f.invoke("handleGeneratePhoto");
  assert.equal(result.status, 200);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.data?.creativeUrl, safeUrl);
  assert.equal(result.reply.data?.assetId, assetId);
  assert.equal(result.reply.data?.fileSize, 3);
  assert.equal(result.reply.data?.model, config.imageModel);
  assert.equal((f.stores[0].metadata as Record<string, unknown>).prompt, markers.customer, "private input actually reaches only fake storage");
  assert.deepEqual(f.events, ["reserve", "image", "complete:succeeded", "store"]);
  assertPrivate(result);
});

test("content privacy: video submission positive control remains accepted and billed exactly once", async () => {
  const f = fixture();
  const result = await f.invoke("handleGenerateVideo");
  assert.equal(result.status, 202);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.data?.handle, "synthetic-signed-handle");
  assert.equal(result.reply.data?.status, "queued");
  assert.equal(result.reply.data?.seconds, 8);
  assert.equal(result.reply.data?.formatSubstituted, false);
  assert.deepEqual(f.events, ["native.read", "native.preflight", "native.admit", "reserve", "native.dispatch", "create", "native.link", "complete:succeeded"]);
  assert.equal(f.reserves.length, 1);
  assert.equal(f.completions.length, 1);
  assertNoAssetWrites(f);
  assertPrivate(result);
});

for (const scenario of [
  { label: "known rejected dispatch", providerStatus: 400, status: 422, completion: "failed", code: "provider_rejected" },
  { label: "unknown paid dispatch", providerStatus: undefined, status: 409, completion: "unknown", code: "request_unknown" },
]) {
  test(`content privacy: video ${scenario.label} preserves accounting without raw diagnostics or another dispatch`, async () => {
    const f = fixture({ failAt: "provider", providerStatus: scenario.providerStatus });
    const result = await f.invoke("handleGenerateVideo");
    assert.equal(result.status, scenario.status);
    assert.equal(result.reply.success, false);
    assert.equal(result.reply.data, undefined, "no provider or private object identity is exposed on dispatch uncertainty");
    assert.equal(f.reserves.length, 1); assert.equal(f.calls.create, 1);
    assert.equal(f.completions.length, 1); assert.equal(f.completions[0].status, scenario.completion);
    assert.equal(f.completions[0].errorCode, scenario.code);
    assert.equal(f.events.includes("native.cancel"), scenario.completion === "failed",
      "an uncertain provider outcome must retain admission rather than authorizing another render");
    assert.equal(f.events.includes("native.link"), false);
    assertNoAssetWrites(f); assertPrivate(result);
  });
}

test("content privacy: failed video job remains HTTP 200 success with failed status and safe failureReason", async () => {
  const f = fixture({ jobStatus: "failed" });
  const result = await f.invoke("handleVideoGeneration");
  assert.equal(result.status, 200);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.data?.status, "failed");
  assert.equal(result.reply.data?.progress, 0);
  assert.equal(Object.hasOwn(result.reply.data!, "creativeUrl"), false);
  assert.equal(result.reply.data?.phase, "generation");
  assert.ok(typeof result.reply.data?.failureReason === "string" && result.reply.data.failureReason.trim());
  assert.deepEqual(f.events, ["native.read", "native.resume", "poll", "native.provider-failed"]);
  assert.deepEqual(f.reserves, []);
  assert.deepEqual(f.completions, []);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.download, 0);
  assertNoAssetWrites(f);
  assertPrivate(result);
});

test("content privacy: completed video storage failure preserves paid-render polling advice with no new charge", async () => {
  const f = fixture({ jobStatus: "completed", failAt: "store" });
  const result = await f.invoke("handleVideoGeneration");
  assert.equal(result.status, 503);
  assert.equal(result.reply.success, false);
  assert.equal(result.reply.accepted, true);
  assert.ok(result.reply.details?.length);
  assert.match(result.reply.error!, /принят.*не подтверждена/iu);
  assert.match(result.reply.hint!, /проверку.*не запускайте новую платную/iu);
  assert.deepEqual(result.reply.data, { handle: "synthetic-signed-handle", status: "in_progress", phase: "validation" });
  assert.deepEqual(f.events, ["native.read", "native.resume", "poll", "native.preflight", "download", "native.receive"]);
  assert.equal(f.calls.create, 0, "polling never starts another paid render");
  assert.deepEqual(f.reserves, []);
  assert.deepEqual(f.completions, []);
  assert.equal(f.stores.length, 0, "generated raw video must never reach the old public writer");
  assert.deepEqual(f.patches, []);
  assertPrivate(result);
});

test("content privacy: completed provider video stays pending until native validation and never reserves another render", async () => {
  const f = fixture({ jobStatus: "completed" });
  const result = await f.invoke("handleVideoGeneration");
  assert.equal(result.status, 200);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.data?.status, "in_progress");
  assert.equal(result.reply.data?.phase, "validation");
  assert.equal(result.reply.data?.validationJobId, videoId);
  assert.equal(Object.hasOwn(result.reply.data!, "creativeUrl"), false);
  assert.deepEqual(f.events, ["native.read", "native.resume", "poll", "native.preflight", "download", "native.receive"]);
  assert.equal(f.calls.create, 0);
  assert.deepEqual(f.reserves, []);
  assert.deepEqual(f.completions, []);
  assert.deepEqual(f.stores, []);
  assertPrivate(result);
  f.finishNative();
  const completed = await f.invoke("handleVideoGeneration");
  assert.equal(completed.reply.data?.status, "completed");
  assert.equal(completed.reply.data?.progress, 100);
  assert.equal(completed.reply.data?.nativeValidated, true);
  assert.equal(completed.reply.data?.validationJobId, videoId);
  const identity = generatedCreativeIdentity({ workspaceId: context.workspaceId, idempotencyKey: `v2:${requestKey}`, mimeType: "video/mp4" });
  assert.equal(completed.reply.data?.assetId, identity.assetId);
  assert.match(String(completed.reply.data?.creativeUrl), /\/optimized\/.*\.mp4$/);
  assert.equal(completed.reply.data?.mimeType, "video/mp4");
  assert.equal(f.calls.poll, 1);
  assert.equal(f.calls.download, 1);
  assert.deepEqual(f.events.slice(-2), ["native.read", "native.resume"]);
  assertPrivate(completed);
});

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual component declarations, lifetime subscription, CRM transport and helper;
// only hooks/state, SDK and HTTP are synthetic. No browser or React commit claim.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pagePath = "artifacts/negis/src/pages/ContentStudio.tsx";
const page = await readFile(path.join(root, pagePath), "utf8");
const ast = ts.createSourceFile(pagePath, page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sessions = ast.statements.filter((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.equal(sessions.length, 1);
const scope = sessions[0].body!.statements;

function select(nodes: readonly import("typescript").Statement[], source: import("typescript").SourceFile, names: string[]) {
  return names.map((name) => {
    const matches = nodes.filter((node) => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === name));
    assert.equal(matches.length, 1, `Execute exactly one actual ${name} declaration`);
    return matches[0].getText(source);
  }).join("\n");
}

function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createIdentifier("fixtureEnv");
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
}

const effects = scope.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === "useLayoutEffect" && node.getText(ast).includes("onAuthStateChange"));
assert.equal(effects.length, 1);
const capturedNames = ["sessionRef", "photoArtifactRef", "photoHandoffPending", "generatePhotoLayout",
  "updatePhotoTexts", "updatePackageBrief", "usePhotoInAdsAutomation"];
const pageCode = compile([
  select(ast.statements, ast, ["safeJson", "handoffAccessDenied", "photoFormats", "photoLayouts", "writeAdsAutomationPrefill"]),
  select(scope, ast, ["sessionRef", "signOutRevisionRef"]), effects[0].getText(ast),
  select(scope, ast, ["photoTextInputsRef", "photoTextRevision", "photoArtifactRef", "photoRenderPending", "photoHandoffPending",
    "photoUploadAttempts", "photoObjectUrls", "packageBriefRef", "packageBriefRevision", "isSessionAlive", "isGenerationSessionCurrent",
    "isHandoffSessionAlive", "isHandoffSessionCurrent", "releasePhotoUrl", "invalidatePhotoPreview", "isPhotoArtifactCurrent",
    "generatePhotoLayout", "updatePhotoTexts", "updatePackageBrief", "writeContentToAdsAutomation", "usePhotoInAdsAutomation"]),
  `exports.captured = { ${capturedNames.join(", ")} };`,
].join("\n"));

async function moduleCode(relative: string, names?: string[]) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (!names) return compile(source);
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return compile(select(parsed.statements, parsed, names) + `\nexports.selected = { ${names.join(", ")} };`);
}
const authCode = await moduleCode("artifacts/negis/src/lib/serverAuth.ts");
const apiCode = await moduleCode("artifacts/negis/src/lib/api.ts", ["CrmApiError", "resolveAccessToken", "inflightGets", "getCache",
  "REFERENCE_TTL_MS", "LIST_TTL_MS", "cacheEpoch", "isUncacheable", "ttlFor", "clearCrmCache", "crmFetch"]);

function evaluate<T>(code: string, bindings: Record<string, unknown>, imports: Record<string, unknown> = {}): T {
  const exports = {};
  Object.assign(bindings, {
    exports, Error, DOMException, AbortController, Headers, Response, Blob, URL, TextEncoder, crypto: webcrypto,
    fetch() { assert.fail("Unlisted network access"); },
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unlisted import: ${name}`); return imports[name]; },
    ...bindings,
  });
  new Script(code, { filename: "content-verified-handoff.actual.cjs" }).runInNewContext(bindings, { timeout: 1000 });
  return exports as T;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const { uploadVerifiedCreativeImage } = evaluate<Record<string, unknown>>(
  await moduleCode("artifacts/negis/src/lib/verified-creative-upload.ts"), {});
const { ADVERTISING_CAMPAIGN_PREFILL_KEY, createAdvertisingCampaignPrefill } = evaluate<{
  ADVERTISING_CAMPAIGN_PREFILL_KEY: string; createAdvertisingCampaignPrefill: unknown;
}>(await moduleCode("lib/advertising/campaignBrief.ts"), {});

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherWorkspace = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const nonce = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const storageOrigin = "https://content-storage.fixture.invalid";
const uploadHandle = `u1.c3ludGhldGlj.${"A".repeat(43)}`;
const privateToken = "SYNTHETIC_PRIVATE_TOKEN";
const storagePath = `${workspaceId}/staged/${nonce}/original.jpg`;
const publicPath = `${workspaceId}/verified/${nonce}/${"1".repeat(64)}.jpg`;
const publicUrl = `${storageOrigin}/storage/v1/object/public/ad-creatives/${publicPath}`;
type Row = Record<string, unknown>;
type Ref<T> = { current: T };
type Phase = "signed" | "signed-body" | "upload" | "finalize" | "finalize-body" | "metadata";
type FailurePhase = "signed" | "upload" | "finalize" | "metadata";
type Captured = {
  sessionRef: Ref<AbortController | null>; photoArtifactRef: Ref<unknown>; photoHandoffPending: Ref<unknown>;
  generatePhotoLayout(): Promise<void>; updatePhotoTexts(key: string, value: string): void;
  updatePackageBrief(key: string, value: string): void; usePhotoInAdsAutomation(): Promise<void>;
};

function fixture(options: { hold?: Phase; demo?: boolean } = {}) {
  const posts: Array<{ phase: FailurePhase; body: Row }> = [];
  const uploads: Array<{ bucket: string; path: string; token: string; file: Blob; opts: unknown }> = [];
  const persisted: Array<{ key: string; value: Row }> = [];
  const toasts: Array<{ kind: string; text: string }> = [];
  const navigation: string[] = [], events: string[] = [];
  const failures: Partial<Record<FailurePhase, number>> = {};
  const reached = deferred(), resume = deferred();
  let actor = options.demo ? "" : "synthetic-A", selectedWorkspace = options.demo ? "demo-verified-handoff" : workspaceId;
  let revision = 0, signOutPending = false, cleanup: (() => void) | undefined, urlCount = 0, tokenReads = 0;
  let throwUpload = false;
  let finalVerification = false, finalSourceChecks = 0, finalHookCalls = 0;
  let finalHook: (() => void) | undefined;
  let prepared: Row = {};
  const listeners = new Set<(event: string, session: { user: { id: string } }) => void>();
  const getSignOutRevision = () => revision, isSignOutPending = () => signOutPending;
  async function phase(name: Phase) {
    if (name === options.hold) { reached.resolve(); await resume.promise; }
  }
  const supabase = {
    auth: {
      async getSession() { tokenReads++; return { data: { session: { user: { id: actor }, access_token: `synthetic-token-${actor}` } }, error: null }; },
      onAuthStateChange(listener: Parameters<typeof listeners.add>[0]) {
        listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
    },
    storage: { from(bucket: string) { return { async uploadToSignedUrl(path: string, token: string, file: Blob, opts: unknown) {
      events.push("upload"); uploads.push({ bucket, path, token, file, opts });
      await phase("upload");
      const error = failures.upload ? { statusCode: String(failures.upload), message: privateToken } : null;
      if (throwUpload && error) throw error;
      return { data: error ? null : { path }, error };
    } }; } },
  };
  const auth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(authCode, {}, {
    "@/lib/supabase": { supabase, hasSupabaseFrontendEnv: true,
      sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } },
    "@/lib/authSignOut": { getSignOutRevision, isSignOutPending },
  });
  const { selected: api } = evaluate<{ selected: Record<string, unknown> }>(apiCode, {
    apiUrl: (url: string) => url,
    async fetch(url: string, init: RequestInit) {
      const endpoint = new URL(url, "https://crm.fixture.invalid");
      const kind: FailurePhase = endpoint.pathname === "/api/crm/ad-creatives/signed-upload" ? "signed"
        : endpoint.pathname === "/api/crm/ad-creatives/finalize-upload" ? "finalize" : "metadata";
      assert.ok(["/api/crm/ad-creatives/signed-upload", "/api/crm/ad-creatives/finalize-upload", "/api/crm/content-videos"].includes(endpoint.pathname));
      assert.equal(endpoint.searchParams.get("workspaceId"), workspaceId);
      assert.equal(init.method, "POST"); assert.equal(init.signal?.aborted, false);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-token-synthetic-A");
      const body = JSON.parse(String(init.body)) as Row;
      posts.push({ phase: kind, body }); events.push(kind);
      if (kind === "signed") prepared = body;
      await phase(kind);
      const status = failures[kind] ?? 200;
      return { ok: status === 200, get status() {
        if (kind === "metadata") finalVerification = true;
        return status;
      }, async text() {
        if (kind === "signed") await phase("signed-body");
        if (kind === "finalize") await phase("finalize-body");
        const data = kind === "signed" ? { ...prepared, workspaceId, bucket: "ad-creatives-staging", storagePath,
          uploadHandle, token: privateToken }
          : kind === "finalize" ? { asset: { id: nonce, workspaceId, fileName: prepared.fileName, fileType: "image",
            mimeType: "image/jpeg", fileSize: Number(prepared.fileSize) + 23,
            storageBucket: "ad-creatives", storagePath: publicPath, publicUrl, status: "uploaded",
            // Even unexpected extra receipt fields must never be spread into history.
            uploadHandle, token: privateToken } } : {};
        return JSON.stringify({ success: status === 200, mode: "supabase", data });
      } };
    },
  }, { "@/lib/serverAuth": auth });
  const bindings: Record<string, unknown> = {
    ...auth, ...api, getSignOutRevision, isSignOutPending, supabase,
    sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange }, hasSupabaseFrontendEnv: true,
    actorId: actor, workspaceId: selectedWorkspace, localDraftsOnly: Boolean(options.demo),
    readWorkspaceId: () => selectedWorkspace, isRealWorkspace: (id: string) => id === workspaceId || id === otherWorkspace,
    useRef: <T>(current: T) => ({ current }), useLayoutEffect(create: () => () => void) { cleanup = create(); },
    photoFormat: "story", photoLayout: "gradient_bottom", photoSourceType: "Synthetic source", photoSourceName: "same-source.jpg",
    photoSourceUrl: "blob:synthetic-source", photoTexts: { headline: "Synthetic headline", offer: "Synthetic offer", cta: "Synthetic CTA", disclaimer: "Synthetic disclaimer" },
    packageBrief: { service: "Synthetic service", audience: "Synthetic audience", city: "Synthetic city" }, advertisingGoalContext: {},
    photoBlob: null, photoPreviewUrl: "", fixtureEnv: { VITE_SUPABASE_URL: `${storageOrigin}/` },
    uploadVerifiedCreativeImage, createAdvertisingCampaignPrefill, ADVERTISING_CAMPAIGN_PREFILL_KEY,
    workspaceScopedKey: (key: string) => `${key}::${selectedWorkspace}`,
    localStorage: { setItem(key: string, value: string) { persisted.push({ key, value: JSON.parse(value) }); } },
    async renderPhotoCreative() { return new Blob(["Synthetic rendered JPEG"], { type: "image/jpeg" }); },
    setPhotoBlob(value: Blob | null) { bindings.photoBlob = value; },
    setPhotoPreviewUrl(value: string) { bindings.photoPreviewUrl = value; },
    setPhotoTexts() {}, setPackageBrief() {}, setPhotoBusy() {},
    setLocation: (url: string) => navigation.push(url),
    toast: Object.fromEntries(["success", "warning", "error"].map(kind => [kind, (text: string) => toasts.push({ kind, text })])),
  };
  // Keep URL construction real while replacing object-URL lifecycle only.
  class FixtureURL extends URL {
    static createObjectURL() { return `blob:synthetic-render-${++urlCount}`; }
    static revokeObjectURL() {}
  }
  bindings.URL = FixtureURL;
  const { captured } = evaluate<{ captured: Captured }>(pageCode, bindings);
  let artifact = captured.photoArtifactRef.current;
  Object.defineProperty(captured.photoArtifactRef, "current", {
    get() {
      if (finalVerification && finalHook && ++finalSourceChecks === 2) {
        const hook = finalHook; finalHook = undefined;
        // Expire after verified()'s final source check, before its caller resumes.
        queueMicrotask(() => { finalHookCalls++; hook(); });
      }
      return artifact;
    },
    set(value: unknown) { artifact = value; },
  });
  const emit = (next: string) => { actor = next; for (const listener of listeners) listener("SIGNED_IN", { user: { id: next } }); };
  return {
    captured, posts, uploads, persisted, toasts, navigation, events, failures,
    async render() { await captured.generatePhotoLayout(); assert.ok(captured.photoArtifactRef.current); toasts.length = 0; },
    async wait(pending: Promise<void>) { await Promise.race([reached.promise, pending.then(() => assert.fail(`Did not reach ${options.hold}`))]); },
    release() { resume.resolve(); },
    expire(kind: string) {
      if (kind === "account" || kind === "account ABA") { emit("synthetic-B"); if (kind === "account ABA") emit("synthetic-A"); }
      else if (kind === "silent account") actor = "synthetic-B";
      else if (kind === "artifact" || kind === "artifact ABA") {
        captured.updatePhotoTexts("headline", "Changed");
        if (kind === "artifact ABA") captured.updatePhotoTexts("headline", "Synthetic headline");
      } else if (kind === "brief" || kind === "brief ABA") {
        captured.updatePackageBrief("service", "Changed");
        if (kind === "brief ABA") captured.updatePackageBrief("service", "Synthetic service");
      } else if (kind === "workspace") selectedWorkspace = otherWorkspace;
      else if (kind === "signout") { revision++; signOutPending = true; }
      else if (kind === "unmount") cleanup?.();
      else assert.fail(`Unknown expiry ${kind}`);
    },
    throwUpload() { throwUpload = true; },
    beforeFinalPublication(hook: () => void) { finalHook = hook; },
    get finalHookCalls() { return finalHookCalls; },
    get tokenReads() { return tokenReads; },
    dispose() { resume.resolve(); cleanup?.(); assert.equal(listeners.size, 0); },
  };
}

function assertNoPrivatePersistence(f: ReturnType<typeof fixture>) {
  const history = JSON.stringify([f.persisted, f.posts.filter(post => post.phase === "metadata"), f.toasts]);
  for (const secret of [uploadHandle, privateToken, storagePath, "ad-creatives-staging", "blob:"]) {
    assert.equal(history.includes(secret), false, `Never persist/display private receipt ${secret}`);
  }
}

test("photo handoff publishes only the final verified asset, after private upload and finalization", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.render();
  await f.captured.usePhotoInAdsAutomation();
  assert.deepEqual(f.events, ["signed", "upload", "finalize", "metadata"]);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].bucket, "ad-creatives-staging"); assert.equal(f.uploads[0].path, storagePath);
  assert.deepEqual(JSON.parse(JSON.stringify(f.uploads[0].opts)), { contentType: "image/jpeg", upsert: false });
  assert.deepEqual(f.posts.find(post => post.phase === "finalize")!.body, { uploadHandle });
  const prepared = f.posts[0].body, creative = f.persisted[0].value.creative as Row;
  assert.match(String(prepared.requestKey), /^[0-9a-f-]{36}$/); assert.equal(prepared.fileSize, f.uploads[0].file.size);
  assert.equal(creative.assetId, nonce); assert.equal(creative.url, publicUrl);
  assert.equal(creative.fileSize, f.uploads[0].file.size + 23); assert.equal(creative.fileName, prepared.fileName);
  assert.equal(f.persisted[0].key, `${ADVERTISING_CAMPAIGN_PREFILL_KEY}::${workspaceId}`);
  const metadata = f.posts.find(post => post.phase === "metadata")!.body;
  assert.equal(metadata.status, "idea"); assert.equal((metadata.photoCreative as Row).creativeUrl, publicUrl);
  assert.deepEqual(f.navigation, ["/ads-automation"]); assert.equal(f.toasts.filter(toast => toast.kind === "success").length, 1);
  assertNoPrivatePersistence(f); assert.equal(f.captured.photoHandoffPending.current, null);
});

for (const phase of ["signed", "signed-body", "upload", "finalize", "finalize-body"] as const) {
  for (const change of ["account", "account ABA", "silent account", "artifact", "artifact ABA", "brief", "brief ABA", "workspace", "signout", "unmount"]) {
    test(`pending ${phase}: ${change} cancels without metadata, fallback, history or navigation`, { timeout: 5000 }, async (t) => {
      const f = fixture({ hold: phase }); t.after(() => f.dispose()); await f.render();
      const pending = f.captured.usePhotoInAdsAutomation(); await f.wait(pending);
      const duplicate = f.captured.usePhotoInAdsAutomation(); await duplicate;
      f.expire(change); f.release(); await pending;
      assert.equal(f.posts.filter(post => post.phase === "metadata").length, 0);
      assert.deepEqual(f.persisted, []); assert.deepEqual(f.navigation, []); assert.deepEqual(f.toasts, []);
      assert.equal(f.uploads.length, phase.startsWith("signed") ? 0 : 1);
      assert.equal(f.posts.filter(post => post.phase === "finalize").length, phase.startsWith("finalize") ? 1 : 0);
      assert.equal(f.captured.photoHandoffPending.current, null); assertNoPrivatePersistence(f);
    });
  }
}

test("pending metadata cannot publish an old account's finalized image", async (t) => {
  const f = fixture({ hold: "metadata" }); t.after(() => f.dispose()); await f.render();
  const pending = f.captured.usePhotoInAdsAutomation(); await f.wait(pending);
  f.expire("account ABA"); f.release(); await pending;
  assert.deepEqual(f.persisted, []); assert.deepEqual(f.navigation, []); assert.deepEqual(f.toasts, []);
  assertNoPrivatePersistence(f);
});

for (const change of ["account ABA", "artifact ABA", "brief ABA"]) {
  test(`final publication microtask gap rejects ${change}`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); await f.render();
    f.beforeFinalPublication(() => f.expire(change));
    await f.captured.usePhotoInAdsAutomation();
    assert.equal(f.finalHookCalls, 1, "The expiry must actually hit the final verification gap");
    assert.equal(f.posts.filter(post => post.phase === "metadata").length, 1);
    assert.deepEqual(f.persisted, []); assert.deepEqual(f.navigation, []); assert.deepEqual(f.toasts, []);
    assertNoPrivatePersistence(f);
  });
}

test("retries keep the actual Blob's request key; a new render gets a different key", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.render(); f.failures.finalize = 503;
  await f.captured.usePhotoInAdsAutomation();
  assert.equal(f.persisted[0].value.creative, undefined);
  assert.equal(f.toasts.some(toast => toast.kind === "warning"), true);
  assertNoPrivatePersistence(f);
  const first = f.posts[0].body;
  delete f.failures.finalize; await f.captured.usePhotoInAdsAutomation();
  const second = f.posts.filter(post => post.phase === "signed")[1].body;
  assert.equal(second.requestKey, first.requestKey); assert.equal(second.fileName, first.fileName);
  assert.equal(f.uploads[1].file, f.uploads[0].file);
  await f.render(); await f.captured.usePhotoInAdsAutomation();
  const third = f.posts.filter(post => post.phase === "signed")[2].body;
  assert.notEqual(third.requestKey, first.requestKey); assert.notEqual(f.uploads[2].file, f.uploads[0].file);
  assert.equal(third.fileSize, first.fileSize); assertNoPrivatePersistence(f);
});

for (const phase of ["signed", "finalize"] as const) {
  test(`${phase} failure carries text only, without a false image-success message`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); await f.render(); f.failures[phase] = 503;
    await f.captured.usePhotoInAdsAutomation();
    assert.equal(f.persisted[0].value.creative, undefined);
    const metadata = f.posts.find(post => post.phase === "metadata")!.body.photoCreative as Row;
    assert.equal(metadata.creativeUrl, undefined); assert.equal(metadata.assetId, undefined);
    assert.deepEqual(f.toasts.map(toast => toast.kind), ["warning", "success"]);
    assert.doesNotMatch(f.toasts[1].text, /Фото-креатив/);
    assert.equal(f.uploads.length, phase === "signed" ? 0 : 1); assertNoPrivatePersistence(f);
  });
}

for (const status of [401, 403]) for (const phase of ["signed", "upload", "finalize", "metadata"] as const) {
  for (const thrown of phase === "upload" ? [false, true] : [false]) {
    test(`${phase} ${status}${thrown ? " thrown" : ""} denies without text fallback or handoff`, async (t) => {
      const f = fixture(); t.after(() => f.dispose()); await f.render(); f.failures[phase] = status;
      if (thrown) f.throwUpload();
      await f.captured.usePhotoInAdsAutomation();
      assert.deepEqual(f.persisted, []); assert.deepEqual(f.navigation, []);
      assert.deepEqual(f.toasts.map(toast => toast.kind), ["error"]);
      if (phase === "upload") assert.equal(f.posts.filter(post => post.phase === "finalize").length, 0);
      assertNoPrivatePersistence(f); assert.equal(f.captured.photoHandoffPending.current, null);
    });
  }
}

test("an uncertain SDK acknowledgement may hand off only if finalization verifies the image", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); await f.render(); f.failures.upload = 503; f.throwUpload();
  await f.captured.usePhotoInAdsAutomation();
  assert.equal((f.persisted[0].value.creative as Row).url, publicUrl);
  assert.deepEqual(f.events, ["signed", "upload", "finalize", "metadata"]); assertNoPrivatePersistence(f);
});

test("local demo handoff makes no request, private upload or session lookup", async (t) => {
  const f = fixture({ demo: true }); t.after(() => f.dispose()); await f.render();
  await f.captured.usePhotoInAdsAutomation();
  assert.deepEqual(f.posts, []); assert.deepEqual(f.uploads, []); assert.equal(f.tokenReads, 0);
  assert.equal(f.persisted.length, 1); assert.equal(f.persisted[0].value.creative, undefined);
  assert.deepEqual(f.navigation, ["/ads-automation"]); assertNoPrivatePersistence(f);
});

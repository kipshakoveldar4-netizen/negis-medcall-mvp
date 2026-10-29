import assert from "node:assert/strict";
import { Blob, File } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Runs the real page closures, effects, request wrapper and shared image helper.
// Only JSX rendering, hooks and external I/O are simulated. No env, network,
// database or provider access. This is not a browser/React-concurrency test.
// node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-ads-verified-upload.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Bag = Record<string, any>;
const W = "11111111-1111-4111-8111-111111111111";
const N = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const J = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const origin = "https://storage.example.invalid";
const exposed = ["creative", "creativeFile", "videoJob", "uploadStatus", "loading", "notice", "lastUploadError",
  "uploadCreative", "uploadVideoThumbnail", "regenerateThumbnail", "removeCreative", "pollVideoJob",
  "retryVideoJob", "importCreativeFromUrl", "repeatLaunchFromHistory", "readCreativeReadiness", "prelaunchErrors", "buildLaunchPayload",
  "setMetaSummary", "creativeIntentRef", "sessionRef"];

function compile(source: string, page: boolean) {
  const result = ts.transpileModule(page ? `${source}\nexport { AdsAutomationSession as session };` : source, {
    fileName: page ? "AdsAutomation.tsx" : "verified-creative-upload.ts", reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("VITE_SUPABASE_URL", ts.factory.createStringLiteral(origin)),
          ]);
        }
        if (page && ts.isFunctionDeclaration(node) && node.body) {
          if (node.name?.text === "captureVideoThumbnail") {
            return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
              node.typeParameters, node.parameters, node.type, ts.factory.createBlock([
                ts.factory.createReturnStatement(ts.factory.createCallExpression(ts.factory.createIdentifier("fixtureCapture"),
                  undefined, [ts.factory.createIdentifier("source")])),
              ]));
          }
          if (node.name?.text === "AdsAutomationSession") {
            return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
              node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body,
                node.body.statements.map((statement) => ts.isReturnStatement(statement)
                  ? ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(
                    exposed.map((name) => ts.factory.createShorthandPropertyAssignment(name))))
                  : ts.visitNode(statement, visit) as import("typescript").Statement)));
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.equal(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}

const compiled = (async () => ({
  page: compile(await readFile(path.join(root, "artifacts/negis/src/pages/AdsAutomation.tsx"), "utf8"), true),
  helper: compile(await readFile(path.join(root, "artifacts/negis/src/lib/verified-creative-upload.ts"), "utf8"), false),
  importer: compile(await readFile(path.join(root, "artifacts/negis/src/lib/creative-import.ts"), "utf8"), false),
}))();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function driver() {
  const slots: Bag[] = [];
  let cursor = 0, lateWrites = 0;
  let alive = true;
  let view: Bag;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  function slot(kind: string, initial: () => Bag) {
    const index = cursor++;
    slots[index] ||= { kind, ...initial() };
    assert.equal(slots[index].kind, kind);
    return slots[index];
  }
  function effect(kind: string, create: () => unknown, deps?: unknown[]) {
    const current = slot(kind, () => ({ deps, pending: true }));
    if (!same(current.deps, deps)) current.pending = true;
    Object.assign(current, { create, deps });
  }
  const hooks = {
    useState(initial: unknown) {
      const current = slot("state", () => ({ value: typeof initial === "function" ? initial() : initial }));
      return [current.value, (next: any) => {
        if (!alive) { lateWrites++; return; }
        current.value = typeof next === "function" ? next(current.value) : next;
      }];
    },
    useRef(initial: unknown) { return slot("ref", () => ({ value: { current: initial } })).value; },
    useMemo(create: () => unknown, deps?: unknown[]) {
      const current = slot("memo", () => ({ deps, value: create() }));
      if (!same(current.deps, deps)) current.value = create();
      current.deps = deps;
      return current.value;
    },
    useLayoutEffect: (create: () => unknown, deps?: unknown[]) => effect("layout", create, deps),
    useEffect: (create: () => unknown, deps?: unknown[]) => effect("effect", create, deps),
  };
  return {
    hooks,
    render(component: () => Bag) {
      cursor = 0;
      view = component();
      for (const kind of ["layout", "effect"]) for (const current of slots.filter((s) => s.kind === kind && s.pending)) {
        current.cleanup?.(); current.pending = false; current.cleanup = current.create();
      }
      return view;
    },
    dispose() { for (const s of slots) s.cleanup?.(); alive = false; },
    get view() { return view; }, get lateWrites() { return lateWrites; },
  };
}

type Http = { url: string; init: Bag; body: Bag; answered: boolean; answer(data: unknown, mode?: string, success?: boolean): void };
const photo = (name = "same.jpg") => new File(["synthetic-image-bytes"], name, { type: "image/jpeg" });
const video = () => new File(["synthetic-video-bytes"], "input.mov", { type: "video/quicktime" });
const sourceUrl = (name: string) => `${origin}/storage/v1/object/public/ad-creatives/${W}/imports/${name}`;
function sourceResponse(file: Blob, body?: Promise<Uint8Array>) {
  return {
    ok: true, redirected: false, url: "", headers: new Headers({ "Content-Type": file.type, "Content-Length": String(file.size) }),
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        const bytes = body ? await body : new Uint8Array(await file.arrayBuffer());
        try { controller.enqueue(bytes); controller.close(); } catch { /* A stale import may already have cancelled its source. */ }
      },
    }),
    blob() { assert.fail("The real importer must use bounded streaming, never response.blob()"); },
  };
}

async function fixture(t: TestContext, prefill?: Bag) {
  const code = await compiled;
  let runtime = driver();
  const retired: ReturnType<typeof driver>[] = [];
  const http: Http[] = [], storage: Bag[] = [], resources: Bag[] = [], captures: Bag[] = [];
  const listeners = new Set<(event: string, session: Bag) => void>();
  const auth = { user: { id: "actor-A", user_metadata: {} }, userRole: "owner" };
  const signOut = { revision: 0, pending: false };
  const local = new Map<string, string>();
  if (prefill) local.set(`negis_content_studio_campaign_prefill::${W}`, JSON.stringify(prefill));
  const city = { id: "astana", labelRu: "Astana", canonicalName: "Astana" };
  let beforeDispatch: (() => Promise<void>) | undefined;
  const response = (data: unknown, mode = "supabase", success = true) => ({
    ok: success, status: success ? 200 : 400,
    text: async () => JSON.stringify({ success, mode, data, error: success ? undefined : "rejected" }),
  });
  const globals = {
    AbortController, DOMException, Blob, File, URL, Headers, TextEncoder, Uint8Array, setTimeout, clearTimeout, crypto: { randomUUID },
    window: {
      localStorage: { getItem: (k: string) => local.get(k) || null, setItem: (k: string, v: string) => local.set(k, v), removeItem: (k: string) => local.delete(k) },
      setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, scrollTo() {},
    },
    fixtureCapture(source: unknown) {
      const gate = deferred<unknown>(); captures.push({ source, ...gate }); return gate.promise;
    },
    fetch(url: string, init: Bag) {
      const gate = deferred<any>(); resources.push({ url, init, ...gate }); return gate.promise;
    },
  };
  function evaluate(source: string, require: (id: string) => unknown) {
    const exports = {};
    new Script(source).runInNewContext({ ...globals, exports, module: { exports }, require });
    return exports as Bag;
  }
  const helper = evaluate(code.helper, (id) => { throw new Error(`Unexpected helper import: ${id}`); });
  const importer = evaluate(code.importer, (id) => { throw new Error(`Unexpected importer import: ${id}`); });
  const sessionAuth = { onAuthStateChange(fn: (event: string, session: Bag) => void) {
    listeners.add(fn); return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
  } };
  const page = evaluate(code.page, (id) => {
    if (id === "react") return new Proxy({}, { get: (_, key) => runtime.hooks[key as keyof typeof runtime.hooks] });
    if (id === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
    if (id === "wouter") return { useLocation: () => ["/ads-automation", () => {}] };
    if (id === "lucide-react") return new Proxy({}, { get: () => () => null });
    if (id === "sonner") return { toast: { success() {}, warning() {}, error() {} } };
    if (id.includes("PageLayout") || id.includes("metric-card")) return {};
    if (id === "@/contexts/AuthContext") return { useAuth: () => auth };
    if (id === "@/lib/verified-creative-upload") return helper;
    if (id === "@/lib/creative-import") return importer;
    if (id === "@/lib/authSignOut") return { getSignOutRevision: () => signOut.revision, isSignOutPending: () => signOut.pending };
    if (id === "@/lib/serverAuth") return { getSupabaseAccessToken: async () => "synthetic" };
    if (id === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: {
      auth: sessionAuth,
      storage: { from(bucket: string) { return { uploadToSignedUrl(storagePath: string, token: string, file: unknown, opts: unknown) {
        const gate = deferred<any>(); storage.push({ bucket, storagePath, token, file, opts, ...gate }); return gate.promise;
      } }; } },
    }, sessionAuth };
    if (id === "@/lib/api") return {
      apiUrl: (url: string) => url, CrmApiError: Error, crmErrorMessage: (_e: unknown, fallback: string) => fallback,
      async crmFetch(url: string, init: Bag) {
        if (beforeDispatch) { const gate = beforeDispatch; beforeDispatch = undefined; await gate(); }
        init.signal?.throwIfAborted();
        if (init.dispatchGuard?.() === false) throw new DOMException("stale", "AbortError");
        if (url === "/api/crm/health") return response({ meta: { videoOptimization: { enabled: true, thresholdMb: 50, maxInputMb: 500 } } });
        const gate = deferred<any>();
        const call: Http = { url, init, body: JSON.parse(init.body || "{}"), answered: false,
          answer(data, mode, success) { call.answered = true; gate.resolve(response(data, mode, success)); } };
        http.push(call);
        return gate.promise;
      },
    };
    if (id === "@/lib/metaInsightsHistory") return { parseMetaInsightsHistorySummaries: () => [] };
    if (id === "@/lib/demoStorage") return { readWorkspaceId: () => W };
    if (id === "@/lib/planFeatures") return { normalizePlan: () => "pro", getPlanFeature: () => ({ enabled: true }), planFeatureBadge: () => "" };
    if (id.endsWith("/campaignBrief")) return {
      ADVERTISING_CAMPAIGN_PREFILL_KEY: "negis_content_studio_campaign_prefill",
      parseAdvertisingCampaignPrefillForPlatform: (x: unknown) => x,
      normalizeAdvertisingContentApproval: (x: unknown) => x, contentApprovalMatchesCopy: () => true,
    };
    if (id.endsWith("/cities")) return { KZ_META_CITY_OPTIONS: [city], getKzMetaCityOption: () => city };
    throw new Error(`Unexpected page import: ${id}`);
  });
  function render() { return runtime.render(() => page.session({ actorId: auth.user.id, workspaceId: W })); }
  async function flush() { for (let i = 0; i < 6; i++) { await tick(); render(); } }
  async function nextHttp(part: string, method = "POST") {
    for (let i = 0; i < 30; i++) {
      await flush();
      const call = http.find((x) => !x.answered && x.url.includes(part) && (x.init.method || "GET") === method);
      if (call) return call;
    }
    throw new Error(`No ${method} ${part}: ${http.map((x) => x.url).join(", ")}`);
  }
  function ticket(call: Http, file: File | Blob, fileName = file instanceof File ? file.name : "input-thumbnail.jpg") {
    call.answer({ bucket: "ad-creatives-staging", storagePath: `${W}/staged/${N}/original.jpg`,
      uploadHandle: `u1.c3ludGhldGlj.${"a".repeat(43)}`, token: "synthetic-token", workspaceId: W,
      requestKey: call.body.requestKey, fileType: "image", fileName, mimeType: "image/jpeg", fileSize: file.size });
  }
  function asset(file: File | Blob, fileName = file instanceof File ? file.name : "input-thumbnail.jpg") {
    const storagePath = `${W}/verified/${N}/${"f".repeat(64)}.jpg`;
    return { id: N, workspaceId: W, fileName, fileType: "image", mimeType: "image/jpeg", fileSize: file.size,
      storageBucket: "ad-creatives", storagePath, publicUrl: `${origin}/storage/v1/object/public/ad-creatives/${storagePath}`, status: "uploaded" };
  }
  async function finishImage(pending: Promise<unknown>, file: File, invalid = false) {
    const signed = await nextHttp("signed-upload");
    ticket(signed, file); await flush();
    storage.at(-1)!.resolve({ data: {}, error: null });
    const final = await nextHttp("finalize-upload");
    final.answer({ asset: invalid ? { ...asset(file), id: "wrong" } : asset(file) });
    await pending; await flush();
    assert.equal(runtime.view.uploadStatus, invalid ? "failed" : "ready");
    if (!invalid) assert.equal(runtime.view.creative.id, N);
    return signed.body.requestKey;
  }
  async function queueVideo(file = video()) {
    const pending = render().uploadCreative(file);
    const created = await nextHttp("video-jobs");
    created.answer({ assetId: "old-input-id", job: { id: J, status: "awaiting_upload" },
      signedUpload: { bucket: "raw-videos", storagePath: `${W}/raw/${J}/input.mov`, token: "synthetic" } });
    await flush(); storage.at(-1)!.resolve({ error: null });
    const queued = await nextHttp("video-jobs", "PATCH");
    queued.answer({ job: { id: J, status: "queued" } });
    await pending; await flush();
  }
  const readyJob = {
    id: J, status: "ready", outputAssetId: N, outputFileName: "worker-output.mp4", outputMimeType: "video/mp4",
    outputSizeBytes: 7, outputStorageBucket: "ad-creatives", outputStoragePath: `${W}/worker/output.mp4`,
    outputPublicUrl: `${origin}/storage/v1/object/public/ad-creatives/${W}/worker/output.mp4`,
    thumbnailPublicUrl: `${origin}/worker-cover.jpg`, thumbnailSource: "worker",
  };
  async function poll(job: Bag) {
    const pending = render().pollVideoJob(J);
    (await nextHttp("video-jobs", "GET")).answer({ job }); await pending; await flush();
  }
  render(); await flush();
  t.after(() => { runtime.dispose(); for (const old of retired) assert.equal(old.lateWrites, 0); });
  return {
    render, flush, http, storage, resources, captures, nextHttp, ticket, asset, finishImage, queueVideo, readyJob, poll,
    get view() { return runtime.view; },
    pauseDispatch(gate: Promise<void>) { beforeDispatch = () => gate; },
    endSession() { signOut.revision++; signOut.pending = true; },
    actorChange() { for (const fn of listeners) fn("SIGNED_IN", { user: { id: "actor-B" } }); },
    newActor() {
      runtime.dispose(); retired.push(runtime); auth.user.id = "actor-B"; runtime = driver(); render();
    },
    dispose() { runtime.dispose(); },
    get lateWrites() { return runtime.lateWrites; },
  };
}

test("image uses the real shared staging/finalize helper and is not ready before finalization", async (t) => {
  const f = await fixture(t), file = photo();
  const pending = f.view.uploadCreative(file);
  const signed = await f.nextHttp("signed-upload");
  assert.equal(signed.body.fileType, "image");
  assert.match(signed.body.requestKey, /^[0-9a-f-]{36}$/);
  assert.equal(f.view.creative.publicUrl, undefined);
  f.ticket(signed, file); await f.flush();
  assert.equal(f.storage[0].bucket, "ad-creatives-staging");
  assert.equal(f.storage[0].file, file);
  assert.equal(f.storage[0].opts.upsert, false);
  f.storage[0].resolve({ error: null });
  const final = await f.nextHttp("finalize-upload");
  assert.deepEqual(Object.keys(final.body), ["uploadHandle"]);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  final.answer({ asset: f.asset(file) }); await pending; await f.flush();
  assert.equal(f.view.creative.id, N);
  assert.equal(f.view.creative.storagePath, f.asset(file).storagePath);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, true);
  assert.equal(f.http.length, 2, "No metadata POST fallback");
});

test("UUID retries follow File identity within the intent, not the filename", async (t) => {
  const f = await fixture(t), file = photo();
  const first = await f.finishImage(f.view.uploadCreative(file), file, true);
  assert.equal(f.view.creative.publicUrl, undefined);
  assert.equal(f.view.uploadStatus, "failed");
  const retry = await f.finishImage(f.view.uploadCreative(file), file);
  assert.equal(retry, first);
  const replacement = photo();
  const second = await f.finishImage(f.view.uploadCreative(replacement), replacement);
  assert.notEqual(second, first);
  const backToOld = await f.finishImage(f.view.uploadCreative(file), file);
  assert.notEqual(backToOld, first, "Returning to a previous File is a new intent");
  f.view.removeCreative(); f.render();
  assert.notEqual(await f.finishImage(f.view.uploadCreative(file), file), backToOld);
  f.newActor(); await f.flush();
  assert.notEqual(await f.finishImage(f.view.uploadCreative(file), file), first);
});

for (const boundary of ["ticket", "storage", "finalize"] as const) {
  test(`session invalidation at ${boundary} stops subsequent dispatch and state writes`, async (t) => {
    const f = await fixture(t), file = photo();
    const pending = f.view.uploadCreative(file);
    const signed = await f.nextHttp("signed-upload");
    if (boundary !== "ticket") { f.ticket(signed, file); await f.flush(); }
    let final: Http | undefined;
    if (boundary === "finalize") {
      f.storage[0].resolve({ error: null }); final = await f.nextHttp("finalize-upload");
    }
    const count = f.http.length;
    f.actorChange(); f.dispose();
    if (boundary === "ticket") f.ticket(signed, file);
    if (boundary === "storage") f.storage[0].resolve({ error: null });
    final?.answer({ asset: f.asset(file) });
    await pending; await tick();
    assert.equal(f.http.length, count);
    assert.equal(f.storage.length, boundary === "ticket" ? 0 : 1);
    assert.equal(f.lateWrites, 0);
  });
}

test("changing selection while credentials are pending blocks the old signed-upload dispatch", async (t) => {
  const f = await fixture(t), gate = deferred<void>();
  f.pauseDispatch(gate.promise);
  const pending = f.view.uploadCreative(photo()); await tick();
  f.view.removeCreative(); gate.resolve(); await pending; await f.flush();
  assert.equal(f.http.length, 0);
  assert.equal(f.storage.length, 0);
  assert.equal(f.view.creative, null);
});

test("replacing a file suppresses its stale finalized asset", async (t) => {
  const f = await fixture(t), old = photo("old.jpg"), next = photo("next.jpg");
  const pending = f.view.uploadCreative(old);
  const signed = await f.nextHttp("signed-upload"); f.ticket(signed, old); await f.flush();
  f.storage[0].resolve({ error: null }); const final = await f.nextHttp("finalize-upload");
  const replacement = f.view.uploadCreative(next);
  final.answer({ asset: f.asset(old) }); await pending;
  await f.finishImage(replacement, next);
  assert.equal(f.view.creative.fileName, "next.jpg");
});

test("Studio photo handoff fetches bytes and verifies them instead of trusting URL/asset metadata", async (t) => {
  const f = await fixture(t, { sourceModule: "content-studio", creative: {
    type: "image", url: sourceUrl("unverified.jpg"), fileName: "handoff.jpg", assetId: "untrusted", mimeType: "image/jpeg",
  } });
  assert.equal(f.view.creative, null);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  assert.equal(f.resources.length, 1);
  assert.equal(f.resources[0].url, sourceUrl("unverified.jpg"));
  assert.equal(f.resources[0].init.credentials, "omit"); assert.equal(f.resources[0].init.referrerPolicy, "no-referrer");
  assert.equal(f.resources[0].init.redirect, "error");
  f.resources[0].resolve(sourceResponse(photo("handoff.jpg")));
  const signed = await f.nextHttp("signed-upload");
  const file = f.view.creativeFile as File;
  assert.equal(file.name, "handoff.jpg"); f.ticket(signed, file); await f.flush();
  f.storage[0].resolve({ error: null });
  (await f.nextHttp("finalize-upload")).answer({ asset: f.asset(file) }); await f.flush();
  const uploaded = f.render().creative;
  assert.equal(uploaded.id, N);
  assert.notEqual(uploaded.publicUrl, sourceUrl("unverified.jpg"));
});

test("removed handoff cannot dispatch after its fetch resolves", async (t) => {
  const f = await fixture(t);
  const pending = f.view.importCreativeFromUrl(sourceUrl("image.jpg"), "handoff.jpg", "image/jpeg");
  await f.flush(); assert.equal(f.resources.length, 1, "Pause after the real bounded fetch dispatch, not before module loading");
  f.view.removeCreative();
  f.resources[0].resolve(sourceResponse(photo()));
  await pending; await f.flush();
  assert.equal(f.http.length, 0); assert.equal(f.view.creative, null);
});

test("a removed handoff cannot dispatch after its response-body await", async (t) => {
  const f = await fixture(t), body = deferred<Uint8Array>(), file = photo();
  const pending = f.view.importCreativeFromUrl(sourceUrl("image.jpg"), "handoff.jpg", "image/jpeg");
  await f.flush(); assert.equal(f.resources.length, 1);
  const source = sourceResponse(file, body.promise);
  f.resources[0].resolve(source); await f.flush();
  assert.equal(source.body.locked, true, "The actual importer must be awaiting its streamed response body");
  f.view.removeCreative(); body.resolve(new Uint8Array(await file.arrayBuffer())); await pending; await f.flush();
  assert.equal(f.http.length, 0); assert.equal(f.storage.length, 0);
});

test("history photo replay re-verifies rather than restoring a launch-ready URL", async (t) => {
  const f = await fixture(t);
  f.view.repeatLaunchFromHistory({ payload: { creativeType: "image", fileName: "history.jpg",
    sourceId: "untrusted", creativeUrl: sourceUrl("history.jpg"), mimeType: "image/jpeg" } });
  await f.flush();
  assert.equal(f.view.creative, null); assert.equal(f.resources.length, 1);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  f.view.removeCreative(); f.resources[0].resolve({ ...sourceResponse(photo()), ok: false }); await f.flush();
});

test("Studio video handoff reads current worker configuration after awaiting its source", async (t) => {
  const f = await fixture(t, { sourceModule: "content-studio", creative: {
    type: "video", url: sourceUrl("studio.mov"), fileName: "studio.mov", mimeType: "video/quicktime",
    thumbnailUrl: "https://source.invalid/unverified-cover.jpg", assetId: "untrusted",
  } });
  f.resources[0].resolve(sourceResponse(video()));
  const created = await f.nextHttp("video-jobs");
  assert.equal(created.body.fileName, "studio.mov");
  created.answer({ assetId: "input", job: { id: J, status: "awaiting_upload" }, signedUpload: {
    bucket: "raw-videos", storagePath: `${W}/raw/${J}/input.mov`, token: "synthetic",
  } });
  await f.flush(); f.storage[0].resolve({ error: null });
  (await f.nextHttp("video-jobs", "PATCH")).answer({ job: { id: J, status: "queued" } }); await f.flush();
  assert.equal(f.view.creative.publicUrl, ""); assert.equal(f.view.creative.thumbnailUrl, undefined);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  assert.equal(f.http.some((call) => call.url.includes("ad-creatives")), false);
});

test("a legacy public signed image ticket fails without uploading or saving metadata", async (t) => {
  const f = await fixture(t), file = photo();
  const pending = f.view.uploadCreative(file);
  (await f.nextHttp("signed-upload")).answer({ bucket: "ad-creatives", token: "legacy", storagePath: "legacy.jpg", publicUrl: `${origin}/legacy.jpg` });
  await pending; await f.flush();
  assert.equal(f.view.uploadStatus, "failed"); assert.equal(f.view.creative.publicUrl, undefined);
  assert.equal(f.storage.length, 0); assert.equal(f.http.length, 1);
});

test("small video uses only private video jobs and applies the complete worker output identity", async (t) => {
  const f = await fixture(t); await f.queueVideo();
  assert.equal(f.storage[0].bucket, "raw-videos");
  assert.equal(f.http.some((x) => x.url.includes("ad-creatives")), false);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  await f.poll({ id: J, status: "ready", outputPublicUrl: f.readyJob.outputPublicUrl });
  assert.equal(f.view.videoJob.status, "uploading", "Incomplete ready receipts keep polling and blocking");
  assert.equal(f.view.creative.publicUrl, "");
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
  const blockedMessage = f.view.readCreativeReadiness().clientMessage;
  assert.equal(f.view.prelaunchErrors("PAUSED").includes(blockedMessage), true);
  await f.poll(f.readyJob);
  const creative = f.view.creative;
  assert.equal(creative.id, N); assert.equal(creative.fileName, "worker-output.mp4");
  assert.equal(creative.fileSize, 7); assert.equal(creative.mimeType, "video/mp4");
  assert.equal(creative.storagePath, f.readyJob.outputStoragePath);
  assert.equal(creative.storageBucket, f.readyJob.outputStorageBucket);
  assert.equal(creative.previewUrl, f.readyJob.outputPublicUrl);
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, true);
  assert.equal(f.view.prelaunchErrors("PAUSED").includes(blockedMessage), false);
  const payload = f.view.buildLaunchPayload(false);
  assert.equal(payload.sourceId, N); assert.equal(payload.fileName, "worker-output.mp4"); assert.equal(payload.fileSize, 7);
});

test("video rejects a public raw upload target before sending any bytes", async (t) => {
  const f = await fixture(t);
  const pending = f.view.uploadCreative(video());
  (await f.nextHttp("video-jobs")).answer({ job: { id: J, status: "awaiting_upload" }, signedUpload: {
    bucket: "ad-creatives", storagePath: `${W}/unsafe.mov`, token: "synthetic",
  } });
  await pending; await f.flush();
  assert.equal(f.storage.length, 0); assert.equal(f.view.uploadStatus, "failed");
  assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
});

for (const boundary of ["create", "storage", "queue"] as const) {
  test(`private video lifetime ends at ${boundary} without publishing or further dispatch`, async (t) => {
    const f = await fixture(t);
    const pending = f.view.uploadCreative(video());
    const created = await f.nextHttp("video-jobs");
    const answerCreate = () => created.answer({ job: { id: J, status: "awaiting_upload" }, signedUpload: {
      bucket: "raw-videos", storagePath: `${W}/raw/${J}/input.mov`, token: "synthetic",
    } });
    if (boundary !== "create") { answerCreate(); await f.flush(); }
    let queued: Http | undefined;
    if (boundary === "queue") {
      f.storage[0].resolve({ error: null }); queued = await f.nextHttp("video-jobs", "PATCH");
    }
    const count = f.http.length; f.endSession(); f.dispose();
    if (boundary === "create") answerCreate();
    if (boundary === "storage") f.storage[0].resolve({ error: null });
    queued?.answer({ job: f.readyJob }); await pending; await tick();
    assert.equal(f.http.length, count); assert.equal(f.lateWrites, 0);
  });
}

for (const enabled of [false, undefined]) {
  test(`video worker ${enabled === false ? "disabled" : "configuration missing"} never falls back to public uploads`, async (t) => {
    const f = await fixture(t);
    f.view.setMetaSummary(enabled === false ? { videoOptimization: { enabled: false } } : null); f.render();
    await f.view.uploadCreative(video()); await f.flush();
    assert.equal(f.http.length, 0); assert.equal(f.storage.length, 0);
    assert.equal(f.view.readCreativeReadiness().isReadyForMeta, false);
    assert.equal(f.view.creative.publicUrl, undefined);
  });
}

test("old worker polling cannot overwrite a new file selection", async (t) => {
  const f = await fixture(t); await f.queueVideo();
  const pending = f.view.pollVideoJob(J), call = await f.nextHttp("video-jobs", "GET");
  const file = photo(); const upload = f.view.uploadCreative(file);
  call.answer({ job: f.readyJob }); await pending;
  await f.finishImage(upload, file);
  assert.equal(f.view.creative.fileType, "image"); assert.equal(f.view.videoJob, null);
});

test("thumbnail regeneration uses verified image finalization before attaching its URL", async (t) => {
  const f = await fixture(t); await f.queueVideo(); await f.poll(f.readyJob);
  const previous = f.view.creative.thumbnailUrl;
  const pending = f.view.regenerateThumbnail(); await f.flush();
  const blob = new Blob(["synthetic-cover-bytes"], { type: "image/jpeg" });
  f.captures[0].resolve({ blob, mimeType: "image/jpeg" });
  const signed = await f.nextHttp("signed-upload");
  const name = "worker-output-thumbnail.jpg";
  f.ticket(signed, blob, name); await f.flush();
  assert.equal(f.view.creative.thumbnailUrl, previous);
  assert.equal(f.storage.at(-1)!.bucket, "ad-creatives-staging");
  f.storage.at(-1)!.resolve({ error: null });
  (await f.nextHttp("finalize-upload")).answer({ asset: f.asset(blob, name) });
  const patch = await f.nextHttp("/api/crm/ad-creatives?", "PATCH");
  assert.equal(patch.body.id, N); assert.equal(patch.body.metadata.thumbnailUrl, f.asset(blob, name).publicUrl);
  patch.answer({}); await pending; await f.flush();
  assert.equal(f.view.creative.thumbnailUrl, f.asset(blob, name).publicUrl);
});

test("thumbnail capture cannot outlive the selected video", async (t) => {
  const f = await fixture(t); await f.queueVideo(); await f.poll(f.readyJob);
  const pending = f.view.regenerateThumbnail(); await f.flush();
  const count = f.http.length; f.view.removeCreative();
  f.captures[0].resolve({ blob: new Blob(["cover"], { type: "image/jpeg" }), mimeType: "image/jpeg" });
  await pending; await f.flush();
  assert.equal(f.http.length, count); assert.equal(f.view.creative, null);
});

test("unverified thumbnail finalization cannot replace or persist a cover", async (t) => {
  const f = await fixture(t); await f.queueVideo(); await f.poll(f.readyJob);
  const previous = f.view.creative.thumbnailUrl;
  const pending = f.view.regenerateThumbnail(); await f.flush();
  const blob = new Blob(["cover"], { type: "image/jpeg" });
  f.captures[0].resolve({ blob, mimeType: "image/jpeg" });
  f.ticket(await f.nextHttp("signed-upload"), blob, "worker-output-thumbnail.jpg"); await f.flush();
  f.storage.at(-1)!.resolve({ error: null });
  (await f.nextHttp("finalize-upload")).answer({ asset: { ...f.asset(blob, "worker-output-thumbnail.jpg"), id: "unverified" } });
  await pending; await f.flush();
  assert.equal(f.view.creative.thumbnailUrl, previous);
  assert.equal(f.view.uploadStatus, "ready");
  assert.equal(f.http.some((call) => call.url.includes("ad-creatives?") && call.init.method === "PATCH"), false);
});

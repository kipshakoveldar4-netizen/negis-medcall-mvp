import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { createServer, request } from "node:http";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { createGeneratedVideoBrowserHttpFixture, generatedVideoFixtureIds as ids } from "./generated-video-browser-http-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const source = await readFile(path.join(root, "artifacts/negis/src/lib/generated-video-receipt.ts"), "utf8");
const exports = {};
new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
  .runInNewContext({ exports, URL, TextEncoder, Error, JSON });
const helpers = exports;
const owner = { actorId: ids.actor, workspaceId: ids.workspace };
const ctx = { workspaceId: ids.workspace, storageOrigin: ids.storageOrigin };
const draft = { handle: ids.handle, status: "in_progress", progress: 75, phase: "validation", validationJobId: ids.job, formatSubstituted: false };
const httpFixture = createGeneratedVideoBrowserHttpFixture({ video: Buffer.from("synthetic-local-video"), thumbnail: Buffer.from("synthetic-local-thumbnail") });
const receipt = () => ({ ...httpFixture.receipt(), status: "completed", phase: "validation", progress: 100 });
const clone = value => JSON.parse(JSON.stringify(value));

test("complete native receipt resolves only a workspace-owned optimized video and matching thumbnail", () => {
  const result = helpers.parseGeneratedVideoPoll(receipt(), ctx);
  assert.equal(result.status, "completed");
  assert.equal(result.receipt.nativeValidated, true);
  assert.equal(result.receipt.validationJobId, ids.job);
  assert.equal(result.receipt.creativeUrl, receipt().creativeUrl);
});
const missing = ["nativeValidated", "assetId", "validationJobId", "fileName", "mimeType", "fileSize", "sha256", "creativeUrl", "thumbnailUrl", "progress"];
for (const field of missing) test(`missing ${field} cannot publish a generated video`, () => {
  const value = receipt(); delete value[field];
  assert.throws(() => helpers.parseGeneratedVideoPoll(value, ctx), /generated_video_receipt_unconfirmed/);
});
const badFields = {
  nativeValidated: [false, "true", 1, null], assetId: [ids.job.toUpperCase(), "bad", null, 2],
  validationJobId: [ids.asset, "invalid", null], fileName: ["../movie.mp4", "movie\\bad.mp4", "movie.mp4\n", ".mp4", "movie.webm", "different.mp4", "a".repeat(256) + ".mp4"],
  mimeType: ["video/quicktime", "video/mp4; charset=utf8", null], fileSize: [0, -1, "32", 100 * 1024 * 1024 + 1, 1.5, null],
  sha256: ["a".repeat(63), "A".repeat(64), "bad", null], progress: [99, -1, "100", null, NaN, Infinity],
  phase: ["generation", "native", null], storageBucket: ["raw-videos", "foreign", null],
  storagePath: ["private/raw.mp4", `optimized/foreign/${ids.job}-${"a".repeat(20)}.mp4`, null],
  thumbnailSize: [0, 1.2, "123", 10 * 1024 * 1024 + 1], thumbnailSha256: ["bad", "A".repeat(64), null],
};
for (const [field, values] of Object.entries(badFields)) for (let index = 0; index < values.length; index++) {
  test(`malformed ${field} case ${index + 1} is rejected before display`, () => {
    assert.throws(() => helpers.parseGeneratedVideoPoll({ ...receipt(), [field]: values[index] }, ctx), /generated_video_receipt_unconfirmed/);
  });
}
const urlMutations = [
  url => url.replace("https://", "http://"), url => url + "?token=not-a-real-token", url => url + "#fragment",
  url => url.replace(".fixture.invalid", ".other.invalid"), url => url.replace("optimized/", "raw/"),
  url => url.replace(ids.workspace, "bbbbbbbb-2222-4222-8222-222222222222"), url => url.replace(ids.job, "eeeeeeee-5555-4555-8555-555555555555"),
  url => url.replace("https://", "https://username:password@"), url => url.replace("/storage/", "/%73torage/"),
  url => url.replace("/storage/", "/other/../storage/"), url => url.replace("ad-creatives/", "ad-creatives-staging/"),
];
for (let index = 0; index < urlMutations.length; index++) for (const field of ["creativeUrl", "thumbnailUrl"]) {
  test(`canonical ${field} rejects altered origin/path case ${index + 1}`, () => {
    const value = receipt(); value[field] = urlMutations[index](value[field]);
    assert.throws(() => helpers.parseGeneratedVideoPoll(value, ctx), /generated_video_receipt_unconfirmed/);
  });
}
test("thumbnail from a different worker claim cannot accompany a valid video", () => {
  const value = receipt(); value.thumbnailUrl = value.thumbnailUrl.replace("a".repeat(20), "b".repeat(20));
  assert.throws(() => helpers.parseGeneratedVideoPoll(value, ctx));
});
test("validation job cannot disappear or change once bound to the accepted handle", () => {
  for (const validationJobId of [undefined, "eeeeeeee-5555-4555-8555-555555555555"]) {
    assert.throws(() => helpers.parseGeneratedVideoPoll({ status: "in_progress", progress: 45, phase: "validation", validationJobId }, { ...ctx, validationJobId: ids.job }));
  }
});
for (const status of ["queued", "in_progress", "failed"]) {
  test(`${status} validation exposes no media and never reaches 100 percent`, () => {
    const parsed = helpers.parseGeneratedVideoPoll({ status, progress: 100, phase: "validation", validationJobId: ids.job }, ctx);
    assert.equal(parsed.progress, 95); assert.equal(parsed.receipt, undefined);
  });
  for (const field of ["creativeUrl", "publicUrl", "url", "thumbnailUrl", "storageBucket", "storagePath", "asset", "receipt"]) {
    test(`${status} with premature ${field} fails closed`, () => {
      assert.throws(() => helpers.parseGeneratedVideoPoll({ status, progress: 40, phase: "validation", validationJobId: ids.job, [field]: "premature" }, ctx));
    });
  }
}
test("generation can be polled before a native job exists", () => {
  const parsed = helpers.parseGeneratedVideoPoll({ status: "in_progress", progress: 36, phase: "generation" }, ctx);
  assert.equal(parsed.validationJobId, undefined); assert.equal(parsed.receipt, undefined);
});
test("recoverable accepted failure preserves the same handle without a new generation", () => {
  const parsed = helpers.parseRecoverableGeneratedVideo({ success: false, accepted: true,
    data: { handle: ids.handle, status: "in_progress", phase: "validation" } }, ctx);
  assert.equal(parsed.handle, ids.handle); assert.equal(parsed.status, "failed"); assert.equal(parsed.validationJobId, undefined);
  assert.equal(helpers.parseRecoverableGeneratedVideo({ success: false, data: { handle: ids.handle } }, ctx), null);
});
test("completed POST is not displayed until an authoritative free poll", () => {
  const parsed = helpers.parseAcceptedGeneratedVideo({ ...receipt(), handle: ids.handle, formatSubstituted: false }, ctx);
  assert.equal(parsed.status, "in_progress"); assert.equal(parsed.progress, 95); assert.equal(parsed.receipt, undefined);
});
for (const handle of ["", "synthetic-local-video-handle", ids.handle + "\n", "https://other.invalid", 1, null, "g2." + "a".repeat(8200) + "." + "x".repeat(43)]) {
  test(`invalid accepted handle ${String(handle).slice(0, 35)} cannot be persisted`, () => {
    assert.throws(() => helpers.parseAcceptedGeneratedVideo({ status: "queued", progress: 0, handle }, ctx));
  });
}
test("draft key and envelope are scoped to exactly the original actor and workspace", () => {
  const key = helpers.generatedVideoStorageKey("video", owner), raw = helpers.serializeGeneratedVideoDraft(draft, owner);
  assert.equal(key, `video::${owner.workspaceId}::${owner.actorId}`);
  assert.equal(helpers.parseGeneratedVideoDraft(raw, owner).handle, ids.handle);
  assert.equal(helpers.parseGeneratedVideoDraft(raw, { ...owner, actorId: "22222222-2222-4222-8222-222222222222" }), null);
  assert.equal(helpers.parseGeneratedVideoDraft(raw, { ...owner, workspaceId: "bbbbbbbb-2222-4222-8222-222222222222" }), null);
  assert.throws(() => helpers.generatedVideoStorageKey("video", { ...owner, actorId: "" }));
});
test("completed and forged local links never restore a ready public file", () => {
  const raw = JSON.stringify({ ...draft, version: 2, ...owner, status: "completed", progress: 100,
    url: "https://external.invalid/raw.mp4", ...receipt() });
  const parsed = helpers.parseGeneratedVideoDraft(raw, owner);
  assert.equal(parsed.status, "in_progress"); assert.equal(parsed.progress, 95);
  assert.equal(parsed.url, undefined); assert.equal(parsed.creativeUrl, undefined); assert.equal(parsed.receipt, undefined);
  const serialized = helpers.serializeGeneratedVideoDraft({ ...draft, url: "https://external.invalid", assetId: ids.asset }, owner);
  assert.doesNotMatch(serialized, /external|assetId|creativeUrl/);
});
for (const raw of ["{}", "[]", "null", "{", " ".repeat(12001), JSON.stringify(draft)]) {
  test(`malformed or old workspace-only draft ${raw.slice(0, 18)} is not adopted by a different lifetime`, () => {
    assert.equal(helpers.parseGeneratedVideoDraft(raw, owner), null);
  });
}
test("native retry acknowledgement must reference the same workspace and existing job", () => {
  const value = { success: true, mode: "supabase", data: { job: { id: ids.job, workspaceId: ids.workspace, status: "queued" } } };
  helpers.requireGeneratedVideoRetryReceipt(value, owner, ids.job);
  for (const mutate of [v => { v.mode = "demo"; }, v => { v.data.job.status = "failed"; }, v => { v.data.job.id = ids.asset; },
    v => { v.data.job.workspaceId = "bbbbbbbb-2222-4222-8222-222222222222"; }, v => { delete v.data.job; }]) {
    const other = clone(value); mutate(other);
    assert.throws(() => helpers.requireGeneratedVideoRetryReceipt(other, owner, ids.job), /generated_video_retry_unconfirmed/);
  }
});

const page = await readFile(path.join(root, "artifacts/negis/src/pages/ContentStudio.tsx"), "utf8");
const ast = ts.createSourceFile("ContentStudio.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.ok(component?.body);
const declarations = names => names.map(name => {
  const item = component.body.statements.find(node => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
  assert.ok(item, `Execute actual ${name}`); return item.getText(ast);
}).join("\n");
const pollEffect = component.body.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === "useEffect" && node.getText(ast).includes("parseGeneratedVideoPoll(body.data"));
assert.ok(pollEffect);
const program = ts.transpileModule([
  declarations(["videoJobStorageKey", "videoReceiptContext", "clearGeneratedVideoAccess", "displayGeneratedVideoReceipt", "retryNativeVideo"]),
  `exports.poll = ${pollEffect.expression.arguments[0].getText(ast)}; exports.retry = retryNativeVideo;`,
].join("\n").replaceAll("import.meta.env", "fixtureEnv"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const paid = {};
new Script(ts.transpileModule(await readFile(path.join(root, "lib/content-studio/paid-generation.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({ exports: paid, Error, JSON, Date, crypto: webcrypto });
const generateProgram = ts.transpileModule([
  declarations(["videoJobStorageKey", "videoReceiptContext", "clearGeneratedVideoAccess", "generateVideo"]),
  "exports.generate = generateVideo;",
].join("\n").replaceAll("import.meta.env", "fixtureEnv"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 35; index++) await Promise.resolve(); };
function runtime({ state = { ...draft }, nextResponse = async () => ({ ok: true, status: 200, payload: { success: true, data: receipt() } }),
  json = response => response.payload } = {}) {
  const session = new AbortController();
  const refs = { sessionRef: { current: session }, videoJobRef: { current: state }, videoCommandRef: { current: null }, videoGenerationRevision: { current: 1 } };
  let current = true, job = state, video = null, notice = null, busy = false, auth = async () => current;
  const events = [], timers = [], toasts = [], bindings = { exports: {}, ...helpers, ...refs, actorId: ids.actor, workspaceId: ids.workspace,
    videoJob: state, VIDEO_POLL_INTERVAL_MS: 12000, VIDEO_JOB_KEY: "video", AbortController, AbortSignal,
    fixtureEnv: { VITE_SUPABASE_URL: ids.storageOrigin }, URL, encodeURIComponent, DOMException, Error,
    isSessionAlive: value => current && value === session && !session.signal.aborted,
    isGenerationSessionCurrent: async value => value === session && await auth() && current && !session.signal.aborted,
    pollingSessionState: async () => await auth() && current && !session.signal.aborted ? "current" : "ended",
    handoffAccessDenied: value => value?.status === 401 || value?.status === 403,
    withWorkspace: url => `${url}${url.includes("?") ? "&" : "?"}workspaceId=${ids.workspace}`,
    crmFetch: async (url, init) => { if (!init.dispatchGuard()) throw Error("stale"); events.push({ url, init }); return nextResponse(url, init); },
    safeJson: async response => json(response),
    generationRefusalText: () => "Synthetic refusal",
    setVideoJob(value) { job = typeof value === "function" ? value(job) : value; refs.videoJobRef.current = job; },
    setGenVideo(value) { video = value; }, setGenNotice(value) { notice = value; }, setVideoRetryBusy(value) { busy = value; },
    writeStoredVideoJob(value) { events.push({ operation: "storage", value }); },
    toast: { success(value) { toasts.push(value); } },
    setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {},
  };
  new Script(program).runInNewContext(bindings);
  return { poll: bindings.exports.poll, retry: bindings.exports.retry, refs, events, toasts, timers,
    state: () => ({ job, video, notice, busy }), abort() { current = false; session.abort(); },
    auth(callback) { auth = callback; } };
}
test("actual pending poll keeps the media private and schedules only another GET", async () => {
  const fixture = runtime({ nextResponse: async () => ({ ok: true, status: 200, payload: { success: true,
    data: { status: "in_progress", phase: "validation", progress: 82, validationJobId: ids.job } } }) });
  const stop = fixture.poll(); await flush();
  assert.equal(fixture.state().video, null); assert.equal(fixture.state().job.status, "in_progress");
  assert.equal(fixture.state().job.phase, "validation"); assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.events.filter(item => item.url).length, 1); assert.equal(fixture.events[0].init.method, undefined);
  stop();
});
test("actual complete poll displays only the native validated receipt", async () => {
  const fixture = runtime(); const stop = fixture.poll(); await flush();
  assert.equal(fixture.state().video.nativeValidated, true); assert.equal(fixture.state().video.validationJobId, ids.job);
  assert.equal(fixture.state().job.status, "completed"); assert.equal(fixture.state().notice, null);
  assert.deepEqual(fixture.toasts, [], "The live completed card must not be covered by a duplicate floating toast"); stop();
});
test("actual incomplete ready response keeps the original handle for a free retry", async () => {
  const fixture = runtime({ nextResponse: async () => ({ ok: true, status: 200, payload: { success: true,
    data: { status: "completed", progress: 100, creativeUrl: "https://other.invalid/raw.mp4" } } }) });
  const stop = fixture.poll(); await flush();
  assert.equal(fixture.state().video, null); assert.equal(fixture.state().job.handle, ids.handle);
  assert.equal(fixture.state().job.status, "failed"); assert.match(fixture.state().notice.text, /Проверить ещё раз/);
  assert.deepEqual(fixture.toasts, []); stop();
});
for (const phase of ["response", "body", "authorization"]) for (const change of ["abort", "generation", "handle"]) {
  test(`actual poll rejects ${change} replacement during ${phase}`, async () => {
    const gate = deferred();
    const fixture = runtime({ nextResponse: async () => phase === "response" ? gate.promise : { ok: true, status: 200, payload: { success: true, data: receipt() } },
      json: response => phase === "body" ? gate.promise : response.payload });
    if (phase === "authorization") fixture.auth(() => gate.promise);
    const stop = fixture.poll(); await flush();
    if (change === "abort") fixture.abort();
    if (change === "generation") fixture.refs.videoGenerationRevision.current++;
    if (change === "handle") fixture.refs.videoJobRef.current = { ...draft, handle: "other" };
    gate.resolve(phase === "response" ? { ok: true, status: 200, payload: { success: true, data: receipt() } }
      : phase === "body" ? { success: true, data: receipt() } : true);
    await flush(); assert.equal(fixture.state().video, null); assert.deepEqual(fixture.toasts, []); stop();
  });
}
test("actual HTTP denial immediately clears the video, form task and scoped draft", async () => {
  const fixture = runtime({ nextResponse: async () => ({ ok: false, status: 403, payload: { success: false } }) });
  const stop = fixture.poll(); await flush();
  assert.equal(fixture.state().video, null); assert.equal(fixture.state().job, null);
  assert.ok(fixture.events.some(item => item.operation === "storage" && item.value === null)); stop();
});
test("actual native retry posts only to the existing protected CRM job, never generation", async () => {
  const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: async () => ({ ok: true, status: 200,
    payload: { success: true, mode: "supabase", data: { job: { id: ids.job, workspaceId: ids.workspace, status: "queued" } } } }) });
  await fixture.retry();
  const calls = fixture.events.filter(item => item.url);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, `/api/crm/video-processing-jobs/${ids.job}/retry?workspaceId=${ids.workspace}`);
  assert.equal(calls[0].init.expectedUserId, ids.actor); assert.equal(fixture.state().job.handle, ids.handle);
  assert.equal(fixture.state().job.status, "in_progress"); assert.equal(fixture.state().busy, false);
});

test("a retained native retry cannot borrow a replacement task before its first await", async () => {
  const initial = { ...draft, status: "failed" }, fixture = runtime({ state: initial });
  const replacement = { ...initial, handle: `${ids.handle}-replacement` };
  fixture.refs.videoJobRef.current = replacement;
  await fixture.retry();
  assert.deepEqual(fixture.events, []); assert.deepEqual(fixture.toasts, []);
  assert.equal(fixture.state().busy, false); assert.equal(fixture.refs.videoJobRef.current, replacement);
});
test("actual native retry double click dispatches one existing-job write", async () => {
  const gate = deferred(); const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: () => gate.promise });
  const first = fixture.retry(); await flush(); const second = fixture.retry(); await second;
  assert.equal(fixture.events.filter(item => item.url).length, 1);
  gate.resolve({ ok: true, status: 200, payload: { success: true, mode: "supabase", data: { job: { id: ids.job, workspaceId: ids.workspace, status: "queued" } } } });
  await first; assert.equal(fixture.state().job.status, "in_progress");
});
test("actual uncertain native retry acknowledgement is followed by a free read, not another POST", async () => {
  const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: async () => ({ ok: false, status: 502, payload: { success: false } }) });
  await fixture.retry();
  assert.equal(fixture.events.filter(item => item.url).length, 1); assert.equal(fixture.state().job.status, "in_progress");
  assert.equal(fixture.state().job.handle, ids.handle); assert.equal(fixture.state().video, null);
});
test("actual native retry rejects a successful-looking foreign acknowledgement", async () => {
  const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: async () => ({ ok: true, status: 200,
    payload: { success: true, mode: "supabase", data: { job: { id: ids.job, workspaceId: "bbbbbbbb-2222-4222-8222-222222222222", status: "queued" } } } }) });
  await fixture.retry(); assert.equal(fixture.state().job.status, "failed"); assert.equal(fixture.state().video, null);
});
for (const phase of ["preflight", "response", "authorization"]) test(`actual native retry ignores account ABA during ${phase}`, async () => {
  const gate = deferred(); const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: async () => phase === "response" ? gate.promise
    : { ok: true, status: 200, payload: { success: true, mode: "supabase", data: { job: { id: ids.job, workspaceId: ids.workspace, status: "queued" } } } } });
  let count = 0;
  if (phase !== "response") fixture.auth(() => ++count === (phase === "preflight" ? 1 : 2) ? gate.promise : Promise.resolve(true));
  const running = fixture.retry(); await flush(); fixture.abort();
  gate.resolve(phase === "response" ? { ok: true, status: 200, payload: { success: true, data: receipt() } } : true);
  await running;
  assert.equal(fixture.state().job.status, "failed"); assert.equal(fixture.state().video, null);
  if (phase === "preflight") assert.equal(fixture.events.filter(item => item.url).length, 0);
});
test("actual native retry denies a revoked role without showing the previous task", async () => {
  const fixture = runtime({ state: { ...draft, status: "failed" }, nextResponse: async () => ({ ok: false, status: 403, payload: { success: false } }) });
  await fixture.retry(); assert.equal(fixture.state().job, null); assert.equal(fixture.state().video, null);
});

function generationRuntime(nextResponse) {
  const session = new AbortController(), refs = { videoGenerationRevision: { current: 0 },
    videoGenerationAttempt: { current: null }, videoCommandRef: { current: null }, sessionRef: { current: session } };
  const events = [], drafts = [], storage = new Map();
  let busy = null, job = null, video = null, notice = null, actorCurrent = true;
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const bindings = { exports: {}, ...helpers, ...paid, ...refs,
    actorId: ids.actor, workspaceId: ids.workspace, genPrompt: "Synthetic video only", genFormat: "reels", VIDEO_JOB_KEY: "video",
    crypto: webcrypto, URL, Error, fixtureEnv: { VITE_SUPABASE_URL: ids.storageOrigin },
    isSessionAlive: value => actorCurrent && value === session && !session.signal.aborted,
    isGenerationSessionCurrent: async value => actorCurrent && value === session && !session.signal.aborted,
    handoffAccessDenied: value => value?.status === 401 || value?.status === 403,
    paidGenerationAttemptKey: () => "paid-video",
    readBrowserPaidGenerationAttempt: () => paid.readStoredPaidGenerationAttempt(sessionStorage, "paid-video"),
    writeBrowserPaidGenerationAttempt: (_kind, attempt) => paid.writeStoredPaidGenerationAttempt(sessionStorage, "paid-video", attempt),
    clearBrowserPaidGenerationAttempt: () => paid.clearStoredPaidGenerationAttempt(sessionStorage, "paid-video"),
    paidGenerationHeaders: key => ({ "Content-Type": "application/json", "X-Idempotency-Key": key }),
    withWorkspace: url => `${url}?workspaceId=${ids.workspace}`,
    crmFetch: async (url, init) => { if (!init.dispatchGuard()) throw Error("stale"); events.push({ url, init }); return nextResponse(url, init); },
    safeJson: async response => response.payload, refreshGenerationUsage: async () => {}, generationRefusalText: () => "Synthetic refusal",
    setGenBusy(value) { busy = value; }, setGenNotice(value) { notice = value; }, setGenVideo(value) { video = value; }, setVideoJob(value) { job = value; },
    writeStoredVideoJob(value, key, owner) { drafts.push({ value, key, owner }); },
  };
  new Script(generateProgram).runInNewContext(bindings);
  return { generate: bindings.exports.generate, events, drafts, storage, refs,
    state: () => ({ busy, job, video, notice }), abort() { actorCurrent = false; session.abort(); } };
}
test("actual accepted POST persists its handle in the actor/workspace-only draft", async () => {
  const fixture = generationRuntime(async () => ({ ok: true, status: 202, payload: { success: true,
    data: { handle: ids.handle, status: "in_progress", phase: "generation", progress: 30, formatSubstituted: false } } }));
  await fixture.generate();
  assert.equal(fixture.state().job.handle, ids.handle); assert.equal(fixture.state().video, null);
  const stored = fixture.drafts.at(-1); assert.equal(stored.value.handle, ids.handle);
  assert.equal(stored.key, `video::${ids.workspace}::${ids.actor}`);
  assert.equal(fixture.events[0].init.expectedUserId, ids.actor);
});
test("actual accepted uncertain POST preserves its handle and paid idempotency key", async () => {
  const fixture = generationRuntime(async () => ({ ok: false, status: 409, payload: { success: false, accepted: true,
    code: "generated_video_workflow_unconfirmed", data: { handle: ids.handle, status: "in_progress", phase: "validation" } } }));
  await fixture.generate();
  assert.equal(fixture.state().job.handle, ids.handle); assert.equal(fixture.state().job.status, "failed");
  assert.ok(fixture.storage.get("paid-video")); assert.equal(fixture.drafts.at(-1).value.handle, ids.handle);
});
test("actual unknown dispatch without a provider handle retains the paid key for an exact retry", async () => {
  const fixture = generationRuntime(async () => ({ ok: false, status: 409, payload: { success: false, accepted: true,
    code: "generated_video_dispatch_unconfirmed" } }));
  await fixture.generate();
  assert.equal(fixture.state().job, null); assert.equal(fixture.state().video, null);
  const stored = fixture.storage.get("paid-video"); assert.ok(stored);
  const key = fixture.events[0].init.headers["X-Idempotency-Key"];
  assert.equal(JSON.parse(stored).requestKey, key);
  await fixture.generate();
  assert.equal(fixture.events.length, 2); assert.equal(fixture.events[1].init.headers["X-Idempotency-Key"], key);
  assert.equal(fixture.storage.get("paid-video"), stored); assert.equal(fixture.state().video, null);
});

test("actual generation double click does not create two paid requests", async () => {
  const gate = deferred(), fixture = generationRuntime(() => gate.promise);
  const first = fixture.generate(); await flush(); await fixture.generate();
  assert.equal(fixture.events.length, 1);
  gate.resolve({ ok: true, status: 202, payload: { success: true,
    data: { handle: ids.handle, status: "queued", progress: 0, phase: "generation" } } });
  await first; assert.equal(fixture.state().busy, null);
});
test("actual generation response after an account switch cannot restore the accepted handle", async () => {
  const gate = deferred(), fixture = generationRuntime(() => gate.promise);
  const running = fixture.generate(); await flush(); fixture.abort();
  gate.resolve({ ok: true, status: 202, payload: { success: true,
    data: { handle: ids.handle, status: "queued", progress: 0, phase: "generation" } } });
  await running; assert.equal(fixture.state().job, null);
  assert.equal(fixture.drafts.filter(item => item.value !== null).length, 0);
});
test("actual generation permission denial clears only its actor-scoped draft", async () => {
  const fixture = generationRuntime(async () => ({ ok: false, status: 403, payload: { success: false } }));
  await fixture.generate(); assert.equal(fixture.state().job, null); assert.equal(fixture.state().video, null);
  assert.equal(fixture.drafts.at(-1).key, `video::${ids.workspace}::${ids.actor}`);
});

test("isolated HTTP fixture exposes no provider and counts native retry separately", async t => {
  const fixture = createGeneratedVideoBrowserHttpFixture({ video: Buffer.from("test-video"), thumbnail: Buffer.from("test-thumbnail") });
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(403); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { fixture.close(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const call = (url, body, actor = "A") => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, method: payload ? "POST" : "GET", path: url,
      headers: { Authorization: `Bearer fixture-ads-${actor}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, res => {
      const parts = []; res.on("data", chunk => parts.push(chunk)); res.on("end", () => {
        const raw = Buffer.concat(parts).toString("utf8"); resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    }); req.on("error", reject); req.end(payload);
  });
  await call("/__fixture/generated-video", { action: "failed" });
  const poll = `/api/content-studio/video-generation?handle=${ids.handle}&workspaceId=${ids.workspace}`;
  assert.equal((await call(poll)).body.data.status, "failed");
  assert.equal((await call(poll, undefined, "B")).status, 403);
  const retry = `/api/crm/video-processing-jobs/${ids.job}/retry?workspaceId=${ids.workspace}`;
  assert.equal((await call(retry, { workspaceId: ids.workspace, status: "failed" })).status, 200);
  assert.equal((await call(poll)).body.data.status, "in_progress");
  assert.equal(fixture.snapshot().generationPosts, 0); assert.equal(fixture.snapshot().retryPosts, 1); assert.equal(fixture.snapshot().externalCalls, 0);
  assert.equal((await call("/api/content-studio/send-telegram", { test: true })).status, 403);
});

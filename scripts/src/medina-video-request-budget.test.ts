import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { TestContext } from "node:test";
import test from "node:test";
import { fixture, load, W, U, S, RAW } from "./medina-generated-video-workflow.fixture";

type Row = Record<string, any>;
const flush = async () => { for (let n = 0; n < 600; n++) await Promise.resolve(); };
function deferred() { let resolve!: (value?: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }
function clock(t: TestContext) {
  let now = 1000; t.mock.method(performance, "now", () => now); t.mock.timers.enable({ apis: ["setTimeout"] });
  return async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
}
const tracked = <T>(work: Promise<T>) => { let ended = false; return { get ended() { return ended; },
  promise: work.then(value => { ended = true; return value; }) }; };
function timeout(response: Row) {
  assert.equal(response.code, 503); assert.equal(response.body.code, "generated_video_request_deadline");
  assert.equal(response.body.data, undefined); assert.equal(response.writes, 1);
}

for (const action of ["allow", "late denial write"] as const) test(`initial authorization ${action} after deadline cannot proceed or write twice`, async t => {
  const advance = clock(t), gate = deferred();
  const f = await fixture(t, { beforeAuthorize: async (_req: unknown, res: Row) => {
    await gate.promise; if (action === "late denial write") res.status(403).json({ success: false });
  } });
  const pending = tracked(f.request("generate-video")); await flush();
  await advance(49_999); assert.equal(pending.ended, false); await advance(1); assert.equal(pending.ended, true);
  const response = await pending.promise; timeout(response); gate.resolve(); await flush(); timeout(response);
  assert.equal(f.calls.length, 0); assert.equal(f.usageCalls.length, 0); assert.equal(f.counts().providerCreates, 0);
});

test("late fresh-actor lookup cannot progress into admission or quota", async t => {
  const advance = clock(t), gate = deferred();
  const f = await fixture(t, { beforeActorCheck: () => gate.promise });
  const pending = tracked(f.request("generate-video")); await flush(); await advance(50_000);
  const response = await pending.promise; timeout(response); gate.resolve(); await flush();
  assert.equal(f.rpcCounts.has("admit_generated_video_workflow"), false); assert.equal(f.usageCalls.length, 0);
  assert.equal(f.counts().providerCreates, 0); timeout(response);
});

test("late quota reservation leaves its original native reservation and cannot cancel or dispatch", async t => {
  const advance = clock(t), gate = deferred(), f = await fixture(t, { beforeQuota: () => gate.promise });
  const pending = tracked(f.request("generate-video")); await flush(); assert.equal(f.usageCalls.length, 1);
  await advance(50_000); const response = await pending.promise; timeout(response);
  const op = [...f.operations.values()][0]!; assert.equal(op.status, "reserved");
  gate.resolve(); await flush(); assert.equal(op.status, "reserved"); timeout(response);
  assert.equal(f.rpcCounts.has("cancel_generated_video_workflow"), false);
  assert.equal(f.rpcCounts.has("begin_generated_video_dispatch_with_usage"), false); assert.equal(f.counts().providerCreates, 0);
});

test("auth and quota waits consume the dispatch budget; a late committed begin never reaches the provider", async t => {
  const advance = clock(t), auth = deferred(), quota = deferred(), begin = deferred(); let authorized = false;
  const f = await fixture(t, { beforeAuthorize: () => authorized ? undefined : auth.promise,
    beforeQuota: () => quota.promise, beforeRpc: (name: string) => name === "begin_generated_video_dispatch_with_usage" ? begin.promise : undefined });
  const pending = tracked(f.request("generate-video")); await flush();
  await advance(19_000); authorized = true; auth.resolve(); await flush(); assert.equal(f.usageCalls.length, 1);
  await advance(19_000); quota.resolve(); await flush(); assert.equal(f.rpcCounts.get("begin_generated_video_dispatch_with_usage"), 1);
  await advance(11_999); assert.equal(pending.ended, false); await advance(1);
  const response = await pending.promise; timeout(response); assert.equal(f.rpcCounts.get("begin_generated_video_dispatch_with_usage"), 1);
  begin.resolve(); await flush(); assert.equal([...f.operations.values()][0]!.status, "dispatching");
  assert.equal(f.counts().providerCreates, 0); assert.equal(f.completions.length, 0); timeout(response);
});

test("a stalled bucket lookup cannot continue into schema probe or quota after the total deadline", async t => {
  const advance = clock(t), auth = deferred(), bucket = deferred();
  const f = await fixture(t, { beforeAuthorize: () => auth.promise, beforeBucket: () => bucket.promise });
  const pending = tracked(f.request("generate-video")); await flush(); await advance(40_000); auth.resolve(); await flush();
  assert.equal(f.calls.filter(call => call.kind === "bucket").length, 1);
  await advance(10_000); const response = await pending.promise; timeout(response); bucket.resolve(); await flush();
  assert.equal(f.calls.filter(call => call.kind === "bucket").length, 1); assert.equal(f.usageCalls.length, 0);
  assert.equal(f.rpcCounts.has("admit_generated_video_workflow"), false); timeout(response);
});

test("accepted provider job survives a hung completion and same-key replay recovers it without spending again", async t => {
  const advance = clock(t), completion = deferred(), f = await fixture(t, { beforeCompletion: () => completion.promise });
  const pending = tracked(f.request("generate-video")); await flush(); assert.equal(f.counts().providerCreates, 1);
  const op = [...f.operations.values()][0]!; assert.equal(op.status, "rendering"); assert.ok(op.provider_job_id);
  await advance(50_000); const response = await pending.promise; timeout(response);
  completion.resolve(); await flush(); timeout(response); assert.equal(f.completions.length, 1);
  const replay = await f.request("generate-video"); assert.equal(replay.code, 202); assert.ok(replay.body.data.handle);
  assert.equal(f.operations.size, 1); assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1);
});

test("request retirement aborts a provider header wait at the remaining deadline", async t => {
  const advance = clock(t), auth = deferred(), provider = deferred(); let authorized = false, signal!: AbortSignal;
  const f = await fixture(t, { beforeAuthorize: () => authorized ? undefined : auth.promise,
    providerResponse: ({ init }: Row) => { signal = init.signal; return provider.promise; } });
  const pending = tracked(f.request("generate-video")); await flush(); await advance(44_000);
  authorized = true; auth.resolve(); await flush(); assert.equal(f.counts().providerCreates, 1);
  await advance(6000); const response = await pending.promise; timeout(response); assert.equal(signal.aborted, true);
  provider.resolve(new Response(JSON.stringify({ id: "late_job", status: "queued" }))); await flush();
  assert.equal([...f.operations.values()][0]!.status, "dispatching"); assert.equal(f.completions.length, 0);
  const replay = await f.request("generate-video"); assert.equal(replay.code, 409); assert.equal(f.counts().providerCreates, 1);
});

test("late private upload commits only its immutable raw object; free replay queues it without another upload", async t => {
  const advance = clock(t), auth = deferred(), upload = deferred(); let delayAuth = false;
  const f = await fixture(t, { beforeAuthorize: () => delayAuth ? auth.promise : undefined, beforePrivateUpload: () => upload.promise });
  const first = await f.request("generate-video"), handle = first.body.data.handle; assert.equal(first.code, 202);
  delayAuth = true;
  const pending = tracked(f.request("video-generation", { query: { handle } })); await flush(); await advance(40_000);
  delayAuth = false; auth.resolve(); await flush(); assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
  await advance(10_000); const response = await pending.promise; timeout(response);
  assert.equal(f.rpcCounts.has("queue_generated_video_workflow"), false);
  upload.resolve(); await flush(); assert.equal(f.privateFiles.size, 1); assert.equal(f.publicFiles.size, 0);
  assert.equal(f.rpcCounts.has("queue_generated_video_workflow"), false); timeout(response);
  const replay = await f.request("video-generation", { query: { handle } }); assert.equal(replay.code, 200);
  assert.equal([...f.operations.values()][0]!.status, "queued"); assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

for (const phase of ["headers", "body"] as const) test(`request deadline aborts private proof ${phase} without queueing or leaking a file`, async t => {
  const advance = clock(t), auth = deferred(), proof = deferred(); let delayAuth = false, signal!: AbortSignal, reads = 0;
  const f = await fixture(t, { beforeAuthorize: () => delayAuth ? auth.promise : undefined,
    storageResponse: ({ init, bytes, contentType }: Row) => {
      if (!bytes) return new Response(null, { status: 404 });
      signal = init.signal;
      if (phase === "headers") return proof.promise;
      return { status: 200, headers: new Headers({ "content-type": contentType, "content-length": String(bytes.length) }),
        body: { getReader: () => ({ read: () => { reads++; return proof.promise; }, cancel: async () => {} }) } };
    } });
  const first = await f.request("generate-video"), handle = first.body.data.handle;
  delayAuth = true; const pending = tracked(f.request("video-generation", { query: { handle } }));
  await flush(); await advance(44_000); delayAuth = false; auth.resolve(); await flush();
  assert.equal(f.privateFiles.size, 1); await advance(6000); const response = await pending.promise; timeout(response);
  assert.equal(signal.aborted, true); assert.equal(f.rpcCounts.has("queue_generated_video_workflow"), false);
  proof.resolve(phase === "headers" ? new Response(new Uint8Array(RAW), { headers: { "content-type": "video/mp4" } })
    : { done: false, value: RAW }); await flush(); timeout(response);
  assert.equal(f.rpcCounts.has("queue_generated_video_workflow"), false); assert.equal(f.publicFiles.size, 0);
  if (phase === "body") assert.equal(reads, 1);
});

test("a response sent immediately before monotonic expiration is never sent a second time", async t => {
  let now = 1000; t.mock.method(performance, "now", () => now);
  const f = await fixture(t, { onResponse: () => { now += 50_001; } });
  const response = await f.request("generate-video"); assert.equal(response.code, 202); assert.equal(response.writes, 1);
});

for (const phase of ["headers", "body"] as const) test(`provider MP4 ${phase} wait stops at the remaining request budget without input admission`, async t => {
  const advance = clock(t), auth = deferred(), content = deferred(); let delayAuth = false, signal!: AbortSignal;
  const f = await fixture(t, { beforeAuthorize: () => delayAuth ? auth.promise : undefined,
    downloadResponse: ({ init }: Row) => {
      signal = init.signal;
      return phase === "headers" ? content.promise : { ok: true, status: 200, headers: new Headers(),
        body: { getReader: () => ({ read: () => content.promise, cancel: async () => {} }) } };
    } });
  const first = await f.request("generate-video"), handle = first.body.data.handle;
  delayAuth = true; const pending = tracked(f.request("video-generation", { query: { handle } }));
  await flush(); await advance(44_000); delayAuth = false; auth.resolve(); await flush(); assert.equal(f.counts().providerDownloads, 1);
  await advance(6000); const response = await pending.promise; timeout(response); assert.equal(signal.aborted, true);
  content.resolve(phase === "headers" ? new Response(new Uint8Array(RAW)) : { done: false, value: RAW }); await flush();
  assert.equal(f.rpcCounts.has("bind_generated_video_input"), false); assert.equal(f.assets.size, 0); assert.equal(f.jobs.size, 0);
  assert.equal(f.counts().providerCreates, 1); timeout(response);
});

test("late finalization may commit once but cannot disclose its receipt; the next free poll verifies it", async t => {
  const advance = clock(t), auth = deferred(), final = deferred(); let delayAuth = false;
  const f = await fixture(t, { beforeAuthorize: () => delayAuth ? auth.promise : undefined,
    beforeRpc: (name: string) => name === "finalize_generated_video_workflow" ? final.promise : undefined });
  const first = await f.request("generate-video"), handle = first.body.data.handle;
  await f.request("video-generation", { query: { handle } }); f.supplyNativeReceipt();
  delayAuth = true; const pending = tracked(f.request("video-generation", { query: { handle } }));
  await flush(); await advance(40_000); delayAuth = false; auth.resolve(); await flush();
  assert.equal(f.rpcCounts.get("finalize_generated_video_workflow"), 1);
  await advance(10_000); const response = await pending.promise; timeout(response);
  final.resolve(); await flush(); assert.equal([...f.operations.values()][0]!.status, "ready"); timeout(response);
  assert.equal(f.rpcCounts.get("finalize_generated_video_workflow"), 1);
  const recovered = await f.request("video-generation", { query: { handle } });
  assert.equal(recovered.body.data.status, "completed"); assert.equal(recovered.body.data.handle, handle);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
  assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
});

test("actual quota plan lookup cannot reserve after request retirement", async t => {
  const actual = await load("lib/content-studio/usage.ts"), factory = await load("lib/supabase/server.ts");
  const { VideoRequestLifetime } = await load("lib/content-studio/video-request-lifetime.ts");
  const gate = deferred(); let reservations = 0;
  const query: Row = { select: () => query, eq: () => query, order: () => query, limit: () => gate.promise };
  factory.setSupabaseServerClientFactoryForTests(() => ({ from: () => query, rpc: () => { reservations++; throw Error("Late quota write"); } }));
  t.after(() => factory.setSupabaseServerClientFactoryForTests(null));
  const lifetime = new VideoRequestLifetime(); t.after(() => lifetime.close());
  const pending = actual.reserveContentGeneration({ workspaceId: W, staffUserId: S, requestKey: U,
    operation: "generated_video", kind: "video_seconds", units: 4, requestLifetime: lifetime });
  await flush(); lifetime.close(); await assert.rejects(pending);
  gate.resolve({ data: [{ plan: "pro" }], error: null }); await flush(); assert.equal(reservations, 0);
});

for (const transport of ["request aborted", "response closed"] as const) test(`${transport} retires a pending authorization without another response or operation`, async t => {
  const gate = deferred(); let req!: Row, res!: Row;
  const f = await fixture(t, { beforeAuthorize: () => gate.promise, onRequest: (request: Row, response: Row) => { req = request; res = response; } });
  const pending = tracked(f.request("generate-video")); await flush();
  if (transport === "request aborted") { req.aborted = true; req.emit("aborted"); }
  else { res.destroyed = true; res.emit("close"); }
  await flush(); assert.equal(pending.ended, true); const response = await pending.promise;
  assert.equal(response.writes ?? 0, 0); assert.equal(response.body, null);
  gate.resolve(); await flush(); assert.equal(f.counts().providerCreates, 0); assert.equal(f.usageCalls.length, 0);
  assert.equal(req.listenerCount("aborted"), 0); assert.equal(res.listenerCount("close"), 0);
});

test("client disconnect during accepted-job accounting neither refunds nor duplicates the provider job", async t => {
  const gate = deferred(); let res!: Row;
  const f = await fixture(t, { beforeCompletion: () => gate.promise, onRequest: (_req: Row, response: Row) => { res = response; } });
  const pending = tracked(f.request("generate-video")); await flush(); assert.equal(f.counts().providerCreates, 1);
  res.destroyed = true; res.emit("close"); await flush(); assert.equal(pending.ended, true);
  const response = await pending.promise; assert.equal(response.writes ?? 0, 0); assert.equal(response.body, null);
  gate.resolve(); await flush(); const op = [...f.operations.values()][0]!;
  assert.equal(op.status, "rendering"); assert.equal(f.completions[0]!.status, "succeeded");
  const replay = await f.request("generate-video"); assert.equal(replay.code, 202);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

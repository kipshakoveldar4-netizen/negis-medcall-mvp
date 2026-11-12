import assert from "node:assert/strict";
import test from "node:test";
import { fixture, load } from "./medina-generated-video-workflow.fixture";

type Row = Record<string, any>;
const flush = async () => { for (let n = 0; n < 250; n++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; };
const accepted = () => new Response(JSON.stringify({ id: "synthetic_provider_job_090", status: "queued", progress: 0 }));
const generation = await load("lib/content-studio/generation.ts");

function stalledBody() {
  const body = deferred(); let reads = 0, cancels = 0;
  return { body, counts: () => ({ reads, cancels }), response: { ok: true, status: 200,
    headers: { get: () => null }, body: { getReader: () => ({
      read: () => { reads++; return body.promise; }, cancel: async () => { cancels++; },
    }) } } };
}

for (const phase of ["headers", "body"] as const) test(`paid POST ${phase} deadline preserves quarantine, quota and same-key server replay`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred(), stream = stalledBody(); let signal!: AbortSignal;
  const f = await fixture(t, { providerResponse: ({ init }: Row) => {
    signal = init.signal; return phase === "headers" ? headers.promise : stream.response;
  } });
  let ended = false; const pending = f.request("generate-video").then(value => { ended = true; return value; });
  await flush(); assert.equal(f.counts().providerCreates, 1);
  t.mock.timers.tick(15_000); await flush(); assert.equal(ended, true);
  const response = await pending;
  assert.equal(response.code, 409); assert.equal(response.body.accepted, true);
  assert.equal(response.body.code, "generated_video_dispatch_unconfirmed"); assert.equal(signal.aborted, true);
  const op = [...f.operations.values()][0]!;
  assert.equal(op.status, "dispatching"); assert.ok(op.dispatch_id); assert.equal(op.provider_job_id, null);
  assert.deepEqual(f.completions.map(value => [value.status, value.errorCode]), [["unknown", "request_unknown"]]);
  assert.equal(f.calls.some(call => call.name === "cancel_generated_video_workflow"), false);
  assert.equal(f.usageCalls.length, 1); const saved = structuredClone(op);
  if (phase === "headers") headers.resolve(accepted());
  else stream.body.resolve({ done: false, value: Buffer.from(JSON.stringify({ id: "late_provider_job", status: "queued" })) });
  await flush(); assert.deepEqual(op, saved); assert.equal(f.completions.length, 1);
  const replay = await f.request("generate-video"); assert.equal(replay.code, 409); assert.equal(replay.body.accepted, true);
  assert.deepEqual(op, saved); assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
  assert.equal(f.rpcCounts.has("link_generated_video_provider"), false);
  assert.equal(f.jobs.size, 0); assert.equal(f.assets.size, 0); assert.equal(f.privateFiles.size, 0); assert.equal(f.publicFiles.size, 0);
});

for (const phase of ["headers", "body"] as const) test(`free provider ${phase} deadline preserves the original handle and permits only free recovery`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = deferred(), stream = stalledBody(); let stalled = true, signal!: AbortSignal;
  const f = await fixture(t, { providerResponse: ({ phase: requestPhase, init, requestedJob }: Row) => {
    if (requestPhase === "create") return accepted();
    signal = init.signal;
    if (stalled) return phase === "headers" ? headers.promise : stream.response;
    return new Response(JSON.stringify({ id: requestedJob, status: "completed", progress: 100 }));
  } });
  const original = await f.request("generate-video"), handle = original.body.data.handle;
  assert.equal(original.code, 202); const op = [...f.operations.values()][0]!, before = structuredClone(op);
  let ended = false; const pending = f.request("video-generation", { query: { handle } }).then(value => { ended = true; return value; });
  await flush(); assert.equal(f.counts().providerReads, 1);
  t.mock.timers.tick(15_000); await flush(); assert.equal(ended, true);
  const response = await pending;
  assert.equal(response.code, 502); assert.equal(response.body.accepted, true); assert.equal(response.body.data.handle, handle);
  assert.notEqual(response.body.data.status, "failed"); assert.equal(signal.aborted, true); assert.deepEqual(op, before);
  assert.equal(f.rpcCounts.has("ack_generated_video_provider_failure"), false);
  assert.equal(f.completions.length, 1); assert.equal(f.completions[0]!.status, "succeeded");
  if (phase === "headers") headers.resolve(new Response(JSON.stringify({ id: op.provider_job_id, status: "failed" })));
  else stream.body.resolve({ done: false, value: Buffer.from(JSON.stringify({ id: op.provider_job_id, status: "failed" })) });
  await flush(); assert.deepEqual(op, before); assert.equal(f.rpcCounts.has("ack_generated_video_provider_failure"), false);
  stalled = false;
  const recovered = await f.request("video-generation", { query: { handle } });
  assert.equal(recovered.code, 200); assert.equal(recovered.body.data.handle, handle); assert.equal(op.status, "queued");
  assert.equal(f.jobs.size, 1); assert.equal(f.privateFiles.size, 1); assert.equal(f.publicFiles.size, 0);
  const replay = await f.request("generate-video"); assert.equal(replay.code, 202); assert.equal(replay.body.data.handle, handle);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1); assert.equal(f.completions.length, 1);
});

for (const access of ["revoked", "account_replaced"] as const) test(`unknown paid result after ${access} exposes no handle or new dispatch`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { providerResponse: () => new Promise<never>(() => {}) });
  let ended = false; const pending = f.request("generate-video").then(value => { ended = true; return value; });
  await flush(); assert.equal(f.counts().providerCreates, 1);
  if (access === "revoked") f.member.status = "inactive"; else f.changeActor();
  t.mock.timers.tick(15_000); await flush(); assert.equal(ended, true);
  const response = await pending; assert.equal(response.code, 403); assert.equal(response.body.data?.handle, undefined);
  assert.equal([...f.operations.values()][0]!.status, "dispatching"); assert.equal(f.completions[0]!.status, "unknown");
  assert.equal(f.calls.some(call => call.name === "cancel_generated_video_workflow"), false);
  assert.equal((await f.request("generate-video")).code, 403); assert.equal(f.counts().providerCreates, 1);
});

test("a real HTTP refusal is still distinct from an unknown transport outcome", async t => {
  const f = await fixture(t, { providerFailure: 429 }), response = await f.request("generate-video");
  assert.equal(response.code, 429); assert.equal(response.body.accepted, undefined);
  assert.equal([...f.operations.values()][0]!.status, "cancelled");
  assert.equal(f.completions[0]!.status, "failed"); assert.equal(f.completions[0]!.errorCode, "provider_unavailable");
  assert.equal(f.calls.filter(call => call.name === "cancel_generated_video_workflow").length, 1);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

test("a thrown HTTP-shaped transport error cannot refund an unconfirmed paid dispatch", async t => {
  const f = await fixture(t, { providerResponse: () => { throw new generation.GenerationProviderError(429, "private transport diagnostic"); } });
  const response = await f.request("generate-video");
  assert.equal(response.code, 409); assert.equal(response.body.code, "generated_video_dispatch_unconfirmed");
  assert.equal(response.body.accepted, true); assert.equal([...f.operations.values()][0]!.status, "dispatching");
  assert.equal(f.completions[0]!.status, "unknown"); assert.equal(f.completions[0]!.errorCode, "request_unknown");
  assert.equal(f.calls.some(call => call.name === "cancel_generated_video_workflow"), false);
  await f.request("generate-video"); assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

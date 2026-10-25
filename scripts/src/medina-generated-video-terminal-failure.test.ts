import assert from "node:assert/strict";
import test from "node:test";
import { terminalFixture } from "./medina-generated-video-terminal-failure.fixture";
import { actor, load, RAW } from "./medina-generated-video-workflow.fixture";

const workflow = await load("lib/crm/generated-video-workflow.ts");
const handles = await load("lib/content-studio/generated-video-handle.ts");
type Row = Record<string, any>;
const operation = (f: { operations: Map<string, Row> }) => [...f.operations.values()][0]!;
const poll = (f: Awaited<ReturnType<typeof terminalFixture>>, handle: string) => f.request("video-generation", { query: { handle } });

test("092: authenticated terminal provider failure frees only native capacity and retains the paid request identity", async t => {
  const f = await terminalFixture(t), accepted = await f.request("generate-video"), before = structuredClone(operation(f));
  const response = await poll(f, accepted.body.data.handle), op = operation(f);
  assert.equal(response.code, 200); assert.equal(response.body.data.status, "failed"); assert.equal(response.body.data.phase, "generation");
  assert.equal(response.body.data.handle, accepted.body.data.handle); assert.equal(response.body.data.validationJobId, undefined);
  assert.equal(response.body.data.creativeUrl, undefined); assert.equal(op.status, "cancelled");
  for (const field of ["provider_job_id", "generation_key", "request_digest", "key_digest", "dispatch_id", "job_id", "asset_id"]) assert.equal(op[field], before[field], field);
  assert.equal(op.provider_failure_receipt.kind, "provider-terminal-failure-v1"); assert.equal(op.provider_failure_receipt.providerJobId, op.provider_job_id);
  assert.equal(f.assets.size, 0); assert.equal(f.jobs.size, 0); assert.equal(f.privateFiles.size, 0); assert.equal(f.publicFiles.size, 0);
  assert.equal(f.usageCalls.length, 1); assert.equal(f.completions.length, 1); assert.equal(f.completions[0]!.status, "succeeded", "No paid usage refund is inferred from provider failure");
});

test("092: failed GET and POST replay return the same failed handle without quota, provider, worker or Storage work", async t => {
  const f = await terminalFixture(t), first = await f.request("generate-video"), handle = first.body.data.handle;
  assert.equal((await poll(f, handle)).body.data.status, "failed");
  const counts = f.counts(), proof = structuredClone(operation(f).provider_failure_receipt), calls = f.calls.length;
  delete process.env.OPENAI_API_KEY; delete process.env.CONTENT_STUDIO_VIDEO_MODEL; process.env.VIDEO_OPTIMIZATION_ENABLED = "false";
  for (const replay of [await poll(f, handle), await f.request("generate-video"), await poll(f, handle)]) {
    assert.equal(replay.code, 200); assert.equal(replay.body.data.handle, handle); assert.equal(replay.body.data.status, "failed");
    assert.equal(replay.body.data.phase, "generation"); assert.equal(replay.body.data.creativeUrl, undefined);
  }
  assert.deepEqual(f.counts(), counts); assert.equal(f.acknowledgements(), 1); assert.equal(f.usageCalls.length, 1);
  assert.deepEqual(operation(f).provider_failure_receipt, proof);
  assert.equal(f.calls.slice(calls).some(call => call.kind === "bucket" || call.kind === "fetch" || call.kind === "upload"), false);
  assert.equal((await f.request("generate-video", { body: { prompt: "Changed synthetic intent" } })).code, 409);
  assert.equal(f.counts().providerCreates, 1);
});

test("092: terminal status can release an unbound slot even while the native worker is disabled", async t => {
  const f = await terminalFixture(t), first = await f.request("generate-video");
  process.env.VIDEO_OPTIMIZATION_ENABLED = "false"; f.options.bucketError = true;
  const before = f.calls.length, response = await poll(f, first.body.data.handle);
  assert.equal(response.code, 200); assert.equal(response.body.data.phase, "generation"); assert.equal(response.body.data.status, "failed");
  assert.equal(operation(f).status, "cancelled"); assert.equal(f.calls.slice(before).some(call => call.kind === "bucket" || call.kind === "upload"), false);
  assert.equal(f.counts().providerDownloads, 0); assert.equal(f.usageCalls.length, 1);
});

for (const lostAcks of [1, 2]) test(`092: ${lostAcks} lost terminal ACKs reconcile the exact old request, never another paid render`, async t => {
  const f = await terminalFixture(t, { lostAcks }), first = await f.request("generate-video"), handle = first.body.data.handle;
  const response = await poll(f, handle);
  assert.equal(response.code, lostAcks === 1 ? 200 : 503); assert.equal(operation(f).status, "cancelled");
  const calls = f.calls.filter(call => call.name === "ack_generated_video_provider_failure");
  assert.equal(calls.length, 2); assert.deepEqual(calls[0]!.args, calls[1]!.args);
  const proof = structuredClone(operation(f).provider_failure_receipt);
  assert.equal((await poll(f, handle)).body.data.status, "failed");
  assert.equal((await f.request("generate-video")).body.data.handle, handle);
  assert.deepEqual(operation(f).provider_failure_receipt, proof); assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

test("092: unknown terminal ACK keeps the rendering reservation until an actual acknowledgement can be read", async t => {
  const f = await terminalFixture(t, { noAckCommit: true }), first = await f.request("generate-video");
  assert.equal((await poll(f, first.body.data.handle)).code, 503); assert.equal(operation(f).status, "rendering");
  assert.equal(operation(f).provider_failure_receipt, undefined); assert.equal(f.acknowledgements(), 2);
  assert.equal((await f.request("generate-video")).body.data.handle, first.body.data.handle);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

for (const providerStatus of ["queued", "in_progress", "unknown-terminal", null]) test(`092: provider status ${String(providerStatus)} is not a terminal failure ACK`, async t => {
  const f = await terminalFixture(t, { providerStatus }), first = await f.request("generate-video");
  const response = await poll(f, first.body.data.handle);
  assert.equal(response.code, 200); assert.notEqual(response.body.data.status, "failed");
  assert.equal(operation(f).status, "rendering"); assert.equal(f.acknowledgements(), 0);
});

for (const options of [{ providerReadError: true }, { providerReadHttpError: 500 }, { providerReadHttpError: 404 }]) {
  test(`092: ${JSON.stringify(options)} is uncertainty, not permission to free input capacity`, async t => {
    const f = await terminalFixture(t, options), first = await f.request("generate-video");
    assert.ok((await poll(f, first.body.data.handle)).code >= 400); assert.equal(operation(f).status, "rendering");
    assert.equal(f.acknowledgements(), 0); assert.equal(f.assets.size, 0); assert.equal(f.jobs.size, 0);
    await f.request("generate-video"); assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1);
  });
}

test("092: a failed response naming another provider job cannot acknowledge the signed handle", async t => {
  const f = await terminalFixture(t, { responseProviderId: "another-synthetic-provider" }), first = await f.request("generate-video");
  assert.equal((await poll(f, first.body.data.handle)).code, 409); assert.equal(f.acknowledgements(), 0);
  assert.equal(operation(f).status, "rendering");
});

for (const change of ["role", "session"]) test(`092: ${change} changes after provider GET refuse before the acknowledgement`, async t => {
  const f = await terminalFixture(t, { afterProviderGet: (state: Row) => change === "role" ? state.member.role = "lead_manager" : state.changeActor() });
  const first = await f.request("generate-video"), response = await poll(f, first.body.data.handle);
  assert.equal(response.code, 403); assert.equal(f.acknowledgements(), 0); assert.equal(operation(f).status, "rendering");
  assert.equal(response.body.data?.handle, undefined);
});

for (const revoke of ["before", "after"]) test(`092: role withdrawal ${revoke} ACK cannot expose a stale successful acknowledgement`, async t => {
  const f = await terminalFixture(t, revoke === "before" ? { beforeAck: (state: Row) => { state.member.status = "inactive"; } } : { revokeAfterAck: true });
  const first = await f.request("generate-video"), response = await poll(f, first.body.data.handle);
  assert.equal(response.code, 403); assert.equal(operation(f).status, revoke === "before" ? "rendering" : "cancelled");
  assert.equal(response.body.data?.handle, undefined); assert.equal(f.counts().providerCreates, 1);
});

test("092: input binding which wins the ACK race cannot be cancelled or free its native reservation", async t => {
  const f = await terminalFixture(t, { beforeAck: async (state: Row) => {
    await workflow.receiveGeneratedVideoInput(workflow.generatedVideoWorkflowConfig(), actor, operation({ operations: state.operations }).generation_key, RAW);
  } });
  const first = await f.request("generate-video"), response = await poll(f, first.body.data.handle);
  assert.equal(response.code, 409); assert.equal(operation(f).status, "queued"); assert.equal(operation(f).provider_failure_receipt, undefined);
  assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.privateFiles.size, 1); assert.equal(f.counts().providerCreates, 1);
});

test("092: native validation failure remains a validation failure and does not release an already bound raw object", async t => {
  const f = await terminalFixture(t, { providerStatus: "completed" }), first = await f.request("generate-video");
  await poll(f, first.body.data.handle); [...f.jobs.values()][0]!.status = "failed";
  const response = await poll(f, first.body.data.handle);
  assert.equal(response.body.data.status, "failed"); assert.equal(response.body.data.phase, "validation"); assert.ok(response.body.data.validationJobId);
  assert.equal(operation(f).status, "queued"); assert.equal(f.acknowledgements(), 0); assert.equal(f.privateFiles.size, 1);
});

test("092: a ready native receipt cannot be overwritten by terminal provider failure", async t => {
  const f = await terminalFixture(t, { providerStatus: "completed" }), first = await f.request("generate-video");
  await poll(f, first.body.data.handle); f.supplyNativeReceipt(); await poll(f, first.body.data.handle);
  const before = structuredClone(operation(f));
  await assert.rejects(workflow.ackGeneratedVideoProviderFailure(workflow.generatedVideoWorkflowConfig(), actor, before.generation_key,
    { id: before.provider_job_id, status: "failed" }), { code: "generated_video_request_conflict" });
  assert.deepEqual(operation(f), before);
});

for (const mutation of ["wrong-provider", "missing-proof", "wrong-key", "wrong-phase", "extra-field", "wrong-digest", "invalid-time"] as const) {
  test(`092: ${mutation} in a terminal receipt is not a confirmed generation failure`, async t => {
    const f = await terminalFixture(t, { mutateAckReceipt: (value: Row) => {
      const op = value.operation;
      if (mutation === "wrong-provider") op.provider_failure_receipt.providerJobId = "other";
      else if (mutation === "missing-proof") op.provider_failure_receipt = null;
      else if (mutation === "wrong-key") op.provider_failure_receipt.generationKey = "other";
      else if (mutation === "wrong-phase") op.status = "rendering";
      else if (mutation === "wrong-digest") op.provider_failure_receipt.requestDigest = "a".repeat(64);
      else if (mutation === "invalid-time") op.provider_failure_receipt.acknowledgedAt = "not-a-time";
      else op.provider_failure_receipt.extra = "unverified";
    } });
    const first = await f.request("generate-video"), response = await poll(f, first.body.data.handle);
    assert.equal(response.code, 503); assert.notEqual(response.body.data?.status, "failed");
  });
}

test("092: caller-supplied nonterminal status or invalid provider id cannot reach the terminal ACK RPC", async t => {
  const f = await terminalFixture(t); await f.request("generate-video");
  const config = workflow.generatedVideoWorkflowConfig(), op = operation(f);
  for (const job of [{ id: op.provider_job_id, status: "completed" }, { id: "", status: "failed" },
    { id: " wrong ", status: "failed" }, { id: "wrong\nprovider", status: "failed" }, { id: "a".repeat(513), status: "failed" }]) {
    await assert.rejects(workflow.ackGeneratedVideoProviderFailure(config, actor, op.generation_key, job), { code: "generated_video_request_invalid" });
  }
  assert.equal(f.acknowledgements(), 0); assert.equal(op.status, "rendering");
});

test("092: a valid handle for another workspace cannot reach the provider or ACK", async t => {
  const f = await terminalFixture(t), first = await f.request("generate-video"), op = operation(f);
  const wrong = handles.signGeneratedVideoJobHandle({ workspaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    generationKey: op.generation_key, providerJobId: op.provider_job_id }, process.env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal((await poll(f, wrong)).code, 404); assert.equal(f.acknowledgements(), 0); assert.equal(f.counts().providerReads, 0);
  assert.ok(first.body.data.handle);
});

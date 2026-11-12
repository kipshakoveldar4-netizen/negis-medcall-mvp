import assert from "node:assert/strict";
import test from "node:test";
import { fixture, load, W, B, origin, secret, RAW, OUTPUT, hash, rawBucket } from "./medina-generated-video-workflow.fixture";

type Row = Record<string, any>;
const generation = await load("lib/content-studio/generation.ts");
const workflow = await load("lib/crm/generated-video-workflow.ts");

async function queued(t: import("node:test").TestContext, options: Row = {}) {
  const f = await fixture(t, options), first = await f.request("generate-video");
  assert.equal(first.code, 202, JSON.stringify(first.body));
  const handle = first.body.data.handle;
  assert.equal((await f.request("video-generation", { query: { handle } })).body.success, true);
  return { ...f, handle };
}

test("native video replay across day/month/year preserves one asset, job, private object and paid render", async t => {
  const f = await queued(t), promotion = f.supplyNativeReceipt();
  const first = await f.request("video-generation", { query: { handle: f.handle } });
  assert.equal(first.body.data.status, "completed");
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 31, 23, 59, 59) });
  for (const at of [Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 1), Date.UTC(2036, 0, 1)]) {
    t.mock.timers.setTime(at);
    const replay = await f.request("video-generation", { query: { handle: f.handle } });
    assert.deepEqual(replay.body.data, first.body.data);
  }
  assert.equal(f.operations.size, 1); assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.privateFiles.size, 1);
  assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1); assert.equal(f.counts().providerDownloads, 1);
  assert.equal(promotion.asset.generated_sha256, hash(OUTPUT));
  assert.equal(promotion.asset.generated_video_job_id, promotion.job.id);
});

test("concurrent native polls promote one asset without uploading raw bytes publicly or rendering again", async t => {
  const f = await queued(t); f.supplyNativeReceipt();
  const results = await Promise.all([f.request("video-generation", { query: { handle: f.handle } }),
    f.request("video-generation", { query: { handle: f.handle } })]);
  for (const response of results) assert.equal(response.body.data.status, "completed", JSON.stringify(response.body));
  assert.equal(results[0]!.body.data.assetId, results[1]!.body.data.assetId);
  assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.operations.size, 1);
  assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1);
  assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
});

test("concurrent POST requests with one paid key never dispatch a second provider render", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request("generate-video"), f.request("generate-video")]);
  assert.ok(results.some(result => result.code === 202));
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.operations.size, 1);
  assert.equal(f.completions.filter(row => row.status === "succeeded").length, 1);
  assert.equal(f.calls.filter(call => call.kind === "upload").length, 0);
});

test("native worker queue receives a durable immutable SHA binding and does not trust mutable caller metadata", async t => {
  const f = await queued(t), op = [...f.operations.values()][0]!, job = f.jobs.get(op.job_id)!, asset = f.assets.get(op.asset_id)!;
  assert.equal(job.metadata.inputSha256, hash(RAW)); assert.equal(op.input_sha256, hash(RAW));
  assert.equal(job.raw_path, op.raw_path); assert.equal(job.raw_bucket, rawBucket);
  assert.equal(asset.generated_key, null); assert.equal(asset.public_url, null);
  const changed = Buffer.from(RAW); changed[changed.length - 1]! ^= 1;
  await assert.rejects(workflow.receiveGeneratedVideoInput(workflow.generatedVideoWorkflowConfig(),
    { workspaceId: W, staffUserId: op.created_by_staff_user_id, userId: op.created_by_auth_user_id }, op.generation_key, changed), /generated_video_input_conflict/);
  assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.jobs.size, 1);
});

for (const [label, patch] of [
  ["foreign tenant", { workspace_id: B }], ["foreign id", { id: B }], ["wrong filename", { file_name: "other.mp4" }],
  ["foreign public URL", { public_url: "https://foreign.invalid/video.mp4" }], ["wrong MIME", { mime_type: "video/webm" }],
  ["wrong file type", { file_type: "image" }], ["wrong size", { file_size: OUTPUT.length + 1 }],
  ["wrong path", { storage_path: W + "/generated/unvalidated.mp4" }], ["archived", { status: "archived" }],
] as Array<[string, Row]>) test("native replay refuses " + label + " without rewrites or false ready", async t => {
  const f = await queued(t), { asset } = f.supplyNativeReceipt(); Object.assign(asset, patch);
  const before = structuredClone(asset);
  const response = await f.request("video-generation", { query: { handle: f.handle } });
  assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
  assert.deepEqual(asset, before); assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
  assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
});

test("native video cannot grandfather an old public row with missing native proof after metadata replacement", async t => {
  const f = await queued(t), { asset } = f.supplyNativeReceipt();
  asset.metadata = { metaStatus: "ready" };
  const response = await f.request("video-generation", { query: { handle: f.handle } });
  assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
  assert.equal(asset.generated_key, null); assert.equal(f.counts().providerCreates, 1); assert.equal(f.publicFiles.size, 2);
});

for (const collision of ["one legacy row", "duplicate legacy rows", "legacy wrong bytes", "foreign legacy row"]) {
  test(collision + " requires explicit native migration rather than public-row reuse", async t => {
    const f = await fixture(t, { legacyCollision: true });
    const handle = generation.signVideoJobHandle({ workspaceId: W, jobId: "synthetic_legacy_provider_090", secret });
    const original = { id: B, workspace_id: W, generated_key: "v1:synthetic_legacy_provider_090", public_url: origin + "/legacy.mp4",
      status: "uploaded", metadata: { kind: "generated-video", uploadMode: "ai-generated" }, label: collision };
    if (collision === "foreign legacy row") original.workspace_id = B;
    f.assets.set(B, original);
    if (collision === "duplicate legacy rows") f.assets.set("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      { ...original, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    if (collision === "legacy wrong bytes") f.publicFiles.set("legacy.mp4", Buffer.from("synthetic wrong legacy bytes"));
    const originals = structuredClone([...f.assets]); const originalFiles = [...f.publicFiles].map(([key, bytes]) => [key, bytes.toString("hex")]);
    const response = await f.request("video-generation", { query: { handle } });
    assert.equal(response.code, 409); assert.notEqual(response.body.data?.status, "completed");
    assert.deepEqual(f.assets.get(B), original); assert.equal(f.calls.some(call => call.kind === "upload"), false);
    assert.deepEqual([...f.assets], originals); assert.deepEqual([...f.publicFiles].map(([key, bytes]) => [key, bytes.toString("hex")]), originalFiles);
    assert.equal(f.counts().providerCreates, 0); assert.equal(f.usageCalls.length, 0);
  });
}

test("legacy signed jobs without an old public identity may enter native validation without a new render", async t => {
  const f = await fixture(t), providerId = "synthetic_legacy_provider_090";
  const handle = generation.signVideoJobHandle({ workspaceId: W, jobId: providerId, secret });
  const response = await f.request("video-generation", { query: { handle } });
  assert.equal(response.body.success, true, JSON.stringify(response.body));
  assert.equal(response.body.data.status, "in_progress"); assert.equal(response.body.data.phase, "validation");
  assert.equal(f.counts().providerCreates, 0); assert.equal(f.usageCalls.length, 0);
  assert.equal(f.operations.size, 1); assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.publicFiles.size, 0);
  const op = [...f.operations.values()][0]!; assert.equal(op.generation_key, providerId); assert.equal(op.request_digest, null);
});

for (const code of ["42703", "PGRST204", "XX000"]) test("missing schema/read failure " + code + " cannot mean absent", async t => {
  const f = await fixture(t, { rpcFailure: { name: "read_generated_video_workflow", count: 99, code } });
  const response = await f.request("generate-video"); assert.ok(response.code >= 400);
  assert.equal(f.counts().providerCreates, 0); assert.equal(f.usageCalls.length, 0); assert.equal(f.operations.size, 0);
  assert.equal(f.calls.some(call => call.kind === "upload"), false);
});

test("lost finalization ACK reconciles the exact committed native receipt without any provider read", async t => {
  const f = await queued(t, { lostAck: { name: "finalize_generated_video_workflow", count: 1 } }); f.supplyNativeReceipt();
  const before = f.counts();
  const response = await f.request("video-generation", { query: { handle: f.handle } });
  assert.equal(response.body.data.status, "completed"); assert.equal(f.rpcCounts.get("finalize_generated_video_workflow"), 2);
  assert.deepEqual(f.counts(), before); assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1);
});

test("two lost finalization ACKs remain uncertain, but a free replay returns the same committed asset", async t => {
  const f = await queued(t, { lostAck: { name: "finalize_generated_video_workflow", count: 2 } }); f.supplyNativeReceipt();
  const refused = await f.request("video-generation", { query: { handle: f.handle } });
  assert.ok(refused.code >= 400); assert.notEqual(refused.body.data?.status, "completed");
  const committed = [...f.assets.values()][0]!;
  const recovered = await f.request("video-generation", { query: { handle: f.handle } });
  assert.equal(recovered.body.data.status, "completed"); assert.equal(recovered.body.data.assetId, committed.id);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.counts().providerDownloads, 1); assert.equal(f.usageCalls.length, 1);
});

test("an uncertain pre-input bind ACK never duplicates the private asset or validation job", async t => {
  const f = await fixture(t, { lostAck: { name: "bind_generated_video_input", count: 1 } });
  const first = await f.request("generate-video"), handle = first.body.data.handle;
  const pending = await f.request("video-generation", { query: { handle } });
  assert.equal(pending.body.success, true); assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.privateFiles.size, 1);
  const binds = f.calls.filter(call => call.kind === "rpc" && call.name === "bind_generated_video_input");
  assert.equal(binds.length, 2); assert.deepEqual(binds[0]!.args, binds[1]!.args);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fixture, W, OUTPUT, rawBucket, outputBucket } from "./medina-generated-video-workflow.fixture";
type Row = Record<string, any>;

test("generated native video: one paid render stays private until the exact native promotion receipt is verified", async t => {
  const f = await fixture(t), first = await f.request("generate-video");
  assert.equal(first.code, 202); assert.equal(first.body.success, true); assert.match(first.body.data.handle, /^g2\./);
  assert.deepEqual(f.counts(), { providerCreates: 1, providerReads: 0, providerDownloads: 0 });
  assert.equal(f.usageCalls.length, 1); assert.equal(f.operations.size, 1); assert.equal(f.assets.size, 0);
  assert.ok(f.events.indexOf("admit_generated_video_workflow") < f.events.indexOf("usage:reserve"));
  assert.ok(f.events.indexOf("begin_generated_video_dispatch_with_usage") < f.events.indexOf("provider:create"));
  const handle = first.body.data.handle;
  const pending = await f.request("video-generation", { query: { handle } });
  assert.equal(pending.body.success, true); assert.equal(pending.body.data.status, "in_progress");
  assert.equal(pending.body.data.phase, "validation"); assert.equal(pending.body.data.creativeUrl, undefined);
  assert.equal(f.privateFiles.size, 1); assert.equal(f.publicFiles.size, 0); assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1);
  const raw = [...f.assets.values()][0]!;
  assert.equal(raw.public_url, null); assert.equal(raw.generated_key, null); assert.equal(raw.storage_bucket, rawBucket);
  assert.equal(raw.metadata.kind, "generated-video-pending");
  const promoted = f.supplyNativeReceipt();
  const ready = await f.request("video-generation", { query: { handle } });
  assert.equal(ready.code, 200); assert.equal(ready.body.data.status, "completed");
  assert.equal(ready.body.data.nativeValidated, true); assert.equal(ready.body.data.validationJobId, promoted.job.id);
  assert.equal(ready.body.data.assetId, promoted.asset.id); assert.equal(ready.body.data.fileSize, OUTPUT.length);
  assert.equal(ready.body.data.creativeUrl, promoted.receipt.public_url); assert.equal(ready.body.data.thumbnailUrl, promoted.receipt.thumbnail_public_url);
  assert.equal(promoted.asset.generated_key, `v1:v2:${f.requestKey}`);
  assert.deepEqual(f.counts(), { providerCreates: 1, providerReads: 1, providerDownloads: 1 });
  assert.equal(f.calls.filter(call => call.kind === "upload" && call.bucket === outputBucket).length, 0);
});

for (const option of ["publicRaw", "bucketError", "capacityDenied"] as const) {
  test(`generated native video: ${option} refuses before quota and paid provider dispatch`, async t => {
    const f = await fixture(t, { [option]: true }), response = await f.request("generate-video");
    assert.ok(response.code >= 400); assert.equal(f.usageCalls.length, 0); assert.equal(f.counts().providerCreates, 0);
    assert.equal(f.calls.some(call => call.kind === "upload"), false);
  });
}

test("generated native video: a quota refusal cancels only the pre-dispatch reservation", async t => {
  const f = await fixture(t, { quotaDenied: true }), response = await f.request("generate-video");
  assert.equal(response.code, 429); assert.equal(f.counts().providerCreates, 0);
  assert.equal([...f.operations.values()][0]?.status, "cancelled"); assert.equal(f.assets.size, 0);
});

test("generated native video: exact accepted POST replay returns one handle without another reservation or provider render", async t => {
  const f = await fixture(t), first = await f.request("generate-video");
  assert.equal(first.code, 202);
  delete process.env.OPENAI_API_KEY; delete process.env.CONTENT_STUDIO_VIDEO_MODEL;
  const retry = await f.request("generate-video");
  assert.equal(retry.body.success, true); assert.equal(retry.body.data.handle, first.body.data.handle);
  assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1); assert.equal(f.operations.size, 1);
});

test("generated native video: changed intent on the same paid key conflicts without another quota or render", async t => {
  const f = await fixture(t); assert.equal((await f.request("generate-video")).code, 202);
  const changed = await f.request("generate-video", { body: { prompt: "Different synthetic intent" } });
  assert.equal(changed.code, 409); assert.equal(f.usageCalls.length, 1); assert.equal(f.counts().providerCreates, 1);
});

for (const rpcName of ["begin_generated_video_dispatch_with_usage", "link_generated_video_provider"] as const) {
  test(`generated native video: one lost ${rpcName} ACK is retried with exactly the same nonce and no second paid call`, async t => {
    const f = await fixture(t, { lostAck: { name: rpcName, count: 1 } }), first = await f.request("generate-video");
    assert.equal(first.code, 202); assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
    const calls = f.calls.filter(call => call.kind === "rpc" && call.name === rpcName);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0]!.args, calls[1]!.args);
    const retry = await f.request("generate-video"); assert.equal(retry.body.data.handle, first.body.data.handle);
    assert.equal(f.counts().providerCreates, 1);
  });
}

test("generated native video: an unknown provider outcome remains quarantined and retry never spends again", async t => {
  const f = await fixture(t, { providerUnknown: true }), first = await f.request("generate-video");
  assert.ok(first.code >= 400); assert.equal([...f.operations.values()][0]!.status, "dispatching");
  const retry = await f.request("generate-video"); assert.ok(retry.code >= 400);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1);
  assert.equal(f.completions.at(-1)?.status, "unknown");
});

for (const options of [{ lostPrivateAck: true }, { lostAck: { name: "queue_generated_video_workflow", count: 1 } }]) {
  test(`generated native video: private/queue lost ACK ${JSON.stringify(options)} resumes one object, asset and job`, async t => {
    const f = await fixture(t, options), first = await f.request("generate-video"), handle = first.body.data.handle;
    const pending = await f.request("video-generation", { query: { handle } }); assert.equal(pending.body.success, true);
    const retry = await f.request("video-generation", { query: { handle } }); assert.equal(retry.body.success, true);
    assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.privateFiles.size, 1); assert.equal(f.publicFiles.size, 0);
    assert.equal(f.counts().providerCreates, 1); assert.equal(f.counts().providerDownloads, 1); assert.equal(f.usageCalls.length, 1);
    assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
  });
}

for (const option of ["corruptPrivate", "noPrivateCommit", "revokeAfterPrivateUpload", "revokeAfterPrivateProof"] as const) {
  test(`generated native video: ${option} cannot queue raw input or expose a completed asset`, async t => {
    const f = await fixture(t, { [option]: true }), first = await f.request("generate-video");
    const response = await f.request("video-generation", { query: { handle: first.body.data.handle } });
    assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
    assert.equal([...f.jobs.values()][0]?.status, "awaiting_upload", "Denied queue RPC cannot change the durable job state");
    assert.equal(f.publicFiles.size, 0); assert.equal(f.counts().providerCreates, 1);
  });
}

for (const option of ["revokeAfterQuota", "revokeAfterProviderCreate"] as const) {
  test(`generated native video: ${option} is denied at the next fresh actor boundary`, async t => {
    const f = await fixture(t, { [option]: true }), response = await f.request("generate-video");
    assert.ok(response.code >= 400); assert.equal(response.body.data?.handle, undefined);
    assert.equal(f.counts().providerCreates, option === "revokeAfterQuota" ? 0 : 1);
    assert.equal(f.privateFiles.size, 0); assert.equal(f.publicFiles.size, 0);
  });
}

for (const corruption of ["missing-receipt", "changed-receipt", "public-bytes", "thumbnail-missing", "role-revoked"] as const) {
  test(`generated native video: native/public proof ${corruption} never announces readiness`, async t => {
    const options: Row = {}, f = await fixture(t, options), first = await f.request("generate-video"), handle = first.body.data.handle;
    assert.equal((await f.request("video-generation", { query: { handle } })).body.success, true);
    const { job, receipt } = f.supplyNativeReceipt();
    if (corruption === "missing-receipt") job.promotion_receipt = null;
    if (corruption === "changed-receipt") receipt.storage_path = `${W}/unvalidated.mp4`;
    if (corruption === "public-bytes") options.corruptPublic = true;
    if (corruption === "thumbnail-missing") f.publicFiles.delete(receipt.thumbnail_path);
    if (corruption === "role-revoked") options.revokeAfterPublicProof = true;
    const response = await f.request("video-generation", { query: { handle } });
    assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
    assert.equal([...f.operations.values()][0]!.status, "queued"); assert.equal(f.counts().providerCreates, 1);
    assert.equal([...f.assets.values()][0]!.generated_key, null, "A refused final RPC cannot freeze a ready identity");
  });
}

test("generated native video: verified GET replays for free with the provider disabled and no download", async t => {
  const f = await fixture(t), first = await f.request("generate-video"), handle = first.body.data.handle;
  await f.request("video-generation", { query: { handle } }); const promoted = f.supplyNativeReceipt();
  assert.equal((await f.request("video-generation", { query: { handle } })).body.data.status, "completed");
  delete process.env.OPENAI_API_KEY; delete process.env.CONTENT_STUDIO_VIDEO_MODEL; process.env.VIDEO_OPTIMIZATION_ENABLED = "false";
  const before = f.counts(), ready = await f.request("video-generation", { query: { handle } });
  assert.equal(ready.code, 200); assert.equal(ready.body.data.creativeUrl, promoted.receipt.public_url);
  assert.deepEqual(f.counts(), before); assert.equal(f.usageCalls.length, 1);
  assert.equal(f.assets.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.calls.filter(call => call.kind === "upload").length, 1);
});

test("generated native video: malformed and cross-workspace handles stop before provider or Storage calls", async t => {
  const f = await fixture(t), first = await f.request("generate-video");
  const before = f.counts(), calls = f.calls.length;
  for (const handle of ["invalid-handle", `${first.body.data.handle}x`, first.body.data.handle.replace(/^g2\./, "g3.")]) {
    assert.equal((await f.request("video-generation", { query: { handle } })).code, 404);
  }
  assert.deepEqual(f.counts(), before); assert.equal(f.calls.length, calls);
});

for (const fault of ["wrong-type", "wrong-length", "oversize", "short-body", "no-body", "redirect", "empty-chunk"] as const) {
  test(`generated native video: bounded private proof rejects ${fault} before queueing`, async t => {
    let cancelled = false;
    const f = await fixture(t, { storageResponse({ bytes, contentType }: { bytes?: Buffer; contentType: string }) {
      if (!bytes) return new Response(null, { status: 404 });
      const headers = new Headers({ "content-type": fault === "wrong-type" ? "text/html" : contentType });
      if (fault === "wrong-length") headers.set("content-length", String(bytes.length + 1));
      const body = fault === "oversize" ? Buffer.concat([bytes, Buffer.from([1])])
        : fault === "short-body" ? bytes.subarray(0, bytes.length - 1) : bytes;
      let read = false;
      return { status: 200, redirected: fault === "redirect", headers, body: fault === "no-body" ? null : {
        getReader() { return { read: async () => { if (read) return { done: true }; read = true;
          return { done: false, value: fault === "empty-chunk" ? new Uint8Array() : new Uint8Array(body) }; },
          cancel: async () => { cancelled = true; } }; },
      } };
    } });
    const first = await f.request("generate-video"), response = await f.request("video-generation", { query: { handle: first.body.data.handle } });
    assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
    assert.equal(f.publicFiles.size, 0); assert.equal([...f.jobs.values()][0]!.status, "awaiting_upload");
    assert.equal(f.rpcCounts.get("queue_generated_video_workflow") ?? 0, 0);
    if (fault !== "no-body") assert.equal(cancelled, true);
  });
}

for (const phase of ["headers", "body"] as const) test(`generated native video: stalled private ${phase} has a bounded deadline and no hung cleanup`, { timeout: 3000 }, async t => {
  const nativeTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    nativeTimer(callback, delay === 10000 || delay === 20000 ? 10 : delay, ...args));
  let cancelled = false, signal: AbortSignal | undefined;
  const f = await fixture(t, { storageResponse({ bytes, init }: { bytes?: Buffer; init: { signal: AbortSignal } }) {
    if (!bytes) return new Response(null, { status: 404 });
    signal = init.signal;
    if (phase === "headers") return new Promise<never>(() => {});
    return { status: 200, redirected: false, headers: new Headers({ "content-type": "video/mp4" }),
      body: { getReader() { return { read: () => new Promise<never>(() => {}),
        cancel: () => { cancelled = true; return new Promise<never>(() => {}); } }; } } };
  } });
  const first = await f.request("generate-video"), response = await f.request("video-generation", { query: { handle: first.body.data.handle } });
  assert.ok(response.code >= 400); assert.equal(signal?.aborted, true);
  if (phase === "body") assert.equal(cancelled, true);
  assert.equal(f.rpcCounts.get("queue_generated_video_workflow") ?? 0, 0); assert.equal(f.publicFiles.size, 0);
});

test("generated native video: unknown private 503 is not absence and cannot authorize another upload", async t => {
  const f = await fixture(t, { storageResponse: () => new Response(null, { status: 503 }) });
  const first = await f.request("generate-video"), response = await f.request("video-generation", { query: { handle: first.body.data.handle } });
  assert.ok(response.code >= 400); assert.equal(f.calls.filter(call => call.kind === "upload").length, 0);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1); assert.equal(f.publicFiles.size, 0);
});

for (const [field, value] of [["workspace_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["generation_key", "v2:foreign"],
  ["key_digest", "0".repeat(64)], ["asset_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["job_id", "not-a-job"],
  ["file_name", "other.mp4"], ["request_digest", null], ["reserved_until", "not-a-date"]] as const) {
  test(`generated native video: malformed admission ${field} stops before quota or provider dispatch`, async t => {
    const f = await fixture(t, { transformRpc(name: string, data: Row) {
      return name === "admit_generated_video_workflow" ? { ...data, operation: { ...data.operation, [field]: value } } : data;
    } });
    const response = await f.request("generate-video"); assert.ok(response.code >= 400);
    assert.equal(f.usageCalls.length, 0); assert.equal(f.counts().providerCreates, 0); assert.equal(f.calls.some(call => call.kind === "upload"), false);
  });
}

for (const [section, field, value] of [["operation", "input_sha256", "0".repeat(64)], ["operation", "raw_path", "foreign/raw.mp4"],
  ["job", "workspace_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["job", "raw_size", 99], ["asset", "generated_key", "v1:forged"],
  ["asset", "public_url", "https://foreign.invalid/raw.mp4"], ["asset", "metadata", { kind: "generated-video", uploadMode: "ai-generated" }]] as const) {
  test(`generated native video: malformed bound ${section}.${field} cannot upload or queue`, async t => {
    const f = await fixture(t, { transformRpc(name: string, data: Row) {
      return name === "bind_generated_video_input" ? { ...data, [section]: { ...data[section], [field]: value } } : data;
    } });
    const accepted = await f.request("generate-video"), response = await f.request("video-generation", { query: { handle: accepted.body.data.handle } });
    assert.ok(response.code >= 400); assert.notEqual(response.body.data?.status, "completed");
    assert.equal(f.calls.filter(call => call.kind === "upload").length, 0); assert.equal(f.rpcCounts.get("queue_generated_video_workflow") ?? 0, 0);
    assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageCalls.length, 1); assert.equal(f.publicFiles.size, 0);
  });
}

test("generated native video: changed authenticated actor after provider binding cannot receive the original signed handle", async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { beforeRpc(name: string) { if (name === "link_generated_video_provider") f.changeActor(); } });
  const response = await f.request("generate-video");
  assert.equal(response.code, 403); assert.equal(response.body.data?.handle, undefined); assert.equal(f.counts().providerCreates, 1);
  assert.equal(f.calls.some(call => call.kind === "upload"), false); assert.equal(f.publicFiles.size, 0);
});

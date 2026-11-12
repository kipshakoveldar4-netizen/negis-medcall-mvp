import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./medina-generated-video-workflow.fixture";

test("lost quota ACK recovers one original reservation and one paid dispatch on an unchanged retry", async t => {
  let quotaReplies = 0;
  const f = await fixture(t, { afterQuota: () => { if (++quotaReplies === 1) throw Error("Synthetic lost committed quota ACK"); } });
  const first = await f.request("generate-video"); assert.equal(first.code, 503);
  assert.equal(f.usageReceipts.size, 1); assert.equal(f.counts().providerCreates, 0);
  assert.equal([...f.operations.values()][0]!.status, "reserved", "An uncertain quota ACK cannot cancel the recoverable native reservation");
  const receipt = [...f.usageReceipts.values()][0]!;
  const second = await f.request("generate-video"); assert.equal(second.code, 202, JSON.stringify(second.body));
  assert.equal(f.usageReceipts.size, 1); assert.equal([...f.usageReceipts.values()][0]!.id, receipt.id);
  assert.equal(f.counts().providerCreates, 1);
  const replay = await f.request("generate-video"); assert.equal(replay.body.data.handle, second.body.data.handle);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.operations.size, 1);
});

test("a concurrent unchanged retry may finish while the first quota ACK is still pending, with one receipt and render", async t => {
  let release!: () => void, count = 0;
  const gate = new Promise<void>(done => { release = done; });
  const f = await fixture(t, { afterQuota: () => ++count === 1 ? gate : undefined });
  const pending = f.request("generate-video");
  for (let n = 0; n < 500; n++) await Promise.resolve();
  assert.equal(f.usageReceipts.size, 1); assert.equal(f.counts().providerCreates, 0);
  const recovered = await f.request("generate-video"); assert.equal(recovered.code, 202);
  release(); const first = await pending; assert.equal(first.body.data.handle, recovered.body.data.handle);
  assert.equal(f.counts().providerCreates, 1); assert.equal(f.usageReceipts.size, 1); assert.equal(f.completions.length, 1);
});

for (const [field, value] of [["units",8],["model","another-model"],["provider","other"],["operation","generated_image"],
  ["kind","image"],["staffUserId",null],["status","unknown"],["status","failed"],["status","succeeded"],
  ["createdAt","2000-01-01T00:00:00.000Z"]] as const) {
  test(`same-key recovery refuses mismatched ${field}=${value} without cancelling, refunding or rendering`, async t => {
    let count = 0;
    const f = await fixture(t, { afterQuota: () => { if (++count === 1) throw Error("Synthetic lost quota ACK"); } });
    assert.equal((await f.request("generate-video")).code, 503);
    const receipt = [...f.usageReceipts.values()][0]!; receipt[field] = value;
    const before = { ...receipt }, response = await f.request("generate-video");
    assert.ok(response.code >= 400); assert.equal(response.body.accepted, true);
    assert.equal(f.counts().providerCreates, 0); assert.equal(f.completions.length, 0); assert.equal(f.usageReceipts.size, 1);
    assert.deepEqual(receipt, before); assert.equal(f.rpcCounts.has("cancel_generated_video_workflow"), false);
  });
}

for (const change of ["entitlement", "expired", "revoked"] as const) test(`quota replay cannot revive ${change}`, async t => {
  let count = 0; const options: Record<string, any> = { afterQuota: () => { if (++count === 1) throw Error("Synthetic lost quota ACK"); } };
  const f = await fixture(t, options); assert.equal((await f.request("generate-video")).code, 503);
  if (change === "entitlement") options.quotaLimit = 0;
  if (change === "expired") [...f.operations.values()][0]!.reserved_until = "2000-01-01T00:00:00.000Z";
  if (change === "revoked") f.member.status = "inactive";
  assert.ok((await f.request("generate-video")).code >= 400);
  assert.equal(f.counts().providerCreates, 0); assert.equal(f.usageReceipts.size, 1); assert.equal(f.completions.length, 0);
});

test("missing 106 refuses before provider dispatch rather than silently calling the old unbound RPC", async t => {
  const f = await fixture(t, { rpcFailure: { name: "begin_generated_video_dispatch_with_usage", count: 9, code: "PGRST202" } });
  const response = await f.request("generate-video"); assert.equal(response.code, 503); assert.equal(response.body.accepted, true);
  assert.equal(f.rpcCounts.get("begin_generated_video_dispatch_with_usage"), 2);
  assert.equal(f.rpcCounts.has("begin_generated_video_dispatch"), false); assert.equal(f.counts().providerCreates, 0);
});

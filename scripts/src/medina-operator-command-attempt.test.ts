import assert from "node:assert/strict";
import test from "node:test";

const storageModule = await import(new URL("../../artifacts/negis/src/lib/operatorCommandAttempt.ts", import.meta.url).href);
const { parseOperatorCommandResult } = await import(new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href);
const { restoreOperatorCommand, persistOperatorCommand, clearOperatorCommand } = storageModule;
const actorId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const commandId = "abcdefab-abcd-4abc-8abc-abcdefabcdef", targetId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const attempt = { actorId, workspaceId, channel: "proposal" as const, commandId, action: "propose" as const, targetId };
const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
test("operator command storage preserves only an opaque original descriptor across reload", () => {
  const s = memory(); assert.deepEqual(restoreOperatorCommand(s, actorId, workspaceId, "proposal"), { attempt: null, error: "" });
  assert.equal(persistOperatorCommand(s, attempt), true);
  const restored = restoreOperatorCommand(s, actorId, workspaceId, "proposal");
  assert.deepEqual(restored.attempt, attempt); assert.notEqual(restored.attempt, attempt);
  assert.equal(restored.error, ""); assert.doesNotMatch([...s.values.values()][0], /brief|price|phone|token|payload|email/);
  assert.ok(restored.attempt); restored.attempt.targetId = requestId; assert.deepEqual(restoreOperatorCommand(s, actorId, workspaceId, "proposal").attempt, attempt);
});
test("unresolved storage is never overwritten or cleared by another command", () => {
  const s = memory(); assert.equal(persistOperatorCommand(s, attempt), true);
  assert.equal(persistOperatorCommand(s, { ...attempt, commandId: requestId }), false);
  assert.equal(clearOperatorCommand(s, { ...attempt, commandId: requestId }), false);
  assert.deepEqual(restoreOperatorCommand(s, actorId, workspaceId, "proposal").attempt, attempt);
  assert.equal(clearOperatorCommand(s, attempt), true); assert.equal(s.values.size, 0);
});
test("actor/workspace/channel isolation cannot adopt another original descriptor", () => {
  const s = memory(); persistOperatorCommand(s, attempt);
  for (const [actor, workspace, channel] of [[requestId, workspaceId, "proposal"], [actorId, requestId, "proposal"], [actorId, workspaceId, "transition"], [actorId, null, "transition"]] as const)
    assert.deepEqual(restoreOperatorCommand(s, actor, workspace, channel), { attempt: null, error: "" });
});
test("corrupt, oversized, private or scope-mismatched stored data remains quarantined", () => {
  for (const raw of ["{broken", "x".repeat(2049), JSON.stringify({ ...attempt, clinicBrief: "Private" }),
    JSON.stringify({ ...attempt, actorId: requestId }), JSON.stringify({ ...attempt, commandId: "wrong" }),
    JSON.stringify({ ...attempt, action: "accept" }), JSON.stringify({ ...attempt, channel: "transition", action: ["end"] })]) {
    const s = memory(); persistOperatorCommand(s, attempt); const key = [...s.values.keys()][0]; s.values.set(key, raw);
    const read = restoreOperatorCommand(s, actorId, workspaceId, "proposal");
    assert.equal(read.attempt, null); assert.ok(read.error); assert.equal(s.values.get(key), raw);
    assert.equal(persistOperatorCommand(s, attempt), false); assert.equal(clearOperatorCommand(s, attempt), false);
  }
});
test("unavailable or lying storage refuses admission and acknowledgement", () => {
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  for (const s of [null, denied]) {
    assert.ok(restoreOperatorCommand(s, actorId, workspaceId, "proposal").error);
    assert.equal(persistOperatorCommand(s, attempt), false); assert.equal(clearOperatorCommand(s, attempt), false);
  }
  assert.equal(persistOperatorCommand({ getItem: () => null, setItem() {}, removeItem() {} }, attempt), false);
});
const committed = { state: "committed", commandId, action: "propose", targetId, requestId, statusAtCommit: "requested", committedAt: "2030-01-07T05:00:00.123456+00:00" };
const parse = (patch: Record<string, unknown> = {}) => parseOperatorCommandResult({ ...committed, ...patch }, commandId, attempt);
test("command result accepts only matching historical outcomes and strips extra private fields", () => {
  assert.deepEqual(parse({ privatePhone: "not-returned" }), committed);
  assert.deepEqual(parse({ commandId: commandId.toUpperCase() }), committed);
  const closed = { state: "abandoned", commandId, action: "propose", targetId, closedAt: "2030-01-07T05:00:00Z" };
  assert.deepEqual(parseOperatorCommandResult(closed, commandId, attempt), closed);
  assert.deepEqual(parseOperatorCommandResult({ state: "unconfirmed", commandId }, commandId, attempt), { state: "unconfirmed", commandId });
});
test("partial, foreign and inconsistent success cannot release a command", () => {
  for (const name of Object.keys(committed)) assert.equal(parse({ [name]: undefined }), null, name);
  for (const patch of [{ commandId: requestId }, { action: "end" }, { targetId: requestId }, { statusAtCommit: "accepted" },
    { committedAt: "2030-02-30T05:00:00Z" }, { committedAt: "2030-01-07T05:00:00" }, { state: "abandoned" }, { requestId: "wrong" },
    { state: "abandoned", closedAt: "2030-01-07T05:00:00Z" }, { closedAt: "2030-01-07T05:00:00Z" }, { state: "unconfirmed" }]) assert.equal(parse(patch), null);
  assert.equal(parseOperatorCommandResult({ ...committed, action: "accept", statusAtCommit: "accepted" }, commandId), null,
    "A transition must refer to its exact target request, not another result");
  assert.equal(parseOperatorCommandResult({ state: "unconfirmed", commandId: requestId }, commandId), null);
});

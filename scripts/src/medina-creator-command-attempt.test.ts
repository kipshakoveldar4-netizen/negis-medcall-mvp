import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Script } from "node:vm";
const contracts = await import(new URL("../../lib/crm/creator-job-contracts.ts", import.meta.url).href);
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = await readFile(new URL("../../artifacts/negis/src/lib/creatorCommandAttempt.ts", import.meta.url), "utf8");
const exports: Record<string, any> = {};
new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
  exports, BigInt, Date, Error, JSON, require(name: string) { assert.equal(name, "../../../../lib/crm/creator-job-contracts"); return contracts; },
});
const { restoreCreatorCommand, persistCreatorCommand, clearCreatorCommand, parseCreatorWrite, creatorFeeToMinor, creatorDueAt } =
  Object.fromEntries(Object.entries(exports).map(([name, fn]) => [name, (...args: unknown[]) => structuredClone(fn(...args))]));
const actorId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333", targetId = "44444444-4444-4444-8444-444444444444";
const attempt = { actorId, workspaceId, requestId, action: "create" as const, targetId };
const terms = { creatorId: targetId, title: "QA", brief: "Private brief", rightsTerms: "Explicit rights", feeMinor: "120001", currency: "KZT", dueAt: "2030-01-01T00:00:00.000Z" };
function memory() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }
test("creator journal restores only exact metadata, never the brief, terms, amount or URLs", () => {
  const s = memory(); assert.deepEqual(restoreCreatorCommand(s, actorId, workspaceId), { attempt: null, error: "" });
  assert.equal(persistCreatorCommand(s, attempt), true); const result = restoreCreatorCommand(s, actorId, workspaceId);
  assert.deepEqual(result.attempt, attempt); assert.notEqual(result.attempt, attempt);
  assert.doesNotMatch([...s.values.values()][0], /brief|terms|fee|price|links|payload|token|email/);
  assert.equal(clearCreatorCommand(s, { ...attempt, requestId: targetId }), false);
  assert.equal(persistCreatorCommand(s, { ...attempt, requestId: targetId }), false);
  assert.equal(clearCreatorCommand(s, attempt), true); assert.equal(s.values.size, 0);
});
test("actor, company and independent creator scopes cannot adopt another pending action", () => {
  const s = memory(); persistCreatorCommand(s, attempt);
  for (const [actor, company] of [[targetId, workspaceId], [actorId, targetId], [actorId, null]] as const)
    assert.deepEqual(restoreCreatorCommand(s, actor, company), { attempt: null, error: "" });
  assert.equal(persistCreatorCommand(s, { ...attempt, workspaceId: null, action: "accept" }), true);
  assert.equal(restoreCreatorCommand(s, actorId, null).attempt?.action, "accept");
});
test("corrupt, oversized, extra/private, invalid-side and scope-mismatched descriptors are quarantined", () => {
  for (const value of ["{bad", "x".repeat(2049), JSON.stringify({ ...attempt, brief: "Private" }),
    JSON.stringify({ ...attempt, actorId: targetId }), JSON.stringify({ ...attempt, action: "accept" }),
    JSON.stringify({ ...attempt, requestId: "bad" }), JSON.stringify({ ...attempt, workspaceId: null, action: "create" })]) {
    const s = memory(); persistCreatorCommand(s, attempt); const key = [...s.values.keys()][0]; s.values.set(key, value);
    assert.equal(restoreCreatorCommand(s, actorId, workspaceId).attempt, null); assert.ok(restoreCreatorCommand(s, actorId, workspaceId).error);
    assert.equal(persistCreatorCommand(s, attempt), false); assert.equal(clearCreatorCommand(s, attempt), false); assert.equal(s.values.get(key), value);
  }
});
test("unavailable, throwing and lying storage cannot admit or acknowledge a command", () => {
  const denied = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  for (const s of [null, denied]) { assert.ok(restoreCreatorCommand(s, actorId, workspaceId).error); assert.equal(persistCreatorCommand(s, attempt), false); assert.equal(clearCreatorCommand(s, attempt), false); }
  assert.equal(persistCreatorCommand({ getItem: () => null, setItem() {}, removeItem() {} }, attempt), false);
});
test("write drafts are closed, side-specific and explicitly validated before key admission", () => {
  assert.deepEqual(parseCreatorWrite({ action: "create", terms }, workspaceId), { action: "create", terms });
  const write = { jobId: targetId, revision: requestId, action: "accept" as const, payload: { termsRevision: requestId } };
  assert.deepEqual(parseCreatorWrite(write, null), write);
  for (const input of [{ action: "create", terms }, { ...write, actorId }, { ...write, requestId }, { ...write, revision: null }, { ...write, payload: { paid: true } }]) assert.equal(parseCreatorWrite(input, null), null);
  assert.equal(parseCreatorWrite(write, workspaceId), null);
  assert.equal(parseCreatorWrite({ action: "create", terms: { ...terms, feeMinor: "0" } }, workspaceId), null);
});
test("creator fees preserve every minor unit up to bigint maximum, without floating point", () => {
  assert.equal(creatorFeeToMinor("1200,01"), "120001"); assert.equal(creatorFeeToMinor("9007199254740993.01"), "900719925474099301");
  assert.equal(creatorFeeToMinor("92233720368547758.07"), "9223372036854775807");
  for (const input of ["0", "-1", "1.001", "1e3", "Infinity", "92233720368547758.08", "9".repeat(19), "", "1,2.3"]) assert.equal(creatorFeeToMinor(input), null);
});
test("deadline conversion is explicit local-device time and rejects rolled dates and hidden offsets", () => {
  const value = creatorDueAt("2030-01-07T10:15"); assert.ok(value);
  const parsed = new Date(value); assert.equal(parsed.getFullYear(), 2030); assert.equal(parsed.getMonth(), 0); assert.equal(parsed.getDate(), 7); assert.equal(parsed.getHours(), 10); assert.equal(parsed.getMinutes(), 15);
  for (const invalid of ["2030-02-30T10:15", "2030-13-01T10:15", "2030-01-01T24:15", "2030-01-01", "2030-01-01T10:00Z", "0000-01-01T10:00", "2030-01-01T10:00+05:00"]) assert.equal(creatorDueAt(invalid), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const contracts = await import(new URL("../../lib/crm/contributor-contracts.ts", import.meta.url).href);
const { resolveCrmRoute } = await import(new URL("../../lib/crm/authorization.ts", import.meta.url).href);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = await readFile(new URL("../../lib/crm/contributors.ts", import.meta.url), "utf8");
function fixture() {
  let actor = id(1), owner: { userId: string } | null = null, failure: unknown = null;
  let dbReads = 0;
  const calls: { name: string; args?: unknown }[] = [];
  const row = { id: id(2), auth_user_id: id(1), revision: id(3), display_name: "QA Blogger", portfolio_urls: [], partner_status: "pending", creator_status: "pending", secret: "never-return" };
  let result: unknown = row;
  const db = {
    from(name: string) {
      assert.equal(name, "growth_contributor_profiles"); calls.push({ name });
      const q: Record<string, unknown> = {};
      q.select = (fields: string) => { assert.ok(!fields.includes("auth_user_id")); return q; };
      q.eq = (key: string, value: unknown) => { assert.equal(key, "auth_user_id"); assert.equal(value, actor); return q; };
      q.maybeSingle = async () => ({ data: result, error: failure });
      q.order = () => q;
      q.range = async () => ({ data: result ? [result] : [], error: failure });
      return q;
    },
    rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: result, error: failure }; },
  };
  const module = { exports: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>> };
  const require = (name: string) => {
    if (name === "../auth/server") return { requireAuthenticatedUser: async () => { if (!actor) throw Error("unauthorized"); return { id: actor }; }, isUuidValue: (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) };
    if (name === "../auth/platform") return { readPlatformOwner: () => owner };
    if (name === "../supabase/server") return { getSupabaseServerClient: () => { dbReads++; return db; } };
    if (name === "./contributor-contracts") return contracts;
    throw Error("Unexpected dependency " + name);
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require, Error, Object, Array, Number, String });
  async function invoke(name = "handleContributorAccount", method = "GET", body?: unknown, query: unknown = {}) {
    const response = { statusCode: 0, payload: null as unknown, headers: {} as Record<string, unknown>,
      setHeader(k: string, v: unknown) { this.headers[k] = v; }, status(v: number) { this.statusCode = v; return this; }, json(v: unknown) { this.payload = JSON.parse(JSON.stringify(v)); return this; } };
    await module.exports[name]({ method, body, query }, response);
    return response;
  }
  return { invoke, calls, row, get dbReads() { return dbReads; }, setActor: (v: string) => { actor = v; },
    setOwner: (v: typeof owner) => { owner = v; }, setFailure: (v: unknown) => { failure = v; }, setResult: (v: unknown) => { result = v; } };
}
test("contributor router methods are explicit identity bootstrap and platform-only", () => {
  // Resolve returns a route descriptor; registry remains deny-by-default.
  const self = resolveCrmRoute(["contributor-account"]);
  const admin = resolveCrmRoute(["platform-contributors"]);
  assert.equal(self?.authorization.kind, "bootstrap");
  assert.equal(admin?.authorization.kind, "platform");
  assert.deepEqual(self?.authorization.methods, ["GET", "POST"]);
});
test("self read is verified-actor scoped, no-store and strips private SQL fields", async () => {
  const f = fixture(), r = await f.invoke();
  assert.equal(r.statusCode, 200); assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(r.payload).includes("never-return"), false);
  assert.equal(JSON.stringify(r.payload).includes("auth_user_id"), false);
  f.setActor(""); await assert.rejects(() => f.invoke(), /unauthorized/);
});
test("application never trusts body identity or grants self approval", async () => {
  const f = fixture();
  const body = { displayName: "QA", partner: true, creator: true, portfolioUrls: [] };
  assert.equal((await f.invoke("handleContributorAccount", "POST", { ...body, auth_user_id: id(99) })).statusCode, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.invoke("handleContributorAccount", "POST", body)).statusCode, 200);
  assert.equal(JSON.stringify(f.calls[0].args).includes(id(1)), true);
  assert.equal(f.calls[0].name, "apply_growth_contributor");
});
test("ordinary authenticated clinic owner cannot reach cross-tenant review storage", async () => {
  const f = fixture();
  const r = await f.invoke("handlePlatformContributors", "GET");
  assert.equal(r.statusCode, 404); assert.equal(f.dbReads, 0);
});
test("platform review passes verified owner plus exact revision, rejects status/financial injection", async () => {
  const f = fixture(); f.setOwner({ userId: id(90) });
  const body = { id: id(2), revision: id(3), role: "creator", action: "approve" };
  assert.equal((await f.invoke("handlePlatformContributors", "PATCH", { ...body, firstCommissionBps: 5000 })).statusCode, 400);
  assert.equal((await f.invoke("handlePlatformContributors", "PATCH", { ...body, role: ["creator"] })).statusCode, 400);
  await f.invoke("handlePlatformContributors", "PATCH", body);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)), { p_id: id(2), p_revision: id(3), p_owner: id(90), p_role: "creator", p_action: "approve" });
});
test("conflict, unavailable schema and invalid DTO fail closed without SQL detail", async () => {
  const f = fixture(); f.setOwner({ userId: id(90) });
  f.setFailure({ code: "P1052", message: "private SQL" });
  const conflict = await f.invoke("handlePlatformContributors", "PATCH", { id: id(2), revision: id(3), role: "creator", action: "approve" });
  assert.equal(conflict.statusCode, 409); assert.equal(JSON.stringify(conflict.payload).includes("private SQL"), false);
  f.setFailure({ code: "42P01", message: "private SQL" }); assert.equal((await f.invoke()).statusCode, 503);
  f.setFailure(null); f.setResult({ ...f.row, partner_status: "active" }); assert.equal((await f.invoke()).statusCode, 503);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticSiteConsent, type ConsentResolver, type SyntheticNotice } from "./site-consent-fixture";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const { createSiteIntakeHandler } = await load("lib/crm/site-intake-handler.ts") as {
  createSiteIntakeHandler(deps: { env(): NodeJS.ProcessEnv; resolveConsent?: ConsentResolver;
    verify?(): Promise<boolean>; save?(site: string, key: string, inquiry: unknown, receipt: SyntheticNotice): Promise<string | null> }): Handler;
};
const { resolveSiteConsentReceipt } = await load("lib/crm/site-intake-handler.ts") as {
  resolveSiteConsentReceipt(version: string, resolve: ConsentResolver): SyntheticNotice | null;
};
const { setSupabaseServerClientFactoryForTests } = await load("lib/supabase/server.ts") as {
  setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
};
const registry = createRequire(import.meta.url)(path.join(root, "lib/site/consent-registry.cjs")) as {
  resolveSiteConsent: ConsentResolver;
};
const resolveConsent = syntheticSiteConsent(["receipt-fixture"]);
const notice = resolveConsent("receipt-fixture")!;
const env = { MEDINA_SITE_INTAKE_ENABLED: "true", MEDINA_SITE_ORIGIN: "https://consent.fixture.invalid",
  MEDINA_SITE_INTAKE_KEY: "consent-fixture", MEDINA_SITE_TURNSTILE_SECRET: "SYNTHETIC-NOT-A-SECRET" };
const inquiry = { name: "Synthetic visitor", phone: "+77000000001", business: "Synthetic business",
  service: "call-center", pagePath: "/ru/", consentVersion: notice.version, consent: true };
const body = { requestKey: "00000000-0000-4000-8000-000000000123", inquiry, challengeToken: "fake-only" };
async function call(handler: Handler, payload: unknown = body) {
  let status = 0, response: unknown;
  const res = { setHeader() {}, status(value: number) { status = value; return res; }, json(value: unknown) { response = value; } };
  await handler({ method: "POST", headers: { origin: env.MEDINA_SITE_ORIGIN, "content-type": "application/json" }, body: payload }, res);
  return { status, response };
}

test("server receipt is an immutable, exact registry copy, not a visitor field", async () => {
  const mutable = { ...notice };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verified = new Promise<void>(resolve => { started = resolve; });
  let snapshot: SyntheticNotice | undefined;
  const handler = createSiteIntakeHandler({ env: () => env, resolveConsent: () => mutable,
    verify: () => { started(); return gate.then(() => true); }, save: async (_site, _key, accepted, receipt) => {
      assert.deepEqual(accepted, inquiry); snapshot = receipt; return null;
    } });
  const pending = call(handler);
  await verified;
  mutable.text = "Changed after resolution"; mutable.policyRevision = "Changed after resolution";
  release();
  assert.deepEqual(await pending, { status: 200, response: { success: true } });
  assert.deepEqual(snapshot, notice); assert.ok(Object.isFrozen(snapshot)); assert.notEqual(snapshot, mutable);
});

for (const field of ["text", "purpose", "policyRevision", "policyUrl", "sha256", "version"] as const) {
  test(`corrupt resolved ${field} fails before challenge, SDK or save`, async () => {
    let calls = 0;
    const handler = createSiteIntakeHandler({ env: () => env,
      resolveConsent: () => ({ ...notice, [field]: field === "sha256" ? "0".repeat(64) : "tampered" }),
      verify: async () => { calls++; return true; }, save: async () => { calls++; return null; } });
    assert.deepEqual(await call(handler), { status: 400, response: { success: false, code: "invalid_inquiry" } });
    assert.equal(calls, 0);
  });
}

for (const field of ["text", "purpose", "policyRevision", "policyUrl", "sha256", "consentReceipt", "p_consent_receipt", "notice_snapshot", "workspaceId"]) {
  test(`visitor cannot inject ${field} into inquiry or envelope`, async () => {
    let calls = 0;
    const handler = createSiteIntakeHandler({ env: () => env, resolveConsent,
      verify: async () => { calls++; return true; }, save: async () => { calls++; return null; } });
    for (const value of [{ ...body, [field]: notice }, { ...body, inquiry: { ...inquiry, [field]: notice } }]) {
      assert.equal((await call(handler, value)).status, 400);
    }
    assert.equal(calls, 0);
  });
}

test("default registry stays empty despite site labels, enable flags or alleged approval env", async () => {
  let calls = 0;
  const handler = createSiteIntakeHandler({ env: () => ({ ...env, MEDINA_SITE_CONSENT_APPROVED: "true",
    MEDINA_SITE_CONSENT_VERSION: notice.version, MEDINA_SITE_CONSENT_TEXT: notice.text }),
    verify: async () => { calls++; return true; }, save: async () => { calls++; return null; } });
  assert.equal(registry.resolveSiteConsent(notice.version), null);
  assert.equal((await call(handler)).status, 400); assert.equal(calls, 0);
});

test("unknown version and resolver failure never obtain a snapshot or verify", async () => {
  for (const resolve of [(() => null), (() => { throw new Error("private registry diagnostic"); })]) {
    let calls = 0;
    const handler = createSiteIntakeHandler({ env: () => env, resolveConsent: resolve,
      verify: async () => { calls++; return true; } });
    assert.deepEqual(await call(handler), { status: 400, response: { success: false, code: "invalid_inquiry" } });
    assert.equal(calls, 0);
  }
});

test("runtime limits fail closed even for a self-consistent oversized injected notice", () => {
  for (const [field, limit] of [["text", 32768], ["purpose", 4096], ["policyRevision", 200], ["policyUrl", 2048]] as const) {
    const value = { ...notice, [field]: field === "policyUrl" ? `https://fixture.invalid/${"x".repeat(limit)}` : "x".repeat(limit + 1) };
    value.sha256 = createHash("sha256").update(JSON.stringify([
      value.version, value.text, value.purpose, value.policyRevision, value.policyUrl,
    ])).digest("hex");
    assert.equal(resolveSiteConsentReceipt(notice.version, () => value), null);
  }
});

test("production persistence calls only the audited wrapper; missing schema has no 058 fallback", async t => {
  let attempts = 0;
  t.after(() => setSupabaseServerClientFactoryForTests(null));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No external calls allowed"); });
  setSupabaseServerClientFactoryForTests(() => ({ async rpc(name: string, args: unknown) {
    attempts++;
    assert.equal(name, "accept_crm_site_inquiry_with_consent");
    assert.deepEqual(args, { p_site_key: env.MEDINA_SITE_INTAKE_KEY, p_request_key: body.requestKey,
      p_inquiry: inquiry, p_consent_receipt: notice });
    return { data: null, error: { message: "Could not find function; sensitive internal schema details" } };
  } }));
  const handler = createSiteIntakeHandler({ env: () => env, resolveConsent, verify: async () => true });
  assert.deepEqual(await call(handler), { status: 503, response: { success: false, code: "intake_unavailable" } });
  assert.equal(attempts, 1);
});

test("exact private receipt is forwarded but never echoed, including corrupt DB success", async t => {
  t.after(() => setSupabaseServerClientFactoryForTests(null));
  for (const data of [{ accepted: true }, { accepted: true, notice_snapshot: notice }, { accepted: false }, null]) {
    setSupabaseServerClientFactoryForTests(() => ({ async rpc(_name: string, args: { p_consent_receipt: unknown }) {
      assert.deepEqual(args.p_consent_receipt, notice); return { data, error: null };
    } }));
    const handler = createSiteIntakeHandler({ env: () => env, resolveConsent, verify: async () => true });
    const result = await call(handler);
    assert.deepEqual(result, Object.keys(data || {}).length === 1 && data?.accepted === true
      ? { status: 200, response: { success: true } }
      : { status: 503, response: { success: false, code: "intake_unavailable" } });
    assert.doesNotMatch(JSON.stringify(result), /notice_snapshot|SYNTHETIC|policyRevision|sha256/);
  }
});

test("actual 058/093 in isolated PGlite: audited write, replay, tampering, rollback and legacy preservation", { timeout: 180000 }, async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;");
  const selected = new Set([9, 10, 11, 12, 13, 14, 19, 58]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (selected.has(Number(file.slice(0, 3)))) await db.exec((await readFile(path.join(root, "migrations", file), "utf8"))
      .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
  }
  const workspace = randomUUID(), site = randomUUID(), siteKey = "synthetic-embedded-consent", oldKey = randomUUID();
  await db.query("insert into public.workspaces(id,name) values($1,'Synthetic embedded fixture')", [workspace]);
  await db.query(`insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled)
    values($1,$2,$3,$4,array['/ru/'],true)`, [site, siteKey, workspace, notice.version]);
  await db.query("select public.accept_crm_site_inquiry($1,$2,$3::jsonb)", [siteKey, oldKey, JSON.stringify(inquiry)]);
  const legacy = (await db.query("select row_to_json(i) as value from public.crm_site_inquiries i where site_id=$1", [site])).rows;
  await db.exec(await readFile(path.join(root, "migrations/093_site_consent_receipts.sql"), "utf8"));
  assert.deepEqual((await db.query("select row_to_json(i) as value from public.crm_site_inquiries i where site_id=$1", [site])).rows, legacy);
  const accept = (key: string, snapshot: unknown = notice) => db.query("select public.accept_crm_site_inquiry_with_consent($1,$2,$3::jsonb,$4::jsonb) as result",
    [siteKey, key, JSON.stringify(inquiry), JSON.stringify(snapshot)]);
  await assert.rejects(accept(oldKey), /consent_receipt_unavailable/);
  const key = randomUUID();
  assert.deepEqual((await accept(key)).rows[0], { result: { accepted: true } });
  assert.deepEqual((await accept(key)).rows[0], { result: { accepted: true } });
  const receipts = (await db.query("select notice_snapshot,workspace_id from public.crm_site_consent_receipts")).rows;
  assert.deepEqual(receipts, [{ notice_snapshot: notice, workspace_id: workspace }]);
  for (const field of ["text", "policyRevision", "sha256"]) {
    await assert.rejects(accept(randomUUID(), { ...notice, [field]: "tampered" }), /invalid_consent_receipt/);
  }
  await db.exec("alter table public.crm_site_consent_receipts add constraint synthetic_refusal check(false) not valid");
  await assert.rejects(accept(randomUUID()), /synthetic_refusal/);
  await db.exec("alter table public.crm_site_consent_receipts drop constraint synthetic_refusal");
  assert.deepEqual((await db.query("select count(*)::int as n from public.crm_site_inquiries")).rows, [{ n: 2 }]);
  assert.deepEqual((await db.query("select count(*)::int as n from public.crm_site_consent_receipts")).rows, [{ n: 1 }]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Config = { origin: string; hostname: string; siteKey: string; secret: string };
type Request = { method: string; headers: Record<string, string>; body?: unknown };
type Response = { status(code: number): Response; setHeader(key: string, value: string): void; json(value: unknown): void; end(): void };
type Handler = (req: Request, res: Response) => Promise<unknown>;
const mod = await import(pathToFileURL(path.join(root, "lib/crm/site-intake-handler.ts")).href) as {
  readSiteIntakeConfig(env: Record<string, string>): Config | null;
  verifySiteChallenge(config: Config, token: string, request: (...args: unknown[]) => Promise<{ ok: boolean; text(): Promise<string> }>): Promise<boolean>;
  createSiteIntakeHandler(deps: { env(): Record<string, string>; verify?(): Promise<boolean>; save?(site: string, key: string, inquiry: unknown): Promise<string | null> }): Handler;
};
const env = { MEDINA_SITE_INTAKE_ENABLED: "true", MEDINA_SITE_ORIGIN: "https://site.example.invalid", MEDINA_SITE_INTAKE_KEY: "medina-test", MEDINA_SITE_TURNSTILE_SECRET: "test-only-not-a-real-secret" };
const body = { requestKey: "00000000-0000-4000-8000-000000000100", challengeToken: "mock-challenge", inquiry: {
  name: "Test", phone: "+77071234567", business: "Salon", service: "call-center", pagePath: "/ru/", consentVersion: "v1", consent: true,
} };
const request = (overrides: Partial<Request> = {}): Request => ({ method: "POST", headers: { origin: env.MEDINA_SITE_ORIGIN, "content-type": "application/json" }, body, ...overrides });
async function call(handler: Handler, req = request()) {
  let status = 0; let payload: unknown;
  const headers: Record<string, string> = {};
  const response: Response = { status(code) { status = code; return this; }, setHeader(key, value) { headers[key] = value; }, json(value) { payload = value; }, end() {} };
  await handler(req, response);
  return { status, payload, headers };
}

test("closed by default and wrong origins never verify or save", async () => {
  let calls = 0;
  const deps = { verify: async () => { calls++; return true; }, save: async () => { calls++; return null; } };
  assert.equal((await call(mod.createSiteIntakeHandler({ ...deps, env: () => ({}) }))).status, 503);
  const handler = mod.createSiteIntakeHandler({ ...deps, env: () => env });
  assert.equal((await call(handler, request({ headers: { origin: "https://foreign.example.invalid" } }))).status, 403);
  assert.equal(calls, 0);
  assert.equal(mod.readSiteIntakeConfig({ ...env, MEDINA_SITE_ORIGIN: "http://localhost" }), null);
  assert.equal(mod.readSiteIntakeConfig({ ...env, MEDINA_SITE_ORIGIN: env.MEDINA_SITE_ORIGIN + "/path" }), null);
});

test("challenge requires success, expected hostname AND action; failures stay closed", async () => {
  const config = mod.readSiteIntakeConfig(env)!;
  for (const result of [{ success: true, hostname: config.hostname, action: "site_inquiry" },
    { success: false, hostname: config.hostname, action: "site_inquiry" },
    { success: true, hostname: "foreign.invalid", action: "site_inquiry" },
    { success: true, hostname: config.hostname, action: "login" }, {}]) {
    const ok = await mod.verifySiteChallenge(config, "mock", async () => ({ ok: true, text: async () => JSON.stringify(result) }));
    assert.equal(ok, result.success === true && result.hostname === config.hostname && result.action === "site_inquiry");
  }
  assert.equal(await mod.verifySiteChallenge(config, "mock", async () => ({ ok: true, text: async () => "not json" })), false);
  assert.equal(await mod.verifySiteChallenge(config, "mock", async () => { throw new Error("secret provider details"); }), false);
});

test("body limits and tenant injection fail before provider or storage", async () => {
  let calls = 0;
  const handler = mod.createSiteIntakeHandler({ env: () => env, verify: async () => { calls++; return true; } });
  for (const value of [{ ...body, workspaceId: "foreign" }, { ...body, inquiry: { ...body.inquiry, workspaceId: "foreign" } },
    { ...body, challengeToken: "x".repeat(9000) }, "{invalid", null]) {
    assert.equal((await call(handler, request({ body: value }))).status, 400);
  }
  const stream = Object.assign(Readable.from([Buffer.alloc(8193)]), request({ body: undefined }));
  assert.equal((await call(handler, stream)).status, 400);
  assert.equal(calls, 0);
});

test("failed challenge never saves; verified write uses only configured site", async () => {
  let saved = 0;
  const save = async (site: string, key: string, inquiry: unknown) => {
    saved++; assert.equal(site, "medina-test"); assert.equal(key, body.requestKey); assert.deepEqual(inquiry, body.inquiry); return null;
  };
  assert.equal((await call(mod.createSiteIntakeHandler({ env: () => env, verify: async () => false, save }))).status, 403);
  assert.equal(saved, 0);
  const result = await call(mod.createSiteIntakeHandler({ env: () => env, verify: async () => true, save }));
  assert.equal(result.status, 200); assert.deepEqual(result.payload, { success: true }); assert.equal(saved, 1);
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.MEDINA_SITE_ORIGIN);
});

test("storage failures are safe; no fake success or raw errors", async () => {
  for (const error of ["unavailable", "rate_limited", "request_conflict"]) {
    const result = await call(mod.createSiteIntakeHandler({ env: () => env, verify: async () => true, save: async () => error }));
    assert.equal(result.status, error === "rate_limited" ? 429 : error === "request_conflict" ? 409 : 503);
    assert.doesNotMatch(JSON.stringify(result.payload), /phone|secret|workspace/);
  }
  const result = await call(mod.createSiteIntakeHandler({ env: () => env, verify: async () => true, save: async () => { throw new Error("sensitive database error"); } }));
  assert.deepEqual(result.payload, { success: false, code: "intake_unavailable" });
});

test("preflight is exact-origin only; GET is not a public data reader", async () => {
  const handler = mod.createSiteIntakeHandler({ env: () => env, verify: async () => { throw new Error("must not run"); } });
  assert.equal((await call(handler, request({ method: "OPTIONS" }))).status, 204);
  assert.equal((await call(handler, request({ method: "GET" }))).status, 405);
  assert.equal((await call(handler, request({ headers: { origin: env.MEDINA_SITE_ORIGIN, "content-type": "text/plain" } }))).status, 415);
});

test("local circuit breaker bounds verification calls", async () => {
  let verified = 0;
  const handler = mod.createSiteIntakeHandler({ env: () => env, verify: async () => { verified++; return false; } });
  for (let i = 0; i < 60; i++) await call(handler);
  assert.equal((await call(handler)).status, 429);
  assert.equal(verified, 60);
});

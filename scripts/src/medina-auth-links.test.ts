import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Request = { headers: Record<string, string | string[]> };
type Invitations = {
  acceptUrl(req: Request, token: string): string;
  sendSupabaseInviteEmail(email: string, redirectTo: string): Promise<{ sent: boolean; reason?: string }>;
  handleStaffInvitations(req: unknown, res: unknown): Promise<unknown>;
};
const invitations = await import(pathToFileURL(path.join(root, "lib/crm/staff-invitations.ts")).href) as Invitations;
const { readApplicationOrigin } = await import(pathToFileURL(path.join(root, "lib/auth/application-origin.ts")).href) as {
  readApplicationOrigin(env: NodeJS.ProcessEnv): string;
};

function isolatedEnvironment(env: NodeJS.ProcessEnv, run: () => void) {
  const original = process.env;
  process.env = { NODE_ENV: "test", ...env };
  try { run(); } finally { process.env = original; }
}

for (const headers of [
  { host: "attacker.invalid" },
  { host: "legitimate.vercel.app", "x-forwarded-host": "attacker.invalid" },
  { host: "legitimate.vercel.app", "x-forwarded-proto": "http" },
  { "x-forwarded-host": "legitimate.vercel.app@attacker.invalid", "x-forwarded-proto": "https" },
  { "x-forwarded-host": "attacker.invalid, legitimate.vercel.app", "x-forwarded-proto": "javascript" },
  { host: ["attacker.invalid", "legitimate.vercel.app"], origin: "https://attacker.invalid" },
] as Request["headers"][]) {
  test(`invitation ignores request-controlled origin: ${JSON.stringify(headers)}`, () => {
    isolatedEnvironment({ VERCEL_URL: "trusted-preview.vercel.app" }, () => {
      assert.equal(invitations.acceptUrl({ headers }, "local-fixture"), "https://trusted-preview.vercel.app/join?token=local-fixture");
    });
  });
}

test("without a trusted origin the invitation stays relative, never uses Host", () => {
  isolatedEnvironment({}, () => {
    assert.equal(invitations.acceptUrl({ headers: { host: "attacker.invalid" } }, "a&b#c"), "/join?token=a%26b%23c");
  });
});

test("an explicit HTTPS application origin wins over the deployment URL", () => {
  assert.equal(readApplicationOrigin({ MEDINA_APP_ORIGIN: " https://app.example.invalid/ ", VERCEL_URL: "preview.vercel.app" }), "https://app.example.invalid");
  assert.equal(readApplicationOrigin({ MEDINA_APP_ORIGIN: "https://APP.example.invalid:443" }), "https://app.example.invalid");
});

test("malformed configured origins fail closed instead of using request headers or fallback", () => {
  for (const value of [
    "http://app.example.invalid", "javascript:alert(1)", "//app.example.invalid", "*", "null",
    "https://user:password@app.example.invalid", "https://app.example.invalid/path",
    "https://app.example.invalid?next=attacker", "https://app.example.invalid#attacker",
    "https://app.example.invalid\\@attacker.invalid", "https://app.example.invalid\n.attacker.invalid",
  ]) {
    assert.equal(readApplicationOrigin({ MEDINA_APP_ORIGIN: value, VERCEL_URL: "preview.vercel.app" }), "", value);
  }
});

test("the deployment URL is a server-configured Vercel hostname, not an arbitrary URL", () => {
  assert.equal(readApplicationOrigin({ VERCEL_URL: " trusted-preview.vercel.app " }), "https://trusted-preview.vercel.app");
  for (const value of [
    "https://preview.vercel.app", "preview.vercel.app@attacker.invalid", "preview.vercel.app/path",
    "preview.vercel.app?next=attacker", "preview.vercel.app:80", "preview.vercel.app, attacker.invalid",
    "preview.vercel.app.attacker.invalid", "attacker.invalid", "127.0.0.1", "preview.vercel.app\\attacker.invalid",
  ]) assert.equal(readApplicationOrigin({ VERCEL_URL: value }), "", value);
});

test("Preview never uses the production URL as a fallback", () => {
  const env = { VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "production.vercel.app" };
  assert.equal(readApplicationOrigin(env), "");
  assert.equal(readApplicationOrigin({ ...env, MEDINA_APP_ORIGIN: " ", VERCEL_URL: "preview.vercel.app" }), "https://preview.vercel.app");
});

type Call = { url: string; init: RequestInit };
type Write = { table: string; value: Record<string, unknown> };
const FIXTURE_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORIGIN = "https://trusted-preview.vercel.app";

async function fixture(env: NodeJS.ProcessEnv, run: (calls: Call[], writes: Write[]) => Promise<void>, mode: "ok" | "registered" | "redirect" = "ok") {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  const writes: Write[] = [];
  process.env = { NODE_ENV: "test", SUPABASE_URL: "https://auth-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "local-fixture-key", ...env };
  const { setSupabaseServerClientFactoryForTests: setFactory } = await import(pathToFileURL(path.join(root, "lib/supabase/server.ts")).href) as {
    setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
  };
  setFactory(() => ({
    from(table: string) {
      let inserted: Record<string, unknown> | null = null;
      const query = {
        select() { return query; }, eq() { return query; }, ilike() { return query; },
        is() { return query; }, gt() { return query; }, lte() { return query; },
        insert(value: Record<string, unknown>) { inserted = value; writes.push({ table, value }); return query; },
        update() { return query; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: FIXTURE_WORKSPACE, created_at: new Date().toISOString(), ...inserted }, error: null }),
        then(resolve: (value: unknown) => void) { resolve({ data: [], error: null }); },
      };
      return query;
    },
  }));
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input);
    assert.ok(url === "https://auth-fixture.invalid/auth/v1/invite" || url === "https://auth-fixture.invalid/auth/v1/admin/users" || url === "https://auth-fixture.invalid/auth/v1/user", "no external network destination");
    calls.push({ url, init });
    assert.equal(init.redirect, "error", "provider redirects must not carry credentials to another host");
    if (mode === "redirect") throw new TypeError("Fixture redirect refused");
    const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.invalid" };
    return { ok: mode === "ok", status: mode === "registered" ? 422 : 200, json: async () => user, text: async () => JSON.stringify(user) } as Response;
  }) as typeof globalThis.fetch;
  try { await run(calls, writes); } finally {
    setFactory(null);
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
}

test("mail is not sent when the trusted origin is absent", async () => {
  await fixture({}, async (calls) => {
    assert.deepEqual(await invitations.sendSupabaseInviteEmail("invited@example.invalid", "/join?token=fixture"), { sent: false, reason: "invite_origin_not_configured" });
    assert.equal(calls.length, 0);
  });
});

test("mail refuses foreign, downgraded, credential-bearing and non-join redirects before fetch", async () => {
  await fixture({ VERCEL_URL: "trusted-preview.vercel.app" }, async (calls) => {
    for (const url of [
      "https://attacker.invalid/join?token=fixture", "http://trusted-preview.vercel.app/join?token=fixture",
      "https://trusted-preview.vercel.app.attacker.invalid/join?token=fixture", "/join?token=fixture",
      "https://user:password@trusted-preview.vercel.app/join?token=fixture", ORIGIN + "/login",
      ORIGIN + "/join?token=fixture#attacker",
    ]) assert.deepEqual(await invitations.sendSupabaseInviteEmail("invited@example.invalid", url), { sent: false, reason: "invalid_invite_redirect" }, url);
    assert.equal(calls.length, 0);
  });
});

for (const mode of ["ok", "registered", "redirect"] as const) {
  test(`mail uses only the trusted join URL and never follows provider redirects: ${mode}`, async () => {
    await fixture({ VERCEL_URL: "trusted-preview.vercel.app" }, async (calls) => {
      const link = invitations.acceptUrl({ headers: { "x-forwarded-host": "attacker.invalid" } }, "fixture");
      const expected = mode === "ok" ? { sent: true } : { sent: false, reason: mode === "registered" ? "already_registered" : "invite_unreachable" };
      assert.deepEqual(await invitations.sendSupabaseInviteEmail("invited@example.invalid", link), expected);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: "invited@example.invalid", redirect_to: ORIGIN + "/join?token=fixture" });
    }, mode);
  });
}

function response() {
  return {
    code: 0, body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    setHeader() { return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
  };
}

test("staff invitation handler returns and mails a trusted link despite poisoned headers", async () => {
  await fixture({ VERCEL_URL: "trusted-preview.vercel.app" }, async (calls, writes) => {
    const { attachWorkspaceContext } = await import(pathToFileURL(path.join(root, "lib/crm/server.ts")).href) as {
      attachWorkspaceContext(req: unknown, context: Record<string, unknown>): void;
    };
    const req = { method: "POST", headers: { host: "attacker.invalid", "x-forwarded-proto": "http" }, body: { email: "invited@example.invalid", role: "manager" } };
    attachWorkspaceContext(req, { workspaceId: FIXTURE_WORKSPACE, staffUserId: "22222222-2222-4222-8222-222222222222", role: "owner" });
    const res = response();
    await invitations.handleStaffInvitations(req, res);
    assert.equal(res.code, 201);
    const data = res.body.data as { acceptUrl: string; emailSent: boolean };
    assert.equal(new URL(data.acceptUrl).origin, ORIGIN);
    assert.equal(data.emailSent, true);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(String(calls[0].init.body)).redirect_to, data.acceptUrl);
    assert.ok(writes.every((write) => write.value.workspace_id === FIXTURE_WORKSPACE));
    assert.ok(!JSON.stringify(res.body).includes("token_hash"));
  });
});

for (const configured of [true, false]) {
  test(`credential onboarding returns a safe login URL: origin configured=${configured}`, async () => {
    await fixture(configured ? { VERCEL_URL: "trusted-preview.vercel.app" } : {}, async (calls, writes) => {
      const { handlePlatformOnboardingCredentials } = await import(pathToFileURL(path.join(root, "lib/crm/platform-onboarding-credentials.ts")).href) as {
        handlePlatformOnboardingCredentials(req: unknown, res: unknown): Promise<unknown>;
      };
      const res = response();
      await handlePlatformOnboardingCredentials({
        method: "POST", headers: { host: "attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "javascript" },
        body: { name: "Fixture Salon", vertical: "beauty", ownerEmail: "owner@example.invalid", ownerName: "Fixture Owner", timeZone: "Asia/Almaty", password: "FixtureStrong123!" },
      }, res);
      assert.equal(res.code, 201);
      assert.equal((res.body.data as { loginUrl: string }).loginUrl, (configured ? ORIGIN : "") + "/login");
      assert.equal(calls.length, 1);
      assert.equal(writes.length, 3);
      assert.ok(!JSON.stringify(res.body).includes("FixtureStrong123!"));
      assert.ok(!JSON.stringify(writes).includes("FixtureStrong123!"));
    });
  });
}

test("a provider redirect during onboarding creates no workspace or membership", async () => {
  await fixture({ VERCEL_URL: "trusted-preview.vercel.app" }, async (calls, writes) => {
    const { handlePlatformOnboardingCredentials } = await import(pathToFileURL(path.join(root, "lib/crm/platform-onboarding-credentials.ts")).href) as {
      handlePlatformOnboardingCredentials(req: unknown, res: unknown): Promise<unknown>;
    };
    const res = response();
    await handlePlatformOnboardingCredentials({
      method: "POST", headers: {},
      body: { name: "Fixture Salon", vertical: "beauty", ownerEmail: "owner@example.invalid", timeZone: "Asia/Almaty", password: "FixtureStrong123!" },
    }, res);
    assert.equal(res.code, 502);
    assert.equal(calls.length, 1);
    assert.equal(writes.length, 0);
  }, "redirect");
});

for (const mode of ["ok", "redirect"] as const) {
  test(`token verification rejects provider redirects instead of moving credentials: ${mode}`, async () => {
    await fixture({}, async (calls, writes) => {
      const { requireAuthenticatedUser } = await import(pathToFileURL(path.join(root, "lib/auth/server.ts")).href) as {
        requireAuthenticatedUser(req: unknown): Promise<{ id: string }>;
      };
      const req = { headers: { authorization: "Bearer fixture.token.signature" } };
      if (mode === "redirect") {
        await assert.rejects(requireAuthenticatedUser(req), (error: unknown) => (error as { statusCode: number }).statusCode === 503);
      } else {
        assert.equal((await requireAuthenticatedUser(req)).id, "11111111-1111-4111-8111-111111111111");
      }
      assert.equal(calls.length, 1);
      assert.equal(writes.length, 0);
    }, mode);
  });
}

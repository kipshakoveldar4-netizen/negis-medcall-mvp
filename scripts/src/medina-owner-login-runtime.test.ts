import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const logins = await import(pathToFileURL(path.join(root, "lib/auth/staff-logins.ts")).href) as {
  isSyntheticEmail(value: unknown): boolean;
  loginOrEmailToAuthEmail(value: unknown): string;
};
const { validatePasswordRules } = await import(pathToFileURL(path.join(root, "lib/auth/password-rules.ts")).href) as {
  validatePasswordRules(value: unknown): string[];
};
const { isVertical, VERTICAL_SETTINGS_KEY } = await import(pathToFileURL(path.join(root, "lib/vertical/terms.ts")).href) as {
  isVertical(value: unknown): boolean; VERTICAL_SETTINGS_KEY: string;
};
const { validateOnboardingRequest } = await import(pathToFileURL(path.join(root, "lib/crm/platform-onboarding.ts")).href) as {
  validateOnboardingRequest(value: Row): Row;
};
const { onboardingSettings, readOnboardingPurpose } = await import(pathToFileURL(path.join(root, "lib/crm/workspace-purpose.ts")).href) as {
  onboardingSettings(id: string, value: Row): Row[]; readOnboardingPurpose(value: unknown): string | null;
};
const { escapeLikePattern, normalizeEmail, sendSupabaseInviteEmail } = await import(pathToFileURL(path.join(root, "lib/crm/staff-invitations.ts")).href) as {
  escapeLikePattern(value: string): string; normalizeEmail(value: unknown): string;
  sendSupabaseInviteEmail(email: string, url: string): Promise<{ sent: boolean; reason?: string }>;
};
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Row = Record<string, unknown>;
type Step = { table: string; mode: "read" | "insert" | "update"; data?: unknown; error?: unknown };
const input = {
  name: "Isolated owner login", vertical: "beauty", ownerName: "Test owner",
  ownerLogin: "QA-Owner", password: "Only-unit-test-42", timeZone: "Asia/Almaty",
};
const preflight: Step[] = [
  { table: "staff_invitations", mode: "read", data: [] },
  { table: "workspaces", mode: "read", data: [] },
];
const inserts: Step[] = [
  { table: "workspaces", mode: "insert", data: { id: "new-workspace" } },
  { table: "workspace_settings", mode: "insert" },
  { table: "staff_users", mode: "insert" },
];

// Real handlers in a VM with synthetic DB/Auth only; no real env or network.
async function fixture(steps: Step[], authReply = { ok: true, status: 201, data: { id: "auth-owner" } as Row }) {
  const calls: Array<{ table: string; mode: Step["mode"]; operations: Array<[string, unknown[]]> }> = [];
  const authCalls: Array<{ url: string; init: RequestInit; body: Row }> = [];
  const mailCalls: string[] = [];
  const exports: Record<string, (...args: any[]) => any> = {};
  let status = 0;
  let response: Row = {};
  const supabase = {
    from(table: string) {
      const call = { table, mode: "read" as Step["mode"], operations: [] as Array<[string, unknown[]]> };
      const finish = () => {
        const step = steps[calls.length];
        calls.push(call);
        assert.ok(step, `Unexpected DB call: ${table}`);
        assert.equal(table, step.table);
        assert.equal(call.mode, step.mode);
        return { data: step.data ?? null, error: step.error ?? null };
      };
      const query: Record<string, any> = {
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(finish).then(resolve, reject);
        },
        single: async () => finish(), maybeSingle: async () => finish(),
      };
      for (const method of ["select", "insert", "update", "eq", "ilike", "is", "gt"]) {
        query[method] = (...args: unknown[]) => {
          call.operations.push([method, args]);
          if (method === "insert" || method === "update") call.mode = method;
          return query;
        };
      }
      return query;
    },
  };
  async function load(file: string) {
    const source = await readFile(path.join(root, "lib/crm", file), "utf8");
    new Script(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText).runInNewContext({
      exports, Intl, URL,
      process: { env: { SUPABASE_URL: "https://auth.unit.test", SUPABASE_SERVICE_ROLE_KEY: "unit-test-key" } },
      require(name: string) {
        const dependencies: Record<string, unknown> = {
          "../auth/application-origin": { readApplicationOrigin: () => "https://crm.unit.test" },
          "../auth/password-rules": { validatePasswordRules },
          "../auth/staff-logins": logins,
          "../supabase/server": { getSupabaseServerClient: () => supabase },
          "../vertical/terms": { isVertical, VERTICAL_SETTINGS_KEY },
          "./platform-onboarding": { validateOnboardingRequest },
          "./workspace-purpose": { onboardingSettings, readOnboardingPurpose },
          "./staff-invitations": {
            escapeLikePattern, normalizeEmail,
            createInvitationToken: () => ({ token: "unit-token", tokenHash: "unit-hash" }),
            expiryFromNow: () => "2099-01-01T00:00:00.000Z",
            acceptUrl: () => "https://crm.unit.test/join?token=unit-token",
            sendSupabaseInviteEmail: async (email: string, link: string) => {
              mailCalls.push(email);
              assert.ok(logins.isSyntheticEmail(email), "Fixture never sends real invitation emails");
              return sendSupabaseInviteEmail(email, link);
            },
          },
        };
        assert.ok(name in dependencies, `Unmocked import ${name}`);
        return dependencies[name];
      },
      fetch: async (url: string, init: RequestInit) => {
        assert.equal(url, "https://auth.unit.test/auth/v1/admin/users");
        assert.equal(init.method, "POST", "Never reset or take over an existing Auth user");
        assert.equal(init.redirect, "error");
        authCalls.push({ url, init, body: JSON.parse(String(init.body)) });
        return { ok: authReply.ok, status: authReply.status, json: async () => authReply.data };
      },
    });
  }
  const res = { status(value: number) { status = value; return this; }, json(value: Row) { response = value; } };
  const submit = async (body: Row) => {
    await load("platform-onboarding-credentials.ts");
    await exports.handlePlatformOnboardingCredentials({ body }, res);
    assert.ok(!JSON.stringify(response).includes(input.password), "Response never contains the supplied password");
    return { status, body: response, data: response.data as Row | undefined };
  };
  return { calls, authCalls, mailCalls, load, submit, res, exports, outcome: () => ({ status, body: response }) };
}

test("Owner username uses the existing sign-in mapping, confirmed Auth and owner membership", async () => {
  const f = await fixture([...preflight, ...inserts]);
  const result = await f.submit(input);
  assert.equal(result.status, 201);
  assert.equal(result.data?.ownerLogin, "qa.owner");
  assert.equal(result.data?.ownerLoginOnly, true);
  const email = logins.loginOrEmailToAuthEmail(input.ownerLogin);
  assert.equal(result.data?.ownerEmail, email);
  assert.equal(f.authCalls.length, 1);
  assert.equal(f.authCalls[0].body.email, email);
  assert.equal(f.authCalls[0].body.email_confirm, true);
  const owner = f.calls.at(-1)?.operations.find(([method]) => method === "insert")?.[1][0] as Row;
  assert.equal(owner.email, email);
  assert.equal(owner.auth_user_id, "auth-owner");
  assert.equal(owner.role, "owner");
  assert.equal(owner.full_name, input.ownerName);
  assert.equal(owner.password, undefined);
  assert.equal(owner.password_reset_required, true);
  assert.equal(f.mailCalls.length, 0);
});

test("Owner email flow retains normalized email and does not require a username", async () => {
  const { ownerLogin: _, ...emailInput } = input;
  const f = await fixture([...preflight, ...inserts]);
  const result = await f.submit({ ...emailInput, ownerEmail: " Owner@Example.test " });
  assert.equal(result.status, 201);
  assert.equal(result.data?.ownerLoginOnly, false);
  assert.equal(result.data?.ownerLogin, "");
  assert.equal(f.authCalls[0].body.email, "owner@example.test");
});

test("Blank owner name falls back to the canonical username, not its internal address", async () => {
  const f = await fixture([...preflight, ...inserts]);
  assert.equal((await f.submit({ ...input, ownerName: "" })).status, 201);
  assert.equal((f.authCalls[0].body.user_metadata as Row).full_name, "qa.owner");
});

test("Invalid or ambiguous owner identities fail before Auth or DB mutations", async () => {
  for (const patch of [
    { ownerLogin: "ab" }, { ownerLogin: "" }, { ownerLogin: null }, { ownerLogin: {} },
    { ownerLogin: "x".repeat(25) }, { ownerLogin: "динарa" }, { ownerLogin: "login@company.test" },
    { ownerLogin: "bad%login" }, { ownerLogin: "bad/login" },
    { ownerEmail: "other@example.test" }, { ownerEmail: {} },
    { ownerLogin: undefined, ownerEmail: "fake@staff.negis.online" },
    { ownerLogin: undefined, ownerEmail: "fake@staff.negis.local" },
    { vertical: "mortgage" }, { timeZone: "" }, { name: "" }, { password: "short" },
  ]) {
    const f = await fixture([]);
    assert.equal((await f.submit({ ...input, ...patch })).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.authCalls.length, 0);
  }
});

test("Marketing guard is unchanged: a username cannot bypass invitation-only onboarding", async () => {
  const f = await fixture([]);
  const result = await f.submit({ ...input, purpose: "marketing", vertical: "" });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "marketing_invitation_required");
  assert.equal(f.calls.length, 0);
  assert.equal(f.authCalls.length, 0);
});

test("Busy owner username is not reset or silently reused and leaves no workspace", async () => {
  const f = await fixture([...preflight, { table: "workspaces", mode: "read", data: [] }], {
    ok: false, status: 422, data: { error_code: "email_exists", msg: "provider-private-detail" },
  });
  const result = await f.submit(input);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "owner_login_unavailable");
  assert.equal(f.authCalls.length, 1);
  assert.ok(f.calls.every((call) => call.mode === "read"));
  assert.ok(!JSON.stringify(result.body).includes("provider-private-detail"));
  assert.ok(!JSON.stringify(result.body).includes("staff.negis"));
});

test("DB preflight failures or missing Auth id never claim successful owner onboarding", async () => {
  for (let failure = 0; failure < preflight.length; failure += 1) {
    const f = await fixture([...preflight.slice(0, failure), {
      ...preflight[failure], data: null, error: { message: "private-detail" },
    }]);
    assert.equal((await f.submit(input)).status, 502);
    assert.equal(f.authCalls.length, 0);
    assert.ok(f.calls.every((call) => call.mode === "read"));
  }
  const f = await fixture([...preflight], { ok: true, status: 201, data: {} });
  const result = await f.submit(input);
  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.data, undefined);
  assert.ok(f.calls.every((call) => call.mode === "read"));
});

test("Pending invitation or existing workspace prevents duplicate Auth/workspace creation", async () => {
  for (const steps of [
    [{ table: "staff_invitations", mode: "read", data: [{ workspace_id: "existing" }] },
      { table: "workspaces", mode: "read", data: { name: "Pending owner" } }],
    [preflight[0], { table: "workspaces", mode: "read", data: [{ id: "existing", name: "Owner workspace" }] }],
  ] as Step[][]) {
    const f = await fixture(steps);
    const result = await f.submit(input);
    assert.equal(result.status, 409);
    assert.equal(result.data?.existingWorkspaceId, "existing");
    assert.equal(f.authCalls.length, 0);
    assert.ok(f.calls.every((call) => call.mode === "read"));
    assert.equal(f.calls[0].operations.find(([method]) => method === "ilike")?.[1][1], "qa.owner@staff.negis.online");
    assert.ok(!JSON.stringify(result.body).includes("staff.negis"));
  }
});

test("Partial username onboarding reports its real stage without success or email recovery promises", async () => {
  for (let failure = 0; failure < inserts.length; failure += 1) {
    const f = await fixture([...preflight, ...inserts.slice(0, failure), {
      ...inserts[failure], data: null, error: { message: "db-private-detail" },
    }]);
    const result = await f.submit(input);
    assert.equal(result.status, 502);
    assert.equal(result.body.success, false);
    assert.equal(result.body.code, "partial_credentials_onboarding");
    assert.equal(result.data?.existingWorkspaceId, failure ? "new-workspace" : undefined);
    assert.equal(f.authCalls.length, 1);
    assert.ok(!JSON.stringify(result.body).includes("db-private-detail"));
    assert.ok(!JSON.stringify(result.body).includes("staff.negis"));
    assert.ok(!JSON.stringify(result.body).includes("Забыли пароль"));
  }
});

test("Username owner reissue yields a session-bound manual invitation, never a mail request", async () => {
  const f = await fixture([
    { table: "workspaces", mode: "read", data: { id: "existing", name: "Test", owner_email: "qa.owner@staff.negis.online" } },
    { table: "staff_users", mode: "read", data: null },
    { table: "staff_invitations", mode: "update" },
    { table: "staff_invitations", mode: "insert", data: { id: "invite", expires_at: "2099-01-01" } },
  ]);
  await f.load("platform-onboarding.ts");
  await f.exports.handlePlatformInvitationReissue({ body: { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }, f.res);
  const result = f.outcome();
  assert.equal(result.status, 201);
  const data = result.body.data as Row;
  assert.equal(data.ownerLogin, "qa.owner");
  assert.equal(data.ownerLoginOnly, true);
  assert.equal(data.emailSent, false);
  assert.equal(data.emailStatus, "login_only");
  assert.equal(f.authCalls.length, 0);
  const invitation = f.calls.at(-1)?.operations.find(([method]) => method === "insert")?.[1][0] as Row;
  assert.equal(invitation.email, "qa.owner@staff.negis.online");
  assert.equal(invitation.token_hash, "unit-hash");
  assert.equal(invitation.role, "owner");
});

test("Synthetic inboxes never invoke invitation mail; fresh invitation needs actual email", async () => {
  for (const email of ["qa.owner@staff.negis.online", "qa.owner@staff.negis.local"]) {
    assert.deepEqual(await sendSupabaseInviteEmail(email, "https://crm.unit.test/join?token=unit-token"), {
      sent: false, reason: "login_only",
    });
  }
  for (const identity of [{ ownerEmail: "qa.owner@staff.negis.online" }, { ownerLogin: "qa.owner" }]) {
    const f = await fixture([]);
    await f.load("platform-onboarding.ts");
    await f.exports.handlePlatformOnboarding({ body: { ...input, ...identity } }, f.res);
    assert.equal(f.outcome().status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.authCalls.length, 0);
  }
});

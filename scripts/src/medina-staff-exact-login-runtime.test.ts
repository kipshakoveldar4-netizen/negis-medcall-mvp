import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Row = Record<string, unknown>;
type Module = Record<string, (...args: any[]) => any>;
type Operation = [string, unknown[]];
type DbCall = { table: string; mode: "read" | "insert" | "update"; operations: Operation[] };
type Step = { table: string; mode: DbCall["mode"]; error?: Row; data?: Row | null };
type AuthReply = { ok: boolean; status: number; data: Row };

const input = { login: "QA-Staff", fullName: "Isolated staff", role: "lead_manager", password: "Only-unit-test-42" };
const context = { workspaceId: "unit-workspace", staffUserId: "unit-owner", role: "owner", email: "owner@example.test", purpose: "mortgage_leads" };
const occupiedReply: AuthReply = { ok: false, status: 422, data: { error_code: "email_exists" } };
const forbidden = () => { assert.fail("Unexpected service call in isolated fixture"); };

// Transpile real sources, but resolve every dependency explicitly in a dummy environment.
async function load(file: string, dependencies: Row, globals: Row = {}): Promise<Module> {
  const exports: Module = {};
  const source = await readFile(path.join(root, file), "utf8");
  new Script(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { filename: file }).runInNewContext({
    exports, Intl, URL, TextEncoder,
    process: { env: Object.freeze({ SUPABASE_URL: "https://auth.unit.test", SUPABASE_SERVICE_ROLE_KEY: "unit-test-key" }) },
    console: { log: forbidden, warn: forbidden, error: forbidden },
    fetch: forbidden,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked import: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

const permissions = await load("lib/auth/permissions.ts", {});
const logins = await load("lib/auth/staff-logins.ts", {});
const passwordRules = await load("lib/auth/password-rules.ts", {});
const invitations = await load("lib/crm/staff-invitations.ts", {
  "node:crypto": { createHash: forbidden, randomBytes: forbidden, timingSafeEqual: forbidden },
  "../auth/application-origin": { readApplicationOrigin: forbidden },
  "../auth/permissions": permissions,
  "../auth/staff-logins": logins,
  "../auth/server": { requireAuthenticatedUser: forbidden, WorkspaceAdminAuthError: Error },
  "../supabase/server": { getSupabaseServerClient: forbidden },
  "./server": { readWorkspaceContext: forbidden },
});
const ownerCredentials = await load("lib/crm/platform-onboarding-credentials.ts", {
  "../auth/application-origin": { readApplicationOrigin: forbidden },
  "../auth/password-rules": passwordRules,
  "../auth/staff-logins": logins,
  "../supabase/server": { getSupabaseServerClient: forbidden },
  "./platform-onboarding": { validateOnboardingRequest: forbidden },
  "./staff-invitations": invitations,
  "./workspace-purpose": { onboardingSettings: forbidden },
});
const exactLogin: string = logins.normalizeLogin(input.login);
const exactEmail: string = logins.emailFromLogin(exactLogin);

function successSteps(): Step[] {
  return [
    { table: "staff_invitations", mode: "update" },
    { table: "staff_users", mode: "insert" },
    { table: "clinic_doctors", mode: "read", data: null },
  ];
}

async function fixture(options: {
  steps?: Step[]; verifiedContext?: Row | null; occupied?: string[];
  authReply?: AuthReply; networkFailure?: boolean;
} = {}) {
  const steps = options.steps ?? [];
  const verifiedContext = options.verifiedContext === undefined ? context : options.verifiedContext;
  const calls: DbCall[] = [];
  const authCalls: Array<{ email: string; method: string }> = [];
  const createdAccounts: Array<{ email: string; id: string }> = [];
  const occupied = new Set(options.occupied ?? []);
  const logs: string[] = [];
  let invitationCalls = 0;
  let contextCalls = 0;
  const writes = () => calls.filter((call) => call.mode !== "read");
  const supabase = {
    from(table: string) {
      assert.ok(["staff_users", "staff_invitations", "clinic_doctors"].includes(table), "Only planned staff tables are available");
      const call: DbCall = { table, mode: "read", operations: [] };
      calls.push(call);
      let finished = false;
      const finish = () => {
        assert.equal(finished, false, "A DB query must finish once");
        finished = true;
        const step = steps[calls.indexOf(call)];
        assert.ok(step, `Unexpected DB call: ${table}/${call.mode}`);
        assert.equal(table, step.table);
        assert.equal(call.mode, step.mode);
        if (step.error) return { data: null, error: step.error };
        if (table === "staff_users" && call.mode === "insert") {
          const row = call.operations.find(([method]) => method === "insert")?.[1][0] as Row;
          return { data: { id: `unit-staff-${calls.length}`, email: row.email, role: row.role, status: row.status }, error: null };
        }
        return { data: step.data ?? null, error: null };
      };
      const query: Record<string, any> = {
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(finish).then(resolve, reject);
        },
        single: async () => finish(), maybeSingle: async () => finish(),
      };
      for (const method of ["select", "insert", "update", "eq", "ilike", "is"]) {
        query[method] = (...args: unknown[]) => {
          call.operations.push([method, args]);
          if (method === "insert" || method === "update") call.mode = method;
          return query;
        };
      }
      return query;
    },
  };
  const invitationAttempt = () => { invitationCalls += 1; return forbidden(); };
  const captureLog = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  let currentRequest: Row | undefined;
  const handler = await load("lib/crm/staff-credentials.ts", {
    "../supabase/server": { getSupabaseServerClient: () => supabase },
    "../auth/permissions": permissions,
    "../auth/staff-logins": logins,
    "../auth/platform": { platformOwnerIds: forbidden },
    "./server": {
      readWorkspaceContext(req: Row) {
        assert.ok(req === currentRequest, "Context belongs to the submitted request");
        contextCalls += 1;
        return verifiedContext;
      },
    },
    "./staff-invitations": {
      escapeLikePattern: invitations.escapeLikePattern, normalizeEmail: invitations.normalizeEmail,
      createInvitationToken: invitationAttempt, expiryFromNow: invitationAttempt, acceptUrl: invitationAttempt,
    },
    "./platform-onboarding-credentials": { validateOwnerPassword: ownerCredentials.validateOwnerPassword },
  }, {
    console: { log: captureLog, warn: captureLog, error: captureLog },
    fetch: async (url: string, init: RequestInit) => {
      assert.equal(url, "https://auth.unit.test/auth/v1/admin/users", "Only the mocked Admin create endpoint is available");
      assert.equal(init.method, "POST", "Never reset, list or reuse an occupied Auth user");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(String(init.body)) as Row;
      assert.equal(typeof body.email, "string");
      assert.ok(body.password === input.password, "Only the dummy fixture credential is submitted");
      assert.equal(body.email_confirm, true);
      assert.equal((body.user_metadata as Row).full_name, input.fullName);
      const email = body.email as string;
      authCalls.push({ email, method: init.method });
      assert.ok(authCalls.length <= 16, "Auth retries remain bounded in the fixture");
      if (options.networkFailure) throw new Error("unit-transport-failure");
      const reply = options.authReply ?? (occupied.has(email) ? occupiedReply : {
        ok: true, status: 201, data: { id: `unit-auth-${createdAccounts.length + 1}` },
      });
      if (reply.ok) {
        occupied.add(email);
        createdAccounts.push({ email, id: String(reply.data.id ?? "") });
      }
      let read = false;
      return { ok: reply.ok, status: reply.status, json: async () => {
        assert.equal(read, false, "Auth reply is read once");
        read = true;
        return reply.data;
      } };
    },
  });
  const submit = async (patch: Row = {}) => {
    let status = 0;
    let body: Row = {};
    currentRequest = { method: "POST", body: { ...input, ...patch } };
    const res = { status(value: number) { status = value; return this; }, json(value: Row) { body = value; } };
    await handler.handleStaffCredentials(currentRequest, res);
    const visible = JSON.stringify({ body, calls, logs });
    assert.ok(!visible.includes(input.password), "Responses, DB calls and logs never contain the supplied credential");
    assert.ok(!visible.includes("unit-test-key"), "Responses, DB calls and logs never contain the dummy service credential");
    assert.equal(invitationCalls, 0, "Username creation must never issue an invitation");
    return { status, body, data: body.data as Row | undefined };
  };
  return { calls, authCalls, createdAccounts, writes, submit, contextCalls: () => contextCalls };
}

function assertUnavailable(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["submit"]>>) {
  assert.equal(result.status, 409);
  assert.equal(result.body.success, false);
  assert.equal(result.body.code, "login_unavailable");
  assert.equal(result.data?.acceptUrl, undefined);
}

function assertBinding(f: Awaited<ReturnType<typeof fixture>>, email: string, authId: string) {
  const revoke = f.calls.find((call) => call.table === "staff_invitations");
  assert.ok(revoke);
  assert.equal(revoke.mode, "update");
  assert.ok(revoke.operations.some(([method, args]) => method === "eq" && args[0] === "workspace_id" && args[1] === context.workspaceId));
  assert.ok(revoke.operations.some(([method, args]) => method === "ilike" && args[0] === "email" && args[1] === invitations.escapeLikePattern(email)));
  const membership = f.calls.find((call) => call.table === "staff_users" && call.mode === "insert");
  assert.ok(membership);
  const row = membership.operations.find(([method]) => method === "insert")?.[1][0] as Row;
  assert.equal(row.email, email);
  assert.equal(row.auth_user_id, authId);
  assert.equal(row.workspace_id, context.workspaceId);
  assert.equal(row.full_name, input.fullName);
  assert.equal(row.role, input.role);
  assert.equal(row.status, "active");
  assert.equal(row.password_reset_required, true);
  assert.equal(row.password, undefined);
  assert.equal(row.token, undefined);
}

for (const [label, data] of [
  ["email_exists", { error_code: "email_exists" }],
  ["already-registered msg", { msg: "User already registered" }],
  ["already-registered message", { message: "User has already been registered" }],
] as Array<[string, Row]>) {
  test(`Mortgage occupied explicit login (${label}): one Admin POST and zero DB writes`, async () => {
    const f = await fixture({ authReply: { ok: false, status: 422, data } });
    const result = await f.submit();
    assert.equal(f.authCalls.length, 1, "Occupied exact login stops after its first Admin POST");
    assert.equal(f.authCalls[0].email, exactEmail);
    assert.equal(f.writes().length, 0);
    assert.equal(f.createdAccounts.length, 0);
    assertUnavailable(result);
  });
}

for (const [label, patch] of [
  ["clinical purpose", { purpose: "clinic_services" }],
  ["missing purpose", { purpose: undefined }],
  ["false strict flag", { purpose: "clinic_services", strict: false, strictLogin: false, strict_login: false, exactLogin: false }],
  ["null purpose and string flag", { purpose: null, strict: "false", strictLogin: "false" }],
] as Array<[string, Row]>) {
  test(`Verified mortgage context ignores body ${label} when an exact login is occupied`, async () => {
    const f = await fixture({ authReply: occupiedReply });
    const result = await f.submit(patch);
    assert.equal(f.contextCalls(), 1);
    assert.equal(f.authCalls.length, 1, "Request body cannot turn off exact login mode");
    assert.equal(f.writes().length, 0);
    assertUnavailable(result);
  });
}

test("First free mortgage login keeps exact Auth email, membership and response binding", async () => {
  const f = await fixture({ steps: successSteps() });
  const result = await f.submit({ workspaceId: "untrusted-workspace", auth_user_id: "untrusted-auth" });
  assert.equal(result.status, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.data?.login, exactLogin);
  assert.equal(result.data?.email, exactEmail);
  assert.equal((result.data?.staff as Row).email, exactEmail);
  assert.equal(f.authCalls.length, 1);
  assert.equal(f.createdAccounts.length, 1);
  assert.equal(f.createdAccounts[0].email, exactEmail);
  assert.equal(f.calls.length, 3);
  assert.equal(f.writes().length, 2);
  assertBinding(f, exactEmail, "unit-auth-1");
});

for (const partial of [false, true]) {
  test(`Mortgage repeat after ${partial ? "partial membership failure" : "successful creation"} cannot create a suffixed second account`, async () => {
    const firstSteps: Step[] = partial ? [successSteps()[0], {
      table: "staff_users", mode: "insert", error: { message: "unit-membership-failure" },
    }] : successSteps();
    // Permit the old suffix path to finish, so assertions expose actual duplicate creation.
    const f = await fixture({ steps: [...firstSteps, ...successSteps()] });
    const first = await f.submit();
    assert.equal(first.status, partial ? 502 : 201);
    assert.equal(first.body.code, partial ? "partial_staff_credentials" : undefined);
    assert.equal(first.data?.email, exactEmail);
    assert.equal(first.data?.login, exactLogin);
    assert.equal(f.createdAccounts.length, 1);
    const postsBeforeRepeat = f.authCalls.length;
    const writesBeforeRepeat = f.writes().length;
    const repeated = await f.submit();
    assert.equal(f.authCalls.length - postsBeforeRepeat, 1, "Repeat must submit only the original exact login");
    assert.equal(f.authCalls.at(-1)?.email, exactEmail);
    assert.equal(f.createdAccounts.length, 1, "Repeat must not create a suffixed account");
    assert.equal(f.writes().length, writesBeforeRepeat, "Repeat must not add membership or invitation writes");
    assertUnavailable(repeated);
  });
}

for (const purpose of ["clinic_services", undefined, null, "mortgage"]) {
  test(`Non-mortgage context (${String(purpose)}) retains collision suffix and issued email downstream`, async () => {
    const f = await fixture({ verifiedContext: { ...context, purpose }, occupied: [exactEmail], steps: successSteps() });
    const result = await f.submit({ purpose: "mortgage_leads", strict: true, strictLogin: true, exactLogin: true });
    assert.equal(result.status, 201);
    assert.equal(f.authCalls.length, 2);
    assert.equal(f.authCalls[0].email, exactEmail);
    const issuedEmail = f.authCalls[1].email;
    assert.notEqual(issuedEmail, exactEmail);
    const issuedLogin: string = logins.loginFromEmail(issuedEmail);
    assert.ok(issuedLogin.startsWith(`${exactLogin}.`), "Clinical retry uses the established login suffix helper");
    assert.ok(logins.isLoginShape(issuedLogin));
    assert.equal(logins.emailFromLogin(issuedLogin), issuedEmail);
    assert.equal(logins.loginOrEmailToAuthEmail(issuedLogin), issuedEmail);
    assert.equal(result.data?.login, issuedLogin);
    assert.equal(result.data?.email, issuedEmail);
    assert.equal((result.data?.staff as Row).email, issuedEmail);
    assert.equal(f.createdAccounts.length, 1);
    assertBinding(f, issuedEmail, "unit-auth-1");
  });
}

for (const purpose of ["mortgage_leads", "clinic_services", undefined]) {
  for (const [label, authReply, networkFailure, status, code] of [
    ["noncollision 422", { ok: false, status: 422, data: { error_code: "weak_password", msg: "Provider rejected credential" } }, false, 400, "password_rejected"],
    ["provider 500", { ok: false, status: 500, data: { error_code: "unexpected_failure" } }, false, 502, "unavailable"],
    ["transport failure", undefined, true, 502, "unavailable"],
    ["unreadable created account", { ok: true, status: 201, data: {} }, false, 502, "staff_credentials_unreadable"],
  ] as Array<[string, AuthReply | undefined, boolean, number, string]>) {
    test(`Context ${String(purpose)} does not suffix on ${label}`, async () => {
      const f = await fixture({ verifiedContext: { ...context, purpose }, authReply, networkFailure });
      const result = await f.submit();
      assert.equal(result.status, status);
      assert.equal(result.body.success, false);
      assert.equal(result.body.code, code);
      assert.equal(f.authCalls.length, 1);
      assert.equal(f.authCalls[0].email, exactEmail);
      assert.equal(f.writes().length, 0);
    });
  }
}

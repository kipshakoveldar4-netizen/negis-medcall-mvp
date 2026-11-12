import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const AUTH_ORIGIN = "https://partner-auth.fixture.invalid";
const AUTH_URL = `${AUTH_ORIGIN}/auth/v1/user`;
const SERVICE_KEY = "synthetic-partner-auth-service-key";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const FORGED_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL = "applicant@example.invalid";
const CONFIRMED_AT = "2026-10-27T10:11:12.123456Z";
const TOKEN = "synthetic.payload.signature";

type Request = { headers: Record<string, string>; query: Record<string, unknown>; body: unknown };
type StaffRow = { id: string; workspace_id: string; role: string; status: string };
type AuthOptions = { status?: number; raw?: string; networkError?: boolean };
type WorkspaceAuthDeps = { getSupabaseClient?: () => unknown };
type AuthUser = { id: string; email?: string; emailConfirmed?: true };
type AuthModule = {
  requireAuthenticatedUser(req: Request): Promise<AuthUser>;
  requireWorkspaceAccess(req: Request, workspaceId: string, deps: WorkspaceAuthDeps): Promise<{
    userId: string; staffUserId: string; workspaceId: string; role: string; permissions: string[];
  }>;
  listAuthContextMemberships(req: Request, deps: WorkspaceAuthDeps): Promise<{
    user: AuthUser; memberships: Array<{ role: string }>;
  }>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const namespace = await import(pathToFileURL(path.join(repoRoot, "lib", "auth", "server.ts")).href) as AuthModule & { default?: AuthModule };
const { requireAuthenticatedUser, requireWorkspaceAccess, listAuthContextMemberships } = namespace.default ?? namespace;

function request(token = TOKEN, extra: Record<string, unknown> = {}): Request {
  return { headers: { authorization: `Bearer ${token}` }, query: {}, body: {}, ...extra } as Request;
}

// Exercise the real verifier through its public entry point, not a second parser.
// Every fetch is intercepted; an unexpected destination fails instead of escaping.
async function withAuth<T>(
  payload: unknown,
  run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
  options: AuthOptions = {},
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  process.env.SUPABASE_URL = AUTH_ORIGIN;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(url, AUTH_URL, "only the isolated Auth user endpoint may be contacted");
    if (options.networkError) throw new Error("synthetic Auth outage");
    return new Response(options.raw ?? JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

function membershipDeps(rows: StaffRow[], seen: Array<Record<string, string>>): WorkspaceAuthDeps {
  return {
    getSupabaseClient: (() => ({
      from(table: string) {
        assert.equal(table, "staff_users");
        const filters: Record<string, string> = {};
        const builder = {
          select(columns: string) {
            assert.equal(columns, "id, workspace_id, role, status");
            return builder;
          },
          eq(column: string, value: string) {
            filters[column] = value;
            return builder;
          },
          then(resolve: (value: { data: StaffRow[]; error: null }) => void) {
            seen.push({ ...filters });
            assert.deepEqual(filters, { auth_user_id: USER_ID, status: "active" });
            resolve({ data: rows.filter(row => row.status === "active"), error: null });
          },
        };
        return builder;
      },
    })) as WorkspaceAuthDeps["getSupabaseClient"],
  };
}

function expectAuthError(statusCode: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { statusCode?: number }).statusCode, statusCode);
    assert.equal((error as Error & { code?: string }).code, code);
    return true;
  };
}

const validTimestamps = [
  ...["", ".1", ".12", ".123", ".1234", ".12345", ".123456"].flatMap(fraction =>
    ["Z", "+00:00"].map(zone => `2026-10-27T10:11:12${fraction}${zone}`)),
  "2024-02-29T23:59:59.999999Z",
  "2000-02-29T00:00:00Z",
  "0001-01-01T00:00:00Z",
  "9999-12-31T23:59:59.999999Z",
];

for (const timestamp of validTimestamps) {
  test(`verified Auth contact accepts UTC confirmation ${timestamp}`, { concurrency: false }, async () => {
    await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: timestamp }, async calls => {
      assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID, email: EMAIL, emailConfirmed: true });
      assert.equal(calls.length, 1);
    });
  });
}

const invalidTimestamps: Array<[string, unknown]> = [
  ["year zero", "0000-01-01T00:00:00Z"],
  ["year zero with fraction and UTC offset", "0000-12-31T23:59:59.123456+00:00"],
  ["non-leap February", "2026-02-29T10:11:12Z"],
  ["century non-leap February", "1900-02-29T10:11:12Z"],
  ["rolled February", "2026-02-30T10:11:12Z"],
  ["rolled April", "2026-04-31T10:11:12Z"],
  ["month zero", "2026-00-27T10:11:12Z"],
  ["month thirteen", "2026-13-27T10:11:12Z"],
  ["day zero", "2026-10-00T10:11:12Z"],
  ["day thirty-two", "2026-10-32T10:11:12Z"],
  ["rolled midnight", "2026-10-27T24:00:00Z"],
  ["hour twenty-five", "2026-10-27T25:11:12Z"],
  ["minute sixty", "2026-10-27T10:60:12Z"],
  ["leap second", "2026-10-27T10:11:60Z"],
  ["nonzero positive offset", "2026-10-27T10:11:12+05:00"],
  ["nonzero negative offset", "2026-10-27T10:11:12-05:00"],
  ["unknown negative zero offset", "2026-10-27T10:11:12-00:00"],
  ["short UTC offset", "2026-10-27T10:11:12+0000"],
  ["no zone", "2026-10-27T10:11:12"],
  ["lowercase zone", "2026-10-27T10:11:12z"],
  ["space separator", "2026-10-27 10:11:12Z"],
  ["date only", "2026-10-27"],
  ["leading whitespace", " 2026-10-27T10:11:12Z"],
  ["trailing whitespace", "2026-10-27T10:11:12Z "],
  ["trailing newline", "2026-10-27T10:11:12Z\n"],
  ["embedded NUL", "2026-10-27T10:11:12\u0000Z"],
  ["empty fraction", "2026-10-27T10:11:12.Z"],
  ["seven fractional digits", "2026-10-27T10:11:12.1234567Z"],
  ["expanded year", "+020026-10-27T10:11:12Z"],
  ["numeric epoch", 1793095872000],
  ["numeric epoch string", "1793095872000"],
  ["boolean", true],
  ["null", null],
  ["array", [CONFIRMED_AT]],
  ["object", { value: CONFIRMED_AT }],
  ["object without toString", { toString: null }],
  ["empty string", ""],
];

for (const [label, timestamp] of invalidTimestamps) {
  test(`invalid confirmation ${label} cannot set contact proof`, { concurrency: false }, async () => {
    await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: timestamp }, async () => {
      const user = await requireAuthenticatedUser(request());
      assert.deepEqual(user, { id: USER_ID, email: EMAIL });
      assert.equal(Object.hasOwn(user, "emailConfirmed"), false, "unconfirmed shape stays backward compatible");
    });
  });
}

test("missing confirmation preserves the original exact user shape", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL }, async () => {
    assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID, email: EMAIL });
  });
});

for (const [label, email] of [
  ["undefined", undefined], ["null", null], ["empty", ""], ["whitespace", " \t\r\n"],
  ["number", 123], ["boolean", true], ["array", [EMAIL]], ["object", { email: EMAIL }],
] as Array<[string, unknown]>) {
  test(`confirmed timestamp without a string contact email (${label}) is not proof`, { concurrency: false }, async () => {
    await withAuth({ id: USER_ID, email, email_confirmed_at: CONFIRMED_AT }, async () => {
      assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID });
    });
  });
}

test("the existing email trim and case behavior is unchanged", { concurrency: false }, async () => {
  await withAuth({ id: ` ${USER_ID} `, email: "  Applicant@Example.invalid \t", email_confirmed_at: CONFIRMED_AT }, async () => {
    assert.deepEqual(await requireAuthenticatedUser(request()), {
      id: USER_ID, email: "Applicant@Example.invalid", emailConfirmed: true,
    });
  });
});

const forgedProofs: Array<[string, Record<string, unknown>]> = [
  ["user metadata confirmation", { user_metadata: { email_confirmed_at: CONFIRMED_AT, emailConfirmed: true, email_verified: true } }],
  ["app metadata confirmation", { app_metadata: { email_confirmed_at: CONFIRMED_AT, emailConfirmed: true, email_verified: true } }],
  ["root camel-case proof", { emailConfirmed: true }],
  ["root snake-case proof", { email_confirmed: true }],
  ["root verified marker", { email_verified: true }],
  ["general account confirmation", { confirmed_at: CONFIRMED_AT }],
  ["phone confirmation", { phone_confirmed_at: CONFIRMED_AT }],
  ["provider identity", { identities: [{ identity_data: { email: EMAIL, email_verified: true } }] }],
];

for (const [label, fields] of forgedProofs) {
  test(`${label} is not the Auth contact proof`, { concurrency: false }, async () => {
    await withAuth({ id: USER_ID, email: EMAIL, ...fields }, async () => {
      assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID, email: EMAIL });
    });
  });
}

test("metadata cannot supply the email missing from the trusted root", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email_confirmed_at: CONFIRMED_AT,
    user_metadata: { email: EMAIL }, app_metadata: { email: EMAIL } }, async () => {
    assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID });
  });
});

test("metadata cannot replace an explicitly null confirmation", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: null,
    user_metadata: { email_confirmed_at: CONFIRMED_AT }, app_metadata: { email_confirmed_at: CONFIRMED_AT } }, async () => {
    assert.deepEqual(await requireAuthenticatedUser(request()), { id: USER_ID, email: EMAIL });
  });
});

test("JWT confirmation, email, subject and owner claims are not trusted locally", { concurrency: false }, async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const forgedToken = `${encode({ alg: "none" })}.${encode({ sub: FORGED_ID, email: "forged@example.invalid",
    email_confirmed_at: CONFIRMED_AT, emailConfirmed: true, role: "owner", workspace_id: WORKSPACE_ID })}.synthetic`;
  await withAuth({ id: USER_ID, email: EMAIL }, async calls => {
    assert.deepEqual(await requireAuthenticatedUser(request(forgedToken)), { id: USER_ID, email: EMAIL });
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${forgedToken}`);
    assert.equal(calls[0].url, AUTH_URL);
  });
});

test("browser request fields cannot supply or override confirmed contact data", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL }, async () => {
    assert.deepEqual(await requireAuthenticatedUser(request(TOKEN, {
      query: { email_confirmed_at: CONFIRMED_AT, email: "forged@example.invalid" },
      body: { id: FORGED_ID, emailConfirmed: true, email_confirmed_at: CONFIRMED_AT },
    })), { id: USER_ID, email: EMAIL });
  });
});

test("verified contact proof cannot grant workspace membership", { concurrency: false }, async () => {
  const seen: Array<Record<string, string>> = [];
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT,
    role: "owner", user_metadata: { role: "owner", workspace_id: WORKSPACE_ID },
    app_metadata: { role: "owner", workspace_id: WORKSPACE_ID } }, async () => {
    await assert.rejects(requireWorkspaceAccess(request(), WORKSPACE_ID, membershipDeps([], seen)),
      expectAuthError(403, "workspace_access_denied"));
    assert.equal(seen.length, 1);
  });
});

test("contact proof does not upgrade the stored staff role or permission set", { concurrency: false }, async () => {
  const seen: Array<Record<string, string>> = [];
  const deps = membershipDeps([{ id: "synthetic-staff", workspace_id: WORKSPACE_ID, role: "receptionist", status: "active" }], seen);
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT,
    role: "owner", app_metadata: { role: "owner", permissions: ["view_admin"] } }, async () => {
    const context = await requireWorkspaceAccess(request(), WORKSPACE_ID, deps);
    assert.equal(context.userId, USER_ID);
    assert.equal(context.staffUserId, "synthetic-staff");
    assert.equal(context.workspaceId, WORKSPACE_ID);
    assert.equal(context.role, "receptionist");
    assert.ok(!context.permissions.includes("view_admin"));
    assert.ok(context.permissions.includes("view_clients"));
    assert.equal(Object.hasOwn(context, "emailConfirmed"), false, "contact proof is not a workspace permission");
    assert.deepEqual(seen, [{ auth_user_id: USER_ID, status: "active" }]);
  });
});

test("bootstrap memberships still use the immutable Auth id rather than confirmed email", { concurrency: false }, async () => {
  const seen: Array<Record<string, string>> = [];
  const deps = membershipDeps([{ id: "synthetic-staff", workspace_id: WORKSPACE_ID, role: "admin", status: "active" }], seen);
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT,
    user_metadata: { id: FORGED_ID, auth_user_id: FORGED_ID } }, async () => {
    const result = await listAuthContextMemberships(request(), deps);
    assert.equal(result.user.id, USER_ID);
    assert.equal(result.memberships.length, 1);
    assert.equal(result.memberships[0].role, "admin");
    assert.deepEqual(seen, [{ auth_user_id: USER_ID, status: "active" }]);
  });
});

for (const [label, id] of [["missing", undefined], ["null", null], ["empty", ""], ["whitespace", " \t"], ["number", 123]] as Array<[string, unknown]>) {
  test(`confirmed email does not replace a ${label} immutable Auth id`, { concurrency: false }, async () => {
    await withAuth({ id, email: EMAIL, email_confirmed_at: CONFIRMED_AT, user_metadata: { id: USER_ID } }, async () => {
      await assert.rejects(requireAuthenticatedUser(request()), expectAuthError(401, "authentication_required"));
    });
  });
}

test("verification uses one bounded authenticated GET with no redirect or token in URL", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT }, async calls => {
    await requireAuthenticatedUser(request());
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, AUTH_URL);
    assert.equal(new URL(url).search, "");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(headers.get("apikey"), SERVICE_KEY);
  });
});

for (const status of [302, 401, 403, 500]) {
  test(`an untrusted HTTP ${status} response cannot grant contact proof`, { concurrency: false }, async () => {
    await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT }, async () => {
      await assert.rejects(requireAuthenticatedUser(request()), expectAuthError(401, "authentication_required"));
    }, { status });
  });
}

test("Auth network failure remains unavailable rather than a verified contact", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT }, async () => {
    await assert.rejects(requireAuthenticatedUser(request()), expectAuthError(503, "authorization_unavailable"));
  }, { networkError: true });
});

test("malformed Auth JSON remains unauthenticated", { concurrency: false }, async () => {
  await withAuth(null, async () => {
    await assert.rejects(requireAuthenticatedUser(request()), expectAuthError(401, "authentication_required"));
  }, { raw: "not-json" });
});

for (const payload of [null, [], true, "user"]) {
  test(`non-record Auth payload ${JSON.stringify(payload)} cannot grant contact proof`, { concurrency: false }, async () => {
    await withAuth(payload, async () => {
      await assert.rejects(requireAuthenticatedUser(request()), expectAuthError(401, "authentication_required"));
    });
  });
}

test("missing bearer is rejected before any Auth request", { concurrency: false }, async () => {
  await withAuth({ id: USER_ID, email: EMAIL, email_confirmed_at: CONFIRMED_AT }, async calls => {
    await assert.rejects(requireAuthenticatedUser(request(TOKEN, { headers: {} })), expectAuthError(401, "authentication_required"));
    assert.equal(calls.length, 0);
  });
});

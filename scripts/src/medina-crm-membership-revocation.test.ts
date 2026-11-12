import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep the module, service client and verified JWT unchanged across requests.
// Only the in-memory membership rows change; no project or network is used.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const authServerUrl = pathToFileURL(path.join(repoRoot, "lib", "auth", "server.ts")).href;
const permissionsUrl = pathToFileURL(path.join(repoRoot, "lib", "auth", "permissions.ts")).href;
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "header.payload.signature";
const AUTH_URL = "https://membership-revocation.example.test";
const SERVICE_KEY = "membership-revocation-test-key";

const roleCases = [
  { role: "owner", changedRole: "manager", permission: "manage_staff" },
  { role: "admin", changedRole: "manager", permission: "manage_staff" },
  { role: "manager", changedRole: "receptionist", permission: "view_admin" },
  { role: "receptionist", changedRole: "lead_manager", permission: "manage_directory" },
  { role: "lead_manager", changedRole: "doctor", permission: "manage_leads" },
] as const;

type StaffRow = {
  id: string;
  auth_user_id: string;
  workspace_id: string;
  role: string;
  status: string;
};
type AccessOptions = { roles?: readonly string[]; permission?: string };
type Deps = { getSupabaseClient: () => unknown };
type AccessContext = {
  userId: string;
  staffUserId: string;
  workspaceId: string;
  role: string;
  permissions: string[];
};
type Bootstrap = {
  user: { id: string };
  memberships: Array<Omit<AccessContext, "userId">>;
};
type AuthServerModule = {
  requireWorkspaceAccess: (req: unknown, workspaceId?: string, options?: AccessOptions & Deps) => Promise<AccessContext>;
  requireWorkspaceAdmin: (req: unknown, workspaceId: string, deps: Deps) => Promise<Omit<AccessContext, "permissions">>;
  listAuthContextMemberships: (req: unknown, deps: Deps) => Promise<Bootstrap>;
};
type Lookup = { table: string; columns: string; filters: Array<[string, string]> };
type QueryResult = { data: StaffRow[] | null; error: { message: string } | null };

function primary(role: string, status = "active"): StaffRow {
  return { id: "staff-a", auth_user_id: USER_ID, workspace_id: WORKSPACE_A, role, status };
}

async function withAuth(t: TestContext, role: string, run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  await run(await harness(t, role));
}

async function harness(t: TestContext, role: string) {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  });
  process.env.SUPABASE_URL = AUTH_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

  let authCalls = 0;
  t.mock.method(globalThis, "fetch", (async (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
  }) => {
    authCalls += 1;
    assert.equal(url, `${AUTH_URL}/auth/v1/user`, "no non-Auth fetch is permitted");
    assert.equal(init?.method, "GET");
    assert.equal(init?.headers?.Authorization, `Bearer ${TOKEN}`, "every request uses the identical JWT");
    assert.equal(init?.headers?.apikey, SERVICE_KEY);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: USER_ID,
        // Even stale privileged claims in a verified response are not authority.
        app_metadata: { role: "owner", workspace_id: WORKSPACE_A },
        user_metadata: { role: "owner" },
      }),
    };
  }) as unknown as typeof fetch);

  const independent: StaffRow = { ...primary("owner"), id: "staff-b", workspace_id: WORKSPACE_B };
  const otherUser: StaffRow = { ...primary("owner"), id: "other-user-staff", auth_user_id: OTHER_USER_ID };
  let rows: StaffRow[] = [];
  function setPrimary(row: StaffRow | null) {
    rows = [...(row ? [{ ...row }] : []), { ...independent }, { ...otherUser }];
  }
  setPrimary(primary(role));

  let failure: "error" | "throw" | undefined;
  let clientCalls = 0;
  const lookups: Lookup[] = [];
  const client = {
    from(table: string) {
      const lookup: Lookup = { table, columns: "", filters: [] };
      const builder = {
        select(columns: string) {
          lookup.columns = columns;
          return builder;
        },
        eq(column: string, value: string) {
          lookup.filters.push([column, value]);
          return builder;
        },
        then(resolve: (result: QueryResult) => void) {
          lookups.push(lookup);
          if (failure === "throw") throw new Error("mock membership lookup failed");
          if (failure === "error") {
            resolve({ data: null, error: { message: "mock membership lookup failed" } });
            return;
          }
          const data = rows.filter((row) => lookup.filters.every(([column, value]) => (
            row[column as keyof StaffRow] === value
          )));
          resolve({ data: data.map((row) => ({ ...row })), error: null });
        },
      };
      return builder;
    },
  };
  const deps: Deps = { getSupabaseClient: () => { clientCalls += 1; return client; } };
  // Import the same URL every time: never reload the module to clear a cache.
  const mod = await import(authServerUrl) as AuthServerModule;
  const permissions = await import(permissionsUrl) as { permissionsForRole: (role: string) => string[] };
  let requests = 0;

  async function nextRequest<T>(authorize: (req: unknown) => Promise<T>): Promise<T> {
    requests += 1;
    try {
      return await authorize({
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { workspaceId: WORKSPACE_A },
        body: { role: "owner", permissions: ["manage_staff"] },
      });
    } finally {
      assert.equal(authCalls, requests, "each new request must verify the same JWT again");
      assert.equal(clientCalls, requests, "each new request must resolve the service client again");
      assert.equal(lookups.length, requests, "each new request must await a fresh membership read");
      assert.deepEqual(lookups.at(-1), {
        table: "staff_users",
        columns: "id, workspace_id, role, status",
        filters: [["auth_user_id", USER_ID], ["status", "active"]],
      }, "every membership read must be active and scoped to the verified user");
    }
  }

  function assertContext(context: AccessContext, expectedRole: string, workspaceId = WORKSPACE_A) {
    assert.deepEqual(context, {
      userId: USER_ID,
      staffUserId: workspaceId === WORKSPACE_A ? "staff-a" : "staff-b",
      workspaceId,
      role: expectedRole,
      permissions: permissions.permissionsForRole(expectedRole),
    });
  }

  return {
    setPrimary,
    setFailure: (value?: typeof failure) => { failure = value; },
    assertContext,
    access: (workspaceId = WORKSPACE_A, options: AccessOptions = {}) => (
      nextRequest((req) => mod.requireWorkspaceAccess(req, workspaceId, { ...deps, ...options }))
    ),
    admin: (workspaceId = WORKSPACE_A) => nextRequest((req) => mod.requireWorkspaceAdmin(req, workspaceId, deps)),
    bootstrap: () => nextRequest((req) => mod.listAuthContextMemberships(req, deps)),
  };
}

async function expectDenied(result: Promise<unknown>) {
  await assert.rejects(result, {
    name: "WorkspaceAdminAuthError",
    statusCode: 403,
    code: "workspace_access_denied",
    message: "Access denied",
  });
}

for (const { role, changedRole, permission } of roleCases) {
  test(`${role}: ${changedRole} role change revokes ${permission} on the next same-JWT request`, async (t) => {
    await withAuth(t, role, async (h) => {
      const before = await h.access(WORKSPACE_A, { permission, roles: [role] });
      h.assertContext(before, role);
      assert.ok(before.permissions.includes(permission));

      h.setPrimary(primary(changedRole));
      await expectDenied(h.access(WORKSPACE_A, { permission }));
      const after = await h.access();
      h.assertContext(after, changedRole);
      assert.ok(!after.permissions.includes(permission), "old privileges must not survive reassignment");
      await expectDenied(h.access(WORKSPACE_A, { roles: [role] }));

      const independent = await h.access(WORKSPACE_B, { permission });
      h.assertContext(independent, "owner", WORKSPACE_B);
      const bootstrap = await h.bootstrap();
      assert.equal(bootstrap.user.id, USER_ID);
      assert.deepEqual(bootstrap.memberships, [
        { staffUserId: "staff-a", workspaceId: WORKSPACE_A, role: changedRole, permissions: after.permissions },
        { staffUserId: "staff-b", workspaceId: WORKSPACE_B, role: "owner", permissions: independent.permissions },
      ]);
      await expectDenied(h.access(WORKSPACE_A, { permission }));
      h.setPrimary(primary(role));
      h.assertContext(await h.access(WORKSPACE_A, { permission }), role);
    });
  });

  for (const mutation of ["inactive", "removed"] as const) {
    test(`${role}: ${mutation} membership denies the next same-JWT request without borrowing workspace B`, async (t) => {
      await withAuth(t, role, async (h) => {
        h.assertContext(await h.access(WORKSPACE_A, { permission }), role);
        h.setPrimary(mutation === "inactive" ? primary(role, "inactive") : null);

        await expectDenied(h.access());
        await expectDenied(h.access(WORKSPACE_A, { permission }));
        const independent = await h.access(WORKSPACE_B, { permission });
        h.assertContext(independent, "owner", WORKSPACE_B);
        const bootstrap = await h.bootstrap();
        assert.equal(bootstrap.user.id, USER_ID);
        assert.deepEqual(bootstrap.memberships, [{
          staffUserId: "staff-b", workspaceId: WORKSPACE_B, role: "owner", permissions: independent.permissions,
        }], "the revoked membership and another user's active row must not leak into bootstrap");
        await expectDenied(h.access());

        h.setPrimary(primary(role));
        h.assertContext(await h.access(WORKSPACE_A, { permission }), role);
      });
    });
  }
}

test("owner to admin loses the owner-only role gate even though their permission sets are identical", async (t) => {
  await withAuth(t, "owner", async (h) => {
    const before = await h.access(WORKSPACE_A, { roles: ["owner"] });
    h.assertContext(before, "owner");
    h.setPrimary(primary("admin"));
    await expectDenied(h.access(WORKSPACE_A, { roles: ["owner"] }));
    const after = await h.access(WORKSPACE_A, { permission: "manage_staff" });
    h.assertContext(after, "admin");
    assert.deepEqual([...after.permissions].sort(), [...before.permissions].sort());
  });
});

for (const role of ["owner", "admin"] as const) {
  for (const mutation of ["downgraded", "inactive", "removed"] as const) {
    test(`${role}: requireWorkspaceAdmin rechecks ${mutation} membership with the same JWT`, async (t) => {
      await withAuth(t, role, async (h) => {
        assert.deepEqual(await h.admin(), {
          userId: USER_ID, staffUserId: "staff-a", workspaceId: WORKSPACE_A, role,
        });
        h.setPrimary(mutation === "removed" ? null : primary(
          mutation === "downgraded" ? "manager" : role,
          mutation === "inactive" ? "inactive" : "active",
        ));
        await expectDenied(h.admin());
        assert.deepEqual(await h.admin(WORKSPACE_B), {
          userId: USER_ID, staffUserId: "staff-b", workspaceId: WORKSPACE_B, role: "owner",
        });
        await expectDenied(h.admin());
        h.setPrimary(primary(role));
        assert.equal((await h.admin()).role, role);
      });
    });
  }
}

for (const failure of ["error", "throw"] as const) {
  test(`membership lookup ${failure} fails closed after a previous grant`, async (t) => {
    await withAuth(t, "owner", async (h) => {
      h.assertContext(await h.access(WORKSPACE_A, { permission: "manage_staff" }), "owner");
      h.setPrimary(null);
      h.setFailure(failure);
      await assert.rejects(h.access(WORKSPACE_A, { permission: "manage_staff" }), {
        name: "WorkspaceAdminAuthError",
        statusCode: 503,
        code: "authorization_unavailable",
        message: "Authorization service unavailable",
      });
      h.setFailure(undefined);
      await expectDenied(h.access());
    });
  });
}

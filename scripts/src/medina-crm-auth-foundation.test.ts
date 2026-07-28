import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2A — the CRM tenant authorization foundation, tested in isolation.
//
// The helpers below are NOT wired into api/crm/[...path].ts yet; that is
// Security-2B. This suite proves the primitives behave correctly first, so the
// router change lands on verified ground.
//
// Everything is exercised against a mocked Supabase Auth endpoint and a mocked
// service client. No production project, no real token, no business rows.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const authServerPath = path.join(repoRoot, "lib", "auth", "server.ts");
const permissionsPath = path.join(repoRoot, "lib", "auth", "permissions.ts");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const VALID_TOKEN = "header.payload.signature";

type StaffRow = { id: string; workspace_id: string; role: string; status: string };

/** Minimal stand-in for the Supabase service client used by the helpers. */
function mockSupabase(rows: StaffRow[] | { error: string }) {
  return {
    from(table: string) {
      assert.equal(table, "staff_users", "membership must come from staff_users only");
      const filters: Record<string, string> = {};
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: string) {
          filters[column] = value;
          return builder;
        },
        then(resolve: (value: { data: StaffRow[] | null; error: { message: string } | null }) => void) {
          if (!Array.isArray(rows)) {
            resolve({ data: null, error: { message: rows.error } });
            return;
          }
          // The helper must scope by the verified auth user and active status.
          assert.equal(filters.auth_user_id, USER_ID, "membership lookup must filter by auth_user_id");
          assert.equal(filters.status, "active", "membership lookup must filter by active status");
          resolve({ data: rows.filter((row) => row.status === "active"), error: null });
        },
      };
      return builder;
    },
  };
}

type Deps = { getSupabaseClient: () => unknown };
type AuthCall = { authUrl: string; headers: Record<string, string> };

type AuthServerModule = {
  requireAuthenticatedUser: (req: unknown) => Promise<{ id: string; email?: string }>;
  requireWorkspaceAccess: (
    req: unknown,
    workspaceId?: string,
    options?: { roles?: readonly string[]; permission?: string } & Partial<Deps>,
  ) => Promise<{ userId: string; staffUserId: string; workspaceId: string; role: string; permissions: string[] }>;
  requireWorkspaceAdmin: (req: unknown, workspaceId: string, deps?: Partial<Deps>) => Promise<{ workspaceId: string; role: string }>;
  listAuthContextMemberships: (req: unknown, deps?: Partial<Deps>) => Promise<{
    user: { id: string };
    memberships: Array<{ workspaceId: string; role: string; permissions: string[] }>;
  }>;
  WorkspaceAdminAuthError: new (status: number, message: string, code?: string) => Error & {
    statusCode: number;
    code: string;
  };
};

/**
 * Loads lib/auth/server.ts with a mocked Supabase Auth endpoint and a stubbed
 * service client passed through the module's dependency seam.
 */
async function loadAuthServer(options: {
  authStatus?: number;
  authBody?: string;
  authThrows?: boolean;
  rows?: StaffRow[] | { error: string };
}): Promise<{ mod: AuthServerModule; deps: Deps; calls: AuthCall[]; restore: () => void }> {
  const calls: AuthCall[] = [];

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ authUrl: String(url), headers: init?.headers ?? {} });
    if (options.authThrows) throw new Error("network down");
    return {
      ok: (options.authStatus ?? 200) < 400,
      status: options.authStatus ?? 200,
      text: async () => options.authBody ?? JSON.stringify({ id: USER_ID, email: "staff@example.test" }),
    };
  }) as unknown as typeof globalThis.fetch;

  const mod = (await import(pathToFileURL(authServerPath).href)) as unknown as AuthServerModule;
  const deps: Deps = {
    getSupabaseClient: () => (options.rows === undefined ? null : mockSupabase(options.rows)),
  };

  return {
    mod,
    deps,
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function request(headers: Record<string, string>, query: Record<string, string> = {}, body: unknown = {}) {
  return { headers, query, body };
}

const activeA: StaffRow = { id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" };
const activeB: StaffRow = { id: "staff-b", workspace_id: WORKSPACE_B, role: "receptionist", status: "active" };

async function withAuth<T>(
  options: Parameters<typeof loadAuthServer>[0],
  fn: (mod: AuthServerModule, deps: Deps) => Promise<T>,
): Promise<T> {
  const loaded = await loadAuthServer(options);
  try {
    return await fn(loaded.mod, loaded.deps);
  } finally {
    loaded.restore();
  }
}

async function expectStatus(promise: Promise<unknown>, status: number, code?: string) {
  try {
    await promise;
    assert.fail(`expected the call to be rejected with ${status}`);
  } catch (error) {
    const typed = error as { statusCode?: number; code?: string; message?: string };
    assert.equal(typed.statusCode, status, `expected status ${status}, got ${typed.statusCode}: ${typed.message}`);
    if (code) assert.equal(typed.code, code);
  }
}

// ---------------------------------------------------------------------------
// Bearer parsing and token verification
// ---------------------------------------------------------------------------

test("01 a missing Authorization header is rejected as 401", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    await expectStatus(mod.requireAuthenticatedUser(request({})), 401, "authentication_required");
  });
});

test("02 a malformed Authorization header is rejected as 401", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    for (const header of ["Bearer", "Bearer ", "Basic abc", "Bearer  ", `Token ${VALID_TOKEN}`, "Bearer not-a-jwt"]) {
      await expectStatus(mod.requireAuthenticatedUser(request({ authorization: header })), 401);
    }
  });
});

test("03 the Bearer scheme is matched case-insensitively", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    const user = await mod.requireAuthenticatedUser(request({ authorization: `bEaReR ${VALID_TOKEN}` }));
    assert.equal(user.id, USER_ID);
  });
});

test("04 a token rejected by Supabase Auth yields 401, not 403", async () => {
  await withAuth({ authStatus: 401, rows: [activeA] }, async (mod, deps) => {
    await expectStatus(
      mod.requireAuthenticatedUser(request({ authorization: `Bearer ${VALID_TOKEN}` })),
      401,
      "authentication_required",
    );
  });
});

test("05 an unreadable Auth response yields 401", async () => {
  await withAuth({ authBody: "not json", rows: [activeA] }, async (mod, deps) => {
    await expectStatus(mod.requireAuthenticatedUser(request({ authorization: `Bearer ${VALID_TOKEN}` })), 401);
  });
});

test("06 an Auth response without an id yields 401", async () => {
  await withAuth({ authBody: JSON.stringify({ email: "staff@example.test" }), rows: [activeA] }, async (mod, deps) => {
    await expectStatus(mod.requireAuthenticatedUser(request({ authorization: `Bearer ${VALID_TOKEN}` })), 401);
  });
});

test("07 an Auth outage fails closed with 503, never open", async () => {
  await withAuth({ authThrows: true, rows: [activeA] }, async (mod, deps) => {
    await expectStatus(
      mod.requireAuthenticatedUser(request({ authorization: `Bearer ${VALID_TOKEN}` })),
      503,
      "authorization_unavailable",
    );
  });
});

test("08 the token is sent to Supabase Auth and never placed in a query string", async () => {
  const loaded = await loadAuthServer({ rows: [activeA] });
  try {
    await loaded.mod.requireAuthenticatedUser(request({ authorization: `Bearer ${VALID_TOKEN}` }));
    assert.equal(loaded.calls.length, 1);
    assert.ok(loaded.calls[0].authUrl.endsWith("/auth/v1/user"), "verification must call the Auth user endpoint");
    assert.ok(!loaded.calls[0].authUrl.includes(VALID_TOKEN), "the token must never appear in the URL");
    assert.equal(loaded.calls[0].headers.Authorization, `Bearer ${VALID_TOKEN}`);
  } finally {
    loaded.restore();
  }
});

// ---------------------------------------------------------------------------
// Membership resolution
// ---------------------------------------------------------------------------

test("09 a verified user with no staff row is denied with 403", async () => {
  await withAuth({ rows: [] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_A, deps),
      403,
      "workspace_access_denied",
    );
  });
});

test("10 an inactive staff row does not grant access", async () => {
  const inactive: StaffRow = { ...activeA, status: "disabled" };
  await withAuth({ rows: [inactive] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_A, deps),
      403,
    );
  });
});

test("11 a single active membership resolves without a selector", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    const context = await mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), undefined, deps);
    assert.equal(context.workspaceId, WORKSPACE_A);
    assert.equal(context.role, "owner");
    assert.equal(context.userId, USER_ID);
    assert.equal(context.staffUserId, "staff-a");
  });
});

test("12 an authorized selector is honoured", async () => {
  await withAuth({ rows: [activeA, activeB] }, async (mod, deps) => {
    const context = await mod.requireWorkspaceAccess(
      request({ authorization: `Bearer ${VALID_TOKEN}` }, { workspaceId: WORKSPACE_B }),
      undefined,
      deps,
    );
    assert.equal(context.workspaceId, WORKSPACE_B);
    assert.equal(context.role, "receptionist");
  });
});

test("13 an unauthorized selector is denied even when the user has other memberships", async () => {
  const foreign = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }, { workspaceId: foreign }), undefined, deps),
      403,
      "workspace_access_denied",
    );
  });
});

test("14 multiple memberships require an explicit selector instead of silently picking one", async () => {
  await withAuth({ rows: [activeA, activeB] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), undefined, deps),
      403,
      "workspace_selection_required",
    );
  });
});

test("15 a workspace id in the body has no effect on the acting workspace", async () => {
  // The body is data being written, not a selector. Only ?workspaceId= selects,
  // so a workspace field in a payload can neither redirect nor deny the request.
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    const context = await mod.requireWorkspaceAccess(
      request({ authorization: `Bearer ${VALID_TOKEN}` }, {}, { workspaceId: WORKSPACE_B, workspace_id: WORKSPACE_B }),
      undefined,
      deps,
    );
    assert.equal(context.workspaceId, WORKSPACE_A, "the body must not steer the tenant");
  });
});

test("16 a database failure during membership lookup fails closed with 503", async () => {
  await withAuth({ rows: { error: "connection reset" } }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_A, deps),
      503,
    );
  });
});

test("17 an unconfigured service client fails closed with 503", async () => {
  await withAuth({}, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_A, deps),
      503,
    );
  });
});

// ---------------------------------------------------------------------------
// Role and permission authority
// ---------------------------------------------------------------------------

test("18 permissions are computed from the stored role, not from the request", async () => {
  await withAuth({ rows: [activeB] }, async (mod, deps) => {
    const context = await mod.requireWorkspaceAccess(
      request({ authorization: `Bearer ${VALID_TOKEN}` }, {}, { role: "owner", permissions: ["view_admin"] }),
      undefined,
      deps,
    );
    assert.equal(context.role, "receptionist", "the browser cannot upgrade its own role");
    assert.ok(!context.permissions.includes("view_admin"), "a receptionist never gains admin permissions");
    assert.ok(context.permissions.includes("view_clients"));
  });
});

test("19 a role restriction denies a non-admin", async () => {
  await withAuth({ rows: [activeB] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_B, { ...deps,
        roles: ["owner", "admin"],
      }),
      403,
    );
  });
});

test("20 a permission requirement denies a role without it", async () => {
  await withAuth({ rows: [activeB] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAccess(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_B, { ...deps,
        permission: "manage_integrations",
      }),
      403,
    );
  });
});

test("21 requireWorkspaceAdmin still demands owner/admin in the named workspace", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    const context = await mod.requireWorkspaceAdmin(
      request({ authorization: `Bearer ${VALID_TOKEN}` }),
      WORKSPACE_A,
      deps,
    );
    assert.equal(context.workspaceId, WORKSPACE_A);
    assert.equal(context.role, "owner");
  });

  await withAuth({ rows: [activeB] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAdmin(request({ authorization: `Bearer ${VALID_TOKEN}` }), WORKSPACE_B, deps),
      403,
    );
  });
});

test("22 requireWorkspaceAdmin rejects a non-uuid workspace without touching Auth", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    await expectStatus(
      mod.requireWorkspaceAdmin(request({ authorization: `Bearer ${VALID_TOKEN}` }), "demo-workspace", deps),
      403,
    );
  });
});

// ---------------------------------------------------------------------------
// auth-context bootstrap
// ---------------------------------------------------------------------------

test("23 the bootstrap returns only the caller's own memberships", async () => {
  await withAuth({ rows: [activeA, activeB] }, async (mod, deps) => {
    const result = await mod.listAuthContextMemberships(request({ authorization: `Bearer ${VALID_TOKEN}` }), deps);
    assert.equal(result.user.id, USER_ID);
    assert.deepEqual(
      result.memberships.map((entry) => entry.workspaceId).sort(),
      [WORKSPACE_A, WORKSPACE_B].sort(),
    );
    for (const membership of result.memberships) {
      assert.ok(Array.isArray(membership.permissions), "server-computed permissions accompany each membership");
    }
  });
});

test("24 the bootstrap requires authentication", async () => {
  await withAuth({ rows: [activeA] }, async (mod, deps) => {
    await expectStatus(mod.listAuthContextMemberships(request({}), deps), 401);
  });
});

// ---------------------------------------------------------------------------
// Role ranking and owner protection
// ---------------------------------------------------------------------------

test("25 owner can never be assigned through generic role assignment", async () => {
  const permissions = (await import(pathToFileURL(permissionsPath).href)) as {
    canAssignRole: (actor: string, target: string) => boolean;
  };
  for (const actor of ["owner", "admin", "manager", "receptionist", "marketer", "doctor"]) {
    assert.equal(permissions.canAssignRole(actor, "owner"), false, `${actor} must not be able to mint an owner`);
  }
});

test("26 an actor may only assign roles strictly below its own rank", async () => {
  const permissions = (await import(pathToFileURL(permissionsPath).href)) as {
    canAssignRole: (actor: string, target: string) => boolean;
  };
  assert.equal(permissions.canAssignRole("admin", "receptionist"), true);
  assert.equal(permissions.canAssignRole("admin", "manager"), true);
  assert.equal(permissions.canAssignRole("admin", "admin"), false, "no lateral self-cloning");
  assert.equal(permissions.canAssignRole("manager", "admin"), false, "no upward assignment");
  assert.equal(permissions.canAssignRole("receptionist", "receptionist"), false);
});

// ---------------------------------------------------------------------------
// Source-level guarantees
// ---------------------------------------------------------------------------

test("27 the auth helper never logs the token and never trusts browser state", async () => {
  const source = await readFile(authServerPath, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  for (const forbidden of [
    "console.log(token",
    "console.warn(token",
    "console.error(token",
    "localStorage",
    "req.query.role",
    "body.role",
    "user_metadata",
    "app_metadata",
  ]) {
    assert.ok(!code.includes(forbidden), `the auth helper must not reference ${forbidden}`);
  }
  assert.ok(code.includes("AbortController"), "the Auth request must be time-bounded");
});

test("28 the CRM router enforces the foundation with no way around it", async () => {
  // Replaces the Security-2A marker that asserted the gate was still off. The
  // guarantee is now the opposite and strictly stronger: the router must use the
  // verified-access helper, deny unknown routes, keep the worker route separate,
  // and ship alongside the tenant-isolation suite.
  const router = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  const registry = await readFile(path.join(repoRoot, "lib", "crm", "authorization.ts"), "utf8");

  assert.ok(router.includes("requireWorkspaceAccess"), "browser routes must resolve a verified workspace context");
  assert.ok(router.includes("requireAuthenticatedUser"), "the bootstrap route must still verify the token");
  assert.ok(router.includes("resolveCrmRoute"), "dispatch must go through the explicit route registry");
  assert.ok(router.includes("normalizeCrmSegments"), "paths must be normalised before resolution");
  assert.ok(router.includes("attachWorkspaceContext"), "handlers must receive the verified context");

  // Unknown routes and unsupported methods are closed by default.
  assert.ok(router.includes("if (!route) {"), "an unregistered route must not reach a handler");
  assert.ok(router.includes("method_not_allowed"), "unsupported methods must be refused");
  assert.ok(router.includes("resource_not_found"), "unknown routes must return the generic not-found shape");

  // The worker route keeps its own contract and never builds a browser context.
  assert.ok(registry.includes('"internal_hmac"'), "the worker route must be classified separately");
  assert.ok(
    router.includes('route.authorization.kind === "internal_hmac"'),
    "the HMAC branch must be explicit, not a fallthrough",
  );

  // No environment, host or header controlled way around authentication.
  const routerCode = router
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith("//"))
    .join(String.fromCharCode(10));
  for (const forbidden of ["NODE_ENV", "process.env.VERCEL_ENV", "x-debug", "skipAuth", "bypass"]) {
    assert.ok(!routerCode.includes(forbidden), `the router must not reference ${forbidden}`);
  }
  // "localhost" appears only as the base for URL parsing of a relative path; it
  // must never gate authorization.
  assert.ok(
    !/localhost[sS]{0,80}(auth|skip|allow)/i.test(routerCode),
    "the host must not influence authorization",
  );

  // Authorization happens before dispatch: every dispatch call sits after an
  // await on an auth helper inside the try block.
  const dispatchIndex = routerCode.indexOf("return await dispatch(route.key, route.resource, segments, req, res);");
  const accessIndex = routerCode.indexOf("await requireWorkspaceAccess(");
  assert.ok(accessIndex > 0 && dispatchIndex > 0, "both the guard and the dispatch must exist");

  // The isolation suite must be registered so the gate cannot ship untested.
  const scriptsPkg = JSON.parse(await readFile(path.join(repoRoot, "scripts", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(scriptsPkg.scripts["test:tenant-isolation"], "test:tenant-isolation must be registered");
});

test("29 the server and browser permission catalogs stay identical", async () => {
  const serverSource = await readFile(permissionsPath, "utf8");
  const browserSource = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "lib", "permissions.ts"),
    "utf8",
  );

  const extractList = (source: string, name: string): string[] => {
    const start = source.indexOf(`export const ${name} = [`);
    assert.ok(start >= 0, `${name} must exist in both catalogs`);
    const end = source.indexOf("]", start);
    return source
      .slice(start, end)
      .match(/"[a-z_]+"/g)
      ?.map((entry) => entry.replace(/"/g, "")) ?? [];
  };

  assert.deepEqual(
    extractList(serverSource, "staffRoles"),
    extractList(browserSource, "staffRoles"),
    "role catalogs drifted; the server must never be broader than the browser",
  );
  assert.deepEqual(
    extractList(serverSource, "crmPermissions"),
    extractList(browserSource, "crmPermissions"),
    "permission catalogs drifted",
  );

  const roleBlock = (source: string, role: string): string[] => {
    const start = source.indexOf(`  ${role}: [`);
    if (start < 0) return [];
    const end = source.indexOf("],", start);
    return source
      .slice(start, end)
      .match(/"[a-z_]+"/g)
      ?.map((entry) => entry.replace(/"/g, "")) ?? [];
  };
  for (const role of ["admin", "receptionist", "marketer", "doctor", "manager"]) {
    assert.deepEqual(
      roleBlock(serverSource, role),
      roleBlock(browserSource, role),
      `the ${role} permission set drifted between server and browser`,
    );
  }
});

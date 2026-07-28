import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2B — tenant isolation for /api/crm/*.
//
// service_role bypasses RLS, so isolation is an application guarantee. These
// tests drive the real router with a mocked Supabase Auth endpoint and a spying
// CRM client, and assert both the response and, crucially, that no query for a
// foreign workspace is ever issued. Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const registryPath = path.join(repoRoot, "lib", "crm", "authorization.ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature";

type StaffRow = { id: string; workspace_id: string; role: string; status: string };

type QueryLog = { table: string; filters: Record<string, unknown>; op: string };

/** Records every table touched and every filter applied. */
function spyClient(rows: Record<string, unknown[]>, log: QueryLog[]) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, filters: {}, op: "select" };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        delete: () => { entry.op = "delete"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        eq(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        then(resolve: (value: { data: unknown; error: null; count?: number }) => void) {
          const table_rows = rows[table] ?? [];
          resolve({ data: table_rows, error: null, count: table_rows.length });
        },
      });
      return builder;
    },
  };
}

type LoadOptions = {
  memberships?: StaffRow[];
  authOk?: boolean;
  authThrows?: boolean;
  rows?: Record<string, unknown[]>;
};

type MockResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  status: (code: number) => MockResponse;
  setHeader: () => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: {},
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
    json(payload) { res.body = (payload ?? {}) as Record<string, unknown>; return res; },
  };
  return res;
}

/**
 * Loads the real router with mocked Auth and a spying CRM client, and returns a
 * callable that performs a request end to end.
 */
async function loadRouter(options: LoadOptions) {
  const log: QueryLog[] = [];
  const memberships = options.memberships ?? [];

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (options.authThrows) throw new Error("auth down");
    const ok = options.authOk !== false;
    return {
      ok,
      status: ok ? 200 : 401,
      text: async () => (ok ? JSON.stringify({ id: USER_A, email: "a@example.test" }) : "{}"),
    };
  }) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  const clientRows: Record<string, unknown[]> = { staff_users: memberships, ...(options.rows ?? {}) };

  // The CRM data client is the thing that must never appear before auth, so it
  // is counted separately from the staff_users membership lookup.
  let crmClientCreations = 0;
  supabaseModule.setSupabaseServerClientFactoryForTests(() => {
    crmClientCreations += 1;
    return spyClient(clientRows, log);
  });

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (input: {
    segments: string[];
    method?: string;
    query?: Record<string, unknown>;
    body?: unknown;
    token?: string | null;
  }) => {
    log.length = 0;
    const res = mockResponse();
    const headers: Record<string, string> = {};
    const token = input.token === undefined ? TOKEN : input.token;
    if (token) headers.authorization = `Bearer ${token}`;
    await routerModule.default(
      {
        method: input.method ?? "GET",
        headers,
        query: { path: input.segments, ...(input.query ?? {}) },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log] };
  };

  return {
    call,
    log,
    get crmClientCreations() { return crmClientCreations; },
    restore: () => {
      globalThis.fetch = originalFetch;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
    },
  };
}

const memberA: StaffRow = { id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" };
const memberBReception: StaffRow = { id: "staff-b", workspace_id: WORKSPACE_B, role: "receptionist", status: "active" };

async function withRouter<T>(options: LoadOptions, fn: (ctx: Awaited<ReturnType<typeof loadRouter>>) => Promise<T>) {
  const ctx = await loadRouter(options);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

/** Tables that hold tenant data; the membership lookup is not one of them. */
function businessQueries(log: QueryLog[]): QueryLog[] {
  return log.filter((entry) => entry.table !== "staff_users");
}

// ===========================================================================
// A. Authentication
// ===========================================================================

test("A1 a request with no Authorization header is refused with 401", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"], token: null });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "authentication_required");
  });
});

test("A2 an empty or malformed bearer value is refused with 401", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    for (const token of ["", "   ", "not-a-jwt", "a.b"]) {
      const { res } = await ctx.call({ segments: ["leads"], token });
      assert.equal(res.statusCode, 401, `token ${JSON.stringify(token)} must be refused`);
    }
  });
});

test("A3 a token Supabase Auth rejects is refused with 401", async () => {
  await withRouter({ memberships: [memberA], authOk: false }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 401);
  });
});

test("A4 an Auth outage fails closed with 503 and never falls open", async () => {
  await withRouter({ memberships: [memberA], authThrows: true }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "authorization_unavailable");
  });
});

test("A5 an unauthenticated request issues no business query at all", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { log } = await ctx.call({ segments: ["leads"], token: null });
    assert.equal(businessQueries(log).length, 0, "no CRM table may be touched before authentication");
  });
});

test("A6 a token in the query string or body is never accepted", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["leads"],
      token: null,
      query: { access_token: TOKEN, token: TOKEN },
      body: { access_token: TOKEN },
    });
    assert.equal(res.statusCode, 401, "only the Authorization header may carry a token");
  });
});

test("A7 the router never logs a token", async () => {
  const source = await readFile(routerPath, "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  assert.ok(!code.includes("console.log"), "the router must not log request material");
  assert.ok(!code.includes("authorization]"), "the raw header must not be echoed");
});

// ===========================================================================
// B. Membership
// ===========================================================================

test("B1 a verified user with no membership is refused with 403", async () => {
  await withRouter({ memberships: [] }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "workspace_access_denied");
    assert.equal(businessQueries(log).length, 0);
  });
});

test("B2 an inactive membership grants nothing", async () => {
  await withRouter({ memberships: [{ ...memberA, status: "disabled" }] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 403);
  });
});

test("B3 a single active membership is inferred without a selector", async () => {
  await withRouter({ memberships: [memberA], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 200);
    const leadQuery = businessQueries(log).find((entry) => entry.table === "leads");
    assert.ok(leadQuery, "the leads table must be queried");
    assert.equal(leadQuery?.filters.workspace_id, WORKSPACE_A);
  });
});

test("B4 selecting a workspace the user does not belong to is refused", async () => {
  await withRouter({ memberships: [memberA], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "workspace_access_denied");
    assert.equal(businessQueries(log).length, 0, "a foreign selector must be refused before any query");
  });
});

test("B5 several memberships require an explicit choice", async () => {
  await withRouter({ memberships: [memberA, memberBReception] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "workspace_selection_required");
  });
});

test("B6 an authorized selector picks that workspace", async () => {
  await withRouter({ memberships: [memberA, memberBReception], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 200);
    assert.equal(businessQueries(log).find((entry) => entry.table === "leads")?.filters.workspace_id, WORKSPACE_B);
  });
});

test("B7 a workspace in the body cannot override the verified context", async () => {
  await withRouter({ memberships: [memberA], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({
      segments: ["leads"],
      method: "POST",
      body: { name: "Test", phone: "+70000000000", workspaceId: WORKSPACE_B, workspace_id: WORKSPACE_B },
    });
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `create should succeed, got ${res.statusCode}`);
    const insert = businessQueries(log).find((entry) => entry.op === "insert");
    const row = insert?.filters.__row as Record<string, unknown> | undefined;
    assert.equal(row?.workspace_id, WORKSPACE_A, "create must use the verified workspace");
  });
});

test("B8 a browser-supplied role or permission list is ignored", async () => {
  await withRouter({ memberships: [memberBReception], rows: { leads: [] } }, async (ctx) => {
    // A receptionist may read leads but not workspace settings.
    const allowed = await ctx.call({ segments: ["leads"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(allowed.res.statusCode, 200);

    const denied = await ctx.call({
      segments: ["admin-settings"],
      query: { workspaceId: WORKSPACE_B },
      body: { role: "owner", permissions: ["view_admin"] },
    });
    assert.equal(denied.res.statusCode, 403, "the body cannot grant an admin-only resource");
  });
});

// ===========================================================================
// C. Router
// ===========================================================================

test("C1 an unregistered resource is a 404", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    for (const segment of ["unknown-resource", "workspaces", "subscriptions"]) {
      const { res, log } = await ctx.call({ segments: [segment] });
      assert.equal(res.statusCode, 404, `${segment} must not resolve`);
      assert.equal(businessQueries(log).length, 0);
    }
  });
});

test("C2 an unsupported method on a known resource is a 405", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["leads"], method: "DELETE" });
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.code, "method_not_allowed");
  });
});

test("C3 path tricks do not reach a handler", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    for (const segments of [["leads/extra"], [".."], ["."], ["LEADS", "..", "admin-settings"], ["leads\\x"]]) {
      const { res, log } = await ctx.call({ segments });
      assert.ok(res.statusCode === 404 || res.statusCode === 403, `${segments.join("|")} must not dispatch`);
      assert.equal(businessQueries(log).length, 0);
    }
  });
});

test("C4 resource names are matched case-insensitively but only after normalisation", async () => {
  await withRouter({ memberships: [memberA], rows: { leads: [] } }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["LEADS"] });
    assert.equal(res.statusCode, 200, "casing alone must not create a second, unguarded route");
  });
});

test("C5 the worker route is not satisfied by a browser token", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["meta-insights-background-cycle"], method: "POST", body: {} });
    assert.ok(res.statusCode >= 400, "a browser JWT must not pass the HMAC contract");
    assert.notEqual(res.statusCode, 200);
  });
});

test("C6 every registered route is classified and no route is public", async () => {
  const registry = (await import(pathToFileURL(registryPath).href)) as {
    CRM_RESOURCE_AUTHORIZATION: Record<string, { kind: string; methods: string[] }>;
    CRM_ROUTE_AUTHORIZATION: Record<string, { kind: string; methods: string[] }>;
    CRM_SUBROUTE_AUTHORIZATION: Record<string, { kind: string; methods: string[] }>;
  };
  const all = {
    ...registry.CRM_RESOURCE_AUTHORIZATION,
    ...registry.CRM_ROUTE_AUTHORIZATION,
    ...registry.CRM_SUBROUTE_AUTHORIZATION,
  };
  const kinds = new Set(["browser", "bootstrap", "internal_hmac"]);
  for (const [key, entry] of Object.entries(all)) {
    assert.ok(kinds.has(entry.kind), `${key} has an unclassified kind`);
    assert.ok(entry.methods.length > 0, `${key} must declare its methods`);
  }
  assert.equal(Object.keys(registry.CRM_RESOURCE_AUTHORIZATION).length, 18, "all 18 generic resources registered");
});

test("C7 health diagnostics are no longer public", async () => {
  await withRouter({ memberships: [] }, async (ctx) => {
    for (const segment of ["health", "storage-health"]) {
      const anon = await ctx.call({ segments: [segment], token: null });
      assert.equal(anon.res.statusCode, 401, `${segment} must require authentication`);
    }
  });
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["health"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 403, "health is administrator-only");
  });
});

// ===========================================================================
// D. Read isolation
// ===========================================================================

test("D1 list queries are always scoped to the verified workspace", async () => {
  const readable = ["leads", "clients", "appointments", "deals", "calls", "tasks", "chat"];
  await withRouter({ memberships: [memberA], rows: Object.fromEntries(readable.map((r) => [r, []])) }, async (ctx) => {
    for (const resource of readable) {
      const { res, log } = await ctx.call({ segments: [resource] });
      assert.equal(res.statusCode, 200, `${resource} must be readable by the owner`);
      const query = businessQueries(log)[0];
      assert.ok(query, `${resource} must issue a query`);
      assert.equal(query.filters.workspace_id, WORKSPACE_A, `${resource} must filter by the verified workspace`);
    }
  });
});

test("D2 a foreign workspace is never queried, whatever the client sends", async () => {
  await withRouter({ memberships: [memberA], rows: { clients: [] } }, async (ctx) => {
    const { log } = await ctx.call({
      segments: ["clients"],
      query: { workspaceId: WORKSPACE_A, workspace_id: WORKSPACE_B },
      body: { workspaceId: WORKSPACE_B },
    });
    for (const entry of businessQueries(log)) {
      assert.notEqual(entry.filters.workspace_id, WORKSPACE_B, "no query may reference the foreign workspace");
    }
  });
});

test("D3 staff cannot be enumerated by email", async () => {
  await withRouter({ memberships: [memberA], rows: { staff_users: [memberA] } }, async (ctx) => {
    const { log } = await ctx.call({ segments: ["staff"], query: { email: "victim@example.test" } });
    const staffReads = log.filter((entry) => entry.table === "staff_users" && entry.filters.email !== undefined);
    assert.equal(staffReads.length, 0, "no query may filter staff by an arbitrary email");
  });
  const source = await readFile(serverPath, "utf8");
  assert.ok(!source.includes("emailFilter"), "the email filter must be gone from the generic list path");
});

test("D4 the staff list is administrator-only and workspace-scoped", async () => {
  await withRouter({ memberships: [memberBReception], rows: { staff_users: [] } }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["staff"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 403, "a receptionist has no manage_staff permission");
  });
});

// ===========================================================================
// E/F. Write isolation
// ===========================================================================

test("E1 create writes the verified workspace and strips client tenant fields", async () => {
  await withRouter({ memberships: [memberA], rows: { clients: [] } }, async (ctx) => {
    const { log } = await ctx.call({
      segments: ["clients"],
      method: "POST",
      body: { name: "Пациент", phone: "+70000000001", workspace_id: WORKSPACE_B, id: "forged-id" },
    });
    const insert = businessQueries(log).find((entry) => entry.op === "insert");
    const row = insert?.filters.__row as Record<string, unknown> | undefined;
    assert.equal(row?.workspace_id, WORKSPACE_A);
    assert.notEqual(row?.id, "forged-id");
  });
});

test("E2 create requires the write permission, not just membership", async () => {
  const doctor: StaffRow = { id: "staff-d", workspace_id: WORKSPACE_A, role: "doctor", status: "active" };
  await withRouter({ memberships: [doctor], rows: { leads: [] } }, async (ctx) => {
    // A doctor may not manage leads.
    const { res } = await ctx.call({ segments: ["leads"], method: "POST", body: { name: "x", phone: "+7" } });
    assert.equal(res.statusCode, 403);
  });
});

test("F1 update is filtered by both id and the verified workspace", async () => {
  await withRouter({ memberships: [memberA], rows: { clients: [{ id: "row-1" }] } }, async (ctx) => {
    const { log } = await ctx.call({
      segments: ["clients"],
      method: "PATCH",
      body: { id: "11111111-2222-4333-8444-555555555555", name: "Обновлено" },
    });
    const update = businessQueries(log).find((entry) => entry.op === "update");
    assert.ok(update, "an update must be issued");
    assert.equal(update?.filters.workspace_id, WORKSPACE_A, "update must carry the workspace filter");
  });
});

test("F2 update cannot move a row to another workspace or change server-owned columns", async () => {
  await withRouter({ memberships: [memberA], rows: { clients: [{ id: "row-1" }] } }, async (ctx) => {
    const { log } = await ctx.call({
      segments: ["clients"],
      method: "PATCH",
      body: {
        id: "11111111-2222-4333-8444-555555555555",
        name: "X",
        workspace_id: WORKSPACE_B,
        auth_user_id: "attacker",
        created_at: "1970-01-01T00:00:00.000Z",
      },
    });
    const update = businessQueries(log).find((entry) => entry.op === "update");
    const row = (update?.filters.__row ?? {}) as Record<string, unknown>;
    for (const forbidden of ["workspace_id", "auth_user_id", "created_at", "id"]) {
      assert.ok(!(forbidden in row), `${forbidden} must be stripped from an update`);
    }
  });
});

// ===========================================================================
// H. Staff
// ===========================================================================

test("H1 generic staff creation is disabled, but only after authorization", async () => {
  const attackerBody = {
    name: "Attacker",
    email: "a@b.c",
    role: "owner",
    auth_user_id: USER_A,
    workspaceId: WORKSPACE_B,
  };

  // Unauthenticated callers learn nothing about the capability.
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["staff"], method: "POST", body: attackerBody, token: null });
    assert.equal(res.statusCode, 401, "authentication is refused before the disabled capability is disclosed");
    assert.equal(res.body.code, "authentication_required");
    assert.equal(businessQueries(log).length, 0);
  });

  // A member without staff-management permission is refused too.
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["staff"],
      method: "POST",
      query: { workspaceId: WORKSPACE_B },
      body: attackerBody,
    });
    assert.equal(res.statusCode, 403, "a receptionist must not learn the invitation state either");
  });

  // Only an authorized administrator sees the structured refusal, and nothing is written.
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["staff"], method: "POST", body: attackerBody });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "staff_invitation_required");
    assert.equal(businessQueries(log).length, 0, "no staff row may be written");
  });
});

test("H2 the role catalog refuses owner assignment and upward moves", async () => {
  const permissions = (await import(pathToFileURL(path.join(repoRoot, "lib", "auth", "permissions.ts")).href)) as {
    canAssignRole: (actor: string, target: string) => boolean;
  };
  for (const actor of ["owner", "admin", "manager"]) {
    assert.equal(permissions.canAssignRole(actor, "owner"), false, `${actor} must not mint an owner`);
  }
  assert.equal(permissions.canAssignRole("admin", "admin"), false);
  assert.equal(permissions.canAssignRole("manager", "admin"), false);
  assert.equal(permissions.canAssignRole("admin", "receptionist"), true);
});

test("H3 the staff update path protects owners and the last owner", async () => {
  const source = await readFile(serverPath, "utf8");
  assert.ok(source.includes("staffPatchRejection"), "staff updates must go through the rejection rules");
  assert.ok(source.includes("last_owner_protected"), "the last active owner must be protected");
  assert.ok(source.includes('targetRole === "owner" && actorRole !== "owner"'), "an admin must not modify an owner");
  assert.ok(
    source.includes("targetStaffUserId === context.staffUserId"),
    "self-promotion through the body must be refused",
  );
});

// ===========================================================================
// I. Auth context
// ===========================================================================

test("I1 the bootstrap route needs a token but not a workspace", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const anon = await ctx.call({ segments: ["auth-context"], token: null });
    assert.equal(anon.res.statusCode, 401);

    const authed = await ctx.call({ segments: ["auth-context"] });
    assert.equal(authed.res.statusCode, 200);
  });
});

test("I2 the bootstrap returns only the caller's memberships and server permissions", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["auth-context"] });
    const data = (res.body.data ?? {}) as Record<string, unknown>;
    const memberships = (data.memberships ?? []) as Array<Record<string, unknown>>;
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].workspaceId, WORKSPACE_A);
    assert.ok(Array.isArray(memberships[0].permissions));
  });
});

test("I3 several memberships are reported without choosing one", async () => {
  await withRouter({ memberships: [memberA, memberBReception] }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["auth-context"] });
    const data = (res.body.data ?? {}) as Record<string, unknown>;
    assert.equal(data.workspaceId, null, "the server must not pick a workspace");
    assert.equal(data.requiresWorkspaceSelection, true);
  });
});

// ===========================================================================
// K. Special routes and Meta safety
// ===========================================================================

test("K1 Meta launch needs the advertising permission and the right workspace", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["meta-launch"],
      method: "POST",
      query: { workspaceId: WORKSPACE_B },
      body: { dryRun: true },
    });
    assert.equal(res.statusCode, 403, "a receptionist must not launch advertising");
  });
});

test("K2 a foreign workspace Meta launch is refused before any Meta or CRM work", async () => {
  await withRouter({ memberships: [memberA] }, async (ctx) => {
    const { res, log } = await ctx.call({
      segments: ["meta-launch"],
      method: "POST",
      query: { workspaceId: WORKSPACE_B },
      body: { dryRun: true },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(businessQueries(log).length, 0);
  });
});

test("K3 Meta Insights stays administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["meta-campaign-insights", "meta-insights-history", "meta-insights-sync-runs"]) {
      const { res } = await ctx.call({ segments: [segment], query: { workspaceId: WORKSPACE_B } });
      assert.equal(res.statusCode, 403, `${segment} must remain owner/admin`);
    }
  });
});

test("K4 configuration resources remain administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["admin-settings", "ai-providers", "integration-statuses", "meta-accounts", "release-checks"]) {
      const { res } = await ctx.call({ segments: [segment], query: { workspaceId: WORKSPACE_B } });
      assert.equal(res.statusCode, 403, `${segment} must be administrator-only`);
    }
  });
});

test("K5 the Meta payload semantics are untouched by this phase", async () => {
  const payload = await readFile(path.join(repoRoot, "lib", "crm", "meta-launch-payload.ts"), "utf8");
  assert.ok(payload.includes('placementsMode: "instagram_only"'), "Instagram-only placement flag retained");
  assert.ok(payload.includes("status: launch.statusMode"), "the ad status still mirrors the requested status");
  assert.ok(!payload.includes('"ACTIVE"'), "no ACTIVE literal is introduced");
});

// ===========================================================================
// L. Legacy webhook and frontend guarantees
// ===========================================================================

test("L1 the legacy webhook is outside the CRM router and still disabled", async () => {
  const handler = await readFile(path.join(repoRoot, "api", "leads", "webhook", "[clinicId].ts"), "utf8");
  assert.ok(handler.includes("legacy_webhook_disabled"));
  assert.ok(!handler.includes("createClient"), "no Supabase client may be constructed");
  assert.ok(!handler.includes(".insert("), "no database write may remain");
});

test("L2 the browser reaches CRM only through the authorized helper", async () => {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(negisSrc);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const rel = path.relative(negisSrc, file);
    if (rel === path.join("lib", "api.ts")) continue;
    assert.ok(
      !/fetch\(\s*apiUrl\(\s*[`'"][^`'"]*\/api\/crm\//.test(source),
      `${rel} must not call the CRM API directly`,
    );
    assert.ok(
      !/fetch\(\s*[`'"]\/api\/crm\//.test(source),
      `${rel} must not call the CRM API directly`,
    );
  }
});

test("L3 Security-1A browser invariants still hold", async () => {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(negisSrc);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const rel = path.relative(negisSrc, file);
    assert.ok(!/\.from\(['"`]/.test(source), `${rel} must not query tables directly`);
    assert.ok(!source.includes(".channel("), `${rel} must not open a realtime channel`);
    assert.ok(!source.includes("postgres_changes"), `${rel} must not subscribe to changes`);
    assert.ok(!source.includes("/rest/v1"), `${rel} must not call PostgREST`);
  }
});

test("L4 the authorized helper puts the token in the header only", async () => {
  const api = await readFile(path.join(negisSrc, "lib", "api.ts"), "utf8");
  assert.ok(api.includes('mergedHeaders.set("Authorization", `Bearer ${token}`)'), "bearer header is set");
  assert.ok(api.includes('mergedHeaders.delete("Authorization")'), "a caller cannot supply its own Authorization");
  assert.ok(!/apiUrl\([^)]*token/i.test(api), "the token must never be placed in the URL");
  assert.ok(api.includes("if (!token)"), "a request without a token is not sent");
});

test("L5 the login screen no longer resolves identity from an email", async () => {
  const login = await readFile(path.join(negisSrc, "pages", "Login.tsx"), "utf8");
  assert.ok(!login.includes("/api/crm/staff?email="), "the staff email lookup must be gone");
  assert.ok(login.includes("/api/crm/auth-context"), "identity comes from the verified session");
});

test("L6 demo collections reach the CRM only through the authorized helper", async () => {
  // DemoCrmModules names CRM endpoints, but useDemoCollection only calls them for
  // a real workspace; in demo mode the data is local. Whichever branch runs, the
  // request must carry a token, so the shared hook uses crmFetch.
  const storage = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  assert.ok(storage.includes("crmFetch"), "the shared collection hook must use the authorized helper");
  assert.ok(!storage.includes("fetch(apiUrl("), "no unauthenticated CRM fetch may remain");
  assert.ok(storage.includes("isRealWorkspace"), "demo mode must stay on the local branch");
});

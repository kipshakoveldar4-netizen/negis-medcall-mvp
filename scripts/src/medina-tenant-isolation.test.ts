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
        in(column: string, values: unknown) { entry.filters[column] = values; return chain(); },
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
  // "platform" — панель владельца платформы: единственный вид, читающий
  // поперёк арендаторов. Он допущен сюда сознательно и с условиями ниже, а не
  // потому, что набор не заметил нового значения.
  const kinds = new Set(["browser", "bootstrap", "internal_hmac", "platform"]);
  for (const [key, entry] of Object.entries(all)) {
    assert.ok(kinds.has(entry.kind), `${key} has an unclassified kind`);
    assert.ok(entry.methods.length > 0, `${key} must declare its methods`);
  }

  // Роли и права разрешаются из членства в ОДНОМ рабочем пространстве, а у
  // запроса платформы рабочего пространства нет. Указать их здесь значило бы
  // объявить проверку, которой не существует.
  const platformRoutes = Object.entries(all).filter(([, entry]) => entry.kind === "platform");
  assert.ok(platformRoutes.length > 0, "платформенный вид объявлен — значит хотя бы один маршрут его использует");
  for (const [key, entry] of platformRoutes) {
    const declared = entry as { roles?: unknown; permissions?: unknown };
    assert.ok(!declared.roles, `${key}: роль клиники не решает доступ к панели платформы`);
    assert.ok(!declared.permissions, `${key}: право клиники не решает доступ к панели платформы`);
    assert.ok(key.startsWith("platform-"), `${key}: платформенные маршруты называются с префиксом platform-`);
  }

  // Ни один ресурс общего вида не имеет права быть платформенным: они ходят
  // через readWorkspaceId и обязаны иметь арендатора.
  for (const [key, entry] of Object.entries(registry.CRM_RESOURCE_AUTHORIZATION)) {
    assert.notEqual(entry.kind, "platform", `${key}: обычный ресурс не может читать поперёк клиник`);
  }
  assert.equal(Object.keys(registry.CRM_RESOURCE_AUTHORIZATION).length, 21, "all 21 generic resources registered");
});

test("C6a ключи прототипа не являются маршрутами", async () => {
  const registry = (await import(pathToFileURL(registryPath).href)) as {
    normalizeCrmSegments: (segments: string[]) => string[] | null;
    resolveCrmRoute: (segments: string[]) => unknown;
  };

  // Шапка реестра обещает: всё, чего нет в списке, неизвестно и запрещено.
  // Обычное обращение по индексу находило и ключи прототипа: сегмент
  // «constructor» возвращал функцию Object, роутер читал у неё methods и падал
  // вне блока try — наружу уходил 500 вместо 404.
  for (const segment of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const normalized = registry.normalizeCrmSegments([segment]);
    const route = normalized ? registry.resolveCrmRoute(normalized) : null;
    assert.equal(route, null, `${segment} не маршрут`);
  }

  // И настоящие маршруты при этом находятся.
  assert.notEqual(registry.resolveCrmRoute(registry.normalizeCrmSegments(["leads"]) || []), null);
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

test("K3a TikTok diagnostics and campaign dry-run stay administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["tiktok-validate", "tiktok-dry-run", "tiktok-setup", "tiktok-connection"]) {
      const { res, log } = await ctx.call({
        segments: [segment],
        method: "POST",
        query: { workspaceId: WORKSPACE_B },
        body: {},
      });
      assert.equal(res.statusCode, 403, `${segment} must remain owner/admin only`);
      assert.equal(businessQueries(log).length, 0, "authorization must fail before any provider or CRM work");
    }
  });
});

test("K3b TikTok provisioning cannot be spoofed by an owner of a different workspace", async () => {
  const previous = process.env.TIKTOK_WORKSPACE_ID;
  process.env.TIKTOK_WORKSPACE_ID = WORKSPACE_B;
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      for (const segment of ["tiktok-validate", "tiktok-dry-run", "tiktok-setup", "tiktok-connection"]) {
        const { res, log } = await ctx.call({ segments: [segment], method: "POST",
          query: { workspaceId: WORKSPACE_A }, body: { confirm: true, city: "Актобе", workspaceId: WORKSPACE_B } });
        assert.equal(res.statusCode, 403, segment);
        assert.equal(businessQueries(log).length, 0);
      }
      const { res, log } = await ctx.call({ segments: ["tiktok-connection"], query: { workspaceId: WORKSPACE_A } });
      assert.equal(res.statusCode, 403);
      assert.equal(businessQueries(log).length, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.TIKTOK_WORKSPACE_ID;
    else process.env.TIKTOK_WORKSPACE_ID = previous;
  }
});

test("K3c TikTok connection GET is workspace-scoped and returns only the safe DTO", async () => {
  const previous = { workspace: process.env.TIKTOK_WORKSPACE_ID, advertiser: process.env.TIKTOK_ADVERTISER_ID, token: process.env.TIKTOK_ACCESS_TOKEN };
  process.env.TIKTOK_WORKSPACE_ID = WORKSPACE_A;
  process.env.TIKTOK_ADVERTISER_ID = "7123456789012345678";
  process.env.TIKTOK_ACCESS_TOKEN = "private-token";
  try {
    await withRouter({ memberships: [memberA], rows: { tiktok_ad_account_connections: [{
      workspace_id: WORKSPACE_A, advertiser_id: process.env.TIKTOK_ADVERTISER_ID, enabled: true,
      currency: "KZT", account_timezone: "Asia/Almaty", verified_at: new Date().toISOString(),
    }] } }, async (ctx) => {
      const { res, log } = await ctx.call({ segments: ["tiktok-connection"], query: { workspaceId: WORKSPACE_A } });
      assert.equal(res.statusCode, 200);
      assert.equal((res.body.data as { state: string }).state, "connected");
      assert.equal(businessQueries(log)[0]?.filters.workspace_id, WORKSPACE_A);
      assert.doesNotMatch(JSON.stringify(res.body), /7123456789012345678|private-token|access_token/);
      for (const method of ["GET", "POST"]) {
        const noToken = await ctx.call({ segments: ["tiktok-connection"], method, token: null,
          query: { workspaceId: WORKSPACE_A }, body: { confirm: true } });
        assert.equal(noToken.res.statusCode, 401);
      }
    });
    await withRouter({ authOk: false }, async (ctx) => {
      assert.equal((await ctx.call({ segments: ["tiktok-connection"] })).res.statusCode, 401);
    });
  } finally {
    for (const [key, value] of Object.entries({ TIKTOK_WORKSPACE_ID: previous.workspace, TIKTOK_ADVERTISER_ID: previous.advertiser, TIKTOK_ACCESS_TOKEN: previous.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("K4 configuration resources remain administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["admin-settings", "ai-providers", "integration-statuses", "meta-accounts", "release-checks"]) {
      const { res } = await ctx.call({ segments: [segment], query: { workspaceId: WORKSPACE_B } });
      assert.equal(res.statusCode, 403, `${segment} must be administrator-only`);
    }
  });
});

test("K4b diagnostics report presence, never names or identifier values", async () => {
  // Before Security-2B /api/crm/health was public. It is administrator-only now,
  // but it still listed every expected environment variable by name and echoed
  // the platform's Meta account identifiers. Both are removed: a diagnostics
  // endpoint reports whether things are configured, not what they are.
  const server = await readFile(serverPath, "utf8");
  const envFn = server.slice(server.indexOf("function envStatus"), server.indexOf("function singleEnvStatus"));
  assert.ok(!envFn.includes("keys: keys.map"), "envStatus must not enumerate variable names");
  assert.ok(envFn.includes("configured: configured.length"), "a coarse configured count is still reported");

  const meta = server.slice(server.indexOf("const safeMeta = {"), server.indexOf("secrets: \"masked\""));
  for (const leaked of [
    'businessId: readEnvValue',
    'adAccountId: readEnvValue',
    'pageId: readEnvValue',
    'instagramActorId: readEnvValue',
  ]) {
    assert.ok(!meta.includes(leaked), `health must not return the value of ${leaked.split(":")[0]}`);
  }
  for (const flag of [
    "businessIdConfigured",
    "adAccountConfigured",
    "pageConfigured",
    "instagramActorConfigured",
  ]) {
    assert.ok(meta.includes(flag), `health must report ${flag} as presence only`);
  }
});

test("K5 the Meta payload semantics are untouched by this phase", async () => {
  const payload = await readFile(path.join(repoRoot, "lib", "crm", "meta-launch-payload.ts"), "utf8");
  assert.ok(payload.includes('placementsMode: "instagram_only"'), "Instagram-only placement flag retained");
  assert.ok(payload.includes("status: launch.statusMode"), "the ad status still mirrors the requested status");

  // "ACTIVE" may appear only in the status union that narrows what a caller is
  // allowed to pass. No runtime expression may produce or default to it.
  const code = payload
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith("//"))
    .filter((line) => !/statusMode:s*"PAUSED"s*|s*"ACTIVE";/.test(line))
    .join(String.fromCharCode(10));
  assert.ok(!code.includes("ACTIVE"), "no runtime path may introduce ACTIVE");
  assert.ok(!/status[^:]*:s*"ACTIVE"/.test(payload), "no payload field may be hardcoded to ACTIVE");
  assert.ok(payload.includes('statusMode: "PAUSED" | "ACTIVE";'), "the status stays a narrow union, not a free string");
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

test("L5b the workspace the browser sends is the one the server verified", async () => {
  // Regression: readWorkspaceId used to consult only the pre-Security-2B staff
  // blobs, which the new bootstrap no longer writes, so a signed-in user sent
  // "demo-workspace" and every CRM request came back 403. Both sides must read
  // the same key, and the verified selector must win.
  const storage = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  const authContext = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");

  assert.ok(
    storage.includes('export const WORKSPACE_SELECTOR_KEY = "negis_workspace_selector"'),
    "the selector key must be defined once and exported",
  );
  assert.ok(
    authContext.includes("WORKSPACE_SELECTOR_KEY") && authContext.includes("from '@/lib/demoStorage'"),
    "AuthContext must import the shared key instead of repeating the literal",
  );
  assert.ok(
    !/const WORKSPACE_SELECTOR_KEYs*=/.test(authContext),
    "AuthContext must not redeclare the key and let the two drift apart",
  );

  // The verified selector is read before any legacy fallback.
  const fn = storage.slice(storage.indexOf("export function readWorkspaceId"));
  const verifiedAt = fn.indexOf("WORKSPACE_SELECTOR_KEY");
  const legacyAt = fn.indexOf("negis_staff_user");
  assert.ok(verifiedAt > 0, "readWorkspaceId must consult the verified selector");
  assert.ok(legacyAt === -1 || verifiedAt < legacyAt, "the verified selector must take precedence over legacy keys");
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

test("L5c no page keeps a private workspace resolver that ignores the selector", async () => {
  // The same defect as L5b, one layer up: six pages had each copied their own
  // readWorkspaceId/readCurrentWorkspaceId that consulted only the pre-Security-2B
  // demo blobs. Fixing the shared helper did nothing for them, so /leads, /clients,
  // /appointments and /content-studio still sent workspaceId=demo-workspace and the
  // server correctly answered 403. One helper, imported everywhere.
  const pagesDir = path.join(negisSrc, "pages");
  const files = (await readdir(pagesDir)).filter((name) => name.endsWith(".tsx"));
  const offenders: string[] = [];
  for (const name of files) {
    const source = await readFile(path.join(pagesDir, name), "utf8");
    const declaresResolver = /function\s+read(Current)?WorkspaceId\s*\(/.test(source);
    if (declaresResolver) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "these pages redeclare a workspace resolver instead of importing the shared one");

  // And every page that sends a workspaceId gets it from the shared helper or the
  // verified auth context, never from a bare demo literal.
  const literalOffenders: string[] = [];
  for (const name of files) {
    const source = await readFile(path.join(pagesDir, name), "utf8");
    if (!source.includes("workspaceId=${encodeURIComponent(") && !source.includes("workspaceId,")) continue;
    if (/=\s*clinicId\s*\|\|\s*"demo-workspace"/.test(source)) literalOffenders.push(name);
  }
  assert.deepEqual(literalOffenders, [], "a page falls back to the demo literal for a signed-in user");
});

test("L5d every CRM call site goes through the authenticated helper", async () => {
  // AdsAutomation and AdminCenter each kept a private crmRequest built on a bare
  // fetch(apiUrl(...)). Once Security-2B required a token, every call through
  // them answered 401 — including /api/crm/meta-launch, so the whole Ads
  // Automation flow was dead in the preview while the dashboard looked fine.
  //
  // The rule: a /api/crm/ path may only reach the network through crmFetch. Page
  // wrappers are fine as long as they delegate to it. Non-CRM endpoints are not
  // covered here — ContentStudio's /api/content-studio/* calls are a different
  // contract.
  const roots = ["pages", "components", "lib", "contexts"].map((dir) => path.join(negisSrc, dir));
  const sharedHelpers = new Set(["crmFetch", "crmRequest", "crmJson"]);
  const offenders: string[] = [];

  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name === "api.ts") continue; // the one place allowed to call fetch for a CRM path
      const source = await readFile(path.join(root, name), "utf8");

      const receivers = new Set<string>();
      for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(\s*[`"'][^`"']*\/api\/crm\//g)) {
        receivers.add(match[1]);
      }

      // A page may wrap the helper, and wrap the wrapper: AiControlCenter's
      // fetchCrmList calls fetchJson calls crmFetch. Grow the safe set until it
      // stops growing, then require every receiver of a CRM path to be in it.
      const locals = [...source.matchAll(/(?:async )?function ([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/g)].map((m) => ({
        name: m[1],
        body: source.slice(m.index ?? 0, (m.index ?? 0) + 1200),
      }));
      const localNames = new Set(locals.map((local) => local.name));
      // Only the imported helpers start out safe. A local function that happens
      // to be called crmRequest — both offending pages had one — has to earn it
      // from its own body, which is the whole point of this check.
      const imported = (source.match(/import \{([^}]*)\} from ["']@\/lib\/api["']/)?.[1] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => sharedHelpers.has(entry) && !localNames.has(entry));
      const safe = new Set(imported);
      for (let pass = 0; pass < locals.length + 1; pass += 1) {
        let grew = false;
        for (const local of locals) {
          if (safe.has(local.name)) continue;
          if ([...safe].some((known) => new RegExp(known + "[<(]").test(local.body))) {
            safe.add(local.name);
            grew = true;
          }
        }
        if (!grew) break;
      }

      for (const helper of receivers) {
        if (helper === "fetch") {
          offenders.push(name + ": a CRM path is handed straight to fetch");
          continue;
        }
        if (!safe.has(helper)) {
          offenders.push(name + ": CRM paths flow through " + helper + ", which never reaches crmFetch");
        }
      }
    }
  }

  assert.deepEqual(offenders, [], "these CRM call sites bypass crmFetch and will answer 401");
});

// ===========================================================================
// M. A reference a lead points at must belong to the acting clinic
//
// Assigning a lead to a colleague is the first lead write that stores a foreign
// key to a row the browser chose. The FK alone is not isolation: staff_users
// carries its own workspace_id, so a valid id from clinic B satisfies the
// constraint while pointing across the tenant line. readWorkspaceReference is
// what makes it safe.
//
// Pinned at the source rather than driven end to end: the harness above fakes
// query results instead of modelling stored rows, so it answers a lookup for a
// foreign id with a row and cannot express "not found". Expressing this
// behaviourally needs a harness that keeps rows per table and filters them —
// worth building, not built here.
// ===========================================================================

test("M1 every lead reference is resolved inside the acting workspace before it is stored", async () => {
  const source = await readFile(serverPath, "utf8");
  const start = source.indexOf("async function buildLeadReferenceRow");
  const end = source.indexOf("async function", start + 10);
  const builder = source.slice(start, end);
  assert.ok(builder.length > 0, "the lead reference builder must exist");

  // Literal assignments, not a regex: the id written to the column must be the
  // one the workspace-scoped lookup returned, never the one the browser sent.
  for (const [field, assignment] of [
    ["stageId", "row.stage_id = stage.id;"],
    ["sourceId", "row.source_id = source.id;"],
    ["responsibleUserId", "row.responsible_user_id = staff.id;"],
    // The fifth reference. client_id used to be written in buildPatchRow behind
    // an isUuid check — a shape check, not a tenancy check — and moved here so
    // that another clinic's client id is refused like every other reference.
    ["clientId", "row.client_id = client.id;"],
  ]) {
    assert.ok(builder.includes(`"${field}"`), `${field} must be handled here`);
    assert.ok(
      builder.includes(assignment),
      `${field} must be stored as ${assignment} — writing the request value directly would cross the tenant line`,
    );
  }

  assert.equal(
    (builder.match(/readWorkspaceReference\(/g) ?? []).length,
    5,
    "each of the five references must go through the workspace-scoped lookup",
  );
});

test("M2 an inactive colleague cannot be made responsible for a lead", async () => {
  const source = await readFile(serverPath, "utf8");
  const start = source.indexOf('fieldName: "responsibleUserId"');
  const block = source.slice(start, start + 420);

  assert.ok(
    block.includes('readString(staff.status).toLowerCase() !== "active"'),
    "a deactivated colleague would leave the lead in a queue nobody reads",
  );
  assert.ok(
    block.includes("CrmReferenceValidationError"),
    "the refusal must be the validation error the router turns into 400, not a raw failure",
  );
});

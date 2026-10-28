import assert from "node:assert/strict";
import { withAppointmentCreateRpcSpy, appointmentSpyRows, appointmentSpyBody } from "./appointment-create-rpc-spy.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crmTransportOffenders } from "./crm-transport-audit";

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

type QueryLog = { table: string; filters: Record<string, unknown>; op: string; columns?: string };
type StaffDirectoryFixture = { rows: Record<string, unknown>[]; error?: { message: string } };
type WriteFailureFixture = {
  table: string;
  op: "insert" | "update" | "upsert" | "delete";
  error: { code: string; message: string; details?: string; hint?: string };
};
type AssignedLeadFixture = {
  rows?: Record<string, unknown>[];
  error?: { code: string; message: string };
  result?: unknown;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
};
type MortgageOutcomesFixture = {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

/** Records every table touched and every filter applied. */
function spyClient(
  rows: Record<string, unknown[]>,
  log: QueryLog[],
  staffDirectory?: StaffDirectoryFixture,
  writeFailure?: WriteFailureFixture,
) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, filters: {}, op: "select" };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const writeError = () => writeFailure?.table === table && writeFailure.op === entry.op ? writeFailure.error : null;
      Object.assign(builder, {
        select: (columns?: string) => {
          entry.columns = columns?.replace(/\s+/g, "");
          return chain();
        },
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        delete: () => { entry.op = "delete"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => {
          const error = writeError();
          return Promise.resolve({ data: error ? null : (rows[table] ?? [])[0] ?? null, error });
        },
        eq(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        in(column: string, values: unknown) { entry.filters[column] = values; return chain(); },
        then(resolve: (value: { data: unknown; error: { message: string } | null; count?: number }) => void) {
          const directoryRead = table === "staff_users" && !("auth_user_id" in entry.filters) && staffDirectory;
          const table_rows = directoryRead
            ? directoryRead.rows.filter((row) => Object.entries(entry.filters).every(([key, value]) => row[key] === value))
            : rows[table] ?? [];
          const error = writeError() ?? (directoryRead ? directoryRead.error ?? null : null);
          resolve({ data: error ? null : table_rows, error, count: table_rows.length });
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
  staffDirectory?: StaffDirectoryFixture;
  writeFailure?: WriteFailureFixture;
  assignedLeads?: AssignedLeadFixture;
  mortgageOutcomes?: MortgageOutcomesFixture;
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
    const client = withAppointmentCreateRpcSpy(spyClient(appointmentSpyRows(clientRows), log, options.staffDirectory, options.writeFailure));
    if (!options.assignedLeads && !options.mortgageOutcomes) return client;
    const fixture = options.assignedLeads;
    return Object.assign(client, { async rpc(name: string, args: Record<string, unknown>) {
      if (options.mortgageOutcomes && ["read_mortgage_contracts", "save_mortgage_contract", "read_mortgage_results"].includes(name)) {
        const outcomes = options.mortgageOutcomes;
        outcomes.calls.push({ name, args });
        return { data: outcomes.error ? null : outcomes.result ?? { records: [], truncated: false }, error: outcomes.error ?? null };
      }
      assert.ok(fixture, `unexpected RPC ${name}`);
      fixture.calls.push({ name, args });
      if (fixture.error) return { data: null, error: fixture.error };
      if (name === "read_assigned_crm_leads") {
        return { data: fixture.result ?? (fixture.rows ?? []).filter((row) =>
          row.workspace_id === args.p_workspace_id && row.responsible_user_id === args.p_staff_user_id), error: null };
      }
      assert.equal(name, "patch_assigned_crm_lead");
      const target = fixture.rows?.find((row) => row.id === args.p_lead_id && row.workspace_id === args.p_workspace_id
        && row.responsible_user_id === args.p_staff_user_id);
      if (!target) return { data: null, error: { code: "P6902", message: "fixture-private" } };
      return { data: fixture.result ?? { before: target, item: { ...target, ...(args.p_patch as object) } }, error: null };
    } });
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
        body: appointmentSpyBody(input.segments[0], input.method, input.body),
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

function isWorkspaceProfileQuery(entry: QueryLog): boolean {
  return entry.table === "workspace_settings" && entry.op === "select"
    && entry.columns === "workspace_id,value" && entry.filters.key === "workspace_purpose";
}

function assertWorkspaceProfileQuery(log: QueryLog[], workspaceId: string) {
  assert.deepEqual(log.filter((entry) => entry.table === "workspace_settings" && entry.filters.key === "workspace_purpose"), [{
    table: "workspace_settings",
    op: "select",
    columns: "workspace_id,value",
    filters: { workspace_id: [workspaceId], key: "workspace_purpose" },
  }], "the purpose profile must be a minimal read of the verified workspace only");
}

/** Membership and the separately asserted purpose lookup are not business reads. */
function businessQueries(log: QueryLog[]): QueryLog[] {
  return log.filter((entry) => entry.table !== "staff_users" && !isWorkspaceProfileQuery(entry));
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
    assert.deepEqual(log, [], "even the safe profile lookup must wait for authentication");
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
    assert.ok(log.every((entry) => entry.table === "staff_users"), "no profile lookup before verified membership");
  });
});

test("B2 an inactive membership grants nothing", async () => {
  await withRouter({ memberships: [{ ...memberA, status: "disabled" }] }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 403);
    assert.ok(log.every((entry) => entry.table === "staff_users"), "inactive membership must not read a profile or business data");
  });
});

test("B3 a single active membership is inferred without a selector", async () => {
  await withRouter({ memberships: [memberA], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 200);
    assertWorkspaceProfileQuery(log, WORKSPACE_A);
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
    assert.ok(log.every((entry) => entry.table === "staff_users"), "a foreign selector must not trigger a profile lookup");
  });
});

test("B5 several memberships require an explicit choice", async () => {
  await withRouter({ memberships: [memberA, memberBReception] }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "workspace_selection_required");
    assert.ok(log.every((entry) => entry.table === "staff_users"), "no profile lookup before workspace selection");
  });
});

test("B6 an authorized selector picks that workspace", async () => {
  await withRouter({ memberships: [memberA, memberBReception], rows: { leads: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["leads"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 200);
    assertWorkspaceProfileQuery(log, WORKSPACE_B);
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
    assertWorkspaceProfileQuery(log, WORKSPACE_A);
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
    assert.ok(denied.log.every((entry) => entry.table === "staff_users"), "permission denial must precede profile and business reads");
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

test("C5b site intake is disabled without explicit configuration and never exposes subpaths", async () => {
  const previous = process.env.MEDINA_SITE_INTAKE_ENABLED;
  delete process.env.MEDINA_SITE_INTAKE_ENABLED;
  try {
    await withRouter({ memberships: [] }, async ctx => {
      const closed = await ctx.call({ segments: ["site-inquiry"], method: "POST", token: null, body: {} });
      assert.equal(closed.res.statusCode, 503);
      const nested = await ctx.call({ segments: ["site-inquiry", "leads"], method: "POST", token: null, body: {} });
      assert.equal(nested.res.statusCode, 404);
    });
  } finally {
    if (previous === undefined) delete process.env.MEDINA_SITE_INTAKE_ENABLED;
    else process.env.MEDINA_SITE_INTAKE_ENABLED = previous;
  }
});

test("C5c company recovery is authenticated bootstrap, not clinic membership", async () => {
  const registry = await import(pathToFileURL(registryPath).href);
  assert.deepEqual(registry.resolveCrmRoute(["partner-company"])?.authorization,
    { kind: "bootstrap", methods: ["GET", "POST"] });
  await withRouter({ memberships: [] }, async ctx => {
    for (const method of ["GET", "POST"]) {
      const anonymous = await ctx.call({ segments: ["partner-company"], method, token: null, body: {} });
      assert.equal(anonymous.res.statusCode, 401, method);
      assert.deepEqual(anonymous.log, [], "anonymous recovery cannot resolve a clinic");
      const unlinked = await ctx.call({ segments: ["partner-company"], method, body: {} });
      assert.equal(unlinked.res.statusCode, method === "GET" ? 400 : 403,
        "verified unlinked actor must reach the recovery contract, not membership denial");
      assert.deepEqual(unlinked.log, [], "bootstrap must not query staff, settings or clinic data");
      const extra = await ctx.call({ segments: ["partner-company", "unexpected"], method, body: {} });
      assert.equal(extra.res.statusCode, 404, method);
      assert.deepEqual(extra.log, []);
    }
    assert.equal(ctx.crmClientCreations, 0, "invalid recovery cannot create a business client");
  });
});

test("C5d company review is platform-only even for a clinic owner", async () => {
  const registry = await import(pathToFileURL(registryPath).href);
  assert.deepEqual(registry.resolveCrmRoute(["platform-partner-companies"])?.authorization,
    { kind: "platform", methods: ["GET", "POST"] });
  const previous = process.env.MEDINA_PLATFORM_OWNER_IDS;
  process.env.MEDINA_PLATFORM_OWNER_IDS = USER_A.replace(/^1/, "2");
  try {
    for (const memberships of [[], [memberA]]) {
      await withRouter({ memberships }, async ctx => {
        for (const method of ["GET", "POST", "PATCH"]) {
          for (const token of [null, TOKEN]) {
            const denied = await ctx.call({ segments: ["platform-partner-companies"], method, token });
            assert.equal(denied.res.statusCode, 404, `${memberships.length} memberships: ${method}`);
            assert.deepEqual(denied.log, [], "clinic roles cannot grant cross-company review access");
          }
        }
        assert.equal(ctx.crmClientCreations, 0);
      });
    }
    process.env.MEDINA_PLATFORM_OWNER_IDS = USER_A;
    await withRouter({ memberships: [] }, async ctx => {
      const allowed = await ctx.call({ segments: ["platform-partner-companies"], method: "PATCH" });
      assert.equal(allowed.res.statusCode, 405, "only an allowlisted owner may discover supported methods");
      for (const method of ["GET", "POST"]) {
        const extra = await ctx.call({ segments: ["platform-partner-companies", "unexpected"], method, body: {} });
        assert.equal(extra.res.statusCode, 404, method);
        assert.deepEqual(extra.log, []);
      }
      assert.equal(ctx.crmClientCreations, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.MEDINA_PLATFORM_OWNER_IDS;
    else process.env.MEDINA_PLATFORM_OWNER_IDS = previous;
  }
});

test("C5e entry accepts only the exact authenticated company subpath", async () => {
  const previous = process.env.MEDINA_PARTNER_COMPANY_ENABLED;
  process.env.MEDINA_PARTNER_COMPANY_ENABLED = "false";
  try {
    await withRouter({ memberships: [] }, async ctx => {
      const anonymous = await ctx.call({ segments: ["partner-entry", "company"], method: "POST", token: null,
        query: { op: "context" } });
      assert.equal(anonymous.res.statusCode, 401);
      const accepted = await ctx.call({ segments: ["partner-entry", "company"], method: "POST",
        query: { op: "context" } });
      assert.equal(accepted.res.statusCode, 503, "exact subpath reaches the disabled company intake gate");
      assert.equal(accepted.res.body.code, "partner_company_registration_unavailable");
      const unsupported = await ctx.call({ segments: ["partner-entry", "company"], method: "GET" });
      assert.equal(unsupported.res.statusCode, 405);
      for (const segments of [["partner-entry", "unknown"], ["partner-entry", "company", "unexpected"]]) {
        for (const token of [null, TOKEN]) {
          const extra = await ctx.call({ segments, method: "POST", token, query: { op: "context" } });
          assert.equal(extra.res.statusCode, 404, segments.join("/"));
          assert.deepEqual(extra.log, []);
        }
      }
      assert.equal(ctx.crmClientCreations, 0, "closed or malformed intake must not resolve clinic data");
    });
  } finally {
    if (previous === undefined) delete process.env.MEDINA_PARTNER_COMPANY_ENABLED;
    else process.env.MEDINA_PARTNER_COMPANY_ENABLED = previous;
  }
});

test("C6 every route is classified; only the isolated site intake may accept anonymous writes", async () => {
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
  const kinds = new Set(["browser", "bootstrap", "internal_hmac", "platform", "site_intake", "site_public", "partner_entry"]);
  assert.deepEqual(Object.entries(all).filter(([, entry]) => entry.kind === "partner_entry").map(([key]) => key), ["partner-entry"]);
  assert.deepEqual(all["partner-entry"].methods, ["POST"]);
  assert.deepEqual(Object.entries(all).filter(([, entry]) => entry.kind === "site_public").map(([key]) => key), ["site-page"]);
  assert.deepEqual(all["site-page"].methods, ["GET", "HEAD"]);
  assert.deepEqual(Object.entries(all).filter(([, entry]) => entry.kind === "site_intake").map(([key]) => key), ["site-inquiry"]);
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
    assert.equal(entry.kind, "browser", `${key}: generic data resources always require workspace auth`);
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

test("D0 only the minimal purpose SELECT is excluded from business queries", () => {
  const profile: QueryLog = { table: "workspace_settings", op: "select", columns: "workspace_id,value",
    filters: { workspace_id: [WORKSPACE_A], key: "workspace_purpose" } };
  const business: QueryLog[] = [
    { ...profile, columns: "*" },
    { ...profile, filters: { workspace_id: WORKSPACE_A, key: "private_setting" } },
    { ...profile, op: "update" },
    { table: "leads", op: "select", filters: { workspace_id: WORKSPACE_A } },
  ];
  assert.deepEqual(businessQueries([profile, ...business]), business);
});

test("D1 list queries are always scoped to the verified workspace", async () => {
  const readable = ["leads", "clients", "appointments", "deals", "calls", "tasks", "chat"];
  await withRouter({ memberships: [memberA], rows: Object.fromEntries(readable.map((r) => [r, []])) }, async (ctx) => {
    for (const resource of readable) {
      const { res, log } = await ctx.call({ segments: [resource] });
      assert.equal(res.statusCode, 200, `${resource} must be readable by the owner`);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      const query = businessQueries(log)[0];
      assert.ok(query, `${resource} must issue a query`);
      assert.equal(query.filters.workspace_id, WORKSPACE_A, `${resource} must filter by the verified workspace`);
    }
  });
});

test("D2 a foreign workspace is never queried, whatever the client sends", async () => {
  await withRouter({ memberships: [memberA], rows: { clients: [] } }, async (ctx) => {
    const { res, log } = await ctx.call({
      segments: ["clients"],
      query: { workspaceId: WORKSPACE_A, workspace_id: WORKSPACE_B, workspacePurpose: "mortgage_leads" },
      body: { workspaceId: WORKSPACE_B, purpose: "mortgage_leads", workspacePurpose: "mortgage_leads" },
    });
    assert.equal(res.statusCode, 200, "browser purpose must not override the absent clinic_services profile");
    assertWorkspaceProfileQuery(log, WORKSPACE_A);
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
    assertWorkspaceProfileQuery(log, WORKSPACE_A);
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

test("K2a Meta account routes fail closed until a workspace is provisioned", async () => {
  const previous = process.env.META_WORKSPACE_ID;
  delete process.env.META_WORKSPACE_ID;
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      const { res, log } = await ctx.call({
        segments: ["meta-validate"],
        method: "POST",
        query: { workspaceId: WORKSPACE_A },
        body: { dryRun: true },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "meta_workspace_not_provisioned");
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previous;
  }
});

test("K2b shared Meta credentials cannot be used from another workspace", async () => {
  const previous = process.env.META_WORKSPACE_ID;
  process.env.META_WORKSPACE_ID = WORKSPACE_B;
  const requests = [
    { segments: ["meta-accounts"], method: "GET", body: {} },
    { segments: ["meta-launch"], method: "POST", body: { dryRun: true } },
    { segments: ["meta-status"], method: "GET", query: { campaignId: "123456789" } },
    { segments: ["meta-validate"], method: "POST", body: { dryRun: true } },
    { segments: ["meta-city-key"], method: "GET", query: { city: "Астана" } },
    { segments: ["meta-insights-sync"], method: "POST", body: {} },
    { segments: ["ad-creative-meta-upload"], method: "POST", body: { fileType: "video", dryRun: true } },
  ];
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      for (const request of requests) {
        const { res, log } = await ctx.call({
          ...request,
          query: { workspaceId: WORKSPACE_A, ...(request.query ?? {}) },
        });
        assert.equal(res.statusCode, 403, request.segments.join("/"));
        assert.equal(res.body.code, "meta_workspace_not_authorized");
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previous;
  }
});

test("K2d saved Meta accounts must match the provisioned server account", async () => {
  const previousWorkspace = process.env.META_WORKSPACE_ID;
  const previousAccount = process.env.META_AD_ACCOUNT_ID;
  process.env.META_WORKSPACE_ID = WORKSPACE_A;
  process.env.META_AD_ACCOUNT_ID = "act_123456789";
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      const missing = await ctx.call({
        segments: ["meta-accounts"],
        method: "POST",
        body: { workspaceId: WORKSPACE_A },
      });
      assert.equal(missing.res.statusCode, 400);
      assert.equal(missing.res.body.code, "meta_account_id_required");
      assertWorkspaceProfileQuery(missing.log, WORKSPACE_A);
      assert.equal(businessQueries(missing.log).length, 0);

      const foreign = await ctx.call({
        segments: ["meta-accounts"],
        method: "POST",
        body: { workspaceId: WORKSPACE_A, adAccountId: "act_987654321" },
      });
      assert.equal(foreign.res.statusCode, 403);
      assert.equal(foreign.res.body.code, "meta_account_not_authorized");
      assertWorkspaceProfileQuery(foreign.log, WORKSPACE_A);
      assert.equal(businessQueries(foreign.log).length, 0);

      const matching = await ctx.call({
        segments: ["meta-accounts"],
        method: "POST",
        body: { workspaceId: WORKSPACE_A, adAccountId: "123456789", status: "draft" },
      });
      assert.equal(matching.res.statusCode, 201);
      const insert = businessQueries(matching.log).find((entry) => entry.op === "insert");
      assert.ok(insert, "the provisioned account may be saved");
      assert.equal((insert?.filters.__row as Record<string, unknown>).workspace_id, WORKSPACE_A);
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previousWorkspace;
    if (previousAccount === undefined) delete process.env.META_AD_ACCOUNT_ID;
    else process.env.META_AD_ACCOUNT_ID = previousAccount;
  }
});

test("K2e repeated Meta account saves update the single workspace record", async () => {
  const previousWorkspace = process.env.META_WORKSPACE_ID;
  const previousAccount = process.env.META_AD_ACCOUNT_ID;
  const existingId = "22222222-2222-4222-8222-222222222222";
  process.env.META_WORKSPACE_ID = WORKSPACE_A;
  process.env.META_AD_ACCOUNT_ID = "act_123456789";
  try {
    await withRouter({
      memberships: [memberA],
      rows: { meta_ad_accounts: [{ id: existingId, workspace_id: WORKSPACE_A }] },
    }, async (ctx) => {
      const { res, log } = await ctx.call({
        segments: ["meta-accounts"],
        method: "POST",
        body: { workspaceId: WORKSPACE_A, adAccountId: "act_123456789", status: "draft" },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(businessQueries(log).some((entry) => entry.op === "insert"), false);
      const update = businessQueries(log).find((entry) => entry.op === "update");
      assert.ok(update, "a second save must update instead of inserting a duplicate");
      assert.equal(update?.filters.id, existingId);
      assert.equal(update?.filters.workspace_id, WORKSPACE_A);
    });

    await withRouter({
      memberships: [memberA],
      rows: {
        meta_ad_accounts: [
          { id: existingId, workspace_id: WORKSPACE_A },
          { id: "33333333-3333-4333-8333-333333333333", workspace_id: WORKSPACE_A },
        ],
      },
    }, async (ctx) => {
      const { res, log } = await ctx.call({
        segments: ["meta-accounts"],
        method: "POST",
        body: { workspaceId: WORKSPACE_A, adAccountId: "123456789", status: "draft" },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, "meta_account_binding_ambiguous");
      assert.equal(businessQueries(log).some((entry) => entry.op === "insert" || entry.op === "update"), false);
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previousWorkspace;
    if (previousAccount === undefined) delete process.env.META_AD_ACCOUNT_ID;
    else process.env.META_AD_ACCOUNT_ID = previousAccount;
  }
});

const metaBindingConstraint = "meta_ad_accounts_one_workspace_idx";
const metaBindingWriteError: WriteFailureFixture["error"] = {
  code: "23505",
  message: `fixture-private duplicate key value violates unique constraint "${metaBindingConstraint}"`,
  details: "fixture-private conflicting workspace and account row",
  hint: "fixture-private database diagnostic",
};
const metaBindingExistingId = "22222222-2222-4222-8222-222222222222";
const metaBindingWriteCases: Array<{ op: "insert" | "update"; rows: Record<string, unknown>[] }> = [
  { op: "insert", rows: [] },
  { op: "update", rows: [{ id: metaBindingExistingId, workspace_id: WORKSPACE_A, account_name: "fixture-private saved account" }] },
];
const metaBindingBody = {
  workspaceId: WORKSPACE_A, workspace_id: WORKSPACE_B, id: WORKSPACE_B,
  adAccountId: "act_123456789", status: "draft",
};

async function withMetaBindingRouter(options: LoadOptions, fn: (ctx: Awaited<ReturnType<typeof loadRouter>>) => Promise<void>) {
  const previousWorkspace = process.env.META_WORKSPACE_ID;
  const previousAccount = process.env.META_AD_ACCOUNT_ID;
  process.env.META_WORKSPACE_ID = WORKSPACE_A;
  process.env.META_AD_ACCOUNT_ID = "act_123456789";
  try {
    await withRouter(options, fn);
  } finally {
    if (previousWorkspace === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previousWorkspace;
    if (previousAccount === undefined) delete process.env.META_AD_ACCOUNT_ID;
    else process.env.META_AD_ACCOUNT_ID = previousAccount;
  }
}

function assertSafeMetaBindingFailure(res: MockResponse, error = metaBindingWriteError) {
  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.error, "string");
  assert.match(res.body.error as string, /[А-Яа-яЁё]/, "the operator must receive a Russian error");
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /"(?:item|diagnostics?|message|hint|data|mode|warning)"\s*:/,
    "failed writes must not return an item, diagnostic or demo payload at any depth");
  for (const privateText of [metaBindingConstraint, "fixture-private", error.code, error.message, error.details, error.hint]) {
    if (privateText) assert.ok(!serialized.includes(privateText), "database failure material must not reach the response");
  }
}

function assertSingleMetaBindingWrite(log: QueryLog[], op: "insert" | "update") {
  assertWorkspaceProfileQuery(log, WORKSPACE_A);
  const queries = businessQueries(log);
  assert.deepEqual(queries.map(({ table, op }) => [table, op]), [
    ["meta_ad_accounts", "select"], ["meta_ad_accounts", op],
  ], "one snapshot and one write only: no retry, journal or other business query");
  assert.equal(queries[0].columns, "id");
  assert.deepEqual(queries[0].filters, { workspace_id: WORKSPACE_A });
  const write = queries[1];
  const row = write.filters.__row as Record<string, unknown>;
  assert.equal(row.workspace_id, WORKSPACE_A, "the body cannot replace the verified tenant");
  assert.equal(row.id, undefined, "the body cannot choose the stored row ID");
  if (op === "update") {
    assert.equal(write.filters.id, metaBindingExistingId);
    assert.equal(write.filters.workspace_id, WORKSPACE_A);
  }
  assert.ok(!JSON.stringify(queries).includes(WORKSPACE_B), "no query or write may target the foreign workspace");
}

for (const scenario of metaBindingWriteCases) {
  test(`K2f G5-C3 exact quoted workspace constraint returns a safe conflict on ${scenario.op}`, { timeout: 10_000 }, async () => {
    await withMetaBindingRouter({
      memberships: [memberA], rows: { meta_ad_accounts: scenario.rows },
      writeFailure: { table: "meta_ad_accounts", op: scenario.op, error: metaBindingWriteError },
    }, async (ctx) => {
      const { res, log } = await ctx.call({ segments: ["meta-accounts"], method: "POST", body: metaBindingBody });
      assertSingleMetaBindingWrite(log, scenario.op);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, "meta_account_binding_conflict");
      assertSafeMetaBindingFailure(res);
    });
  });
}

test("K2g G5-C3 near-match database failures retain generic 502 on insert and update", { timeout: 10_000 }, async () => {
  const errors = [
    { ...metaBindingWriteError, code: "XX000" },
    { ...metaBindingWriteError, message: 'fixture-private unique constraint "meta_ad_accounts_pkey"' },
    { ...metaBindingWriteError, message: `fixture-private unique constraint ${metaBindingConstraint}` },
    { ...metaBindingWriteError, message: `fixture-private unique constraint ${metaBindingConstraint}_similar` },
    { ...metaBindingWriteError, message: 'fixture-private unique constraint "meta_ad_accounts_one_workspace_id"' },
    { ...metaBindingWriteError, message: `fixture-private unique constraint "${metaBindingConstraint}_suffix"` },
  ];
  for (const scenario of metaBindingWriteCases) {
    for (const error of errors) {
      await withMetaBindingRouter({
        memberships: [memberA], rows: { meta_ad_accounts: scenario.rows },
        writeFailure: { table: "meta_ad_accounts", op: scenario.op, error },
      }, async (ctx) => {
        const { res, log } = await ctx.call({ segments: ["meta-accounts"], method: "POST", body: metaBindingBody });
        assertSingleMetaBindingWrite(log, scenario.op);
        assert.equal(res.statusCode, 502, `${scenario.op}: ${error.code}: ${error.message}`);
        assert.notEqual(res.body.code, "meta_account_binding_conflict");
        assertSafeMetaBindingFailure(res, error);
      });
    }
  }
});

test("K2h G5-C3 the exact Meta constraint does not reclassify another resource", { timeout: 10_000 }, async () => {
  for (const [resource, table, expectedStatus] of [
    ["clients", "clients", 502], ["clinic-services", "clinic_services", 400], ["clinic-doctors", "clinic_doctors", 400],
  ] as const) {
    await withMetaBindingRouter({
      memberships: [memberA],
      writeFailure: { table, op: "insert", error: metaBindingWriteError },
    }, async (ctx) => {
      const { res, log } = await ctx.call({ segments: [resource], method: "POST", body: { name: "Local fixture", fullName: "Local fixture" } });
      assert.equal(res.statusCode, expectedStatus, resource);
      assert.notEqual(res.statusCode, 409, resource);
      assert.notEqual(res.body.code, "meta_account_binding_conflict", resource);
      assertSafeMetaBindingFailure(res);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      const writes = businessQueries(log).filter((entry) => entry.op !== "select");
      assert.equal(writes.length, 1, "no retry or journal after a refused write");
      assert.equal(writes[0].table, table);
      assert.equal((writes[0].filters.__row as Record<string, unknown>).workspace_id, WORKSPACE_A);
    });
  }
});

test("K2i G5-C3 existing service and doctor unique-error responses keep their own behavior", { timeout: 10_000 }, async () => {
  for (const [resource, table, constraint, expectedError, expectedDetail] of [
    ["clinic-services", "clinic_services", "clinic_services_workspace_name_idx", "Услуга с таким названием уже есть", "name must be unique within the workspace"],
    ["clinic-doctors", "clinic_doctors", "clinic_doctors_workspace_name_idx", "Врач с таким именем уже есть", "fullName must be unique within the workspace"],
    ["clinic-doctors", "clinic_doctors", "clinic_doctors_workspace_staff_user_idx", "Этот сотрудник уже привязан к другому врачу", "staffUserId must be unique within the workspace"],
  ] as const) {
    const error = { ...metaBindingWriteError, message: `fixture-private unique constraint "${constraint}"` };
    await withMetaBindingRouter({ memberships: [memberA], writeFailure: { table, op: "insert", error } }, async (ctx) => {
      const { res, log } = await ctx.call({ segments: [resource], method: "POST", body: { name: "Local fixture", fullName: "Local fixture" } });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { success: false, error: expectedError, details: [expectedDetail] });
      assertSafeMetaBindingFailure(res, error);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.deepEqual(businessQueries(log).filter((entry) => entry.op !== "select").map((entry) => [entry.table, entry.op]), [[table, "insert"]]);
    });
  }
});

test("K2j G5-C3 write failure injection leaves other tables, operations and reads unchanged", { timeout: 10_000 }, async () => {
  const scenarios: Array<{ resource: string; method: string; rows: Record<string, unknown>[]; failureOp: "insert" | "update"; status: number }> = [
    { resource: "meta-accounts", method: "GET", rows: [], failureOp: "insert", status: 200 },
    { resource: "meta-accounts", method: "POST", rows: [], failureOp: "update", status: 201 },
    { resource: "meta-accounts", method: "POST", rows: metaBindingWriteCases[1].rows, failureOp: "insert", status: 201 },
    { resource: "clients", method: "POST", rows: [], failureOp: "insert", status: 201 },
  ];
  for (const scenario of scenarios) {
    await withMetaBindingRouter({
      memberships: [memberA], rows: { meta_ad_accounts: scenario.rows },
      writeFailure: { table: "meta_ad_accounts", op: scenario.failureOp, error: metaBindingWriteError },
    }, async (ctx) => {
      const { res, log } = await ctx.call({ segments: [scenario.resource], method: scenario.method,
        body: scenario.resource === "meta-accounts" ? metaBindingBody : { name: "Local fixture" } });
      assert.equal(res.statusCode, scenario.status, `${scenario.resource} ${scenario.method} with injected ${scenario.failureOp}`);
      assert.equal(res.body.success, true);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      if (scenario.resource === "meta-accounts" && scenario.method === "POST") {
        assertSingleMetaBindingWrite(log, scenario.rows.length ? "update" : "insert");
      }
      if (scenario.method === "GET") assert.ok(log.every((entry) => entry.op === "select"));
    });
  }
});

test("K2k G5-C3 auth, tenant and provisioning refusals precede injected business writes", { timeout: 10_000 }, async () => {
  const refusals = ["anonymous", "invalid-token", "inactive", "role", "foreign-selector", "unprovisioned", "foreign-provisioning", "foreign-account"];
  for (const scenario of metaBindingWriteCases) {
    for (const refusal of refusals) {
      const beforeProfile = ["anonymous", "invalid-token", "inactive", "role", "foreign-selector"].includes(refusal);
      await withMetaBindingRouter({
        memberships: [{ ...memberA, ...(refusal === "inactive" ? { status: "disabled" } : {}), ...(refusal === "role" ? { role: "receptionist" } : {}) }],
        authOk: refusal !== "invalid-token", rows: { meta_ad_accounts: scenario.rows },
        writeFailure: { table: "meta_ad_accounts", op: scenario.op, error: metaBindingWriteError },
      }, async (ctx) => {
        if (refusal === "unprovisioned") delete process.env.META_WORKSPACE_ID;
        if (refusal === "foreign-provisioning") process.env.META_WORKSPACE_ID = WORKSPACE_B;
        const { res, log } = await ctx.call({ segments: ["meta-accounts"], method: "POST",
          token: refusal === "anonymous" ? null : TOKEN,
          query: refusal === "foreign-selector" ? { workspaceId: WORKSPACE_B } : {},
          body: { ...metaBindingBody, ...(refusal === "foreign-account" ? { adAccountId: "act_987654321" } : {}) },
        });
        const expectedStatus = refusal === "anonymous" || refusal === "invalid-token" ? 401 : refusal === "unprovisioned" ? 503 : 403;
        assert.equal(res.statusCode, expectedStatus, `${scenario.op}: ${refusal}`);
        assert.equal(res.body.success, false);
        assert.notEqual(res.body.code, "meta_account_binding_conflict");
        assert.equal(businessQueries(log).length, 0, `${refusal} must precede the account snapshot and every business write`);
        if (beforeProfile) assert.ok(log.every((entry) => entry.table === "staff_users"), `${refusal} must precede the profile read`);
        else assertWorkspaceProfileQuery(log, WORKSPACE_A);
        if (refusal === "foreign-selector" || refusal === "inactive") assert.equal(res.body.code, "workspace_access_denied");
        if (refusal === "unprovisioned") assert.equal(res.body.code, "meta_workspace_not_provisioned");
        if (refusal === "foreign-provisioning") assert.equal(res.body.code, "meta_workspace_not_authorized");
        if (refusal === "foreign-account") assert.equal(res.body.code, "meta_account_not_authorized");
      });
    }
  }
});

test("K2c the provisioned workspace can reach Meta diagnostics", async () => {
  const previous = process.env.META_WORKSPACE_ID;
  process.env.META_WORKSPACE_ID = WORKSPACE_A;
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      const { res } = await ctx.call({
        segments: ["meta-validate"],
        method: "POST",
        query: { workspaceId: WORKSPACE_A },
        body: { dryRun: true },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });
  } finally {
    if (previous === undefined) delete process.env.META_WORKSPACE_ID;
    else process.env.META_WORKSPACE_ID = previous;
  }
});

test("K3 advertising results stay administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["meta-campaign-insights", "meta-insights-history", "meta-insights-sync-runs", "advertising-outcomes"]) {
      const { res } = await ctx.call({ segments: [segment], query: { workspaceId: WORKSPACE_B } });
      assert.equal(res.statusCode, 403, `${segment} must remain owner/admin`);
    }
  });
});

test("K3a TikTok diagnostics and campaign dry-run stay administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["tiktok-validate", "tiktok-dry-run", "tiktok-setup", "tiktok-connection", "tiktok-videos", "tiktok-launch"]) {
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
      for (const segment of ["tiktok-validate", "tiktok-dry-run", "tiktok-setup", "tiktok-connection", "tiktok-videos", "tiktok-launch"]) {
        const { res, log } = await ctx.call({ segments: [segment], method: "POST",
          query: { workspaceId: WORKSPACE_A }, body: { confirm: true, city: "Актобе", workspaceId: WORKSPACE_B } });
        assert.equal(res.statusCode, 403, segment);
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
      }
      const { res, log } = await ctx.call({ segments: ["tiktok-connection"], query: { workspaceId: WORKSPACE_A } });
      assert.equal(res.statusCode, 403);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.TIKTOK_WORKSPACE_ID;
    else process.env.TIKTOK_WORKSPACE_ID = previous;
  }
});

test("K3b1 TikTok launch fails closed before its feature flag when no workspace is provisioned", async () => {
  const previousWorkspace = process.env.TIKTOK_WORKSPACE_ID;
  const previousLaunch = process.env.TIKTOK_DISABLED_LAUNCH_ENABLED;
  delete process.env.TIKTOK_WORKSPACE_ID;
  process.env.TIKTOK_DISABLED_LAUNCH_ENABLED = "false";
  try {
    await withRouter({ memberships: [memberA] }, async (ctx) => {
      const { res, log } = await ctx.call({
        segments: ["tiktok-launch"],
        method: "POST",
        query: { workspaceId: WORKSPACE_A },
        body: { confirm: true, confirmationPhrase: "СОЗДАТЬ" },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, "workspace_not_provisioned");
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env.TIKTOK_WORKSPACE_ID;
    else process.env.TIKTOK_WORKSPACE_ID = previousWorkspace;
    if (previousLaunch === undefined) delete process.env.TIKTOK_DISABLED_LAUNCH_ENABLED;
    else process.env.TIKTOK_DISABLED_LAUNCH_ENABLED = previousLaunch;
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
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
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

test("K3d TikTok video library requires verified owner/admin for GET and POST", async () => {
  for (const method of ["GET", "POST"]) {
    await withRouter({}, async (ctx) => {
      assert.equal((await ctx.call({ segments: ["tiktok-videos"], method, token: null,
        query: { workspaceId: WORKSPACE_A }, body: { confirm: true } })).res.statusCode, 401);
    });
    await withRouter({ authOk: false }, async (ctx) => {
      assert.equal((await ctx.call({ segments: ["tiktok-videos"], method,
        query: { workspaceId: WORKSPACE_A }, body: { confirm: true } })).res.statusCode, 401);
    });
    await withRouter({ memberships: [memberBReception] }, async (ctx) => {
      assert.equal((await ctx.call({ segments: ["tiktok-videos"], method,
        query: { workspaceId: WORKSPACE_B }, body: { confirm: true } })).res.statusCode, 403);
    });
  }
});

test("K3e TikTok video GET returns safe workspace evidence and POST stays off by default", async () => {
  const settings = { TIKTOK_WORKSPACE_ID: WORKSPACE_A, TIKTOK_ADVERTISER_ID: "7123456789012345678",
    TIKTOK_ACCESS_TOKEN: "private-provider-token", TIKTOK_VIDEO_UPLOAD_ENABLED: "false" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const revision = new Date().toISOString();
  try {
    await withRouter({ memberships: [memberA], rows: {
      tiktok_ad_account_connections: [{ workspace_id: WORKSPACE_A, advertiser_id: settings.TIKTOK_ADVERTISER_ID,
        enabled: true, currency: "KZT", account_timezone: "Asia/Almaty", verified_at: revision }],
      ad_creative_assets: [{ id: WORKSPACE_B, workspace_id: WORKSPACE_A, file_name: "Ролик.mp4", file_type: "video",
        mime_type: "video/mp4", file_size: 1000, storage_bucket: "ad-creatives", storage_path: `${WORKSPACE_A}/video.mp4`,
        status: "ready", updated_at: revision, public_url: "https://private.example/never-return" }],
      tiktok_video_uploads: [{ id: WORKSPACE_A, workspace_id: WORKSPACE_A, advertiser_id: settings.TIKTOK_ADVERTISER_ID,
        asset_id: WORKSPACE_B, asset_revision: revision, status: "uploaded", video_id: "v070private", attempt: 1,
        started_at: revision, finished_at: revision }],
    } }, async (ctx) => {
      const library = await ctx.call({ segments: ["tiktok-videos"], query: { workspaceId: WORKSPACE_A } });
      assert.equal(library.res.statusCode, 200);
      assert.equal((library.res.body.data as { enabled: boolean }).enabled, false);
      const evidence = await ctx.call({ segments: ["tiktok-videos"], query: { workspaceId: WORKSPACE_A, assetId: WORKSPACE_B } });
      assert.equal(evidence.res.statusCode, 200);
      assert.equal((evidence.res.body.data as { videoIdAvailable: boolean }).videoIdAvailable, true);
      for (const result of [library, evidence]) {
        assert.doesNotMatch(JSON.stringify(result.res.body), /v070private|private-provider-token|7123456789012345678|https:|storage_path/);
        assertWorkspaceProfileQuery(result.log, WORKSPACE_A);
        for (const query of businessQueries(result.log)) assert.equal(query.filters.workspace_id, WORKSPACE_A);
      }
      const blocked = await ctx.call({ segments: ["tiktok-videos"], method: "POST", query: { workspaceId: WORKSPACE_A },
        body: { confirm: true, assetId: WORKSPACE_B, video_id: "forged", publicUrl: "https://untrusted.example" } });
      assert.equal(blocked.res.statusCode, 409);
      assert.equal(blocked.res.body.code, "upload_disabled");
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("K4 configuration resources remain administrator-only", async () => {
  await withRouter({ memberships: [memberBReception] }, async (ctx) => {
    for (const segment of ["admin-settings", "ai-providers", "integration-statuses", "meta-accounts", "release-checks", "site-blog"]) {
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

const publicPartnerEntryFile = "pages/partner-entry-client.ts";

// Mask one proved anonymous request, never a file or a caller-supplied URL.
// Every other CRM call still reaches both original transport audits unchanged.
function reviewedPublicPartnerEntrySource(file: string, source: string): string {
  if (file.replaceAll("\\", "/") !== publicPartnerEntryFile) return source;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  const one = <T,>(values: T[]): T | undefined => values.length === 1 ? values[0] : undefined;
  const literal = (node: ts.Node | undefined, text: string) => !!node && ts.isStringLiteral(node) && node.text === text;
  const identifier = (node: ts.Node | undefined, text: string) => !!node && ts.isIdentifier(node) && node.text === text;
  const fail = () => assert.fail(`${file}: anonymous partner-entry request boundary requires review`);
  const operation = one(ast.statements.filter(ts.isTypeAliasDeclaration).filter(node => node.name.text === "PartnerEntryOperation"));
  if (!operation || !ts.isUnionTypeNode(operation.type)
    || operation.type.types.length !== 3 || operation.type.types.some((node, index) =>
      !ts.isLiteralTypeNode(node) || !literal(node.literal, ["notice", "prepare", "capture"][index]))) return fail();
  const requestType = one(ast.statements.filter(ts.isTypeAliasDeclaration).filter(node => node.name.text === "PartnerEntryRequest"));
  if (!requestType || !ts.isFunctionTypeNode(requestType.type)
    || requestType.type.getText(ast).replace(/\s/g, "") !== "(op:PartnerEntryOperation,body:unknown,signal:AbortSignal)=>Promise<unknown>") return fail();
  const declaration = one(nodes.filter(ts.isVariableDeclaration).filter(node => identifier(node.name, "requestPartnerEntry")));
  if (!declaration || !declaration.type || !ts.isTypeReferenceNode(declaration.type)
    || !identifier(declaration.type.typeName, "PartnerEntryRequest") || declaration.type.typeArguments
    || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)
    || declaration.parent.declarations.length !== 1 || !ts.isVariableStatement(declaration.parent.parent)
    || !declaration.parent.parent.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || !declaration.initializer || !ts.isArrowFunction(declaration.initializer)) return fail();
  const fn = declaration.initializer;
  if (!fn.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword) || fn.parameters.length !== 3
    || fn.parameters.some((param, index) => !identifier(param.name, ["op", "body", "signal"][index])
      || param.initializer || param.dotDotDotToken || param.questionToken || param.type)
    || !ts.isBlock(fn.body)) return fail();
  const statement = fn.body.statements[0];
  const response = statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement.declarationList.declarations[0] : undefined;
  const awaited = response?.initializer;
  const call = awaited && ts.isAwaitExpression(awaited) && ts.isCallExpression(awaited.expression) ? awaited.expression : undefined;
  if (!response || !identifier(response.name, "response") || !call || !identifier(call.expression, "fetch")
    || call.arguments.length !== 2 || call.typeArguments || call.questionDotToken
    || !ts.isTemplateExpression(call.arguments[0])) return fail();
  const url = call.arguments[0];
  if (url.head.text !== "/api/crm/partner-entry?op=" || url.templateSpans.length !== 1
    || !identifier(url.templateSpans[0].expression, "op") || url.templateSpans[0].literal.text !== "") return fail();
  const options = call.arguments[1];
  const properties = (node: ts.Node): readonly (ts.PropertyAssignment | ts.ShorthandPropertyAssignment)[] | null => {
    if (!ts.isObjectLiteralExpression(node)) return null;
    const result = node.properties.filter((property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) || ts.isShorthandPropertyAssignment(property));
    return result.length === node.properties.length ? result : null;
  };
  const optionsProperties = properties(options);
  const expected = new Map([
    ["method", "POST"], ["credentials", "same-origin"], ["mode", "same-origin"], ["redirect", "error"],
    ["cache", "no-store"], ["referrerPolicy", "no-referrer"],
  ]);
  if (!optionsProperties || optionsProperties.length !== expected.size + 3
    || new Set(optionsProperties.map(property => property.name!.getText(ast))).size !== optionsProperties.length) return fail();
  const property = (name: string) => optionsProperties.find(node => node.name!.getText(ast) === name);
  for (const [name, value] of expected) {
    const node = property(name);
    if (!node || !ts.isPropertyAssignment(node) || !literal(node.initializer, value)) return fail();
  }
  const headers = property("headers"), body = property("body"), signal = property("signal");
  if (!headers || !ts.isPropertyAssignment(headers) || !ts.isObjectLiteralExpression(headers.initializer)
    || headers.initializer.properties.length !== 2 || headers.initializer.properties.some((node, index) =>
      !ts.isPropertyAssignment(node) || !literal(node.initializer, "application/json")
      || !(index === 0 ? literal(node.name, "Content-Type") : identifier(node.name, "Accept")))
    || !body || !ts.isPropertyAssignment(body) || !ts.isCallExpression(body.initializer)
    || !ts.isPropertyAccessExpression(body.initializer.expression) || !identifier(body.initializer.expression.expression, "JSON")
    || body.initializer.expression.name.text !== "stringify" || body.initializer.arguments.length !== 1
    || !identifier(body.initializer.arguments[0], "body") || body.initializer.typeArguments || body.initializer.questionDotToken
    || !signal || !ts.isShorthandPropertyAssignment(signal) || signal.objectAssignmentInitializer) return fail();
  // No imported/shadowed built-ins, parameter mutation, alias or extra network call.
  if (nodes.filter(node => identifier(node, "fetch")).length !== 1
    || nodes.filter(node => identifier(node, "JSON")).length !== 1) return fail();
  const fnNodes: ts.Node[] = [];
  const visitFn = (node: ts.Node) => { fnNodes.push(node); ts.forEachChild(node, visitFn); };
  visitFn(fn);
  for (const [index, use] of [url.templateSpans[0].expression, body.initializer.arguments[0], signal.name].entries()) {
    const name = ["op", "body", "signal"][index];
    const uses = fnNodes.filter(node => identifier(node, name) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node));
    if (uses.length !== 2 || !uses.includes(fn.parameters[index].name) || !uses.includes(use)) return fail();
  }
  return source.slice(0, call.getStart(ast)) + "undefined".padEnd(call.getWidth(ast), " ") + source.slice(call.end);
}

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
    const rel = path.relative(negisSrc, file);
    const source = reviewedPublicPartnerEntrySource(rel, await readFile(file, "utf8"));
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

test("L2b only the actual closed anonymous entry request is recognized; private or widened fetches remain forbidden", async () => {
  const source = await readFile(path.join(negisSrc, publicPartnerEntryFile), "utf8");
  const reviewed = reviewedPublicPartnerEntrySource(publicPartnerEntryFile, source);
  assert.notEqual(reviewed, source, "the exact audited call, not the file, is masked");
  assert.deepEqual(crmTransportOffenders(new Map([[publicPartnerEntryFile, reviewed]])), []);
  const lf = source.replaceAll("\r\n", "\n");
  assert.notEqual(reviewedPublicPartnerEntrySource(publicPartnerEntryFile, lf), lf);
  for (const [from, to] of [
    ["/api/crm/partner-entry?op=", "/api/crm/partner-entry/company?op="],
    ["/api/crm/partner-entry?op=", "/api/crm/leads?op="],
    ["/api/crm/partner-entry?op=", "https://other.invalid/api/crm/partner-entry?op="],
    ["?op=${op}`", "?op=${op}&workspaceId=foreign`"],
    ['"notice" | "prepare" | "capture"', '"notice" | "prepare" | "capture" | "claim"'],
    ['method: "POST"', 'method: "GET"'],
    ['credentials: "same-origin"', 'credentials: "include"'],
    ['mode: "same-origin"', 'mode: "cors"'],
    ['redirect: "error"', 'redirect: "follow"'],
    ['cache: "no-store"', 'cache: "default"'],
    ['referrerPolicy: "no-referrer"', 'referrerPolicy: "unsafe-url"'],
    ['Accept: "application/json"', 'Accept: "application/json", Authorization: "Bearer token"'],
    ['body: JSON.stringify(body)', 'body: JSON.stringify({ ...body as object, workspaceId: "foreign" })'],
    ['body: JSON.stringify(body)', 'body: body as BodyInit'],
    ['    signal,', '    signal: new AbortController().signal,'],
    ['    signal,', '    ...options, signal,'],
    ['    signal,', '    signal, method: "GET",'],
    ['async (op, body, signal) => {', 'async (op, body, signal) => { body = { workspaceId: "foreign" };'],
    ['async (op, body, signal) => {', 'async (op, body, signal) => { const JSON = unsafeSerializer;'],
    ['await fetch(', 'await window.fetch('],
  ]) {
    assert.ok(source.includes(from), `mutation must alter an actual boundary: ${from}`);
    assert.throws(() => reviewedPublicPartnerEntrySource(publicPartnerEntryFile, source.replace(from, to)),
      /anonymous partner-entry request boundary requires review/, to);
  }
  const privateFetch = '\nexport const unsafe = () => fetch("/api/crm/leads", { method: "POST" });';
  assert.throws(() => reviewedPublicPartnerEntrySource(publicPartnerEntryFile, source + privateFetch),
    /anonymous partner-entry request boundary requires review/, "an added fetch cannot hide behind a reviewed module");
  for (const file of ["pages/partner-company-client.ts", "pages/Other.ts"]) {
    const unchanged = reviewedPublicPartnerEntrySource(file, source + privateFetch);
    assert.equal(unchanged, source + privateFetch, "authenticated or arbitrary files receive no exemption");
    assert.ok(crmTransportOffenders(new Map([[file, unchanged]])).some(message => message.startsWith(file + ":")));
  }
  const privateFile = "pages/partner-company-client.ts";
  assert.ok(crmTransportOffenders(new Map([[publicPartnerEntryFile, reviewed], [privateFile, privateFetch]]))
    .some(message => message.startsWith(privateFile + ":")), "recognizing the public call cannot mask another module");
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
  // Private /api/crm/ paths may only reach the network through crmFetch. The one
  // explicit public entry call is proved and masked above, not file-exempted. Page
  // wrappers are fine as long as they delegate to it. Non-CRM endpoints are not
  // covered here — ContentStudio's /api/content-studio/* calls are a different
  // contract.
  const roots = ["pages", "components", "lib", "contexts"].map((dir) => path.join(negisSrc, dir));
  const sources = new Map<string, string>();

  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const source = await readFile(path.join(root, name), "utf8");
      const relative = path.relative(negisSrc, path.join(root, name)).replaceAll("\\", "/");
      sources.set(relative, reviewedPublicPartnerEntrySource(relative, source));
    }
  }

  assert.deepEqual(crmTransportOffenders(sources), [], "these CRM call sites bypass crmFetch or have an unverified transport");
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

const leadSupervisor = { ...memberA, role: "manager" };
const assignmentTeam = Array.from({ length: 8 }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  workspace_id: WORKSPACE_A,
  full_name: index < 6 ? `Manager ${index + 1}` : index === 6 ? "Supervisor" : "Administrator",
  status: "active",
  email: `fixture-${index}@example.test`,
  auth_user_id: `auth-fixture-${index}`,
  permissions: ["fixture-only"],
  password_hash: "fixture-not-a-credential",
}));
const assignmentPeople = assignmentTeam.map((row) => ({ id: row.id, name: row.full_name }));
const isAssigneeRead = (entry: QueryLog) => entry.table === "staff_users" && !("auth_user_id" in entry.filters);

test("N1 manual assignment reads eight names without granting staff administration", async () => {
  await withRouter({ memberships: [leadSupervisor], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const administrative = await ctx.call({ segments: ["staff"] });
    assert.equal(administrative.res.statusCode, 403);
    const { res, log } = await ctx.call({ segments: ["lead-assignees"] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, "supabase");
    const data = res.body.data as Record<string, unknown>;
    assert.deepEqual(data.assignees, assignmentPeople);
    assert.deepEqual(data.items, assignmentPeople);
    const query = log.find(isAssigneeRead);
    assert.ok(query);
    assert.equal(query.columns, "id,full_name,status");
    assert.equal(query.filters.workspace_id, WORKSPACE_A);
    assert.equal(query.filters.status, "active");
    for (const item of data.assignees as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(item).sort(), ["id", "name"]);
    }
    assert.ok(log.every((entry) => entry.op === "select"));
  });
});

test("N2 assignment options exclude foreign and inactive employees and malformed IDs", async () => {
  await withRouter({
    memberships: [leadSupervisor],
    staffDirectory: { rows: [
      ...assignmentTeam,
      { ...assignmentTeam[0], id: "20000000-0000-4000-8000-000000000001", workspace_id: WORKSPACE_B },
      { ...assignmentTeam[0], id: "20000000-0000-4000-8000-000000000002", status: "inactive" },
      { ...assignmentTeam[0], id: "not-a-staff-uuid" },
    ] },
  }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["lead-assignees"] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body.data as Record<string, unknown>).assignees, assignmentPeople);
  });
});

test("N3 an anonymous caller cannot read assignment names", async () => {
  await withRouter({ memberships: [leadSupervisor], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["lead-assignees"], token: null });
    assert.equal(res.statusCode, 401);
    assert.equal(log.length, 0);
    assert.equal(ctx.crmClientCreations, 0);
  });
});

test("N4 an invalid session cannot read assignment names", async () => {
  await withRouter({ memberships: [leadSupervisor], authOk: false, staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["lead-assignees"] });
    assert.equal(res.statusCode, 401);
    assert.equal(log.length, 0);
  });
});

test("N5 browser-supplied permissions cannot open the assignment directory", async () => {
  await withRouter({ memberships: [{ ...memberA, role: "doctor" }], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({
      segments: ["lead-assignees"],
      body: { role: "manager", permissions: ["manage_leads"] },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(log.filter(isAssigneeRead).length, 0);
  });
});

test("N6 a foreign workspace selector is denied before reading assignment options", async () => {
  await withRouter({ memberships: [leadSupervisor], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["lead-assignees"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(res.statusCode, 403);
    assert.equal(log.filter(isAssigneeRead).length, 0);
  });
});

test("N7 the body cannot override the server-verified assignment workspace", async () => {
  await withRouter({ memberships: [leadSupervisor], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({
      segments: ["lead-assignees"],
      body: { workspaceId: WORKSPACE_B, workspace_id: WORKSPACE_B },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(log.find(isAssigneeRead)?.filters.workspace_id, WORKSPACE_A);
    assert.deepEqual((res.body.data as Record<string, unknown>).assignees, assignmentPeople);
  });
});

test("N8 the assignment directory has no write methods", async () => {
  await withRouter({ memberships: [memberA], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const { res, log } = await ctx.call({ segments: ["lead-assignees"], method, body: { role: "owner" } });
      assert.equal(res.statusCode, 405, method);
      assert.equal(log.filter(isAssigneeRead).length, 0);
      assert.ok(log.every((entry) => entry.op === "select"));
    }
  });
});

test("N9 an inactive supervisor cannot read names through an old valid token", async () => {
  await withRouter({ memberships: [{ ...leadSupervisor, status: "inactive" }], staffDirectory: { rows: assignmentTeam } }, async (ctx) => {
    const { res, log } = await ctx.call({ segments: ["lead-assignees"] });
    assert.equal(res.statusCode, 403);
    assert.equal(log.filter(isAssigneeRead).length, 0);
  });
});

test("N10 a failed directory read is not reported as an empty successful list", async () => {
  await withRouter({ memberships: [leadSupervisor], staffDirectory: { rows: assignmentTeam, error: { message: "private-fixture-diagnostic" } } }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["lead-assignees"] });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.ok(!JSON.stringify(res.body).includes("private-fixture-diagnostic"));
    assert.equal(res.body.data, undefined);
  });
});

test("N11 the lead form uses the minimal directory, not staff administration", async () => {
  const source = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");
  assert.ok(source.includes('endpoint: "/api/crm/lead-assignees", listKey: "assignees"'));
  assert.ok(!source.includes('endpoint: "/api/crm/staff"'));
});

const ownLeadStaffId = "30000000-0000-4000-8000-000000000001";
const assignedLeadMember = { ...memberA, id: ownLeadStaffId, role: "lead_manager" };
const ownLeadId = "40000000-0000-4000-8000-000000000001";
const ownLeadRows = [
  { id: ownLeadId, workspace_id: WORKSPACE_A, responsible_user_id: ownLeadStaffId, full_name: "Own fixture", phone: "+77001110001", status: "new" },
  { id: "40000000-0000-4000-8000-000000000002", workspace_id: WORKSPACE_A, responsible_user_id: assignmentTeam[1].id, full_name: "Other fixture", phone: "+77001110002" },
  { id: "40000000-0000-4000-8000-000000000003", workspace_id: WORKSPACE_A, responsible_user_id: null, full_name: "Unassigned fixture" },
  { id: "40000000-0000-4000-8000-000000000004", workspace_id: WORKSPACE_B, responsible_user_id: ownLeadStaffId, full_name: "Foreign fixture" },
];

test("P1 assigned-only role has only two permissions and cannot grant roles", async () => {
  const { permissionsForRole, canAssignRole, staffRoles } = await import(pathToFileURL(path.join(repoRoot, "lib/auth/permissions.ts")).href) as {
    permissionsForRole(role: string): string[]; canAssignRole(actor: string, target: string): boolean; staffRoles: string[];
  };
  assert.ok(staffRoles.includes("lead_manager"));
  assert.deepEqual(permissionsForRole("lead_manager"), ["view_leads", "manage_leads"]);
  for (const role of staffRoles) assert.equal(canAssignRole("lead_manager", role), false);
  assert.equal(canAssignRole("admin", "lead_manager"), true);
  assert.ok(permissionsForRole("manager").includes("view_clients"), "existing supervisor unchanged");
});

test("P2 assigned leads are fetched only through the scoped RPC with verified identity", async () => {
  const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    const { res, log } = await ctx.call({ segments: ["leads"], query: { responsibleUserId: assignmentTeam[1].id, staffUserId: assignmentTeam[1].id },
      body: { workspaceId: WORKSPACE_B, role: "owner", p_staff_user_id: assignmentTeam[1].id } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(((res.body.data as Record<string, unknown>).leads as Record<string, unknown>[]).map(x => x.id), [ownLeadId]);
    assert.deepEqual(fixture.calls, [{ name: "read_assigned_crm_leads", args: {
      p_workspace_id: WORKSPACE_A, p_staff_user_id: ownLeadStaffId, p_auth_user_id: USER_A,
    } }]);
    assertWorkspaceProfileQuery(log, WORKSPACE_A);
    assert.equal(businessQueries(log).length, 0, "no generic leads SELECT may bypass RPC");
  });
});

test("P3 assigned-only access has a closed browser-route allowlist", async () => {
  const registry = await import(pathToFileURL(registryPath).href) as {
    CRM_ROUTE_AUTHORIZATION: Record<string, { kind: string; methods?: string[] }>;
  };
  const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    for (const [route, policy] of Object.entries(registry.CRM_ROUTE_AUTHORIZATION)) {
      if (policy.kind !== "browser") continue;
      for (const method of policy.methods ?? []) {
        if ((route === "leads" && (method === "GET" || method === "PATCH"))
          || ((route === "lead-stages" || route === "lead-sources") && method === "GET")) continue;
        const { res, log } = await ctx.call({ segments: route.split("/"), method, body: { id: ownLeadId, updates: { notes: "forged" } } });
        assert.ok([403,404,405].includes(res.statusCode), `${route} ${method}: ${res.statusCode}`);
        assert.equal(businessQueries(log).length, 0, `${route} must fail before any business query`);
        if (route === "mortgage-workspace" || (route === "mortgage-contracts" && ["GET", "POST"].includes(method))) {
          // Only these dedicated methods need purpose to decide this role's access.
          assert.equal(res.statusCode, 403, "the dedicated route requires authoritative mortgage purpose");
          assertWorkspaceProfileQuery(log, WORKSPACE_A);
          assert.ok(log.every((entry) => entry.table === "staff_users" || isWorkspaceProfileQuery(entry)),
            "only membership and the verified workspace purpose may be read before denial");
        } else {
          assert.ok(log.every((entry) => entry.table === "staff_users"), `${route} must not read a profile before permission denial`);
        }
      }
    }
    assert.equal(fixture.calls.length, 0);
  });
});

test("P3a dedicated mortgage access verifies membership and workspace selection before its purpose read", async () => {
  for (const scenario of [
    { memberships: [assignedLeadMember], token: null, status: 401 },
    { memberships: [assignedLeadMember], authOk: false, status: 401 },
    { memberships: [], status: 403 },
    { memberships: [{ ...assignedLeadMember, status: "inactive" }], status: 403 },
    { memberships: [assignedLeadMember], query: { workspaceId: WORKSPACE_B }, status: 403 },
    { memberships: [assignedLeadMember, { ...assignedLeadMember, id: "staff-b", workspace_id: WORKSPACE_B }], status: 403 },
  ]) {
    const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
    await withRouter({ memberships: scenario.memberships, authOk: scenario.authOk, assignedLeads: fixture }, async ctx => {
      for (const [route, method] of [["mortgage-workspace", "GET"], ["mortgage-workspace", "POST"], ["mortgage-workspace", "PATCH"],
        ["mortgage-contracts", "GET"], ["mortgage-contracts", "POST"]]) {
        const { res, log } = await ctx.call({ segments: [route], method, token: scenario.token,
          query: scenario.query, body: { purpose: "mortgage_leads", role: "owner" } });
        assert.equal(res.statusCode, scenario.status);
        assert.ok(log.every((entry) => entry.table === "staff_users"), "unverified scope must not read a profile or business data");
      }
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("P3b a browser-claimed mortgage purpose cannot open the dedicated routes", async () => {
  for (const profile of [[], [{ workspace_id: WORKSPACE_A, value: { purpose: "clinic_services" } }]]) {
    const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
    await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture, rows: { workspace_settings: profile } }, async ctx => {
      for (const [route, method] of [["mortgage-workspace", "GET"], ["mortgage-workspace", "POST"], ["mortgage-workspace", "PATCH"],
        ["mortgage-contracts", "GET"], ["mortgage-contracts", "POST"]]) {
        const { res, log } = await ctx.call({ segments: [route], method,
          query: { workspaceId: WORKSPACE_A, purpose: "mortgage_leads" },
          body: { workspaceId: WORKSPACE_B, purpose: "mortgage_leads", role: "owner" } });
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.success, false);
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.ok(log.every((entry) => entry.table === "staff_users" || isWorkspaceProfileQuery(entry)));
        assert.equal(businessQueries(log).length, 0);
      }
      assert.equal(fixture.calls.length, 0);
    });
  }
});

const outcomesProfile = [{ workspace_id: WORKSPACE_A, value: { purpose: "mortgage_leads" } }];
const outcomesRequestId = "50000000-0000-4000-8000-000000000001";
const outcomesContractId = "60000000-0000-4000-8000-000000000001";
const outcomesCreate = { leadId: ownLeadId, requestId: outcomesRequestId, signedAt: "2026-06-01T12:00:00Z", reference: " Fixture " };
const outcomesVoid = { leadId: ownLeadId, requestId: outcomesRequestId, id: outcomesContractId, reason: " Fixture correction " };
const outcomesIdentity = { p_workspace_id: WORKSPACE_A, p_staff_user_id: ownLeadStaffId, p_auth_user_id: USER_A };

for (const role of ["owner", "admin", "lead_manager"]) {
  test(`P3c ${role} contract reads and writes use only verified RPC identity`, async () => {
    const fixture: MortgageOutcomesFixture = { calls: [] };
    await withRouter({ memberships: [{ ...assignedLeadMember, role }], mortgageOutcomes: fixture,
      rows: { workspace_settings: outcomesProfile } }, async ctx => {
      for (const method of role === "lead_manager" ? ["GET", "POST"] : ["GET", "POST", "PATCH"]) {
        const { res, log } = await ctx.call({ segments: ["mortgage-contracts"], method,
          query: { workspaceId: WORKSPACE_A, leadId: ownLeadId, purpose: "clinic_services", role: "owner",
            staffUserId: assignmentTeam[1].id, p_staff_user_id: assignmentTeam[1].id, p_workspace_id: WORKSPACE_B, p_auth_user_id: "forged" },
          body: method === "GET" ? { workspaceId: WORKSPACE_B, role: "owner", leadId: ownLeadRows[1].id }
            : method === "POST" ? outcomesCreate : outcomesVoid });
        assert.equal(res.statusCode, 200, `${role} ${method}`);
        assert.equal(res.body.mode, "supabase");
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0, "outcomes must not use generic business queries");
        assert.deepEqual(fixture.calls.at(-1), method === "GET"
          ? { name: "read_mortgage_contracts", args: { ...outcomesIdentity, p_lead_id: ownLeadId } }
          : { name: "save_mortgage_contract", args: { ...outcomesIdentity, p_lead_id: ownLeadId,
            p_contract_id: method === "POST" ? null : outcomesContractId, p_request_id: outcomesRequestId,
            p_payload: method === "POST" ? { signedAt: "2026-06-01T12:00:00.000Z", reference: "Fixture" } : { reason: "Fixture correction" } } });
      }
      assert.equal(fixture.calls.length, role === "lead_manager" ? 2 : 3);
    });
  });
}

test("P3d lead-manager correction and results are denied before profile lookup even for mortgage purpose", async () => {
  const fixture: MortgageOutcomesFixture = { calls: [] };
  await withRouter({ memberships: [assignedLeadMember], mortgageOutcomes: fixture,
    rows: { workspace_settings: outcomesProfile } }, async ctx => {
    for (const [route, method] of [["mortgage-contracts", "PATCH"], ["mortgage-results", "GET"]]) {
      const { res, log } = await ctx.call({ segments: [route], method,
        query: { purpose: "mortgage_leads", role: "owner" }, body: { ...outcomesVoid, role: "owner", permissions: ["view_admin"] } });
      assert.equal(res.statusCode, 403);
      assert.ok(log.every((entry) => entry.table === "staff_users"), `${route} ${method} must not read a profile`);
    }
    assert.deepEqual(fixture.calls, []);
  });
});

for (const role of ["owner", "admin"]) {
  test(`P3e ${role} results allow only supported periods and verified identity`, async () => {
    const fixture: MortgageOutcomesFixture = { calls: [], result: { members: [], timeZone: "Asia/Almaty" } };
    await withRouter({ memberships: [{ ...assignedLeadMember, role }], mortgageOutcomes: fixture,
      rows: { workspace_settings: outcomesProfile } }, async ctx => {
      for (const days of [undefined, "7", "30", "90"]) {
        const { res, log } = await ctx.call({ segments: ["mortgage-results"], query: { days,
          staffUserId: assignmentTeam[1].id, responsibleUserId: assignmentTeam[1].id, p_workspace_id: WORKSPACE_B },
          body: { workspaceId: WORKSPACE_B, role: "lead_manager", days: 999, p_auth_user_id: "forged" } });
        assert.equal(res.statusCode, 200);
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
        assert.deepEqual(fixture.calls.at(-1), { name: "read_mortgage_results", args: { ...outcomesIdentity, p_days: Number(days ?? 30) } });
      }
      fixture.calls.length = 0;
      for (const days of ["0", "365", "07", "30.0", "30&role=owner", ["7", "90"], 30, {}, null]) {
        const { res, log } = await ctx.call({ segments: ["mortgage-results"], query: { days } });
        assert.equal(res.statusCode, 400);
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
      }
      assert.deepEqual(fixture.calls, []);
    });
  });

  test(`P3e ${role} rejects results without a valid authoritative time zone`, async () => {
    const fixture: MortgageOutcomesFixture = { calls: [] };
    await withRouter({ memberships: [{ ...assignedLeadMember, role }], mortgageOutcomes: fixture,
      rows: { workspace_settings: outcomesProfile } }, async ctx => {
      for (const timeZone of [undefined, null, "", "not/an-iana-zone", 5, {}]) {
        fixture.result = { members: [], timeZone, privateDetail: "must-not-leak" };
        const { res, log } = await ctx.call({ segments: ["mortgage-results"], query: { days: "30", timeZone: "Asia/Almaty" } });
        assert.equal(res.statusCode, 502);
        assert.deepEqual(res.body, { success: false, code: "outcomes_unavailable", error: "Не удалось загрузить результаты" });
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.deepEqual(fixture.calls.at(-1), { name: "read_mortgage_results", args: { ...outcomesIdentity, p_days: 30 } });
      }
    });
  });
}

test("P3f results and contracts cannot widen their registered methods", async () => {
  const fixture: MortgageOutcomesFixture = { calls: [] };
  await withRouter({ memberships: [{ ...assignedLeadMember, role: "owner" }], mortgageOutcomes: fixture,
    rows: { workspace_settings: outcomesProfile } }, async ctx => {
    for (const [route, methods] of [["mortgage-contracts", ["PUT", "DELETE", "HEAD"]],
      ["mortgage-results", ["POST", "PATCH", "PUT", "DELETE", "HEAD"]]] as const) {
      for (const method of methods) {
        const { res, log } = await ctx.call({ segments: [route], method, body: outcomesCreate });
        assert.equal(res.statusCode, 405, `${route} ${method}`);
        assert.equal(businessQueries(log).length, 0);
        assert.ok(!log.some(isWorkspaceProfileQuery));
      }
    }
    assert.deepEqual(fixture.calls, []);
  });
});

test("P3g outcome roles and authoritative mortgage purpose only narrow access", async () => {
  for (const role of ["owner", "admin", "lead_manager", "manager", "doctor", "receptionist"]) {
    for (const profile of [[], [{ workspace_id: WORKSPACE_A, value: { purpose: "clinic_services" } }], outcomesProfile]) {
      const fixture: MortgageOutcomesFixture = { calls: [] };
      await withRouter({ memberships: [{ ...assignedLeadMember, role }], mortgageOutcomes: fixture,
        rows: { workspace_settings: profile } }, async ctx => {
        for (const [route, method] of [["mortgage-contracts", "GET"], ["mortgage-contracts", "POST"],
          ["mortgage-contracts", "PATCH"], ["mortgage-results", "GET"]]) {
          if (profile === outcomesProfile && (["owner", "admin"].includes(role)
            || (role === "lead_manager" && route === "mortgage-contracts" && method !== "PATCH"))) continue;
          const { res, log } = await ctx.call({ segments: [route], method,
            query: { purpose: "mortgage_leads", role: "owner", leadId: ownLeadId },
            body: { ...outcomesCreate, purpose: "mortgage_leads", role: "owner" } });
          assert.equal(res.statusCode, 403, `${role} ${route} ${method}`);
          assert.equal(businessQueries(log).length, 0);
          const preflightAllowed = ["owner", "admin"].includes(role)
            || (role === "lead_manager" && route === "mortgage-contracts" && method !== "PATCH");
          if (preflightAllowed) assertWorkspaceProfileQuery(log, WORKSPACE_A);
          else assert.ok(log.every((entry) => entry.table === "staff_users"));
        }
        assert.deepEqual(fixture.calls, []);
      });
    }
  }
});

test("P3h outcome body identity and permission forgery is rejected before RPC", async () => {
  const fixture: MortgageOutcomesFixture = { calls: [] };
  await withRouter({ memberships: [{ ...assignedLeadMember, role: "owner" }], mortgageOutcomes: fixture,
    rows: { workspace_settings: outcomesProfile } }, async ctx => {
    for (const method of ["POST", "PATCH"]) {
      for (const key of ["workspaceId", "workspace_id", "staffUserId", "responsibleStaffId", "responsible_user_id",
        "recordedBy", "recorded_by", "p_auth_user_id", "p_staff_user_id", "p_workspace_id", "role", "permissions", "purpose", "updates"]) {
        const { res, log } = await ctx.call({ segments: ["mortgage-contracts"], method,
          body: { ...(method === "POST" ? outcomesCreate : outcomesVoid), [key]: "forged" } });
        assert.equal(res.statusCode, 400, `${method} ${key}`);
        assert.equal(res.body.code, "invalid_contract");
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
      }
    }
    for (const leadId of [undefined, "bad", [ownLeadId, ownLeadRows[1].id], {}]) {
      const { res } = await ctx.call({ segments: ["mortgage-contracts"], query: { leadId }, body: { leadId: ownLeadId } });
      assert.equal(res.statusCode, 400, "the body cannot repair a malformed read selector");
    }
    assert.deepEqual(fixture.calls, []);
  });
});

test("P3i outcomes membership and tenant selection precede profile and RPC for both resources", async () => {
  for (const scenario of [
    { memberships: [{ ...assignedLeadMember, role: "owner" }], token: null, status: 401 },
    { memberships: [], status: 403 },
    { memberships: [{ ...assignedLeadMember, role: "owner", status: "inactive" }], status: 403 },
    { memberships: [{ ...assignedLeadMember, role: "owner" }], workspaceId: WORKSPACE_B, status: 403 },
  ]) {
    const fixture: MortgageOutcomesFixture = { calls: [] };
    await withRouter({ memberships: scenario.memberships, mortgageOutcomes: fixture,
      rows: { workspace_settings: outcomesProfile } }, async ctx => {
      for (const [route, method] of [["mortgage-contracts", "GET"], ["mortgage-contracts", "POST"],
        ["mortgage-contracts", "PATCH"], ["mortgage-results", "GET"]]) {
        const { res, log } = await ctx.call({ segments: [route], method, token: scenario.token,
          query: { workspaceId: scenario.workspaceId, leadId: ownLeadId }, body: outcomesCreate });
        assert.equal(res.statusCode, scenario.status);
        assert.ok(log.every((entry) => entry.table === "staff_users"));
      }
      assert.deepEqual(fixture.calls, []);
    });
  }
});

test("P3j outcome RPC scope revocation and invisible records never fall back to generic queries", async () => {
  for (const [code, status] of [["P7001", 403], ["P7002", 404]] as const) {
    const fixture: MortgageOutcomesFixture = { calls: [], error: { code, message: "private-outcomes-diagnostic" } };
    await withRouter({ memberships: [{ ...assignedLeadMember, role: "owner" }], mortgageOutcomes: fixture,
      rows: { workspace_settings: outcomesProfile } }, async ctx => {
      for (const [route, method] of [["mortgage-contracts", "GET"], ["mortgage-contracts", "POST"],
        ["mortgage-contracts", "PATCH"], ["mortgage-results", "GET"]]) {
        const { res, log } = await ctx.call({ segments: [route], method, query: { leadId: ownLeadId },
          body: method === "PATCH" ? outcomesVoid : outcomesCreate });
        assert.equal(res.statusCode, status);
        assert.equal(res.body.success, false);
        assert.equal(res.body.mode, undefined);
        assert.ok(!JSON.stringify(res.body).includes("private-outcomes-diagnostic"));
        assertWorkspaceProfileQuery(log, WORKSPACE_A);
        assert.equal(businessQueries(log).length, 0);
        assert.equal(fixture.calls.at(-1)?.args.p_workspace_id, WORKSPACE_A);
      }
      assert.equal(fixture.calls.length, 4);
    });
  }
});

test("P4 scoped PATCH is normalized and cannot use the generic UPDATE", async () => {
  const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    const { res, log } = await ctx.call({ segments: ["leads"], method: "PATCH",
      body: { id: ownLeadId, workspaceId: WORKSPACE_B, updates: { name: " Updated ", notes: " Own note " } } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(fixture.calls[0], { name: "patch_assigned_crm_lead", args: {
      p_workspace_id: WORKSPACE_A, p_staff_user_id: ownLeadStaffId, p_auth_user_id: USER_A,
      p_lead_id: ownLeadId, p_patch: { full_name: "Updated", notes: "Own note" },
    } });
    assert.ok(!log.some(x => x.table === "leads"));
    assert.equal((res.body.data as Record<string, unknown>).item !== undefined, true);
  });
});

test("P5 assignment, source, client, campaign and unknown fields never reach the RPC", async () => {
  const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    for (const key of ["responsibleUserId","responsible_user_id","clientId","client_id","source","sourceId","source_id",
      "campaign","metaCampaignLaunchId","meta_campaign_launch_id","workspace_id","role","permissions","updated_at","constructor","toString"]) {
      const { res, log } = await ctx.call({ segments: ["leads"], method: "PATCH",
        body: { id: ownLeadId, updates: { notes: "legitimate", [key]: "forged" } } });
      assert.equal(res.statusCode, 400, key);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    }
    for (const updates of [{}, { notes: {} }, { name: "a", full_name: "b" }, { stageId: "bad" }, { status: "" }, { notes: "x".repeat(10001) }]) {
      const { res } = await ctx.call({ segments: ["leads"], method: "PATCH", body: { id: ownLeadId, updates } });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(fixture.calls.length, 0);
  });
});

test("P6 unassigned, another employee, foreign and missing PATCH IDs have one refusal", async () => {
  const fixture: AssignedLeadFixture = { calls: [], rows: ownLeadRows };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    let reference: unknown;
    for (const id of [...ownLeadRows.slice(1).map(x => x.id), "40000000-0000-4000-8000-000000000099"]) {
      const { res, log } = await ctx.call({ segments: ["leads"], method: "PATCH", body: { id, updates: { notes: "forged" } } });
      assert.equal(res.statusCode, 404);
      if (!reference) reference = res.body; else assert.deepEqual(res.body, reference);
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    }
  });
});

test("P7 a revoked membership with a still valid token is denied before reading or patching", async () => {
  for (const membership of [{ ...assignedLeadMember, status: "paused" }, { ...assignedLeadMember, role: "unknown" }]) {
    const fixture: AssignedLeadFixture = { calls: [] };
    await withRouter({ memberships: [membership], assignedLeads: fixture }, async ctx => {
      for (const method of ["GET", "PATCH"]) {
        const { res, log } = await ctx.call({ segments: ["leads"], method, body: { id: ownLeadId, updates: { notes: "n" } } });
        assert.equal(res.statusCode, 403);
        assert.equal(businessQueries(log).length, 0);
        assert.ok(log.every((entry) => entry.table === "staff_users"), "revoked membership must not read a profile");
      }
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("P8 database revocation, reassignment, validation and missing migration never become demo success", async () => {
  for (const [code, expected] of [["P6901",403],["P6902",404],["P6903",400],["PGRST202",502],["XX000",502]] as const) {
    const fixture: AssignedLeadFixture = { calls: [], error: { code, message: "private-database-fixture" } };
    await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
      const { res, log } = await ctx.call({ segments: ["leads"], method: "PATCH", body: { id: ownLeadId, updates: { notes: "n" } } });
      assert.equal(res.statusCode, expected, code);
      assert.equal(res.body.success, false);
      assert.equal(res.body.mode, undefined);
      assert.ok(!JSON.stringify(res.body).includes("private-database-fixture"));
      assertWorkspaceProfileQuery(log, WORKSPACE_A);
      assert.equal(businessQueries(log).length, 0);
    });
  }
});

test("P9 assigned-only GET rejects an invalid RPC result and a foreign workspace selector", async () => {
  const fixture: AssignedLeadFixture = { calls: [], result: {} };
  await withRouter({ memberships: [assignedLeadMember], assignedLeads: fixture }, async ctx => {
    const { res } = await ctx.call({ segments: ["leads"] });
    assert.equal(res.statusCode, 502);
    fixture.calls.length = 0;
    const denied = await ctx.call({ segments: ["leads"], query: { workspaceId: WORKSPACE_B } });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(fixture.calls.length, 0);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Selection-1 — the workspace choice the server has been asking for.
//
// /api/crm/auth-context has answered `requiresWorkspaceSelection: true` with a
// null workspaceId since Security-2B, because the server refuses to pick a
// tenant for a user who belongs to several. Nothing in the app ever offered the
// choice: such a user was told their account was not linked to a clinic, and a
// second device or cleared site data left them there permanently.
//
// These tests drive the real router for the server half and pin the browser
// half at the source, which is the only level the frontend is testable at in
// this repository. Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature";

type QueryLog = { table: string; filters: Record<string, unknown> };

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

type LoadOptions = {
  rows?: Record<string, unknown[]>;
  /** Tables whose queries fail, to exercise degraded paths. */
  errors?: Record<string, string>;
};

async function loadRouter(options: LoadOptions = {}) {
  const queries: QueryLog[] = [];

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER_A, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      const entry: QueryLog = { table, filters: {} };
      queries.push(entry);
      const settle = (shape: "one" | "list") => {
        const message = options.errors?.[table];
        if (message) return Promise.resolve({ data: null, error: { message } });
        const tableRows = options.rows?.[table] ?? [];
        return Promise.resolve(
          shape === "list"
            ? { data: tableRows, error: null, count: tableRows.length }
            : { data: tableRows[0] ?? null, error: null },
        );
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
        in(column: string, values: unknown) { entry.filters[column] = values; return builder; },
        single: () => settle("one"),
        maybeSingle: () => settle("one"),
        then(onFulfilled: (value: unknown) => unknown) { return settle("list").then(onFulfilled); },
      });
      return builder;
    },
  }));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (query: Record<string, unknown> = {}) => {
    queries.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: ["auth-context"], ...query },
        body: undefined,
      },
      res,
    );
    return { res, queries: queries.map((entry) => ({ ...entry })) };
  };

  return {
    call,
    restore: () => {
      globalThis.fetch = originalFetch;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
    },
  };
}

async function withRouter<T>(options: LoadOptions, fn: (ctx: Awaited<ReturnType<typeof loadRouter>>) => Promise<T>): Promise<T> {
  const ctx = await loadRouter(options);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

const twoMemberships = {
  staff_users: [
    { id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" },
    { id: "staff-b", workspace_id: WORKSPACE_B, role: "marketer", status: "active" },
  ],
  workspaces: [
    { id: WORKSPACE_A, name: "Клиника на Абая" },
    { id: WORKSPACE_B, name: "Клиника на Сатпаева" },
  ],
};

function membershipsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = (body.data ?? {}) as Record<string, unknown>;
  return Array.isArray(data.memberships) ? (data.memberships as Array<Record<string, unknown>>) : [];
}

// ===========================================================================
// A. The server names the choice
// ===========================================================================

test("W1 a caller with two memberships is offered both, by name", async () => {
  await withRouter({ rows: twoMemberships }, async (ctx) => {
    const { res } = await ctx.call();

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const data = res.body.data as Record<string, unknown>;
    assert.equal(data.requiresWorkspaceSelection, true);
    assert.equal(data.workspaceId, null, "the server must not pick one of them");

    const names = membershipsOf(res.body).map((entry) => entry.workspaceName);
    assert.deepEqual(names, ["Клиника на Абая", "Клиника на Сатпаева"]);
  });
});

test("W2 the name lookup is keyed by the caller's own memberships and nothing else", async () => {
  await withRouter({ rows: twoMemberships }, async (ctx) => {
    // A workspace id in the request must not influence the query in any way.
    const { queries } = await ctx.call({ workspaceId: WORKSPACE_C });

    const lookup = queries.find((entry) => entry.table === "workspaces");
    assert.ok(lookup, "the handler must look the names up");
    assert.deepEqual(lookup.filters.id, [WORKSPACE_A, WORKSPACE_B]);
    assert.equal(
      JSON.stringify(lookup.filters).includes(WORKSPACE_C),
      false,
      "a workspace named in the request must never reach the query",
    );
  });
});

test("W3 a single membership still resolves without a choice", async () => {
  await withRouter({
    rows: {
      staff_users: [{ id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" }],
      workspaces: [{ id: WORKSPACE_A, name: "Клиника на Абая" }],
    },
  }, async (ctx) => {
    const { res } = await ctx.call();
    const data = res.body.data as Record<string, unknown>;
    assert.equal(data.requiresWorkspaceSelection, false);
    assert.equal(data.workspaceId, WORKSPACE_A);
    assert.equal(membershipsOf(res.body)[0].workspaceName, "Клиника на Абая");
  });
});

test("W4 a failed name lookup degrades to an unnamed choice, not to a failed login", async () => {
  await withRouter({ rows: twoMemberships, errors: { workspaces: "relation unavailable" } }, async (ctx) => {
    const { res } = await ctx.call();

    assert.equal(res.statusCode, 200, "names are cosmetic; losing them must not deny access");
    const names = membershipsOf(res.body).map((entry) => entry.workspaceName);
    assert.deepEqual(names, ["", ""]);
    assert.equal(membershipsOf(res.body).length, 2, "the memberships themselves must survive");
  });
});

// ===========================================================================
// B. The browser offers it
// ===========================================================================

test("W5 the picker is mounted and renders only when a choice is actually pending", async () => {
  const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
  assert.ok(app.includes("<WorkspacePicker />"), "App must mount the picker");

  const picker = await readFile(path.join(negisSrc, "components", "WorkspacePicker.tsx"), "utf8");
  for (const condition of ["!isLoading", "!clinicId", "!isDemoMode", "!isImpersonation", "availableWorkspaces.length > 1"]) {
    assert.ok(picker.includes(condition), `the picker must be gated on ${condition}`);
  }
  assert.ok(picker.includes("selectWorkspace(workspace.id)"), "choosing must go through the context");
  assert.ok(picker.includes("Выберите клинику"), "the UI stays in Russian");
});

test("W6 selecting a workspace is refused unless the server listed it", async () => {
  const source = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  const selector = source.slice(source.indexOf("const selectWorkspace"));
  const body = selector.slice(0, selector.indexOf("\n  };"));

  assert.ok(
    body.includes("membershipsRef.current") && body.includes("memberships.find"),
    "the candidate must be looked up in the memberships the server returned",
  );
  assert.ok(
    body.includes("if (!selected") && body.includes("return;"),
    "anything not in that list must be refused",
  );
});

test("W7 the choice is reversible: the sidebar offers it back to multi-clinic users only", async () => {
  const sidebar = await readFile(path.join(negisSrc, "components", "layout", "Sidebar.tsx"), "utf8");
  assert.ok(
    sidebar.includes("availableWorkspaces.length > 1 &&"),
    "the switch control must be hidden from single-clinic users",
  );
  assert.ok(sidebar.includes("clearWorkspaceSelection"), "and must return them to the picker");
  assert.ok(sidebar.includes('aria-label="Сменить клинику"'), "the control needs an accessible name");

  const auth = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  const clear = auth.slice(auth.indexOf("const clearWorkspaceSelection"));
  assert.ok(
    clear.slice(0, clear.indexOf("\n  };")).includes("membershipsRef.current.length < 2"),
    "clearing the selection is meaningless with one membership and must be a no-op",
  );
});

test("W8 a user with several memberships is no longer told their account is unlinked", async () => {
  const source = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  const fn = source.slice(source.indexOf("const applyNoWorkspaceAccess"));
  const body = fn.slice(0, fn.indexOf("\n  };"));

  const guardAt = body.indexOf("membershipsRef.current.length > 1");
  const toastAt = body.indexOf("Аккаунт не связан с клиникой");
  assert.ok(guardAt > 0, "the multi-membership case must be recognised");
  assert.ok(toastAt > guardAt, "and must return before the misleading message");
});

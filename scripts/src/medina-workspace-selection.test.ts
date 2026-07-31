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

// ===========================================================================
// C. Selection-2: nothing one clinic cached may appear in another
// ===========================================================================

// These caches were written when a browser could only ever be in one workspace,
// so nothing could cross. Selection-1 made switching possible and turned every
// unscoped key into a leak: a patient's name and phone prefilled into another
// clinic's appointment form, one clinic's WhatsApp destination in another
// clinic's campaign brief, one clinic's Meta ad account shown — and saved — on
// another clinic's admin screen.

/** localStorage keys that are per-user or per-browser, not per-clinic. */
const UNSCOPED_BY_DESIGN = new Set([
  "negis_ads_automation_ui_mode",
  "negis_onboarding_hint_dismissed",
  "negis_plan",
  // Auth and demo-session plumbing: read before a workspace is even known.
  "negis_staff_user",
  "negis_staff_session",
  "negis_demo_user",
  "negis_demo_workspace",
  "negis_demo_session",
  "negis_clinic_id",
  "negis_session",
  "negis_impersonation",
  "negis_workspace_selector",
]);

async function readPageSources(): Promise<Array<{ file: string; source: string }>> {
  const dir = path.join(negisSrc, "pages");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((entry) => entry.endsWith(".tsx"));
  return Promise.all(
    files.map(async (file) => ({ file, source: await readFile(path.join(dir, file), "utf8") })),
  );
}

test("W9 the scoping helper binds a key to the current workspace", async () => {
  const source = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  const fn = source.slice(source.indexOf("export function workspaceScopedKey"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  assert.ok(body.includes("readWorkspaceId()"), "the scope must be the workspace in effect right now");
  assert.ok(body.includes("`${key}::"), "and must be part of the key, not a separate entry");
});

test("W10 no page stores one clinic's data under a key another clinic can read", async () => {
  const offenders: string[] = [];
  for (const { file, source } of await readPageSources()) {
    // Only literal keys: a variable is either already scoped or covered by W11.
    for (const match of source.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*"([a-z0-9_]+)"/g)) {
      if (!UNSCOPED_BY_DESIGN.has(match[1])) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "wrap the key in workspaceScopedKey, or add it to UNSCOPED_BY_DESIGN with a reason if it is not clinic data",
  );
});

test("W11 the handoff and admin caches are scoped at every site", async () => {
  const sources = new Map((await readPageSources()).map((entry) => [entry.file, entry.source]));

  // Appointment, deal and Content Studio handoffs: written on one page, read on
  // another, so both ends have to agree on the scope.
  for (const [file, keys] of [
    ["ClientsPage.tsx", ["APPOINTMENT_PREFILL_KEY", "DEAL_PREFILL_KEY"]],
    ["LeadsPage.tsx", ["APPOINTMENT_PREFILL_KEY", "DEAL_PREFILL_KEY"]],
    ["AdsAutomation.tsx", ["STUDIO_PREFILL_KEY"]],
  ] as const) {
    const source = sources.get(file) ?? "";
    const lines = source.split(/\r?\n/);
    for (const key of keys) {
      // Plain string matching on purpose: a RegExp built in a template literal
      // has lost its backslashes twice in this repository already.
      for (const call of ["getItem(", "setItem(", "removeItem("]) {
        assert.equal(
          source.includes(`localStorage.${call}${key}`),
          false,
          `${file} passes ${key} to ${call} without a workspace scope`,
        );
      }
      // The same call split across lines, with the key as the first argument.
      assert.equal(
        lines.some((line) => line.trim() === `${key},`),
        false,
        `${file} passes ${key} as a bare argument without a workspace scope`,
      );
    }
  }

  // The reading pages derive their key once per effect.
  for (const file of ["AppointmentsPage.tsx", "SalesPage.tsx"]) {
    const source = sources.get(file) ?? "";
    assert.ok(
      source.includes("const prefillKey = workspaceScopedKey("),
      `${file} must derive the prefill key from the current workspace`,
    );
  }

  // AdminCenter holds the clinic's settings and its Meta ids; the scope is in
  // its two storage helpers so no call site can forget it.
  const admin = sources.get("AdminCenter.tsx") ?? "";
  assert.ok(
    admin.includes("window.localStorage.getItem(workspaceScopedKey(key))") &&
      admin.includes("window.localStorage.setItem(workspaceScopedKey(key)"),
    "AdminCenter's readStored/writeStored must scope every key they touch",
  );
});

test("W12 the ACTIVE launch mirror is per clinic, and the real gate is still the server's", async () => {
  const ads = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");
  const admin = await readFile(path.join(negisSrc, "pages", "AdminCenter.tsx"), "utf8");

  // Unscoped, enabling live launch in one clinic lit the affordance up in the
  // next one. Scoped, an unknown clinic reads false, which can only close the
  // gate, never open it.
  for (const match of ads.matchAll(/readStored\(\s*"negis_meta_live_launch_enabled"/g)) {
    assert.fail(`AdsAutomation reads the live launch flag unscoped at index ${match.index}`);
  }
  assert.ok(
    ads.includes('readStored(workspaceScopedKey("negis_meta_live_launch_enabled"), false)'),
    "the flag defaults to off for a clinic that has not enabled it",
  );
  assert.ok(admin.includes('"negis_meta_live_launch_enabled"'), "AdminCenter still owns the toggle");

  // And the flag is a mirror: the server reads workspace_settings for the
  // verified workspace, so no browser value can open ACTIVE on its own.
  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const gate = server.slice(server.indexOf("async function readMetaLiveLaunchEnabled"));
  const body = gate.slice(0, gate.indexOf("\n}"));
  assert.ok(body.includes('from("workspace_settings")'), "the gate reads the workspace's own setting");
  assert.ok(body.includes('eq("workspace_id", workspaceId)'), "scoped to the verified workspace");
});

test("W13 a collection refetches when the clinic changes, without relying on the page unmounting", async () => {
  const source = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  const hook = source.slice(source.indexOf("export function useDemoCollection"));

  assert.ok(
    hook.includes("const workspaceId = readWorkspaceId();"),
    "the workspace must be read where the hook can depend on it, not inside the effect",
  );
  assert.ok(
    hook.includes("productionMode, workspaceId]"),
    "and must be in the fetch effect's dependencies, so a switch refetches",
  );

  const fetchEffect = hook.slice(hook.indexOf("const loadFromApi"));
  assert.equal(
    fetchEffect.slice(0, fetchEffect.indexOf("};")).includes("readWorkspaceId()"),
    false,
    "reading it again inside the effect would reintroduce the hidden dependency",
  );
});

test("W14 clearing the selection takes the current page down with it", async () => {
  const auth = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  const clear = auth.slice(auth.indexOf("const clearWorkspaceSelection"));
  const body = clear.slice(0, clear.indexOf("  };"));
  // Permissions are what ProtectedPage gates on. Leaving them in place — to
  // avoid a flicker, say — would keep the previous clinic's page mounted
  // underneath the picker with its rows still on screen.
  assert.ok(body.includes("setRolePermissions({})"), "the switch must drop the permissions");
  assert.ok(body.includes("setClinicId(null)"), "and the workspace");

  const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
  assert.ok(
    app.includes("if (isLoading || !allowed) return null;"),
    "ProtectedPage must render nothing once permissions are gone",
  );
});

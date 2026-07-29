import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2D — authorization for the whole serverless surface, not just /api/crm/*.
//
// Security-2B closed the CRM catch-all and stopped there. Everything else kept
// running unauthenticated on the service-role client: Content Studio spent the
// platform's OpenAI budget and patched content_videos for a workspace named in
// the request body, /api/auth/register inserted rows into `workspaces` for
// anyone who asked, and the targeting routes wrote targeting_campaigns and
// targeting_reports the same way.
//
// This suite inventories every file under api/ and fails when one is not
// classified, so a new route cannot be added without saying what it is. The
// behavioural tests drive the real handlers with a mocked Supabase Auth
// endpoint and count provider calls, because "requires a token" is only true if
// nothing expensive happens before the token is checked.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiRoot = path.join(repoRoot, "api");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "22222222-2222-4222-8222-222222222222";
const TOKEN = "header.payload.signature";

/**
 * A. authenticated browser route   B. auth bootstrap
 * C. signed external webhook       D. HMAC internal route
 * E. intentionally public          F. disabled legacy route
 * G. unsafe / unknown — must not exist
 */
type Classification = "A" | "B" | "C" | "D" | "E" | "F" | "G";

type RouteClassification = {
  file: string;
  classification: Classification;
  /** Why this classification is the correct one for this route. */
  rationale: string;
  /** Set for E: what proves the route is safe to serve anonymously. */
  publicProof?: string;
};

// Every file under api/ appears here exactly once. The inventory test below
// fails if the directory and this table disagree in either direction.
const API_SURFACE: readonly RouteClassification[] = [
  {
    file: "crm/[...path].ts",
    classification: "A",
    rationale:
      "Deny-by-default CRM router. Verified JWT, active membership, server-resolved role and permission; " +
      "auth-context is the B bootstrap inside it and meta-insights-background-cycle is the D HMAC route.",
  },
  {
    file: "content-studio/[...path].ts",
    classification: "A",
    rationale:
      "Generators call OpenAI on the platform key and write content_videos for the verified workspace. " +
      "The legacy in-memory videos route is registered as disabled and answers 410.",
  },
  {
    file: "targeting/health.ts",
    classification: "A",
    rationale: "Agent diagnostics, workspace administrators only, same level as /api/crm/health.",
  },
  {
    file: "targeting/analyze.ts",
    classification: "A",
    rationale: "Spends the targeting agent's budget; requires manage_marketing.",
  },
  {
    file: "targeting/launch.ts",
    classification: "A",
    rationale: "Writes targeting_campaigns under the verified workspace; requires manage_marketing.",
  },
  {
    file: "targeting/report.ts",
    classification: "A",
    rationale: "Reads a campaign and writes targeting_reports; requires view_marketing.",
  },
  {
    file: "targeting/reports/[campaignId].ts",
    classification: "A",
    rationale: "Same contract as targeting/report, addressed by path.",
  },
  {
    file: "auth/register.ts",
    classification: "F",
    rationale:
      "Self-registration inserted workspaces rows for anonymous callers and created no account. " +
      "Disabled: 410 self_registration_disabled, no body parsed, no database client.",
  },
  {
    file: "leads/webhook/[clinicId].ts",
    classification: "F",
    rationale: "Unsigned lead intake. Disabled in Security-2A: 410 for every method, no database client.",
  },
];

async function listApiFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      files.push(...(await listApiFiles(full, prefix ? `${prefix}/${entry}` : entry)));
    } else if (entry.endsWith(".ts")) {
      files.push(prefix ? `${prefix}/${entry}` : entry);
    }
  }
  return files.sort();
}

/* ── Inventory ──────────────────────────────────────────────── */

test("S1 every api/** route is classified, and every classification has a route", async () => {
  const onDisk = await listApiFiles(apiRoot);
  const classified = API_SURFACE.map((entry) => entry.file).sort();

  assert.deepEqual(
    onDisk,
    classified,
    "add the new route to API_SURFACE with its classification and rationale, or remove the stale entry",
  );
});

test("S2 no route is left in the unsafe class", () => {
  const unsafe = API_SURFACE.filter((entry) => entry.classification === "G");
  assert.deepEqual(unsafe, [], "a route classified G must be fixed or disabled before it ships");
});

test("S3 public routes carry an explicit proof, and there are none by default", () => {
  for (const entry of API_SURFACE.filter((route) => route.classification === "E")) {
    assert.ok(
      entry.publicProof && entry.publicProof.length > 20,
      `${entry.file} is public but does not say what makes it safe to serve anonymously`,
    );
  }
});

test("S4 every classification carries a rationale", () => {
  for (const entry of API_SURFACE) {
    assert.ok(entry.rationale.length > 30, `${entry.file} needs a rationale, not a label`);
  }
});

/* ── Static guarantees ──────────────────────────────────────── */

test("S5 no service-role key or server secret reaches the browser bundle", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const source = await readFile(full, "utf8");
      // Naming a variable in operator copy ("SUPABASE_SERVICE_ROLE_KEY missing")
      // is a diagnostic string. Reading one is the defect.
      for (const match of source.matchAll(/(?:process\.env|import\.meta\.env)\.([A-Z0-9_]+)/g)) {
        const name = match[1];
        if (/SERVICE_ROLE|OPENAI|TELEGRAM|META_ACCESS|SECRET|_KEY$/.test(name) && !name.startsWith("VITE_PUBLIC")) {
          offenders.push(`${path.relative(negisSrc, full)}: reads ${name}`);
        }
      }
    }
  };
  await walk(negisSrc);
  assert.deepEqual(offenders, [], "server-only secrets must never be referenced from browser code");
});

test("S6 no route hands authority to a client-supplied identifier", async () => {
  // The request may carry a workspace selector; it may never be the authority.
  // These are the two shapes that were actually exploited: a workspace read off
  // the body, and an email used to look a staff member up.
  const offenders: string[] = [];
  for (const entry of API_SURFACE) {
    // Read the code, not the commentary explaining why the body is ignored.
    const source = (await readFile(path.join(apiRoot, entry.file), "utf8"))
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    if (/workspaceId:\s*(payload|body|req\.body)\.|(payload|req\.body)\.workspaceId/.test(source)) {
      offenders.push(`${entry.file}: takes the workspace from the request body`);
    }
    if (/(query|body)\.email/.test(source)) {
      offenders.push(`${entry.file}: looks a user up by a client-supplied email`);
    }
  }
  assert.deepEqual(offenders, [], "the verified context is the only tenant authority");
});

test("S7 the shared guard is the only authorization path outside the CRM router", async () => {
  const guarded = ["content-studio/[...path].ts", "targeting/health.ts", "targeting/analyze.ts", "targeting/launch.ts", "targeting/report.ts", "targeting/reports/[campaignId].ts"];
  for (const file of guarded) {
    const source = await readFile(path.join(apiRoot, file), "utf8");
    assert.ok(
      source.includes("authorizePrivateRoute"),
      `${file} must authorize through the shared guard rather than rolling its own check`,
    );
    assert.ok(
      !/getSupabaseServerClient\(\)/.test(source),
      `${file} must not construct a service-role client directly`,
    );
  }
});

test("S8 content video patches are scoped to a workspace at the source", async () => {
  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const fn = server.slice(server.indexOf("export async function persistContentVideoPatchIfAvailable"));
  const body = fn.slice(0, 1400);
  assert.ok(
    /!isUuid\(workspaceId\)/.test(body),
    "the patch must refuse to run without a workspace: on the service-role client, id alone crosses tenants",
  );
  assert.ok(
    /\.eq\("workspace_id", workspaceId\)/.test(body),
    "the update must filter by workspace_id unconditionally",
  );
});

test("S9 the platform's Telegram bot only talks to the platform's chat", async () => {
  const source = await readFile(path.join(apiRoot, "content-studio", "[...path].ts"), "utf8");
  assert.ok(
    !/payload\.chatId/.test(source),
    "a caller-supplied chatId turns the platform bot into an open relay",
  );
  assert.ok(source.includes("process.env.TELEGRAM_CHAT_ID"), "the destination comes from configuration");
});

/* ── Handler-level behaviour ────────────────────────────────── */

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

type StaffRow = { id: string; workspace_id: string; role: string; status: string };

type HandlerOptions = {
  memberships?: StaffRow[];
  authOk?: boolean;
};

type ProviderCalls = { auth: number; openai: number; telegram: number; agent: number; supabaseClients: number };

/**
 * Loads a real handler with a mocked Supabase Auth endpoint and counts every
 * outbound provider call, so a test can assert that an unauthenticated request
 * spends nothing.
 */
async function loadHandler(file: string, options: HandlerOptions = {}) {
  const calls: ProviderCalls = { auth: 0, openai: 0, telegram: 0, agent: 0, supabaseClients: 0 };

  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat";
  process.env.META_INSIGHTS_WORKER_SECRET = "test-worker-secret";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? "");
    if (url.includes("/auth/v1/user")) {
      calls.auth += 1;
      const ok = options.authOk !== false;
      return { ok, status: ok ? 200 : 401, text: async () => (ok ? JSON.stringify({ id: USER_A, email: "a@example.test" }) : "{}") };
    }
    if (url.includes("openai.com")) calls.openai += 1;
    else if (url.includes("api.telegram.org")) calls.telegram += 1;
    else calls.agent += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: {} }), json: async () => ({ success: true, data: {} }) };
  }) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  const rows = options.memberships ?? [];
  supabaseModule.setSupabaseServerClientFactoryForTests(() => {
    calls.supabaseClients += 1;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: () => chain(),
      insert: () => chain(),
      update: () => chain(),
      upsert: () => chain(),
      order: () => chain(),
      limit: () => chain(),
      eq: () => chain(),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => void) => resolve({ data: rows, error: null }),
    });
    return { from: () => builder };
  });

  const module = (await import(pathToFileURL(path.join(apiRoot, file)).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (input: { method?: string; query?: Record<string, unknown>; body?: unknown; token?: string | null }) => {
    calls.auth = 0;
    calls.openai = 0;
    calls.telegram = 0;
    calls.agent = 0;
    calls.supabaseClients = 0;
    const res = mockResponse();
    await module.default(
      {
        method: input.method ?? "GET",
        url: "/api/test",
        query: input.query ?? {},
        body: input.body ?? {},
        headers: input.token === null ? {} : { authorization: `Bearer ${input.token ?? TOKEN}` },
      },
      res,
    );
    return { status: res.statusCode, body: res.body, calls: { ...calls } };
  };

  const restore = () => {
    globalThis.fetch = originalFetch;
    supabaseModule.setSupabaseServerClientFactoryForTests(null);
  };

  return { call, restore };
}

const activeMembership: StaffRow = { id: STAFF_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" };

test("S10 Content Studio spends nothing without a token", async () => {
  const { call, restore } = await loadHandler("content-studio/[...path].ts");
  try {
    for (const resource of ["generate-package", "generate-script", "generate-avatar-prompt", "generate-tapnow-prompt", "send-telegram"]) {
      const result = await call({ method: "POST", query: { path: resource }, token: null, body: { title: "x" } });
      assert.equal(result.status, 401, `${resource} must require a token`);
      assert.equal(result.body.code, "authentication_required");
      assert.equal(result.calls.openai, 0, `${resource} called OpenAI before authenticating`);
      assert.equal(result.calls.telegram, 0, `${resource} called Telegram before authenticating`);
      assert.equal(result.calls.supabaseClients, 0, `${resource} built a service-role client before authenticating`);
    }
  } finally {
    restore();
  }
});

test("S11 Content Studio denies a workspace the caller is not a member of", async () => {
  const { call, restore } = await loadHandler("content-studio/[...path].ts", { memberships: [activeMembership] });
  try {
    const result = await call({ method: "POST", query: { path: "generate-package", workspaceId: WORKSPACE_B }, body: { title: "x" } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "workspace_access_denied");
    assert.equal(result.calls.openai, 0, "a denied caller must not reach the provider");
  } finally {
    restore();
  }
});

test("S12 the legacy Content Studio video store is closed, and only to an authorized caller", async () => {
  const { call, restore } = await loadHandler("content-studio/[...path].ts", { memberships: [activeMembership] });
  try {
    const anonymous = await call({ method: "GET", query: { path: "videos" }, token: null });
    assert.equal(anonymous.status, 401, "the closure is not disclosed before authentication");

    const authorized = await call({ method: "GET", query: { path: "videos", workspaceId: WORKSPACE_A } });
    assert.equal(authorized.status, 410);
    assert.equal(authorized.body.code, "route_disabled");
  } finally {
    restore();
  }
});

test("S13 Content Studio is deny-by-default for unknown resources and wrong methods", async () => {
  const { call, restore } = await loadHandler("content-studio/[...path].ts", { memberships: [activeMembership] });
  try {
    const unknown = await call({ method: "POST", query: { path: "generate-everything" }, token: null });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "resource_not_found");

    const traversal = await call({ method: "POST", query: { path: "../crm/leads" }, token: null });
    assert.equal(traversal.status, 404, "a traversal segment must not resolve to a handler");

    const wrongMethod = await call({ method: "GET", query: { path: "generate-package" }, token: null });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.code, "method_not_allowed");
  } finally {
    restore();
  }
});

test("S14 targeting routes require a token before calling the agent", async () => {
  for (const file of ["targeting/health.ts", "targeting/analyze.ts", "targeting/launch.ts", "targeting/report.ts"]) {
    const { call, restore } = await loadHandler(file);
    try {
      const method = file.includes("analyze") || file.includes("launch") ? "POST" : "GET";
      const result = await call({ method, token: null, query: { campaignId: "c-1" }, body: { clinicName: "x" } });
      assert.equal(result.status, 401, `${file} must require a token`);
      assert.equal(result.calls.agent, 0, `${file} called the targeting agent before authenticating`);
      assert.equal(result.calls.supabaseClients, 0, `${file} built a service-role client before authenticating`);
    } finally {
      restore();
    }
  }
});

test("S15 targeting diagnostics are administrators only", async () => {
  const { call, restore } = await loadHandler("targeting/health.ts", {
    memberships: [{ ...activeMembership, role: "receptionist" }],
  });
  try {
    const result = await call({ method: "GET", query: { workspaceId: WORKSPACE_A } });
    assert.equal(result.status, 403);
    assert.equal(result.calls.agent, 0);
  } finally {
    restore();
  }
});

test("S16 self-registration is disabled and touches no database", async () => {
  const { call, restore } = await loadHandler("auth/register.ts");
  try {
    for (const method of ["POST", "GET", "PATCH"]) {
      const result = await call({
        method,
        token: null,
        body: { name: "x", workspaceName: "y", email: "z@example.test", password: "password123" },
      });
      assert.equal(result.status, 410, `${method} must be refused`);
      assert.equal(result.body.code, "self_registration_disabled");
      assert.equal(result.calls.supabaseClients, 0, "no workspace row may be created");
    }
  } finally {
    restore();
  }
});

test("S17 the legacy lead webhook stays disabled", async () => {
  const { call, restore } = await loadHandler("leads/webhook/[clinicId].ts");
  try {
    const result = await call({ method: "POST", token: null, query: { clinicId: WORKSPACE_A }, body: { name: "x" } });
    assert.equal(result.status, 410);
    assert.equal(result.body.code, "legacy_webhook_disabled");
    assert.equal(result.calls.supabaseClients, 0);
  } finally {
    restore();
  }
});

test("S18 a browser JWT does not satisfy the worker HMAC route", async () => {
  const { call, restore } = await loadHandler("crm/[...path].ts", { memberships: [activeMembership] });
  try {
    const result = await call({ method: "POST", query: { path: ["meta-insights-background-cycle"] }, body: {} });
    assert.equal(result.status, 401, "a valid user token is not a worker signature");
    assert.equal(result.body.code, "worker_unauthorized");
  } finally {
    restore();
  }
});

test("S18b the worker route fails closed when its secret is missing", async () => {
  const { call, restore } = await loadHandler("crm/[...path].ts", { memberships: [activeMembership] });
  const secret = process.env.META_INSIGHTS_WORKER_SECRET;
  delete process.env.META_INSIGHTS_WORKER_SECRET;
  try {
    const result = await call({ method: "POST", query: { path: ["meta-insights-background-cycle"] }, body: {} });
    assert.equal(result.status, 503, "an unconfigured worker secret must never mean 'run unauthenticated'");
    assert.equal(result.body.code, "worker_unauthorized");
  } finally {
    process.env.META_INSIGHTS_WORKER_SECRET = secret;
    restore();
  }
});

/* ── Frontend contract ──────────────────────────────────────── */

test("S19 private browser calls carry the token in the header only", async () => {
  const offenders: string[] = [];
  const roots = ["pages", "components", "lib", "contexts"].map((dir) => path.join(negisSrc, dir));
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const source = await readFile(path.join(root, name), "utf8");
      if (/access_token=|token=\$\{|accessToken=\$\{/.test(source)) {
        offenders.push(`${name}: a token appears in a URL`);
      }
      if (/body:[^\n]*accessToken/.test(source)) {
        offenders.push(`${name}: a token appears in a request body`);
      }
      if (/console\.(log|warn|error)\([^)]*[Aa]uthorization/.test(source)) {
        offenders.push(`${name}: an Authorization header is logged`);
      }
      // Content Studio is private now: its calls must go through the authorized helper.
      for (const match of source.matchAll(/fetch\(\s*(?:apiUrl\()?["'`][^"'`]*\/api\/(content-studio|targeting)\//g)) {
        offenders.push(`${name}: ${match[0].slice(0, 60)} bypasses crmFetch`);
      }
    }
  }
  assert.deepEqual(offenders, [], "private API calls must go through crmFetch with the token in the header");
});

test("S20 demo mode never reaches a private backend route", async () => {
  const storage = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  assert.ok(storage.includes("isRealWorkspace"), "the shared hook must keep demo data local");
  assert.ok(storage.includes("crmFetch"), "and the real branch must use the authorized helper");

  // crmFetch refuses to send at all without a token, which is what makes the
  // demo branch safe: there is no anonymous request to leak.
  const api = await readFile(path.join(negisSrc, "lib", "api.ts"), "utf8");
  const crmFetch = api.slice(api.indexOf("export async function crmFetch"));
  assert.ok(
    /if \(!token\) \{\s*throw new CrmApiError\(401/.test(crmFetch),
    "crmFetch must refuse to send a request without a token",
  );
});

/* ── Production verification safety (Security-2D, Part 8) ───── */

test("S21 production verification is read-only by default", async () => {
  const { assertVerificationRequestAllowed, VerificationBlocked, PRODUCTION_MUTATION_ALLOWLIST } = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "src", "production-verification-guard.ts")).href
  );

  assert.deepEqual([...PRODUCTION_MUTATION_ALLOWLIST], [], "the allowlist is empty until an owner approves an operation");

  // Reads and denial probes are the whole point of a verification pass.
  assertVerificationRequestAllowed({ target: "production", method: "GET", path: "/api/crm/leads" });
  assertVerificationRequestAllowed({ target: "production", method: "HEAD", path: "/api/crm/health" });

  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assert.throws(
      () => assertVerificationRequestAllowed({ target: "production", method, path: "/api/crm/leads", body: { name: "x" } }),
      (error: unknown) => error instanceof VerificationBlocked && (error as { reason: string }).reason === "mutation_without_approval",
      `${method} against production must be refused without an approved operation id`,
    );
  }
});

test("S22 an unapproved operation id does not unlock a mutation", async () => {
  const { assertVerificationRequestAllowed, VerificationBlocked } = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "src", "production-verification-guard.ts")).href
  );

  assert.throws(
    () =>
      assertVerificationRequestAllowed({
        target: "production",
        method: "POST",
        path: "/api/crm/leads",
        body: { name: "x" },
        operationId: "i-said-so",
      }),
    (error: unknown) => error instanceof VerificationBlocked && (error as { reason: string }).reason === "operation_not_allowlisted",
  );
});

test("S23 no verification may create a probe record, at any target", async () => {
  const { assertVerificationRequestAllowed, VerificationBlocked } = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "src", "production-verification-guard.ts")).href
  );

  // This is the exact request that left cc290928-… behind.
  for (const target of ["local", "preview", "production"] as const) {
    assert.throws(
      () =>
        assertVerificationRequestAllowed({
          target,
          method: "POST",
          path: "/api/crm/leads",
          body: { workspaceId: "any", name: "__probe_never_committed__" },
        }),
      (error: unknown) => error instanceof VerificationBlocked && (error as { reason: string }).reason === "probe_record",
      `a probe record must be refused for target ${target}`,
    );
  }

  // Nested and key-side markers count too.
  assert.throws(() =>
    assertVerificationRequestAllowed({
      target: "preview",
      method: "POST",
      path: "/api/crm/clients",
      body: { record: { notes: ["__probe_x"] } },
    }),
  );
});

test("S24 verification never calls a Meta endpoint", async () => {
  const { assertVerificationRequestAllowed, VerificationBlocked } = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "src", "production-verification-guard.ts")).href
  );

  for (const route of ["/api/crm/meta-launch", "/api/crm/meta-validate", "/api/crm/meta-insights-sync"]) {
    assert.throws(
      () => assertVerificationRequestAllowed({ target: "preview", method: "GET", path: route }),
      (error: unknown) => error instanceof VerificationBlocked && (error as { reason: string }).reason === "meta_endpoint",
      `${route} must never be exercised by a verification run`,
    );
  }
});

test("S25 verification logs redact credentials and never carry row contents", async () => {
  const { redactAuthorization, summarizeVerificationResponse } = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "src", "production-verification-guard.ts")).href
  );

  const redacted = redactAuthorization({
    authorization: "Bearer real.token.value",
    cookie: "session=abc",
    "x-worker-signature": "deadbeef",
    "content-type": "application/json",
  });
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.cookie, "[redacted]");
  assert.equal(redacted["x-worker-signature"], "[redacted]");
  assert.equal(redacted["content-type"], "application/json");

  const summary = summarizeVerificationResponse({
    status: 200,
    code: undefined,
    rows: [{ name: "a real patient name", phone: "+7700..." }],
  });
  assert.deepEqual(summary, { status: 200, code: "-", rowCount: 1 });
  assert.ok(!JSON.stringify(summary).includes("patient"), "a summary must not carry row contents");
});

test("S26 no mutation probe survives in the verification tooling", async () => {
  // The guard is only worth having if nothing bypasses it. Scripts may describe
  // probe markers (this suite does), but none may send one.
  const scriptsDir = path.join(repoRoot, "scripts", "src");
  const offenders: string[] = [];
  for (const name of await readdir(scriptsDir)) {
    if (!name.endsWith(".ts")) continue;
    if (name === "production-verification-guard.ts" || name === "medina-api-surface-authorization.test.ts") continue;
    const source = await readFile(path.join(scriptsDir, name), "utf8");
    if (/__probe_/.test(source)) offenders.push(`${name}: references a probe record`);
    if (/method:\s*"(POST|PATCH|PUT|DELETE)"[^]{0,400}negis-medcall-mvp-api-server\.vercel\.app/.test(source)) {
      offenders.push(`${name}: sends a mutation straight at production`);
    }
  }
  assert.deepEqual(offenders, [], "verification scripts must route mutations through the guard");
});

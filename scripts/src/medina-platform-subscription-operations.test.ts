import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const files = {
  platform: "lib/crm/platform.ts",
  owner: "lib/auth/platform.ts",
  authorization: "lib/crm/authorization.ts",
  router: "api/crm/[...path].ts",
};
const programs = new Map<string, Script>();
for (const file of Object.values(files)) {
  const result = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics ?? [], [], `Cannot compile actual ${file}`);
  programs.set(file, new Script(result.outputText, { filename: file }));
}

type RecordValue = Record<string, any>;
type RpcResult = { data: unknown; error: unknown };
type RpcCall = { name: string; args: RecordValue };
type Kind = "replace" | "status";
type Owner = { userId: string; email: string };

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const OTHER_REQUEST = "44444444-4444-4444-8444-444444444444";
const SUBSCRIPTION = "55555555-5555-4555-8555-555555555555";
const PREVIOUS = "66666666-6666-4666-8666-666666666666";
const BEFORE = "2026-10-24T10:00:00.000Z";
const AFTER = "2026-10-25T10:00:00.000Z";
const OWNER: Owner = { userId: ACTOR, email: "platform@example.test" };
const PRIVATE_DETAIL = "synthetic-private-backend-detail";
const APPLY = "apply_platform_subscription_operation";
const READ = "read_platform_subscription_operation";
const ABANDON = "abandon_platform_subscription_operation";
const INVALID_TIMESTAMPS = [
  ["February 30", "2026-02-30T10:00:00.123456Z"],
  ["non-leap February 29", "2025-02-29T10:00:00Z"],
  ["non-leap century", "1900-02-29T10:00:00Z"],
  ["month zero", "2026-00-25T10:00:00Z"],
  ["month 13", "2026-13-25T10:00:00Z"],
  ["day zero", "2026-10-00T10:00:00Z"],
  ["April 31", "2026-04-31T10:00:00Z"],
  ["hour 24", "2026-10-25T24:00:00.000Z"],
  ["hour 25", "2026-10-25T25:00:00Z"],
  ["minute 60", "2026-10-25T10:60:00Z"],
  ["second 60", "2026-10-25T10:00:60Z"],
  ["offset hour 24", "2026-10-25T10:00:00+24:00"],
  ["offset minute 60", "2026-10-25T10:00:00+05:60"],
  ["sub-microsecond precision", "2026-10-25T10:00:00.1234567Z"],
] as const;
const VALID_TIMESTAMPS = [
  ["leap day UTC", "2024-02-29T12:34:56Z"],
  ["leap century with microseconds", "2000-02-29T00:00:00.000001+00:00"],
  ["leap day positive offset", "2024-02-29T23:59:59.123456+05:00"],
  ["leap day negative offset", "2024-02-29T00:00:00.654321-03:30"],
  ["one fractional digit", "2024-02-29T12:34:56.1Z"],
] as const;

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function replaceBody(overrides: RecordValue = {}): RecordValue {
  return {
    workspaceId: WORKSPACE,
    requestKey: REQUEST,
    expectedActiveId: PREVIOUS,
    plan: "standard",
    priceMinor: 3990000,
    currency: "KZT",
    billingPeriod: "monthly",
    note: "Agreed terms",
    ...overrides,
  };
}

function statusBody(overrides: RecordValue = {}): RecordValue {
  return {
    workspaceId: WORKSPACE,
    requestKey: REQUEST,
    subscriptionId: SUBSCRIPTION,
    expectedUpdatedAt: BEFORE,
    expectedStatus: "active",
    status: "paused",
    ...overrides,
  };
}

function subscription(overrides: RecordValue = {}): RecordValue {
  return {
    id: SUBSCRIPTION,
    workspace_id: WORKSPACE,
    plan: "standard",
    status: "active",
    price_minor: 3990000,
    currency: "KZT",
    billing_period: "monthly",
    note: "Agreed terms",
    started_at: BEFORE,
    ended_at: null,
    created_at: BEFORE,
    updated_at: AFTER,
    ...overrides,
  };
}

function receipt(overrides: RecordValue = {}): RecordValue {
  return {
    requestKey: REQUEST,
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    kind: "replace",
    state: "committed",
    replayed: false,
    item: subscription(),
    ...overrides,
  };
}

function statusReceipt(overrides: RecordValue = {}): RecordValue {
  return receipt({ kind: "status", item: subscription({ status: "paused" }), ...overrides });
}

function abandonedReceipt(overrides: RecordValue = {}): RecordValue {
  return receipt({ kind: null, state: "abandoned", item: null, ...overrides });
}

function fixture(options: {
  result?: RpcResult;
  onRpc?: (name: string, args: RecordValue) => RpcResult | Promise<RpcResult>;
  history?: unknown;
  historyCount?: unknown;
  historyError?: unknown;
  tables?: Record<string, { data: unknown; count?: number; error?: unknown }>;
  storage?: boolean;
  allowlist?: string;
} = {}) {
  const rpcCalls: RpcCall[] = [];
  const tableCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const requests: RecordValue[] = [];
  const events: string[] = [];
  let sdkCalls = 0;
  let authCalls = 0;
  let bodyReads = 0;

  class WorkspaceAdminAuthError extends Error {
    readonly statusCode = 401;
    readonly code = "unauthorized";
  }
  const authServer = {
    WorkspaceAdminAuthError,
    async requireAuthenticatedUser(req: RecordValue) {
      authCalls++;
      events.push("authenticate");
      if (req.headers.authorization === "Bearer synthetic-platform-owner") return { id: ACTOR, email: OWNER.email };
      if (req.headers.authorization === "Bearer synthetic-clinic-owner") return { id: OTHER_ACTOR, email: "clinic@example.test" };
      throw new WorkspaceAdminAuthError("Unauthenticated");
    },
    requireWorkspaceAccess() { assert.fail("Platform routes must not resolve a tenant membership"); },
  };
  const sdk = {
    async rpc(name: string, args: RecordValue) {
      events.push(`rpc:${name}`);
      rpcCalls.push({ name, args: plain(args) });
      if (options.onRpc) return options.onRpc(name, args);
      return options.result ?? { data: receipt(), error: null };
    },
    from(table: string) {
      tableCalls.push({ table, method: "from", args: [] });
      if (options.tables) assert.ok(Object.hasOwn(options.tables, table), `Unexpected overview table: ${table}`);
      else assert.equal(table, "platform_subscriptions", "Only subscription history may use a table read");
      function result() {
        if (options.tables) return { error: null, ...options.tables[table] };
        const data = Object.hasOwn(options, "history") ? options.history : [];
        const count = Object.hasOwn(options, "historyCount") ? options.historyCount : Array.isArray(data) ? data.length : null;
        return { data, count, error: options.historyError ?? null };
      }
      const builder: RecordValue = {
        then(resolve: (value: RecordValue) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
        update() { assert.fail("No direct update fallback is permitted"); },
        insert() { assert.fail("No direct insert fallback is permitted"); },
        upsert() { assert.fail("No direct upsert fallback is permitted"); },
        delete() { assert.fail("No direct delete fallback is permitted"); },
      };
      for (const method of ["select", "eq", "is", "order", "range"]) {
        builder[method] = (...args: unknown[]) => {
          tableCalls.push({ table, method, args: plain(args) });
          return builder;
        };
      }
      return builder;
    },
  };
  const server = {
    getSupabaseServerClient() {
      sdkCalls++;
      events.push("sdk");
      return options.storage === false ? null : sdk;
    },
  };
  function evaluate(file: string, require: (name: string) => unknown): RecordValue {
    const exports: RecordValue = {};
    programs.get(file)!.runInNewContext({
      exports, require, Error, Date, URL, URLSearchParams, Buffer,
      process: { env: { MEDINA_PLATFORM_OWNER_IDS: options.allowlist ?? ACTOR } },
    });
    return exports;
  }
  function forbiddenModule(name: string) {
    return new Proxy({}, {
      get(_target, member) {
        return function unexpectedDependency() { assert.fail(`Unexpected dependency: ${name}.${String(member)}`); };
      },
    });
  }
  // Use the real symbol-backed carrier and allowlist gate, not a duplicate auth model.
  const owner = evaluate(files.owner, (name) => {
    assert.equal(name, "./server");
    return authServer;
  });
  const authorization = evaluate(files.authorization, (name) => assert.fail(`Unexpected route registry import: ${name}`));
  const platform = evaluate(files.platform, (name) => {
    if (name === "../supabase/server") return server;
    if (name === "../auth/platform") return owner;
    return forbiddenModule(name);
  });
  const router = evaluate(files.router, (name) => {
    if (name === "../../lib/auth/platform") return owner;
    if (name === "../../lib/auth/server") return authServer;
    if (name === "../../lib/auth/cors") return { applyControlCors: () => "continue" };
    if (name === "../../lib/crm/authorization") return authorization;
    if (name === "../../lib/crm/platform") return platform;
    return forbiddenModule(name);
  });

  async function invoke(input: {
    method?: string;
    body?: unknown;
    query?: RecordValue;
    owner?: Owner | null;
    routed?: boolean;
    token?: string | null;
    rawBody?: string;
    overview?: boolean;
  } = {}) {
    const req: RecordValue = {
      method: input.method,
      url: `/api/crm/${input.overview ? "platform-overview" : "platform-subscriptions"}`,
      headers: {
        "content-type": "application/json",
        ...(input.token === null ? {} : { authorization: input.token ?? "Bearer synthetic-platform-owner" }),
      },
      query: { path: [input.overview ? "platform-overview" : "platform-subscriptions"], ...input.query },
      body: input.body,
      async *[Symbol.asyncIterator]() {
        bodyReads++;
        events.push("parse-body");
        yield Buffer.from(input.rawBody ?? "{}");
      },
    };
    requests.push(req);
    if (!input.routed && input.owner !== null) owner.attachPlatformOwner(req, input.owner ?? { ...OWNER });
    let status = 200;
    let body: RecordValue | undefined;
    let sends = 0;
    const headers: Record<string, unknown> = {};
    const res = {
      status(code: number) { status = code; return this; },
      setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value; return this; },
      json(value: RecordValue) { sends++; body = plain(value); return this; },
      end() { sends++; return this; },
    };
    const handler = input.routed ? router.default : input.overview ? platform.handlePlatformOverview : platform.handlePlatformSubscriptions;
    await handler(req, res);
    assert.equal(sends, 1, "The actual handler must finish with exactly one response");
    assert.ok(body, "Expected a JSON response");
    return { status, body, headers, req };
  }
  return { invoke, rpcCalls, tableCalls, requests, events, counters: () => ({ sdkCalls, authCalls, bodyReads }) };
}

function assertSuccess(response: { status: number; body: RecordValue }, value: RecordValue) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify({ status: response.status, body: response.body }));
  const { item, ...operation } = value;
  assert.deepEqual(response.body, { success: true, data: { item, operation } });
}

function assertFailure(response: { status: number; body: RecordValue }, status: number, code?: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.success, false);
  if (code) assert.equal(response.body.code, code);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(PRIVATE_DETAIL), false, "Backend diagnostics must stay private");
  if (code === "subscription_transition_unconfirmed") {
    assert.doesNotMatch(serialized, /(?:preserved|unchanged|unsaved|not saved)\b|(?:сохран[её]н[аоы]?|не измен[её]н[аоы]?)(?!\p{L})/iu,
      "An uncertain outcome must not promise that the old subscription survived or that no write committed");
  }
}

function assertRpc(runtime: ReturnType<typeof fixture>, name: string, kind?: Kind, payload?: RecordValue) {
  assert.deepEqual(runtime.rpcCalls, [{ name, args: {
    p_actor_auth_user_id: ACTOR,
    p_request_id: REQUEST,
    p_workspace_id: WORKSPACE,
    ...(kind ? { p_kind: kind, p_payload: payload } : {}),
  } }]);
  assert.deepEqual(runtime.tableCalls, [], "Operations cannot fall back to table reads or writes");
}

function assertHistoryQuery(runtime: ReturnType<typeof fixture>, workspaceId?: string) {
  assert.deepEqual(runtime.rpcCalls, []);
  assert.equal(runtime.tableCalls.length, workspaceId ? 6 : 5);
  assert.equal(runtime.tableCalls.every((call) => call.table === "platform_subscriptions"), true);
  assert.deepEqual(runtime.tableCalls.filter((call) => call.method === "from").map((call) => call.args), [[]]);
  assert.deepEqual(runtime.tableCalls.filter((call) => call.method === "select").map((call) => call.args), [["*", { count: "exact" }]]);
  const ordering = runtime.tableCalls.filter((call) => call.method === "order");
  assert.deepEqual(ordering.map((call) => call.args[0]), ["started_at", "id"]);
  assert.deepEqual(ordering[0].args[1], { ascending: false });
  assert.deepEqual(runtime.tableCalls.filter((call) => call.method === "range").map((call) => call.args), [[0, 999]]);
  assert.deepEqual(runtime.tableCalls.filter((call) => call.method === "eq").map((call) => call.args), workspaceId ? [["workspace_id", workspaceId]] : []);
}

test("direct handler requires an attached platform owner before SDK access, including GET", async (t) => {
  for (const input of [
    {},
    { method: "GET" },
    { method: "GET", query: { workspaceId: WORKSPACE, requestKey: REQUEST } },
    { method: "POST", body: replaceBody() },
    { method: "PATCH", body: statusBody() },
    { method: "POST", body: { workspaceId: WORKSPACE, requestKey: REQUEST, abandon: true } },
  ]) {
    await t.test(JSON.stringify(input), async () => {
      const runtime = fixture({ storage: false });
      const response = await runtime.invoke({ ...input, owner: null });
      assertFailure(response, 404);
      assert.deepEqual(runtime.counters(), { sdkCalls: 0, authCalls: 0, bodyReads: 0 });
      assert.deepEqual(runtime.rpcCalls, []);
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

test("body, query, token and clinic role do not impersonate the symbol-backed owner context", async () => {
  const runtime = fixture();
  const response = await runtime.invoke({
    method: "POST", owner: null,
    body: replaceBody({ actorId: ACTOR, userId: ACTOR, role: "owner", platformOwner: OWNER }),
    query: { actorId: ACTOR, userId: ACTOR, role: "owner" },
  });
  assertFailure(response, 404);
  assert.equal(runtime.counters().sdkCalls, 0);
});

test("router authenticates before parsing, method disclosure, or SDK access", async (t) => {
  for (const allowlist of [ACTOR, ""]) {
    for (const token of [null, "Bearer invalid", "Bearer synthetic-clinic-owner"]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        await t.test(`${allowlist ? "enabled" : "disabled"}/${token}/${method}`, async () => {
          const runtime = fixture({ allowlist });
          const response = await runtime.invoke({ routed: true, method, token, rawBody: "{invalid" });
          assertFailure(response, 404);
          assert.deepEqual(runtime.counters(), { sdkCalls: 0, authCalls: 1, bodyReads: 0 });
          assert.deepEqual(runtime.rpcCalls, []);
          assert.deepEqual(runtime.tableCalls, []);
        });
      }
    }
  }
  const disabled = fixture({ allowlist: "" });
  assertFailure(await disabled.invoke({ routed: true, method: "GET" }), 404);
  assert.equal(disabled.counters().sdkCalls, 0);
});

test("authorized router attaches the verified actor and parses JSON exactly once", async () => {
  const value = receipt();
  const runtime = fixture({ result: { data: value, error: null } });
  const response = await runtime.invoke({
    routed: true, method: "POST",
    rawBody: JSON.stringify(replaceBody({ actorId: OTHER_ACTOR, userId: OTHER_ACTOR })),
  });
  assertSuccess(response, value);
  assert.deepEqual(runtime.counters(), { sdkCalls: 1, authCalls: 1, bodyReads: 1 });
  assert.deepEqual(runtime.events, ["authenticate", "parse-body", "sdk", `rpc:${APPLY}`]);
  assertRpc(runtime, APPLY, "replace", {
    expectedActiveId: PREVIOUS, plan: "standard", priceMinor: 3990000,
    currency: "KZT", billingPeriod: "monthly", note: "Agreed terms",
  });
});

test("authorized router rejects unsupported methods and malformed JSON without SDK calls", async () => {
  for (const [method, rawBody, expectedStatus] of [["DELETE", "{}", 405], ["POST", "{invalid", 400]] as const) {
    const runtime = fixture();
    assertFailure(await runtime.invoke({ routed: true, method, rawBody }), expectedStatus);
    assert.equal(runtime.counters().authCalls, 1);
    assert.equal(runtime.counters().sdkCalls, 0);
  }
});

test("GET without an operation selector remains an authenticated history read", async () => {
  const items = [subscription(), subscription({ id: PREVIOUS, status: "cancelled", ended_at: AFTER })];
  const runtime = fixture({ history: items });
  const response = await runtime.invoke({ routed: true, method: "GET" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, data: { items } });
  assertHistoryQuery(runtime);
  assert.deepEqual(runtime.counters(), { sdkCalls: 1, authCalls: 1, bodyReads: 0 });
});

test("GET with workspaceId but no requestKey returns scoped history, not an operation lookup", async () => {
  const items = [subscription(), subscription({ id: PREVIOUS, status: "paused" })];
  const runtime = fixture({ history: items, historyCount: 2 });
  const response = await runtime.invoke({ routed: true, method: "GET", query: { workspaceId: WORKSPACE } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, data: { items } });
  assertHistoryQuery(runtime, WORKSPACE);
});

test("history accepts exact empty and 1000-row results, including unscoped rows from different tenants", async (t) => {
  const thousand = Array.from({ length: 1000 }, (_, index) => subscription({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }));
  for (const [label, items, scoped] of [
    ["empty unscoped", [], false], ["empty scoped", [], true],
    ["1000 unscoped", thousand, false], ["1000 scoped", thousand, true],
    ["multiple tenants", [subscription(), subscription({ id: PREVIOUS, workspace_id: OTHER_WORKSPACE })], false],
  ] as Array<[string, RecordValue[], boolean]>) {
    await t.test(label, async () => {
      const runtime = fixture({ history: items, historyCount: items.length });
      const response = await runtime.invoke({ method: "GET", query: scoped ? { workspaceId: WORKSPACE } : {} });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { success: true, data: { items } });
      assertHistoryQuery(runtime, scoped ? WORKSPACE : undefined);
    });
  }
});

test("history rejects missing, unsafe, oversized or inconsistent counts without claiming a partial result is complete", async (t) => {
  const items = [subscription()];
  const cases: Array<[string, unknown, unknown]> = [
    ["missing count", items, undefined], ["null count", items, null], ["text count", items, "1"],
    ["negative count", items, -1], ["fractional count", items, 1.5], ["NaN count", items, NaN],
    ["infinite count", items, Infinity], ["unsafe count", items, Number.MAX_SAFE_INTEGER + 1],
    ["over 1000", items, 1001], ["truncated page", items, 2], ["unexpected extra rows", items, 0],
    ["null rows", null, 0], ["nonarray rows", {}, 0],
    ["duplicate ids", [subscription(), subscription()], 2],
    ["invalid id", [subscription({ id: "invalid" })], 1],
  ];
  for (const [label, history, historyCount] of cases) {
    for (const scoped of [false, true]) {
      await t.test(`${label}/${scoped ? "scoped" : "unscoped"}`, async () => {
        const runtime = fixture({ history, historyCount });
        const response = await runtime.invoke({ method: "GET", query: scoped ? { workspaceId: WORKSPACE } : {} });
        assertFailure(response, 502, "unavailable");
        assert.equal(response.body.data?.items, undefined, "A partial or unverified history must not be exposed as a complete list");
        assertHistoryQuery(runtime, scoped ? WORKSPACE : undefined);
      });
    }
  }
});

test("scoped history rejects a row belonging to a different workspace", async () => {
  const runtime = fixture({ history: [subscription({ workspace_id: OTHER_WORKSPACE })], historyCount: 1 });
  const response = await runtime.invoke({ method: "GET", query: { workspaceId: WORKSPACE } });
  assertFailure(response, 502, "unavailable");
  assert.equal(response.body.data?.items, undefined);
  assertHistoryQuery(runtime, WORKSPACE);
});

test("history rejects malformed full-row projections even when count, ids and workspace agree", async (t) => {
  const rows: Array<[string, RecordValue]> = [
    ["identity-only projection", { id: SUBSCRIPTION, workspace_id: WORKSPACE }],
    ["unknown plan", subscription({ plan: "unknown" })], ["unknown status", subscription({ status: "unknown" })],
    ["plan whitespace", subscription({ plan: " standard " })], ["status whitespace", subscription({ status: " active " })],
    ["period whitespace", subscription({ billing_period: " monthly " })], ["currency whitespace", subscription({ currency: " KZT " })],
    ["text price", subscription({ price_minor: "3990000" })], ["negative price", subscription({ price_minor: -1 })],
    ["invalid period", subscription({ billing_period: "weekly" })], ["invalid currency", subscription({ currency: "KZ1" })],
    ["missing update version", subscription({ updated_at: undefined })],
    ["invalid start timestamp", subscription({ started_at: "not-a-time" })],
    ["invalid end timestamp", subscription({ ended_at: "not-a-time" })],
    ["missing note column", subscription({ note: undefined })], ["invalid note type", subscription({ note: 1 })],
  ];
  for (const [label, row] of rows) {
    await t.test(label, async () => {
      const runtime = fixture({ history: [row], historyCount: 1 });
      const response = await runtime.invoke({ method: "GET", query: { workspaceId: WORKSPACE } });
      assertFailure(response, 502, "unavailable");
      assert.equal(response.body.data?.items, undefined);
      assertHistoryQuery(runtime, WORKSPACE);
    });
  }
});

test("invalid history workspace selectors do not trigger a cross-tenant read", async (t) => {
  for (const workspaceId of ["invalid", [WORKSPACE]]) {
    await t.test(JSON.stringify(workspaceId), async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "GET", query: { workspaceId } }), 400);
      assert.deepEqual(runtime.tableCalls, []);
      assert.deepEqual(runtime.rpcCalls, []);
    });
  }
});

test("history database failures return a safe unavailable response without rows", async () => {
  const runtime = fixture({ history: [subscription()], historyError: { message: PRIVATE_DETAIL } });
  const response = await runtime.invoke({ method: "GET" });
  assertFailure(response, 502, "unavailable");
  assert.equal(response.body.data?.items, undefined);
  assertHistoryQuery(runtime);
});

test("actual overview DTO exposes the active subscription id used as replacement CAS", async () => {
  const runtime = fixture({ tables: {
    workspaces: { data: [
      { id: WORKSPACE, name: "Clinic A", owner_email: "a@example.test", created_at: BEFORE },
      { id: OTHER_WORKSPACE, name: "Clinic B", owner_email: "b@example.test", created_at: BEFORE },
    ] },
    platform_subscriptions: { data: [subscription()] },
    staff_users: { data: [], count: 0 },
    leads: { data: [], count: 0 },
    appointments: { data: [], count: 0 },
    staff_invitations: { data: [] },
  } });
  const response = await runtime.invoke({ routed: true, method: "GET", overview: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  const clinic = response.body.data.clinics.find((row: RecordValue) => row.id === WORKSPACE);
  assert.ok(clinic);
  assert.equal(clinic.subscriptionId, SUBSCRIPTION);
  assert.equal(clinic.subscriptionStatus, "active");
  const selection = runtime.tableCalls.find((call) => call.table === "platform_subscriptions" && call.method === "select");
  assert.ok(selection);
  assert.ok(String(selection.args[0]).split(",").map((field) => field.trim()).includes("id"), "The overview must select the actual active row id");
  assert.deepEqual(runtime.rpcCalls, []);
});

test("replace sends one canonical operation RPC with the attached actor, explicit CAS and normalized terms", async (t) => {
  for (const expectedActiveId of [PREVIOUS, null]) {
    for (const replayed of [false, true]) {
      await t.test(`${expectedActiveId}/${replayed}`, async () => {
        const value = receipt({ replayed, item: subscription({ price_minor: 0, note: "Zero-price agreement" }) });
        const runtime = fixture({ result: { data: value, error: null } });
        const response = await runtime.invoke({ method: "POST", body: replaceBody({
          expectedActiveId, plan: " STANDARD ", priceMinor: " 0 ", currency: " kzt ",
          billingPeriod: " monthly ", note: " Zero-price agreement ",
          actorId: OTHER_ACTOR, kind: "status", status: "cancelled", arbitrary: PRIVATE_DETAIL,
        }) });
        assertSuccess(response, value);
        assertRpc(runtime, APPLY, "replace", {
          expectedActiveId, plan: "standard", priceMinor: 0, currency: "KZT",
          billingPeriod: "monthly", note: "Zero-price agreement",
        });
      });
    }
  }
});

test("replace preserves existing aliases, defaults, and explicit numeric zero", async () => {
  const body = { workspace_id: WORKSPACE, requestKey: REQUEST, expectedActiveId: null, plan: "basic", price_minor: 0 };
  const value = receipt({ item: subscription({ plan: "basic", price_minor: 0, note: null }) });
  const runtime = fixture({ result: { data: value, error: null } });
  assertSuccess(await runtime.invoke({ method: "POST", body }), value);
  assertRpc(runtime, APPLY, "replace", {
    expectedActiveId: null, plan: "basic", priceMinor: 0, currency: "KZT", billingPeriod: "monthly", note: null,
  });
});

test("replace accepts supported plans, yearly billing, maximum safe price and the note length boundary", async (t) => {
  for (const plan of ["basic", "standard", "pro"]) {
    await t.test(plan, async () => {
      const note = "x".repeat(2000);
      const value = receipt({ item: subscription({ plan, price_minor: Number.MAX_SAFE_INTEGER, currency: "USD", billing_period: "yearly", note }) });
      const runtime = fixture({ result: { data: value, error: null } });
      const body = replaceBody({ plan, priceMinor: Number.MAX_SAFE_INTEGER, currency: "usd", billingPeriod: undefined, billing_period: "yearly", note });
      assertSuccess(await runtime.invoke({ method: "POST", body }), value);
      assertRpc(runtime, APPLY, "replace", {
        expectedActiveId: PREVIOUS, plan, priceMinor: Number.MAX_SAFE_INTEGER, currency: "USD", billingPeriod: "yearly", note,
      });
    });
  }
});

test("replace retains plan, price, period, currency and note validation plus operation preconditions", async (t) => {
  const cases: Array<[string, RecordValue]> = [
    ["workspace absent", { workspaceId: undefined }], ["workspace invalid", { workspaceId: "invalid" }],
    ["request absent", { requestKey: undefined }], ["request null", { requestKey: null }],
    ["request invalid", { requestKey: "not-a-uuid" }], ["request array", { requestKey: [REQUEST] }],
    ["expected active absent", { expectedActiveId: undefined }], ["expected active empty", { expectedActiveId: "" }],
    ["expected active invalid", { expectedActiveId: "invalid" }], ["expected active object", { expectedActiveId: {} }],
    ["plan absent", { plan: undefined }], ["plan unknown", { plan: "enterprise" }],
    ["price absent", { priceMinor: undefined }], ["price null", { priceMinor: null }],
    ["price blank", { priceMinor: " " }], ["price text", { priceMinor: "free" }],
    ["price negative", { priceMinor: -1 }], ["price fractional", { priceMinor: 0.5 }],
    ["price infinite", { priceMinor: Infinity }], ["price unsafe", { priceMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["period invalid", { billingPeriod: "weekly" }], ["currency invalid", { currency: "KZ1" }],
    ["currency too long", { currency: "KZTT" }], ["note too long", { note: "x".repeat(2001) }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "POST", body: replaceBody(overrides) }), 400);
      assert.deepEqual(runtime.rpcCalls, [], "Invalid requests must not reach an RPC");
      assert.deepEqual(runtime.tableCalls, [], "Invalid requests must not touch subscription rows");
    });
  }
});

test("PATCH uses a status operation with the exact row/version/status preconditions and no plan requirement", async (t) => {
  for (const [expectedStatus, status] of [["active", "paused"], ["paused", "active"], ["paused", "cancelled"]]) {
    for (const replayed of [false, true]) {
      await t.test(`${expectedStatus}->${status}/${replayed}`, async () => {
        const value = statusReceipt({ replayed, item: subscription({ status, ended_at: status === "cancelled" ? AFTER : null }) });
        const runtime = fixture({ result: { data: value, error: null } });
        assertSuccess(await runtime.invoke({ method: "PATCH", body: statusBody({ expectedStatus, status, actorId: OTHER_ACTOR }) }), value);
        assertRpc(runtime, APPLY, "status", { subscriptionId: SUBSCRIPTION, expectedUpdatedAt: BEFORE, expectedStatus, status });
      });
    }
  }
});

test("PATCH preserves timestamp microseconds and timezone offsets in both CAS payload and raw receipt", async () => {
  const expectedUpdatedAt = "2026-10-24T15:00:00.123456+05:00";
  const value = statusReceipt({ item: subscription({
    status: "paused", note: null,
    created_at: "2026-10-23T10:00:00.000001+00:00",
    started_at: "2026-10-24T10:00:00.000002+00:00",
    updated_at: "2026-10-25T10:00:00.654321+00:00",
  }) });
  const runtime = fixture({ result: { data: value, error: null } });
  const response = await runtime.invoke({ method: "PATCH", body: statusBody({ expectedUpdatedAt }) });
  assertSuccess(response, value);
  assertRpc(runtime, APPLY, "status", {
    subscriptionId: SUBSCRIPTION, expectedUpdatedAt, expectedStatus: "active", status: "paused",
  });
});

test("PATCH rejects impossible calendar, clock and offset preconditions before the RPC", async (t) => {
  for (const [label, expectedUpdatedAt] of INVALID_TIMESTAMPS) {
    await t.test(label, async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "PATCH", body: statusBody({ expectedUpdatedAt }) }), 400, "subscription_operation_invalid");
      assert.deepEqual(runtime.rpcCalls, []);
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

test("PATCH accepts valid leap-day versions and preserves offset and fractional text in the CAS payload", async (t) => {
  for (const [label, expectedUpdatedAt] of VALID_TIMESTAMPS) {
    await t.test(label, async () => {
      const value = statusReceipt();
      const runtime = fixture({ result: { data: value, error: null } });
      assertSuccess(await runtime.invoke({ method: "PATCH", body: statusBody({ expectedUpdatedAt }) }), value);
      assertRpc(runtime, APPLY, "status", {
        subscriptionId: SUBSCRIPTION, expectedUpdatedAt, expectedStatus: "active", status: "paused",
      });
    });
  }
});

test("PATCH validates all operation and compare-and-set fields before any database call", async (t) => {
  const cases: Array<[string, RecordValue]> = [
    ["workspace absent", { workspaceId: undefined }], ["workspace invalid", { workspaceId: "invalid" }],
    ["request absent", { requestKey: undefined }], ["request invalid", { requestKey: "invalid" }],
    ["row absent", { subscriptionId: undefined }], ["row null", { subscriptionId: null }],
    ["row invalid", { subscriptionId: "invalid" }],
    ["version absent", { expectedUpdatedAt: undefined }], ["version null", { expectedUpdatedAt: null }],
    ["version empty", { expectedUpdatedAt: "" }], ["version invalid", { expectedUpdatedAt: "not-a-time" }],
    ["version numeric", { expectedUpdatedAt: 123 }],
    ["expected status absent", { expectedStatus: undefined }], ["expected status null", { expectedStatus: null }],
    ["expected status unknown", { expectedStatus: "expired" }],
    ["status absent", { status: undefined }], ["status unknown", { status: "expired" }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "PATCH", body: statusBody(overrides) }), 400);
      assert.deepEqual(runtime.rpcCalls, []);
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

test("POST abandon needs only workspace/request identity and returns the database receipt, including a raced commit", async (t) => {
  for (const value of [abandonedReceipt(), abandonedReceipt({ replayed: true }), receipt({ replayed: true }), statusReceipt({ replayed: true })]) {
    await t.test(`${value.state}/${value.kind}/${value.replayed}`, async () => {
      const runtime = fixture({ result: { data: value, error: null } });
      assertSuccess(await runtime.invoke({ method: "POST", body: { workspaceId: WORKSPACE, requestKey: REQUEST, abandon: true } }), value);
      assertRpc(runtime, ABANDON);
    });
  }
});

test("abandon validates operation identity without a legacy replacement fallback", async (t) => {
  for (const overrides of [{ workspaceId: undefined }, { workspaceId: "invalid" }, { requestKey: undefined }, { requestKey: "invalid" }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "POST", body: { workspaceId: WORKSPACE, requestKey: REQUEST, abandon: true, ...overrides } }), 400);
      assert.deepEqual(runtime.rpcCalls, []);
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

test("operation GET uses read RPC and separates the raw item from committed or abandoned receipt metadata", async (t) => {
  for (const value of [receipt(), statusReceipt({ replayed: true }), abandonedReceipt()]) {
    await t.test(`${value.state}/${value.kind}`, async () => {
      const runtime = fixture({ result: { data: value, error: null } });
      assertSuccess(await runtime.invoke({ routed: true, method: "GET", query: { workspaceId: WORKSPACE, requestKey: REQUEST, actorId: OTHER_ACTOR } }), value);
      assertRpc(runtime, READ);
    });
  }
  const runtime = fixture({ result: { data: null, error: null } });
  const response = await runtime.invoke({ method: "GET", query: { workspaceId: WORKSPACE, requestKey: REQUEST } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, data: { item: null, operation: null } });
  assertRpc(runtime, READ);
});

test("invalid operation GET selectors never degrade to a history read", async (t) => {
  for (const query of [
    { requestKey: REQUEST }, { workspaceId: "invalid", requestKey: REQUEST },
    { workspaceId: WORKSPACE, requestKey: "invalid" }, { workspaceId: WORKSPACE, requestKey: "" },
    { workspaceId: WORKSPACE, requestKey: [REQUEST] },
  ]) {
    await t.test(JSON.stringify(query), async () => {
      const runtime = fixture();
      assertFailure(await runtime.invoke({ method: "GET", query }), 400);
      assert.deepEqual(runtime.rpcCalls, []);
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

const operations = [
  { label: "replace", name: APPLY, method: "POST", body: replaceBody(), valid: receipt() },
  { label: "status", name: APPLY, method: "PATCH", body: statusBody(), valid: statusReceipt() },
  { label: "abandon", name: ABANDON, method: "POST", body: { workspaceId: WORKSPACE, requestKey: REQUEST, abandon: true }, valid: abandonedReceipt() },
  { label: "read", name: READ, method: "GET", query: { workspaceId: WORKSPACE, requestKey: REQUEST }, valid: receipt() },
];

test("all operation RPCs map typed database errors without diagnostics, speculative success, or table fallback", async (t) => {
  const mappings = [
    ["P8403", 400, "subscription_operation_invalid"],
    ["P8404", 409, "subscription_conflict"],
    ["P8407", 409, "subscription_request_conflict"],
    ["P8409", 409, "subscription_request_abandoned"],
    ["PGRST202", 503, "subscription_transition_unavailable"],
    ["42883", 503, "subscription_transition_unavailable"],
    ["P8402", 502, "subscription_transition_unconfirmed"],
    ["P8408", 502, "subscription_transition_unconfirmed"],
    ["XX000", 502, "subscription_transition_unconfirmed"],
    ["23505", 502, "subscription_transition_unconfirmed"],
    ["constructor", 502, "subscription_transition_unconfirmed"],
    ["__proto__", 502, "subscription_transition_unconfirmed"],
  ] as const;
  for (const operation of operations) {
    for (const [code, status, expectedCode] of mappings) {
      await t.test(`${operation.label}/${code}`, async () => {
        const runtime = fixture({ result: { data: operation.valid, error: { code, message: PRIVATE_DETAIL, details: PRIVATE_DETAIL, hint: PRIVATE_DETAIL } } });
        assertFailure(await runtime.invoke(operation), status, expectedCode);
        assert.equal(runtime.rpcCalls.length, 1);
        assert.equal(runtime.rpcCalls[0].name, operation.name);
        assert.deepEqual(runtime.tableCalls, []);
      });
    }
  }
});

test("transport failures and untyped backend errors have an explicitly unconfirmed outcome", async (t) => {
  for (const operation of operations) {
    for (const failure of ["throw", "no-code", "rpc-name-in-message"]) {
      await t.test(`${operation.label}/${failure}`, async () => {
        const runtime = fixture({ onRpc: async () => {
          if (failure === "throw") throw new Error(PRIVATE_DETAIL);
          return { data: null, error: { message: `${PRIVATE_DETAIL} ${failure === "rpc-name-in-message" ? operation.name : ""}` } };
        } });
        assertFailure(await runtime.invoke(operation), 502, "subscription_transition_unconfirmed");
        assert.equal(runtime.rpcCalls.length, 1);
        assert.deepEqual(runtime.tableCalls, []);
      });
    }
  }
});

test("malformed or mismatched receipt envelopes are never acknowledged as a saved or unsaved operation", async (t) => {
  const mutations: Array<[string, (value: RecordValue) => unknown]> = [
    ["undefined", () => undefined], ["array", (value) => [value]], ["empty", () => ({})],
    ["number", () => 1], ["boolean", () => true], ["string", () => "committed"],
    ["wrong request", (value) => ({ ...value, requestKey: OTHER_REQUEST })],
    ["wrong workspace", (value) => ({ ...value, workspaceId: OTHER_WORKSPACE })],
    ["wrong actor", (value) => ({ ...value, actorId: OTHER_ACTOR })],
    ["missing request", ({ requestKey: _ignored, ...value }) => value],
    ["missing actor", ({ actorId: _ignored, ...value }) => value],
    ["missing workspace", ({ workspaceId: _ignored, ...value }) => value],
    ["missing kind", ({ kind: _ignored, ...value }) => value],
    ["unknown kind", (value) => ({ ...value, kind: "delete" })],
    ["kind whitespace", (value) => ({ ...value, kind: " replace " })],
    ["missing state", ({ state: _ignored, ...value }) => value],
    ["pending state", (value) => ({ ...value, state: "pending" })],
    ["state whitespace", (value) => ({ ...value, state: ` ${value.state} ` })],
    ["missing replayed", ({ replayed: _ignored, ...value }) => value],
    ["nonboolean replayed", (value) => ({ ...value, replayed: "false" })],
    ["missing item", ({ item: _ignored, ...value }) => value],
  ];
  for (const operation of operations) {
    for (const [label, mutate] of mutations) {
      await t.test(`${operation.label}/${label}`, async () => {
        const runtime = fixture({ result: { data: mutate(plain(operation.valid)), error: null } });
        assertFailure(await runtime.invoke(operation), 502, "subscription_transition_unconfirmed");
        assert.equal(runtime.rpcCalls.length, 1);
        assert.deepEqual(runtime.tableCalls, []);
      });
    }
  }
});

test("committed receipts require a valid subscription from the captured workspace, while abandoned receipts require null", async (t) => {
  const itemMutations: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["empty", {}], ["id invalid", subscription({ id: "invalid" })],
    ["workspace wrong", subscription({ workspace_id: OTHER_WORKSPACE })],
    ["plan unknown", subscription({ plan: "unknown" })], ["status unknown", subscription({ status: "unknown" })],
    ["plan whitespace", subscription({ plan: " standard " })], ["status whitespace", subscription({ status: " active " })],
    ["period whitespace", subscription({ billing_period: " monthly " })], ["currency whitespace", subscription({ currency: " KZT " })],
    ["price negative", subscription({ price_minor: -1 })], ["price fractional", subscription({ price_minor: 0.5 })],
    ["price unsafe", subscription({ price_minor: Number.MAX_SAFE_INTEGER + 1 })],
    ["currency invalid", subscription({ currency: "KZ1" })], ["period invalid", subscription({ billing_period: "weekly" })],
  ];
  for (const operation of operations.filter((value) => value.label !== "abandon")) {
    for (const [label, item] of itemMutations) {
      await t.test(`${operation.label}/${label}`, async () => {
        const runtime = fixture({ result: { data: { ...operation.valid, item }, error: null } });
        assertFailure(await runtime.invoke(operation), 502, "subscription_transition_unconfirmed");
        assert.deepEqual(runtime.tableCalls, []);
      });
    }
  }
  for (const operation of operations) {
    for (const value of [receipt({ kind: null }), abandonedReceipt({ item: subscription() })]) {
      await t.test(`${operation.label}/inconsistent-${value.state}`, async () => {
        const runtime = fixture({ result: { data: value, error: null } });
        assertFailure(await runtime.invoke(operation), 502, "subscription_transition_unconfirmed");
      });
    }
  }
});

test("operation receipts require every full SQL subscription column and valid date/note types", async (t) => {
  const query = { workspaceId: WORKSPACE, requestKey: REQUEST };
  const cases: Array<[string, RecordValue]> = [];
  for (const key of Object.keys(subscription())) {
    const row = subscription();
    delete row[key];
    cases.push([`missing ${key}`, row]);
  }
  for (const key of ["started_at", "updated_at", "created_at", "ended_at"]) {
    cases.push([`invalid ${key}`, subscription({ [key]: "invalid" })]);
    cases.push([`numeric ${key}`, subscription({ [key]: 123 })]);
  }
  cases.push(["numeric note", subscription({ note: 123 })], ["oversized note", subscription({ note: "x".repeat(2001) })]);
  for (const [label, item] of cases) {
    await t.test(label, async () => {
      const runtime = fixture({ result: { data: receipt({ item }), error: null } });
      assertFailure(await runtime.invoke({ method: "GET", query }), 502, "subscription_transition_unconfirmed");
      assertRpc(runtime, READ);
    });
  }
});

test("history and operation receipts reject impossible timestamps in every raw date column", async (t) => {
  for (const source of ["history", "receipt"] as const) {
    for (const column of ["started_at", "updated_at", "created_at", "ended_at"]) {
      for (const [label, timestamp] of INVALID_TIMESTAMPS) {
        await t.test(`${source}/${column}/${label}`, async () => {
          const item = subscription({ [column]: timestamp });
          const runtime = source === "history"
            ? fixture({ history: [item], historyCount: 1 })
            : fixture({ result: { data: receipt({ item }), error: null } });
          const query = { workspaceId: WORKSPACE, ...(source === "receipt" ? { requestKey: REQUEST } : {}) };
          const response = await runtime.invoke({ method: "GET", query });
          assertFailure(response, 502, source === "history" ? "unavailable" : "subscription_transition_unconfirmed");
          assert.equal(response.body.data, undefined, "Invalid dates must not escape in a successful or partial projection");
          if (source === "history") assertHistoryQuery(runtime, WORKSPACE);
          else assertRpc(runtime, READ);
        });
      }
    }
  }
});

test("history and operation receipts preserve valid leap-day timestamps, offsets and microseconds verbatim", async (t) => {
  for (const source of ["history", "receipt"] as const) {
    for (const [label, timestamp] of VALID_TIMESTAMPS) {
      await t.test(`${source}/${label}`, async () => {
        const item = subscription({ status: "cancelled", note: null,
          started_at: timestamp, updated_at: timestamp, created_at: timestamp, ended_at: timestamp });
        const value = statusReceipt({ item });
        const runtime = source === "history"
          ? fixture({ history: [item], historyCount: 1 })
          : fixture({ result: { data: value, error: null } });
        const query = { workspaceId: WORKSPACE, ...(source === "receipt" ? { requestKey: REQUEST } : {}) };
        const response = await runtime.invoke({ method: "GET", query });
        if (source === "history") {
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { success: true, data: { items: [item] } });
          assertHistoryQuery(runtime, WORKSPACE);
        } else {
          assertSuccess(response, value);
          assertRpc(runtime, READ);
        }
      });
    }
  }
});

test("success responses allowlist receipt metadata and raw subscription columns", async (t) => {
  for (const operation of operations) {
    await t.test(operation.label, async () => {
      const clean = operation.valid;
      const untrusted = { ...clean, debug: PRIVATE_DETAIL,
        item: clean.item === null ? null : { ...clean.item, backend_detail: PRIVATE_DETAIL } };
      const runtime = fixture({ result: { data: untrusted, error: null } });
      const response = await runtime.invoke(operation);
      assertSuccess(response, clean);
      assert.equal(JSON.stringify(response.body).includes(PRIVATE_DETAIL), false);
    });
  }
  const clean = subscription();
  const runtime = fixture({ history: [{ ...clean, backend_detail: PRIVATE_DETAIL }], historyCount: 1 });
  const response = await runtime.invoke({ method: "GET" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, data: { items: [clean] } });
  assertHistoryQuery(runtime);
});

test("replace receipts must confirm the requested kind, new row, active status and every canonical term", async (t) => {
  for (const [label, patch] of [
    ["same row as expected active", { id: PREVIOUS }], ["wrong plan", { plan: "pro" }],
    ["wrong price", { price_minor: 1 }], ["wrong currency", { currency: "USD" }],
    ["wrong period", { billing_period: "yearly" }], ["wrong note", { note: "Different agreement" }],
    ["inactive replacement", { status: "paused" }],
  ] as Array<[string, RecordValue]>) {
    await t.test(label, async () => {
      const runtime = fixture({ result: { data: receipt({ item: subscription(patch) }), error: null } });
      assertFailure(await runtime.invoke({ method: "POST", body: replaceBody() }), 502, "subscription_transition_unconfirmed");
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
  const wrongKind = fixture({ result: { data: receipt({ kind: "status" }), error: null } });
  assertFailure(await wrongKind.invoke({ method: "POST", body: replaceBody() }), 502, "subscription_transition_unconfirmed");
  const absent = fixture({ result: { data: null, error: null } });
  assertFailure(await absent.invoke({ method: "POST", body: replaceBody() }), 502, "subscription_transition_unconfirmed");
});

test("apply cannot report success with an abandoned tombstone, and abandon cannot report success without a receipt", async () => {
  for (const operation of operations.filter((value) => value.name === APPLY)) {
    const runtime = fixture({ result: { data: abandonedReceipt(), error: null } });
    assertFailure(await runtime.invoke(operation), 502, "subscription_transition_unconfirmed");
    assert.deepEqual(runtime.tableCalls, []);
  }
  const runtime = fixture({ result: { data: null, error: null } });
  assertFailure(await runtime.invoke({ method: "POST", body: { workspaceId: WORKSPACE, requestKey: REQUEST, abandon: true } }), 502, "subscription_transition_unconfirmed");
  assert.deepEqual(runtime.tableCalls, []);
});

test("status receipts must confirm the captured subscription id, requested status and operation kind", async (t) => {
  for (const value of [
    statusReceipt({ item: subscription({ id: PREVIOUS, status: "paused" }) }),
    statusReceipt({ item: subscription({ status: "active" }) }),
    statusReceipt({ kind: "replace" }),
    null,
  ]) {
    await t.test(JSON.stringify(value), async () => {
      const runtime = fixture({ result: { data: value, error: null } });
      assertFailure(await runtime.invoke({ method: "PATCH", body: statusBody() }), 502, "subscription_transition_unconfirmed");
      assert.deepEqual(runtime.tableCalls, []);
    });
  }
});

test("receipt validation stays bound to the request captured before the asynchronous RPC", async (t) => {
  for (const kind of ["replace", "status", "read"] as const) {
    for (const returnCaptured of [true, false]) {
      await t.test(`${kind}/${returnCaptured ? "original receipt" : "mutated receipt"}`, async () => {
        let release!: (value: RpcResult) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const pending = new Promise<RpcResult>((resolve) => { release = resolve; });
        const runtime = fixture({ onRpc: () => { entered(); return pending; } });
        const body = kind === "status" ? statusBody() : replaceBody();
        const query = { workspaceId: WORKSPACE, requestKey: REQUEST };
        const responsePromise = runtime.invoke({ method: kind === "read" ? "GET" : kind === "status" ? "PATCH" : "POST", body, query });
        await Promise.race([started, responsePromise.then(() => assert.fail("The operation must enter the RPC before responding"))]);
        body.workspaceId = OTHER_WORKSPACE;
        body.requestKey = OTHER_REQUEST;
        body.plan = "pro";
        body.status = "cancelled";
        runtime.requests[0].query.workspaceId = OTHER_WORKSPACE;
        runtime.requests[0].query.requestKey = OTHER_REQUEST;
        const original = kind === "status" ? statusReceipt() : receipt();
        const changed = { ...original, requestKey: OTHER_REQUEST, workspaceId: OTHER_WORKSPACE,
          item: subscription({ workspace_id: OTHER_WORKSPACE, plan: "pro", status: kind === "status" ? "cancelled" : "active" }) };
        release({ data: returnCaptured ? original : changed, error: null });
        const response = await responsePromise;
        if (returnCaptured) assertSuccess(response, original);
        else assertFailure(response, 502, "subscription_transition_unconfirmed");
        assert.equal(runtime.rpcCalls.length, 1);
        assert.equal(runtime.rpcCalls[0].args.p_request_id, REQUEST);
        assert.equal(runtime.rpcCalls[0].args.p_workspace_id, WORKSPACE);
        assert.deepEqual(runtime.tableCalls, []);
      });
    }
  }
});

test("authorized requests report unconfigured storage without attempting an operation", async () => {
  const runtime = fixture({ storage: false });
  assertFailure(await runtime.invoke({ method: "POST", body: replaceBody() }), 503, "storage_not_configured");
  assert.deepEqual(runtime.rpcCalls, []);
  assert.deepEqual(runtime.tableCalls, []);
});

import assert from "node:assert/strict";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreignWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const privateMarker = "fixture-private-report-data";

type Row = Record<string, unknown>;
type RangeCall = { table: string; from: number; to: number };
type QueryCall = {
  table: string;
  columns: string;
  head: boolean;
  filters: { column: string; operator: "eq" | "not"; value: unknown }[];
  order: { column: string; ascending: boolean } | null;
  range: [number, number] | null;
};
type QueryResult = { data: unknown; error: unknown; count: unknown };
type CountName = "totalLeads" | "attributedLeads" | "totalPaidDeals" | "paidAttributedDeals"
  | "paidAppointmentDeals" | "paidAttributedAppointmentDeals" | "pendingDeals";
type FixtureOptions = {
  shortenRangeStartingAt?: number;
  calls?: QueryCall[];
  counts?: Partial<Record<CountName, unknown>>;
  reply?: (query: QueryCall, result: QueryResult) => QueryResult;
};

const supabaseModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
)) as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
const server = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href
)) as {
  attachWorkspaceContext(req: unknown, context: unknown): void;
  handleAdvertisingOutcomes(req: unknown, res: unknown): Promise<unknown>;
};

const originalFetch = globalThis.fetch;
let networkAttempts = 0;
beforeEach(() => {
  networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error("Network is forbidden in advertising report tests");
  };
});
afterEach(() => {
  supabaseModule.setSupabaseServerClientFactoryForTests(null);
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0, "Every report must use only the in-memory client");
});

function response() {
  const state = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { state.statusCode = code; return state; },
    setHeader() { return state; },
    json(payload: unknown) { state.body = (payload ?? {}) as Record<string, unknown>; return state; },
  };
  return state;
}

function request(role: "owner" | "admin" | "manager" = "owner") {
  const req = { method: "GET", query: { workspaceId }, headers: {} };
  server.attachWorkspaceContext(req, {
    userId: "11111111-1111-4111-8111-111111111111",
    staffUserId: "22222222-2222-4222-8222-222222222222",
    workspaceId,
    role,
    permissions: [],
  });
  return req;
}

function fakeSupabase(
  tables: Record<string, Row[]>,
  rangeCalls: RangeCall[],
  options: FixtureOptions = {},
) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let head = false;
      let wantsCount = false;
      let range: [number, number] | null = null;
      const query: QueryCall = { table, columns: "", head: false, filters: [], order: null, range: null };
      const builder = {
        select(columns: string, selectOptions?: { count?: string; head?: boolean }) {
          wantsCount = selectOptions?.count === "exact";
          head = selectOptions?.head === true;
          query.columns = columns;
          query.head = head;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push({ column, operator: "eq", value });
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          assert.equal(operator, "is");
          assert.equal(value, null);
          query.filters.push({ column, operator: "not", value });
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        order(column: string, { ascending }: { ascending: boolean }) {
          query.order = { column, ascending };
          rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          query.range = range;
          rangeCalls.push({ table, from, to });
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          const name = head ? countName(query) : null;
          const count = name && options.counts && Object.hasOwn(options.counts, name)
            ? options.counts[name] : wantsCount ? rows.length : null;
          let data: Row[] | null = head ? null : rows;
          if (!head && range) {
            const [from, to] = range;
            data = rows.slice(from, to + 1);
            if (options.shortenRangeStartingAt === from) data = data.slice(0, -1);
          }
          return Promise.resolve().then(() => {
            options.calls?.push(query);
            const result = { data, error: null, count };
            return options.reply ? options.reply(query, result) : result;
          }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

function countName(query: QueryCall): CountName {
  const attributed = query.filters.some((filter) => filter.operator === "not" && filter.column === "meta_campaign_launch_id");
  const linked = query.filters.some((filter) => filter.operator === "not" && filter.column === "appointment_id");
  if (query.table === "leads") return attributed ? "attributedLeads" : "totalLeads";
  if (query.filters.some((filter) => filter.column === "status" && filter.value === "pending")) return "pendingDeals";
  if (linked) return attributed ? "paidAttributedAppointmentDeals" : "paidAppointmentDeals";
  return attributed ? "paidAttributedDeals" : "totalPaidDeals";
}

function assertScopedQueries(calls: QueryCall[]) {
  assert.ok(calls.length >= 7, "The seven aggregate counts must be read");
  for (const call of calls) {
    assert.ok(["leads", "deals"].includes(call.table));
    assert.deepEqual(call.filters.filter((filter) => filter.column === "workspace_id"),
      [{ column: "workspace_id", operator: "eq", value: workspaceId }]);
    assert.equal(call.columns, call.head ? "id" : "id,amount_minor,currency");
    if (!call.head) {
      assert.deepEqual(call.order, { column: "id", ascending: true });
      assert.ok(call.range);
      assert.ok(call.filters.some((filter) => filter.column === "status" && filter.value === "paid"));
      assert.ok(call.filters.some((filter) => filter.column === "meta_campaign_launch_id" && filter.operator === "not"));
    }
  }
}

function assertPrivateFailure(res: ReturnType<typeof response>, forbidden: string[] = []) {
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  assert.deepEqual(Object.keys(res.body).sort(), ["details", "error", "success"]);
  assert.equal(typeof res.body.error, "string");
  const serialized = JSON.stringify(res.body);
  for (const value of [workspaceId, foreignWorkspaceId, privateMarker, ...forbidden]) {
    assert.equal(serialized.includes(value), false, `Failure must not expose ${value}`);
  }
}

async function report(tables: Record<string, Row[]>, options: FixtureOptions = {}) {
  const calls: QueryCall[] = [];
  const ranges: RangeCall[] = [];
  supabaseModule.setSupabaseServerClientFactoryForTests(() => fakeSupabase(tables, ranges, { ...options, calls }));
  const req = request("admin");
  // The attached context, not a forged browser selector, owns every read.
  req.query.workspaceId = foreignWorkspaceId;
  const res = response();
  await server.handleAdvertisingOutcomes(req, res);
  assertScopedQueries(calls);
  return { res, calls, ranges };
}

function attributed(id: string, amountMinor: number, currency = "KZT"): Row {
  return {
    id,
    workspace_id: workspaceId,
    status: "paid",
    meta_campaign_launch_id: "33333333-3333-4333-8333-333333333333",
    amount_minor: amountMinor,
    currency,
  };
}

test("owner report pages past the PostgREST ceiling and keeps currencies separate", async () => {
  const rangeCalls: RangeCall[] = [];
  const attributedDeals = Array.from({ length: 1_203 }, (_, index) => attributed(`deal-${String(index).padStart(4, "0")}`, 100));
  attributedDeals.push(attributed("deal-usd-1", 250, "USD"), attributed("deal-usd-2", 250, "USD"));
  attributedDeals.slice(0, 1_000).forEach((deal, index) => {
    deal.appointment_id = `appointment-${index}`;
  });
  const deals: Row[] = [
    ...attributedDeals,
    ...Array.from({ length: 3 }, (_, index) => ({
      id: `unattributed-${index}`,
      workspace_id: workspaceId,
      status: "paid",
      meta_campaign_launch_id: null,
      appointment_id: index === 0 ? "appointment-unattributed" : null,
      amount_minor: 900,
      currency: "KZT",
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `pending-${index}`,
      workspace_id: workspaceId,
      status: "pending",
      meta_campaign_launch_id: null,
      amount_minor: 0,
      currency: "KZT",
    })),
    attributed("foreign", 999_999),
  ];
  deals[deals.length - 1].workspace_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const leads: Row[] = [
    { id: "lead-1", workspace_id: workspaceId, meta_campaign_launch_id: "campaign-a" },
    { id: "lead-2", workspace_id: workspaceId, meta_campaign_launch_id: "campaign-b" },
    { id: "lead-3", workspace_id: workspaceId, meta_campaign_launch_id: null },
    { id: "lead-4", workspace_id: workspaceId, meta_campaign_launch_id: null },
    { id: "lead-foreign", workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", meta_campaign_launch_id: "campaign-x" },
  ];
  supabaseModule.setSupabaseServerClientFactoryForTests(() => fakeSupabase({ leads, deals }, rangeCalls));

  const res = response();
  await server.handleAdvertisingOutcomes(request(), res);

  assert.equal(res.statusCode, 200);
  const data = res.body.data as { outcomes: Record<string, unknown> };
  assert.equal(data.outcomes.attributedLeads, 2);
  assert.equal(data.outcomes.unattributedLeads, 2);
  assert.equal(data.outcomes.paidAttributedDeals, 1_205);
  assert.equal(data.outcomes.paidUnattributedDeals, 3);
  assert.equal(data.outcomes.paidAppointmentDeals, 1_001);
  assert.equal(data.outcomes.paidAttributedAppointmentDeals, 1_000);
  assert.equal(data.outcomes.pendingDeals, 4);
  assert.deepEqual(data.outcomes.attributedRevenueByCurrency, [
    { currency: "KZT", currencyExponent: 2, amountMinor: "120300" },
    { currency: "USD", currencyExponent: 2, amountMinor: "500" },
  ]);
  assert.deepEqual(rangeCalls, [
    { table: "deals", from: 0, to: 499 },
    { table: "deals", from: 500, to: 999 },
    { table: "deals", from: 1000, to: 1204 },
  ]);
});

test("a changing dataset fails closed instead of returning a partial total", async () => {
  const deals = Array.from({ length: 501 }, (_, index) => attributed(`deal-${index}`, 100));
  supabaseModule.setSupabaseServerClientFactoryForTests(() => fakeSupabase(
    { leads: [], deals },
    [],
    { shortenRangeStartingAt: 500 },
  ));

  const res = response();
  await server.handleAdvertisingOutcomes(request("admin"), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  assert.equal(JSON.stringify(res.body).includes("50000"), false, "raw totals must not leak through an error");
});

test("a non-admin direct call is refused before any database read", async () => {
  let opened = 0;
  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from() { opened += 1; throw new Error("must not query"); },
  }));

  const res = response();
  await server.handleAdvertisingOutcomes(request("manager"), res);
  assert.equal(res.statusCode, 403);
  assert.equal(opened, 0);
});

for (const foreignOnly of [false, true]) {
  test(`${foreignOnly ? "foreign-only" : "empty"} data returns a real zero snapshot without revenue rows or contacts`, async () => {
    const { res, ranges } = await report(foreignOnly ? {
      leads: [{ id: privateMarker, workspace_id: foreignWorkspaceId, phone: privateMarker,
        meta_campaign_launch_id: privateMarker }],
      deals: [{ ...attributed(privateMarker, 999_999), workspace_id: foreignWorkspaceId,
        amount_minor: privateMarker, full_name: privateMarker }],
    } : { leads: [], deals: [] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mode, "supabase");
    const { generatedAt, ...outcomes } = (res.body.data as { outcomes: Row }).outcomes;
    assert.equal(typeof generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(generatedAt as string)));
    assert.deepEqual(outcomes, {
      attributedLeads: 0, unattributedLeads: 0, paidAttributedDeals: 0, paidUnattributedDeals: 0,
      paidAppointmentDeals: 0, paidAttributedAppointmentDeals: 0, pendingDeals: 0,
      attributedRevenueByCurrency: [],
    });
    assert.deepEqual(ranges, [], "Zero attributed sales must not trigger a money-page read");
    assert.equal(JSON.stringify(res.body).includes(privateMarker), false);
    assert.equal(JSON.stringify(res.body).includes(foreignWorkspaceId), false);
  });
}

test("unattributed paid and pending sales keep their counts without inventing attributed revenue", async () => {
  const { res, ranges } = await report({
    leads: [{ id: privateMarker, workspace_id: workspaceId, phone: privateMarker }],
    deals: [
      { ...attributed("unattributed", 700050), meta_campaign_launch_id: null, appointment_id: "appointment-private" },
      { ...attributed("pending", 900), status: "pending" },
      { ...attributed("refunded", 900), status: "refunded" },
      { ...attributed("cancelled", 900), status: "cancelled" },
    ],
  });
  assert.equal(res.statusCode, 200);
  const { generatedAt, ...outcomes } = (res.body.data as { outcomes: Row }).outcomes;
  assert.ok(generatedAt);
  assert.deepEqual(outcomes, {
    attributedLeads: 0, unattributedLeads: 1, paidAttributedDeals: 0, paidUnattributedDeals: 1,
    paidAppointmentDeals: 1, paidAttributedAppointmentDeals: 0, pendingDeals: 1,
    attributedRevenueByCurrency: [],
  });
  assert.deepEqual(ranges, []);
  assert.equal(JSON.stringify(res.body).includes(privateMarker), false);
});

test("duplicate sale IDs within one page refuse the entire report", async () => {
  const { res, ranges } = await report({ deals: [attributed(privateMarker, 100), attributed(privateMarker, 200)] });
  assertPrivateFailure(res, ["duplicate_or_missing_id"]);
  assert.deepEqual(ranges, [{ table: "deals", from: 0, to: 1 }]);
});

test("a repeated ID on the second page discards the first page and stops further reads", async () => {
  const deals = Array.from({ length: 1_001 }, (_, i) => attributed(`sale-${String(i).padStart(4, "0")}`, 100));
  const { res, ranges } = await report({ deals }, {
    reply(query, result) {
      if (query.range?.[0] !== 500) return result;
      const page = result.data as Row[];
      return { ...result, data: [{ ...page[0], id: deals[0].id }, ...page.slice(1)] };
    },
  });
  assertPrivateFailure(res, ["sale-0000", "duplicate_or_missing_id"]);
  assert.deepEqual(ranges, [{ table: "deals", from: 0, to: 499 }, { table: "deals", from: 500, to: 999 }]);
});

for (const [label, id] of [["missing", undefined], ["null", null], ["empty", ""], ["blank", "  "]] as const) {
  test(`${label} sale IDs refuse the report instead of silently reducing the total`, async () => {
    const { res } = await report({ deals: [{ ...attributed("original", 100), id }] });
    assertPrivateFailure(res, ["duplicate_or_missing_id"]);
  });
}

const malformedMoney: { label: string; patch: Row }[] = [
  { label: "missing amount", patch: { amount_minor: undefined } },
  { label: "null amount", patch: { amount_minor: null } },
  { label: "empty amount", patch: { amount_minor: "" } },
  { label: "decimal string", patch: { amount_minor: "1.5" } },
  { label: "negative string", patch: { amount_minor: "-1" } },
  { label: "fractional number", patch: { amount_minor: 1.5 } },
  { label: "negative number", patch: { amount_minor: -1 } },
  { label: "unsafe JS integer", patch: { amount_minor: Number.MAX_SAFE_INTEGER + 1 } },
  { label: "NaN amount", patch: { amount_minor: Number.NaN } },
  { label: "object amount", patch: { amount_minor: { privateMarker } } },
  { label: "missing currency", patch: { currency: undefined } },
  { label: "null currency", patch: { currency: null } },
  { label: "empty currency", patch: { currency: "" } },
  { label: "short currency", patch: { currency: "KZ" } },
  { label: "long currency", patch: { currency: "KZTT" } },
  { label: "nonalphabetic currency", patch: { currency: "K2T" } },
];
for (const { label, patch } of malformedMoney) {
  test(`${label} fails without publishing an otherwise valid partial money total`, async () => {
    const { res } = await report({ deals: [
      attributed("a-valid", 700050),
      { ...attributed(privateMarker, 100), ...patch, phone: privateMarker },
    ] });
    assertPrivateFailure(res, ["700050", "invalid_money_row"]);
  });
}

test("zero amounts and large integer strings remain valid and currencies stay separate", async () => {
  const { res } = await report({ deals: [
    { ...attributed("large", 0), amount_minor: "9007199254740993", phone: privateMarker },
    attributed("zero-number", 0),
    { ...attributed("zero-string", 0), amount_minor: "0" },
    { ...attributed("usd", 7, "usd"), full_name: privateMarker },
  ] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.body.data as { outcomes: Row }).outcomes.attributedRevenueByCurrency, [
    { currency: "KZT", currencyExponent: 2, amountMinor: "9007199254740993" },
    { currency: "USD", currencyExponent: 2, amountMinor: "7" },
  ]);
  assert.equal(JSON.stringify(res.body).includes(privateMarker), false);
});

test("the exact 20000 attributed-sale ceiling is accepted with all forty bounded pages", async () => {
  const deals = Array.from({ length: 20_000 }, (_, i) => attributed(`sale-${String(i).padStart(5, "0")}`, 1));
  const { res, ranges } = await report({ deals });
  assert.equal(res.statusCode, 200);
  const outcomes = (res.body.data as { outcomes: Row }).outcomes;
  assert.equal(outcomes.paidAttributedDeals, 20_000);
  assert.deepEqual(outcomes.attributedRevenueByCurrency,
    [{ currency: "KZT", currencyExponent: 2, amountMinor: "20000" }]);
  assert.deepEqual(ranges, Array.from({ length: 40 }, (_, i) => ({ table: "deals", from: i * 500, to: i * 500 + 499 })));
});

test("20001 attributed sales refuse before any money page is read", async () => {
  const { res, ranges } = await report({}, { counts: { totalPaidDeals: 20_001, paidAttributedDeals: 20_001 } });
  assertPrivateFailure(res, ["report_too_large", "20001"]);
  assert.deepEqual(ranges, []);
});

const contradictions: { label: string; counts: Partial<Record<CountName, number>> }[] = [
  { label: "attributed leads exceed total leads", counts: { totalLeads: 1, attributedLeads: 2 } },
  { label: "attributed paid sales exceed all paid sales", counts: { totalPaidDeals: 1, paidAttributedDeals: 2 } },
  { label: "appointment sales exceed all paid sales", counts: { totalPaidDeals: 1, paidAppointmentDeals: 2 } },
  { label: "attributed appointment sales exceed attributed sales",
    counts: { totalPaidDeals: 2, paidAttributedDeals: 0, paidAppointmentDeals: 1, paidAttributedAppointmentDeals: 1 } },
  { label: "attributed appointment sales exceed appointment sales",
    counts: { totalPaidDeals: 2, paidAttributedDeals: 1, paidAppointmentDeals: 0, paidAttributedAppointmentDeals: 1 } },
];
for (const { label, counts } of contradictions) {
  test(`${label} fails before paging or emitting contradictory counts`, async () => {
    const { res, ranges } = await report({}, { counts });
    assertPrivateFailure(res, ["changed_during_count"]);
    assert.deepEqual(ranges, []);
  });
}

for (const [label, count] of [
  ["null", null], ["missing", undefined], ["negative", -1], ["fractional", 0.5], ["string", "1"],
  ["NaN", Number.NaN], ["infinite", Infinity], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
] as const) {
  test(`${label} database counts cannot become a plausible empty snapshot`, async () => {
    const { res, ranges } = await report({}, { counts: { pendingDeals: count } });
    assertPrivateFailure(res, ["count_failed"]);
    assert.deepEqual(ranges, []);
  });
}

const countNames: CountName[] = ["totalLeads", "attributedLeads", "totalPaidDeals", "paidAttributedDeals",
  "paidAppointmentDeals", "paidAttributedAppointmentDeals", "pendingDeals"];
for (const name of countNames) {
  test(`${name} database errors fail even when a numeric count is returned`, async () => {
    const { res, ranges } = await report({}, {
      reply(query, result) {
        return query.head && countName(query) === name
          ? { ...result, count: 0, error: { code: "XX000", message: privateMarker, details: foreignWorkspaceId } }
          : result;
      },
    });
    assertPrivateFailure(res, ["XX000", "count_failed"]);
    assert.deepEqual(ranges, []);
  });
}

test("a rejected count query is a private report failure, not an empty snapshot", async () => {
  const { res, ranges } = await report({}, {
    reply(query, result) {
      if (query.head && countName(query) === "totalLeads") throw new Error(privateMarker);
      return result;
    },
  });
  assertPrivateFailure(res);
  assert.deepEqual(ranges, []);
});

for (const from of [0, 500]) {
  for (const rejected of [false, true]) {
    test(`${rejected ? "rejected" : "returned"} database error on page ${from / 500 + 1} discards every partial result`, async () => {
      const { res, ranges } = await report({
        deals: Array.from({ length: 1_001 }, (_, i) => attributed(`sale-${String(i).padStart(4, "0")}`, 700050)),
      }, {
        reply(query, result) {
          if (query.range?.[0] !== from) return result;
          if (rejected) throw new Error(privateMarker);
          return { ...result, error: { code: "XX000", message: privateMarker, details: workspaceId } };
        },
      });
      assertPrivateFailure(res, ["700050", "XX000", "read_failed"]);
      assert.equal(ranges.length, from / 500 + 1, "No later page may be read after a failed page");
    });
  }
}

const malformedPages: { label: string; change: (rows: Row[]) => unknown }[] = [
  { label: "null", change: () => null },
  { label: "non-array", change: () => ({ privateMarker }) },
  { label: "empty", change: () => [] },
  { label: "short", change: (rows) => rows.slice(0, -1) },
  { label: "oversized", change: (rows) => [...rows, attributed(privateMarker, 100)] },
];
for (const { label, change } of malformedPages) {
  test(`${label} second page fails rather than returning the first page as a total`, async () => {
    const { res, ranges } = await report({
      deals: Array.from({ length: 1_001 }, (_, i) => attributed(`sale-${String(i).padStart(4, "0")}`, 700050)),
    }, {
      reply(query, result) {
        return query.range?.[0] === 500 ? { ...result, data: change(result.data as Row[]) } : result;
      },
    });
    assertPrivateFailure(res, ["700050", "changed_during_read"]);
    assert.deepEqual(ranges, [{ table: "deals", from: 0, to: 499 }, { table: "deals", from: 500, to: 999 }]);
  });
}

test("unconfigured storage returns unavailable without fabricated totals", async () => {
  supabaseModule.setSupabaseServerClientFactoryForTests(() => null);
  const res = response();
  await server.handleAdvertisingOutcomes(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.deepEqual(Object.keys(res.body).sort(), ["details", "error", "success"]);
});

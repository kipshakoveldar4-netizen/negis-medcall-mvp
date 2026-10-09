import assert from "node:assert/strict";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;
type RangeCall = { table: string; from: number; to: number };

const supabaseModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
)) as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
const server = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href
)) as {
  attachWorkspaceContext(req: unknown, context: unknown): void;
  handleAdvertisingOutcomes(req: unknown, res: unknown): Promise<unknown>;
};

afterEach(() => {
  supabaseModule.setSupabaseServerClientFactoryForTests(null);
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
  options: { shortenRangeStartingAt?: number } = {},
) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let head = false;
      let wantsCount = false;
      let range: [number, number] | null = null;
      const builder = {
        select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
          wantsCount = selectOptions?.count === "exact";
          head = selectOptions?.head === true;
          return builder;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          assert.equal(operator, "is");
          assert.equal(value, null);
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        order() { return builder; },
        range(from: number, to: number) {
          range = [from, to];
          rangeCalls.push({ table, from, to });
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          const count = wantsCount ? rows.length : null;
          let data: Row[] | null = head ? null : rows;
          if (!head && range) {
            const [from, to] = range;
            data = rows.slice(from, to + 1);
            if (options.shortenRangeStartingAt === from) data = data.slice(0, -1);
          }
          return Promise.resolve({ data, error: null, count }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
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

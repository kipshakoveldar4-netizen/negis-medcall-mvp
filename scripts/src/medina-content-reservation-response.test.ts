import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type GenerationKind = "text_request" | "image" | "video_seconds";
type ReservationInput = {
  workspaceId: string; staffUserId: string; requestKey: string;
  operation: "content_package" | "generated_image" | "generated_video";
  kind: GenerationKind; units: number;
};
type Reservation = {
  allowed: boolean; tracked: boolean; duplicate: boolean; usageId: string;
  kind: GenerationKind; used: number; limit: number | null; remaining: number | null;
  periodStart: string; reason?: string; warning?: string;
};
type UsageModule = {
  reserveContentGeneration: (input: ReservationInput) => Promise<Reservation>;
  quotaForPlan: (plan: "standard" | "pro", kind: GenerationKind) => number | null;
};
type RpcRow = Record<string, unknown>;
type Fixture = {
  plan: "standard" | "pro";
  kind: ReservationInput["kind"];
  operation: ReservationInput["operation"];
  units: number;
};

const usage = await import(pathToFileURL(path.join(repoRoot, "lib", "content-studio", "usage.ts")).href) as UsageModule;
const supabaseServer = await import(pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href) as {
  setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void;
};

const PERIOD_START = "2026-10-01";
const USAGE_ID = "44444444-4444-4444-8444-444444444444";
const INPUT_IDS = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
  requestKey: "33333333-3333-4333-8333-333333333333",
};
const MEDIA_FIXTURES: Fixture[] = [
  { plan: "standard", kind: "image", operation: "generated_image", units: 1 },
  { plan: "pro", kind: "video_seconds", operation: "generated_video", units: 8 },
];
const TEXT_FIXTURE: Fixture = {
  plan: "standard", kind: "text_request", operation: "content_package", units: 1,
};

function allowedRow(fixture: Fixture): RpcRow {
  const limit = usage.quotaForPlan(fixture.plan, fixture.kind);
  return {
    allowed: true,
    duplicate: false,
    usage_id: USAGE_ID,
    used_units: fixture.units,
    limit_units: limit,
    remaining_units: limit === null ? null : limit - fixture.units,
    period_start: PERIOD_START,
  };
}

async function withRpcPayload(
  t: TestContext,
  fixture: Fixture,
  data: unknown,
  check: (reservation: Promise<Reservation>) => Promise<void>,
  crossMonthBoundary = false,
): Promise<void> {
  const input = {
    ...INPUT_IDS,
    operation: fixture.operation,
    kind: fixture.kind,
    units: fixture.units,
  };
  const tables: string[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = async () => ({ data: [{ plan: fixture.plan }], error: null });
  const client = {
    from: (table: string) => {
      tables.push(table);
      return chain;
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (crossMonthBoundary) {
        t.mock.timers.setTime(new Date("2026-11-01T00:00:00.001Z").getTime());
      }
      return { data, error: null };
    },
  };

  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(crossMonthBoundary ? "2026-10-31T23:59:59.999Z" : "2026-10-15T12:00:00.000Z"),
  });
  supabaseServer.setSupabaseServerClientFactoryForTests(() => client);
  try {
    await check(usage.reserveContentGeneration(input));
    // Check the mock outside assert.rejects so a harness error cannot pass as validation.
    assert.deepEqual(tables, ["platform_subscriptions"]);
    assert.deepEqual(rpcCalls, [{
      name: "reserve_content_generation_usage",
      args: {
        p_workspace_id: input.workspaceId,
        p_staff_user_id: input.staffUserId,
        p_request_key: input.requestKey,
        p_operation: input.operation,
        p_kind: input.kind,
        p_units: input.units,
        p_limit_units: usage.quotaForPlan(fixture.plan, fixture.kind),
        p_provider: null,
        p_model: null,
      },
    }]);
  } finally {
    supabaseServer.setSupabaseServerClientFactoryForTests(null);
    t.mock.timers.reset();
  }
}

for (const fixture of MEDIA_FIXTURES) {
  const label = `${fixture.plan}/${fixture.kind}`;
  const limit = usage.quotaForPlan(fixture.plan, fixture.kind);
  assert.ok(typeof limit === "number" && limit >= fixture.units);

  for (const bigintStrings of [false, true]) {
    test(`CRR ${label}: valid allowed SQL row (${bigintStrings ? "bigint strings" : "numbers"})`, async (t) => {
      const row = allowedRow(fixture);
      if (bigintStrings) {
        row.used_units = String(row.used_units);
        row.remaining_units = String(row.remaining_units);
      }
      await withRpcPayload(t, fixture, [row], async (reservation) => {
        assert.deepEqual(await reservation, {
          allowed: true,
          tracked: true,
          duplicate: false,
          usageId: USAGE_ID,
          kind: fixture.kind,
          used: fixture.units,
          limit,
          remaining: limit - fixture.units,
          periodStart: PERIOD_START,
        });
      });
    });
  }

  test(`CRR ${label}: valid allowed reservation may exhaust the quota exactly`, async (t) => {
    const row = { ...allowedRow(fixture), used_units: limit, remaining_units: 0 };
    await withRpcPayload(t, fixture, [row], async (reservation) => {
      assert.deepEqual(await reservation, {
        allowed: true, tracked: true, duplicate: false, usageId: USAGE_ID,
        kind: fixture.kind, used: limit, limit, remaining: 0, periodStart: PERIOD_START,
      });
    });
  });

  test(`CRR ${label}: valid quota-denied row has no receipt and may exceed a downgraded limit`, async (t) => {
    const row = {
      ...allowedRow(fixture), allowed: false, usage_id: null,
      used_units: limit + 1, remaining_units: 0,
    };
    await withRpcPayload(t, fixture, [row], async (reservation) => {
      assert.deepEqual(await reservation, {
        allowed: false, tracked: true, duplicate: false, usageId: "",
        kind: fixture.kind, used: limit + 1, limit, remaining: 0,
        periodStart: PERIOD_START, reason: "quota_exceeded",
      });
    });
  });

  test(`CRR ${label}: valid duplicate may reference an earlier receipt without using this month's units`, async (t) => {
    const row = {
      ...allowedRow(fixture), allowed: false, duplicate: true,
      used_units: 0, remaining_units: limit,
    };
    await withRpcPayload(t, fixture, [row], async (reservation) => {
      assert.deepEqual(await reservation, {
        allowed: false, tracked: true, duplicate: true, usageId: USAGE_ID,
        kind: fixture.kind, used: 0, limit, remaining: limit,
        periodStart: PERIOD_START, reason: "duplicate_request",
      });
    });
  });
}

test("CRR valid text accounting remains unbounded with SQL bigint strings", async (t) => {
  const row = { ...allowedRow(TEXT_FIXTURE), used_units: "3" };
  await withRpcPayload(t, TEXT_FIXTURE, [row], async (reservation) => {
    assert.deepEqual(await reservation, {
      allowed: true, tracked: true, duplicate: false, usageId: USAGE_ID,
      kind: "text_request", used: 3, limit: null, remaining: null, periodStart: PERIOD_START,
    });
  });
});

test("CRR a canonical RPC month may advance while awaiting the reservation", async (t) => {
  const fixture = MEDIA_FIXTURES[0];
  const row = { ...allowedRow(fixture), period_start: "2026-11-01" };
  await withRpcPayload(t, fixture, [row], async (reservation) => {
    const result = await reservation;
    assert.equal(result.allowed, true);
    assert.equal(result.tracked, true);
    assert.equal(result.usageId, USAGE_ID);
    assert.equal(result.periodStart, "2026-11-01");
  }, true);
});

type MalformedRow = {
  label: string;
  patch: (fixture: Fixture) => RpcRow;
};
const malformedRows: MalformedRow[] = [
  { label: "missing usage_id", patch: () => ({ usage_id: undefined }) },
  { label: "null usage_id", patch: () => ({ usage_id: null }) },
  { label: "empty usage_id", patch: () => ({ usage_id: "" }) },
  { label: "whitespace usage_id", patch: () => ({ usage_id: "   " }) },
  { label: "numeric usage_id", patch: () => ({ usage_id: 123 }) },
  { label: "non-UUID usage_id", patch: () => ({ usage_id: "not-a-uuid" }) },
  { label: "invalid UUID characters", patch: () => ({ usage_id: "44444444-4444-4444-8444-44444444444g" }) },
  { label: "allowed duplicate", patch: () => ({ duplicate: true }) },
  { label: "missing period", patch: () => ({ period_start: undefined }) },
  { label: "null period", patch: () => ({ period_start: null }) },
  { label: "empty period", patch: () => ({ period_start: "" }) },
  { label: "non-date period", patch: () => ({ period_start: "not-a-date" }) },
  { label: "invalid calendar month", patch: () => ({ period_start: "2026-13-01" }) },
  { label: "period is not month start", patch: () => ({ period_start: "2026-10-02" }) },
  { label: "noncanonical period", patch: () => ({ period_start: "2026-1-01" }) },
  { label: "timestamp instead of a month date", patch: () => ({ period_start: "2026-10-01T00:00:00.000Z" }) },
  { label: "missing media limit", patch: () => ({ limit_units: undefined }) },
  { label: "unbounded media limit", patch: () => ({ limit_units: null }) },
  { label: "zero media limit", patch: () => ({ limit_units: 0 }) },
  {
    label: "limit above local plan",
    patch: (fixture) => ({ limit_units: usage.quotaForPlan(fixture.plan, fixture.kind)! + 1 }),
  },
  {
    label: "limit below local plan",
    patch: (fixture) => ({ limit_units: usage.quotaForPlan(fixture.plan, fixture.kind)! - 1 }),
  },
  {
    label: "used does not include all requested units",
    patch: (fixture) => ({
      used_units: fixture.units - 1,
      remaining_units: usage.quotaForPlan(fixture.plan, fixture.kind)! - fixture.units + 1,
    }),
  },
  {
    label: "allowed usage exceeds the limit even with a clamped balance",
    patch: (fixture) => ({
      used_units: usage.quotaForPlan(fixture.plan, fixture.kind)! + 1,
      remaining_units: 0,
    }),
  },
  {
    label: "remaining is too high",
    patch: (fixture) => ({ remaining_units: usage.quotaForPlan(fixture.plan, fixture.kind)! - fixture.units + 1 }),
  },
  {
    label: "remaining is too low",
    patch: (fixture) => ({ remaining_units: usage.quotaForPlan(fixture.plan, fixture.kind)! - fixture.units - 1 }),
  },
];

for (const field of ["allowed", "duplicate"] as const) {
  for (const [label, value] of [
    ["missing", undefined], ["null", null], ["numeric", 1],
    ["string true", "true"], ["string false", "false"],
  ] as const) {
    malformedRows.push({ label: `${label} ${field} flag`, patch: () => ({ [field]: value }) });
  }
}

// PostgreSQL bigint values may be decimal strings, but never unsafe or coercible junk.
for (const field of ["used_units", "limit_units", "remaining_units"] as const) {
  const invalidCounters: Array<[string, unknown]> = [
    ["negative", -1], ["fractional", 0.5], ["NaN", NaN], ["infinite", Infinity],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["unsafe bigint string", "9007199254740992"],
    ["exponent string", "1e2"], ["nonnumeric string", "invalid"], ["boolean", true],
  ];
  if (field !== "limit_units") {
    invalidCounters.push(["missing", undefined], ["null", null]);
  }
  for (const [label, value] of invalidCounters) {
    malformedRows.push({ label: `${label} ${field}`, patch: () => ({ [field]: value }) });
  }
}

for (const fixture of MEDIA_FIXTURES) {
  for (const malformed of malformedRows) {
    test(`CRR ${fixture.kind}: rejects successful RPC with ${malformed.label}`, async (t) => {
      const row = { ...allowedRow(fixture), ...malformed.patch(fixture) };
      await withRpcPayload(t, fixture, [row], async (reservation) => {
        await assert.rejects(reservation, Error, "malformed receipts must throw, not allow or fabricate a quota denial");
      });
    });
  }

  const malformedPayloads: Array<[string, unknown]> = [
    ["null data", null], ["undefined data", undefined], ["empty rows", []],
    ["null row", [null]], ["empty row", [{}]], ["empty object", {}],
    ["scalar data", true], ["scalar row", [true]],
    ["multiple receipts", [allowedRow(fixture), allowedRow(fixture)]],
    ["receipt followed by null", [allowedRow(fixture), null]],
  ];
  for (const [label, data] of malformedPayloads) {
    test(`CRR ${fixture.kind}: rejects successful RPC with ${label}`, async (t) => {
      await withRpcPayload(t, fixture, data, async (reservation) => {
        await assert.rejects(reservation, Error, "a successful RPC must contain exactly one valid reservation record");
      });
    });
  }
}

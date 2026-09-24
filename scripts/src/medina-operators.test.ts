import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const load = (name: string) =>
  import(pathToFileURL(path.join(root, name)).href);
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATOR = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
type Row = Record<string, unknown>;
type Query = {
  table: string;
  filters: Row;
  op: string;
  values?: Row;
  range?: number[];
  select?: string;
};

test("operator HTTP authorization, DTOs and transitions", async (t) => {
  const savedFetch = globalThis.fetch;
  const savedEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    MEDINA_PLATFORM_OWNER_IDS: process.env.MEDINA_PLATFORM_OWNER_IDS,
  };
  Object.assign(process.env, {
    SUPABASE_URL: "https://operators.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-only",
    MEDINA_PLATFORM_OWNER_IDS: OTHER,
  });
  let validToken = true;
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(
      String(url),
      "https://operators.example.test/auth/v1/user",
      "no advertising/provider request allowed",
    );
    return {
      ok: validToken,
      status: validToken ? 200 : 401,
      text: async () =>
        JSON.stringify(
          validToken ? { id: USER, email: "operator@example.test" } : {},
        ),
    };
  }) as unknown as typeof fetch;
  const supabase = await load("lib/supabase/server.ts");
  let tables: Record<string, Row[]>;
  let log: Query[];
  let rpcCalls: { name: string; args: Row }[];
  let dbFailure = "";
  function reset() {
    validToken = true;
    dbFailure = "";
    log = [];
    rpcCalls = [];
    process.env.MEDINA_PLATFORM_OWNER_IDS = OTHER;
    tables = {
      staff_users: [
        {
          id: "staff",
          auth_user_id: USER,
          workspace_id: WORKSPACE,
          role: "owner",
          status: "active",
        },
      ],
      growth_operator_profiles: [
        {
          id: OPERATOR,
          auth_user_id: USER,
          display_name: "Оператор",
          status: "approved",
          accepting_requests: true,
        },
      ],
      growth_operator_requests: [
        {
          id: REQUEST,
          workspace_id: WORKSPACE,
          operator_id: OPERATOR,
          status: "requested",
          price_per_arrival_minor: 150000,
          currency: "KZT",
          clinic_brief: "Описание",
          workspaces: { name: "Клиника" },
          growth_operator_profiles: { display_name: "Оператор" },
          secret: "must-not-return",
        },
      ],
    };
  }
  function client() {
    return {
      from(table: string) {
        const entry: Query = { table, filters: {}, op: "select" };
        log.push(entry);
        const builder: Row = {};
        const result = (single: boolean) => {
          if (dbFailure && table !== "staff_users")
            return {
              data: null,
              error: { code: dbFailure, message: "sensitive-db-detail" },
            };
          let rows = (tables[table] ?? []).filter((row) =>
            Object.entries(entry.filters).every(([key, value]) =>
              Array.isArray(value)
                ? value.includes(row[key])
                : row[key] === value,
            ),
          );
          if (entry.op === "insert") rows = [{ id: OPERATOR, ...entry.values }];
          if (entry.op === "update")
            rows = rows.map((row) => ({ ...row, ...entry.values }));
          if (entry.range)
            rows = rows.slice(entry.range[0], entry.range[1] + 1);
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        };
        Object.assign(builder, {
          select: (fields: string) => {
            entry.select = fields;
            return builder;
          },
          order: () => builder,
          range: (start: number, end: number) => {
            entry.range = [start, end];
            return builder;
          },
          limit: () => builder,
          eq: (key: string, value: unknown) => {
            entry.filters[key] = value;
            return builder;
          },
          in: (key: string, value: unknown) => {
            entry.filters[key] = value;
            return builder;
          },
          insert: (value: Row) => {
            entry.op = "insert";
            entry.values = value;
            return builder;
          },
          update: (value: Row) => {
            entry.op = "update";
            entry.values = value;
            return builder;
          },
          maybeSingle: () => Promise.resolve(result(true)),
          single: () => Promise.resolve(result(true)),
          then: (resolve: (value: unknown) => void) => resolve(result(false)),
        });
        return builder;
      },
      rpc(name: string, args: Row) {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: REQUEST, error: null });
      },
    };
  }
  supabase.setSupabaseServerClientFactoryForTests(client);
  const router = await load("api/crm/[...path].ts");
  async function call(
    route: string,
    method = "GET",
    body?: Row,
    token: string | null = "test.payload.signature",
    workspace = WORKSPACE,
  ) {
    const res = {
      statusCode: 0,
      body: {} as Row,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(data: Row) {
        this.body = data;
        return this;
      },
    };
    await router.default(
      {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        query: { path: [route], workspaceId: workspace },
        body,
      },
      res,
    );
    return res;
  }
  try {
    await t.test(
      "no token and invalid token cannot reach operator tables",
      async () => {
        reset();
        for (const route of [
          "operator-account",
          "operator-inbox",
          "operator-directory",
          "clinic-operator-requests",
        ]) {
          assert.equal(
            (await call(route, "GET", undefined, null)).statusCode,
            401,
          );
          validToken = false;
          assert.equal((await call(route)).statusCode, 401);
        }
        assert.equal(log.length, 0);
      },
    );
    await t.test("clinic owner cannot approve operators", async () => {
      reset();
      assert.equal(
        (
          await call("platform-operators", "PATCH", {
            id: OPERATOR,
            action: "approve",
          })
        ).statusCode,
        404,
      );
      assert.equal(log.length, 0);
    });
    await t.test(
      "platform approval uses verified approver and leaves operator unavailable",
      async () => {
        reset();
        process.env.MEDINA_PLATFORM_OWNER_IDS = USER;
        tables.growth_operator_profiles[0].status = "pending";
        assert.equal(
          (
            await call("platform-operators", "PATCH", {
              id: OPERATOR,
              action: "approve",
              approved_by: OTHER,
            })
          ).statusCode,
          200,
        );
        const write = log.find((row) => row.op === "update")!;
        assert.equal(write.values?.approved_by, USER);
        assert.equal(write.values?.accepting_requests, false);
      },
    );
    await t.test(
      "application cannot self-approve or register another identity",
      async () => {
        reset();
        tables.growth_operator_profiles = [];
        const res = await call("operator-account", "POST", {
          displayName: "Новый оператор",
          auth_user_id: OTHER,
          status: "approved",
          accepting_requests: true,
        });
        assert.equal(res.statusCode, 201);
        const write = log.find((row) => row.op === "insert")!;
        assert.deepEqual(write.values, {
          display_name: "Новый оператор",
          auth_user_id: USER,
          status: "pending",
          accepting_requests: false,
        });
      },
    );
    await t.test(
      "pending and suspended accounts cannot become available or read inbox",
      async () => {
        for (const status of ["pending", "suspended"]) {
          reset();
          tables.growth_operator_profiles[0].status = status;
          assert.equal(
            (
              await call("operator-account", "PATCH", {
                acceptingRequests: true,
              })
            ).statusCode,
            403,
          );
          assert.equal((await call("operator-inbox")).statusCode, 403);
          assert.ok(
            !log.some((row) => row.table === "growth_operator_requests"),
          );
        }
      },
    );
    await t.test(
      "directory exposes only approved available profiles and no identity",
      async () => {
        reset();
        tables.growth_operator_profiles.push({
          id: OTHER,
          status: "pending",
          accepting_requests: false,
        });
        const res = await call("operator-directory");
        assert.equal(res.statusCode, 200);
        assert.deepEqual((res.body.data as { items: unknown[] }).items, [
          {
            id: OPERATOR,
            displayName: "Оператор",
            status: "approved",
            acceptingRequests: true,
          },
        ]);
        assert.ok(!JSON.stringify(res.body).includes("auth_user_id"));
      },
    );
    await t.test(
      "foreign workspace and receptionist denied before growth reads",
      async () => {
        reset();
        assert.equal(
          (
            await call(
              "operator-directory",
              "GET",
              undefined,
              undefined,
              FOREIGN,
            )
          ).statusCode,
          403,
        );
        tables.staff_users[0].role = "receptionist";
        assert.equal(
          (
            await call("clinic-operator-requests", "POST", {
              operatorId: OPERATOR,
            })
          ).statusCode,
          403,
        );
        assert.ok(log.every((row) => row.table === "staff_users"));
      },
    );
    await t.test(
      "clinic request identity, currency and initial status are server-owned",
      async () => {
        reset();
        const res = await call("clinic-operator-requests", "POST", {
          operatorId: OPERATOR,
          clinicBrief: "Описание",
          pricePerArrivalMinor: "150000",
          requested_by_staff_user_id: "attacker",
          status: "accepted",
          currency: "USD",
        });
        assert.equal(res.statusCode, 201);
        assert.deepEqual(log.find((row) => row.op === "insert")?.values, {
          workspace_id: WORKSPACE,
          requested_by_staff_user_id: "staff",
          operator_id: OPERATOR,
          clinic_brief: "Описание",
          price_per_arrival_minor: "150000",
          currency: "KZT",
          status: "requested",
        });
      },
    );
    await t.test(
      "unsafe and malformed amounts rejected before insert",
      async () => {
        reset();
        for (const amount of ["1.5", "-1", "NaN", "9007199254740992", ""])
          assert.equal(
            (
              await call("clinic-operator-requests", "POST", {
                operatorId: OPERATOR,
                clinicBrief: "Описание",
                pricePerArrivalMinor: amount,
              })
            ).statusCode,
            400,
          );
        assert.ok(!log.some((row) => row.op === "insert"));
      },
    );
    await t.test(
      "inbox restricted to self even with forged workspace selector",
      async () => {
        reset();
        tables.staff_users = [];
        const res = await call(
          "operator-inbox",
          "GET",
          undefined,
          undefined,
          FOREIGN,
        );
        assert.equal(res.statusCode, 200);
        const query = log.find(
          (row) => row.table === "growth_operator_requests",
        )!;
        assert.equal(query.filters.operator_id, OPERATOR);
        assert.ok(!JSON.stringify(res.body).includes("must-not-return"));
        assert.ok(!JSON.stringify(res.body).includes("workspace_id"));
      },
    );
    await t.test(
      "accept only uses verified identity and atomic RPC",
      async () => {
        reset();
        assert.equal(
          (
            await call("operator-inbox", "PATCH", {
              id: REQUEST,
              action: "accept",
              p_operator_user_id: OTHER,
            })
          ).statusCode,
          200,
        );
        assert.deepEqual(rpcCalls, [
          {
            name: "accept_growth_operator_request",
            args: { p_request_id: REQUEST, p_operator_user_id: USER },
          },
        ]);
        assert.ok(
          !log.some((row) =>
            ["staff_users", "meta_campaign_launches"].includes(row.table),
          ),
        );
      },
    );
    await t.test("foreign operator request never reaches RPC", async () => {
      reset();
      tables.growth_operator_requests[0].operator_id = OTHER;
      assert.equal(
        (
          await call("operator-inbox", "PATCH", {
            id: REQUEST,
            action: "accept",
          })
        ).statusCode,
        404,
      );
      assert.equal(rpcCalls.length, 0);
    });
    await t.test(
      "clinic withdrawal cannot modify a different workspace",
      async () => {
        reset();
        tables.growth_operator_requests[0].workspace_id = FOREIGN;
        assert.equal(
          (
            await call("clinic-operator-requests", "PATCH", {
              id: REQUEST,
              action: "withdraw",
            })
          ).statusCode,
          409,
        );
        assert.equal(
          log.find((row) => row.op === "update")?.filters.workspace_id,
          WORKSPACE,
        );
      },
    );
    await t.test(
      "end only updates accepted state; no price or approval writes",
      async () => {
        reset();
        tables.growth_operator_requests[0].status = "accepted";
        assert.equal(
          (
            await call("operator-inbox", "PATCH", {
              id: REQUEST,
              action: "end",
              price_per_arrival_minor: 0,
            })
          ).statusCode,
          200,
        );
        const write = log.find((row) => row.op === "update")!;
        assert.equal(write.filters.status, "accepted");
        assert.deepEqual(Object.keys(write.values!).sort(), [
          "ended_at",
          "status",
        ]);
      },
    );
    await t.test(
      "missing migration is honest 503 without raw database details",
      async () => {
        reset();
        dbFailure = "PGRST205";
        const res = await call("operator-account");
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, "operators_not_provisioned");
        assert.ok(!JSON.stringify(res.body).includes("sensitive-db-detail"));
      },
    );
    await t.test(
      "list has bounded pagination and explicit more flag",
      async () => {
        reset();
        tables.growth_operator_profiles = Array.from(
          { length: 21 },
          (_, index) => ({
            id: String(index),
            status: "approved",
            accepting_requests: true,
          }),
        );
        const res = await call("operator-directory");
        assert.equal((res.body.data as { hasMore: boolean }).hasMore, true);
        assert.equal((res.body.data as { items: unknown[] }).items.length, 20);
        assert.deepEqual(
          log.find((row) => row.table === "growth_operator_profiles")?.range,
          [0, 20],
        );
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
    supabase.setSupabaseServerClientFactoryForTests(null);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("operator agreed KZT prices roundtrip without float arithmetic", async () => {
  const { arrivalPriceToMinor, formatArrivalPrice } = await load(
    "lib/crm/operator-contracts.ts",
  );
  assert.equal(arrivalPriceToMinor("1500,50"), "150050");
  assert.equal(arrivalPriceToMinor("0"), "0");
  for (const input of ["", "-1", "1.001", "Infinity", "1e4"])
    assert.equal(arrivalPriceToMinor(input), null);
  assert.match(formatArrivalPrice("150050", "KZT"), /1\s500,50 ₸/);
});

test("operator entry, clinic and platform controls stay distinct", async () => {
  const read = (name: string) => readFile(path.join(root, name), "utf8");
  assert.match(
    await read("artifacts/negis/src/App.tsx"),
    /path="\/operator" component=\{OperatorPortal\}/,
  );
  assert.match(
    await read("artifacts/negis/src/pages/OperatorPortal.tsx"),
    /Принимаю предложения клиник/,
  );
  assert.match(
    await read("artifacts/negis/src/pages/AdminCenter.tsx"),
    /ClinicOperators key=\{workspaceId\}/,
  );
  assert.match(
    await read("artifacts/medina-control/src/screens/Operators.tsx"),
    /platform-operators/,
  );
  const backend = await read("lib/crm/operators.ts");
  assert.doesNotMatch(
    backend,
    /localStorage|launchMeta|meta_campaign_launches|from\("clients"\)|from\("leads"\)/,
  );
  assert.match(backend, /accept_growth_operator_request/);
});

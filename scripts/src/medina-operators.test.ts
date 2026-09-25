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
const LEAD = "55555555-5555-4555-8555-555555555555";
const STAGE = "66666666-6666-4666-8666-666666666666";
type Row = Record<string, unknown>;
type Query = {
  table: string;
  filters: Row;
  op: string;
  values?: Row;
  range?: number[];
  select?: string;
  or?: string;
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
  let dbFailureTable = "";
  let rpcData: unknown;
  let rpcFailure = "";
  let rpcMessage = "private-db-detail";
  let pipelineMissing = false;
  function reset() {
    validToken = true;
    dbFailure = "";
    dbFailureTable = "";
    rpcFailure = "";
    rpcMessage = "private-db-detail";
    pipelineMissing = false;
    rpcData = REQUEST;
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
          lead_scope: "assigned",
          clinic_brief: "Описание",
          workspaces: { name: "Клиника" },
          growth_operator_profiles: { display_name: "Оператор" },
          secret: "must-not-return",
        },
      ],
      leads: [{ id: LEAD, workspace_id: WORKSPACE, full_name: "Тестовая заявка", phone: "fixture-phone", notes: "private-notes" }],
      growth_operator_lead_assignments: [],
    };
  }
  function client() {
    return {
      from(table: string) {
        const entry: Query = { table, filters: {}, op: "select" };
        log.push(entry);
        const builder: Row = {};
        const result = (single: boolean) => {
          if (dbFailure && table !== "staff_users" && (!dbFailureTable || dbFailureTable === table))
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
          if (entry.or) {
            const match = /^doctor_id\.eq\.([\w-]+),doctor_id\.is\.null$/.exec(entry.or);
            assert.ok(match, "only expected catalog OR filter is supported");
            rows = rows.filter((row) => row.doctor_id === match[1] || row.doctor_id === null);
          }
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
          or: (filter: string) => { entry.or = filter; return builder; },
          range: (start: number, end: number) => {
            entry.range = [start, end];
            return builder;
          },
          limit: () => builder,
          ilike: () => builder,
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
        if (pipelineMissing && name === "read_growth_operator_lead_pipeline")
          return Promise.resolve({data:null,error:{code:"PGRST202",message:"private-db-detail"}});
        return Promise.resolve({ data: rpcData, error: rpcFailure ? { code: rpcFailure, message: rpcMessage } : null });
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
    query: Row = {},
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
        query: { path: [route], workspaceId: workspace, ...query },
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
          "operator-services",
          "operator-bookings",
          "operator-directory",
          "clinic-operator-requests",
          "operator-leads",
          "clinic-operator-leads",
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
          lead_scope: "assigned",
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
    await t.test("clinic chooses either scope, never an unknown or array scope", async () => {
      for (const scope of ["assigned", "clinic", "all", ["clinic"]]) {
        reset();
        const res = await call("clinic-operator-requests", "POST", {
          operatorId: OPERATOR, clinicBrief: "Описание", pricePerArrivalMinor: "150000", leadScope: scope,
        });
        assert.equal(res.statusCode, typeof scope === "string" && scope !== "all" ? 201 : 400);
        if (res.statusCode === 201) assert.equal(log.find(r => r.op === "insert")?.values?.lead_scope, scope);
      }
    });
    await t.test("operator leads use only verified identity and agreement, never supplied workspace or user", async () => {
      reset(); tables.staff_users = [];
      rpcData = {items: [{ id: LEAD, full_name: "Заявка", phone: "fixture-phone", status:" Новая ", stage_id: STAGE, stage_name:"Новая", notes: "private-notes", auth_user_id: OTHER }], stages:[{id:STAGE,name:"Новая",workspace_id:OTHER,secret:"private-notes"}]};
      const res = await call("operator-leads", "GET", { userId: OTHER }, undefined, FOREIGN, { requestId: REQUEST });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(rpcCalls, [{ name: "read_growth_operator_lead_pipeline", args: { p_request_id: REQUEST, p_operator_user_id: USER, p_offset: 0 } }]);
      assert.equal(log.length, 0);
      assert.ok(!JSON.stringify(res.body).includes("private-notes"));
      assert.ok(!JSON.stringify(res.body).includes(OTHER));
      assert.equal((res.body.data as {items: Row[]}).items[0].name, "Заявка");
      assert.equal((res.body.data as {items: Row[]}).items[0].status, " Новая ");
      assert.equal((res.body.data as Row).stageEditingAvailable, true);
      assert.deepEqual((res.body.data as Row).stages, [{id:STAGE,name:"Новая"}]);
    });
    await t.test("RPC denial, schema lag, or malformed response never become empty success", async () => {
      for (const [failure, status] of [["P0001", 403], ["PGRST202", 503], ["500", 503]] as const) {
        reset(); rpcFailure = failure;
        const res = await call("operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST });
        assert.equal(res.statusCode, status);
        assert.ok(!JSON.stringify(res.body).includes("private-db-detail"));
      }
      reset(); rpcData = null;
      assert.equal((await call("operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 503);
    });
    await t.test("operator pages are bounded; wrong method, request or offset are refused", async () => {
      reset(); rpcData = { items: Array.from({length: 21}, (_, i) => ({id: String(i)})), stages:[] };
      const res = await call("operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST, offset: "20" });
      assert.equal((res.body.data as {items: Row[]}).items.length, 20);
      assert.equal((res.body.data as {hasMore: boolean}).hasMore, true);
      assert.equal(rpcCalls[0].args.p_offset, 20);
      assert.equal((await call("operator-leads", "DELETE", {})).statusCode, 405);
      assert.equal((await call("operator-leads")).statusCode, 400);
      assert.equal((await call("operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST, offset: "-1" })).statusCode, 400);
    });
    await t.test("missing 056 read RPC keeps 054 read-only, never bypassing access errors", async () => {
      reset(); pipelineMissing = true; rpcData = [{id:LEAD,full_name:"Заявка"}];
      const res = await call("operator-leads","GET",undefined,undefined,WORKSPACE,{requestId:REQUEST});
      assert.equal(res.statusCode,200);
      assert.equal((res.body.data as Row).stageEditingAvailable,false);
      assert.deepEqual((res.body.data as Row).stages,[]);
      assert.deepEqual(rpcCalls.map(r => r.name),["read_growth_operator_lead_pipeline","read_growth_operator_leads"]);
      reset(); rpcFailure = "P0001";
      assert.equal((await call("operator-leads","GET",undefined,undefined,WORKSPACE,{requestId:REQUEST})).statusCode,403);
      assert.equal(rpcCalls.length,1);
    });
    const stageBody = {leadId:LEAD,stageId:STAGE,expectedStageId:null,expectedStatus:"Новая"};
    await t.test("stage write uses token identity, no staff membership, only the narrow RPC", async () => {
      reset(); tables.staff_users=[];
      const res = await call("operator-leads","PATCH",stageBody,undefined,FOREIGN,{requestId:REQUEST});
      assert.equal(res.statusCode,200);
      assert.deepEqual(rpcCalls,[{name:"set_growth_operator_lead_stage",args:{p_request_id:REQUEST,p_operator_user_id:USER,p_lead_id:LEAD,p_stage_id:STAGE,p_expected_stage_id:null,p_expected_status:"Новая"}}]);
      assert.equal(log.length,0);
      assert.deepEqual(res.body,{success:true});
    });
    await t.test("stage write rejects unauthenticated, invalid, extra and forged write fields", async () => {
      reset();
      assert.equal((await call("operator-leads","PATCH",stageBody,null,WORKSPACE,{requestId:REQUEST})).statusCode,401);
      validToken=false;
      assert.equal((await call("operator-leads","PATCH",stageBody,undefined,WORKSPACE,{requestId:REQUEST})).statusCode,401);
      assert.equal(rpcCalls.length,0);
      for (const invalid of [{}, {...stageBody,stageId:"fake"}, {...stageBody,expectedStageId:undefined}, {...stageBody,expectedStatus:null}, {...stageBody,notes:"private"}, {...stageBody,userId:OTHER}, {...stageBody,workspaceId:FOREIGN}, {...stageBody,status:"arbitrary"}]) {
        reset();
        assert.equal((await call("operator-leads","PATCH",invalid,undefined,WORKSPACE,{requestId:REQUEST})).statusCode,400);
        assert.equal(rpcCalls.length,0);
      }
    });
    await t.test("stage write fails safely on conflict, revoked access and unapplied migration", async () => {
      for (const [failure,status] of [["PT409",409],["P0001",403],["PGRST202",503],["500",503]] as const) {
        reset(); rpcFailure=failure;
        const res=await call("operator-leads","PATCH",stageBody,undefined,WORKSPACE,{requestId:REQUEST});
        assert.equal(res.statusCode,status);
        assert.equal(rpcCalls.length,1);
        assert.ok(!JSON.stringify(res.body).includes("private-db-detail"));
        if (failure === "PGRST202") assert.equal(res.body.code,"operator_stage_not_provisioned");
      }
    });
    await t.test("clinic assignment uses verified staff and requires a matching accepted agreement", async () => {
      reset(); tables.growth_operator_requests[0].status = "accepted";
      const res = await call("clinic-operator-leads", "PATCH", { leadId: LEAD, assigned: true, staffId: OTHER }, undefined, WORKSPACE, { requestId: REQUEST });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(rpcCalls, [{ name: "set_growth_operator_lead_assignment", args: { p_request_id: REQUEST, p_lead_id: LEAD, p_staff_id: "staff", p_assigned: true } }]);
      assert.equal(log.find(r => r.table === "growth_operator_requests")?.filters.workspace_id, WORKSPACE);
      for (const state of ["requested", "ended", "declined"]) {
        reset(); tables.growth_operator_requests[0].status = state;
        assert.equal((await call("clinic-operator-leads", "PATCH", { leadId: LEAD, assigned: true }, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 404);
        assert.equal(rpcCalls.length, 0);
      }
    });
    await t.test("clinic cannot assign foreign requests, and whole-clinic scope has no assignment override", async () => {
      reset(); tables.growth_operator_requests[0].status = "accepted";
      tables.growth_operator_requests[0].workspace_id = FOREIGN;
      assert.equal((await call("clinic-operator-leads", "PATCH", { leadId: LEAD, assigned: true }, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 404);
      assert.equal(rpcCalls.length, 0);
      reset(); tables.growth_operator_requests[0].status = "accepted"; tables.growth_operator_requests[0].lead_scope = "clinic";
      assert.equal((await call("clinic-operator-leads", "PATCH", { leadId: LEAD, assigned: true }, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 409);
      assert.equal(rpcCalls.length, 0);
    });
    await t.test("clinic list is scoped, minimal, paged and assignment-read errors are visible", async () => {
      reset(); tables.growth_operator_requests[0].status = "accepted";
      tables.leads.push({id: OTHER, workspace_id: FOREIGN});
      tables.growth_operator_lead_assignments.push({ workspace_id: WORKSPACE, operator_request_id: REQUEST, lead_id: LEAD, assigned: true });
      const res = await call("clinic-operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST });
      assert.equal(res.statusCode, 200);
      const items = (res.body.data as {items: Row[]}).items;
      assert.equal(items.length, 1); assert.equal(items[0].assigned, true);
      assert.ok(!JSON.stringify(res.body).includes("private-notes"));
      assert.equal(log.find(r => r.table === "leads")?.filters.workspace_id, WORKSPACE);
      assert.deepEqual(log.find(r => r.table === "leads")?.range, [0,20]);
      dbFailure = "PGRST205"; dbFailureTable = "growth_operator_lead_assignments";
      const failed = await call("clinic-operator-leads", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST });
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body.code, "operator_leads_not_provisioned");
      assert.equal(failed.body.data, undefined);
      assert.ok(!JSON.stringify(failed.body).includes("sensitive-db-detail"));
    });
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
    await t.test("operator catalog is tenant scoped, read-only and master specific", async () => {
      reset();
      tables.growth_operator_requests[0].status = "accepted";
      tables.clinic_doctors = [
        { id: LEAD, workspace_id: WORKSPACE, is_active: true, full_name: "Лаура", specialty: "Ресницы", staff_user_id: "private-staff" },
        { id: STAGE, workspace_id: FOREIGN, is_active: true, full_name: "Чужой" },
        { id: OTHER, workspace_id: WORKSPACE, is_active: false, full_name: "Архив" },
      ];
      tables.clinic_services = [
        { id: "own", workspace_id: WORKSPACE, doctor_id: LEAD, is_active: true, name: "Ресницы", base_price_minor: "1200000", duration_minutes: 90, notes: "private-note" },
        { id: "shared", workspace_id: WORKSPACE, doctor_id: null, is_active: true, name: "Консультация", base_price_minor: "0", duration_minutes: null },
        { id: "unknown", workspace_id: WORKSPACE, doctor_id: LEAD, is_active: true, name: "Без цены", base_price_minor: null, duration_minutes: 30 },
        { id: "other-master", workspace_id: WORKSPACE, doctor_id: OTHER, is_active: true },
        { id: "foreign", workspace_id: FOREIGN, doctor_id: LEAD, is_active: true },
        { id: "archived", workspace_id: WORKSPACE, doctor_id: LEAD, is_active: false },
      ];
      const query = { requestId: REQUEST };
      const doctors = await call("operator-services", "GET", undefined, undefined, FOREIGN, query);
      assert.equal(doctors.statusCode, 200);
      assert.deepEqual(doctors.body.data, { items: [{ id: LEAD, name: "Лаура", specialty: "Ресницы" }], hasMore: false });
      const services = await call("operator-services", "GET", undefined, undefined, FOREIGN, { ...query, doctorId: LEAD });
      assert.equal(services.statusCode, 200);
      assert.deepEqual(services.body.data, { items: [
        { id: "own", name: "Ресницы", priceMinor: "1200000", currency: "KZT", durationMinutes: 90 },
        { id: "shared", name: "Консультация", priceMinor: "0", currency: "KZT", durationMinutes: null },
        { id: "unknown", name: "Без цены", priceMinor: null, currency: "KZT", durationMinutes: 30 },
      ], hasMore: false });
      assert.match(log.find((entry) => entry.table === "clinic_services")?.select || "", /base_price_minor::text/);
      for (const doctorId of [STAGE, OTHER])
        assert.equal((await call("operator-services", "GET", undefined, undefined, WORKSPACE, { ...query, doctorId })).statusCode, 404);
      for (const method of ["POST", "PATCH", "DELETE"])
        assert.equal((await call("operator-services", method, {}, undefined, WORKSPACE, query)).statusCode, 405);
      assert.ok(log.every((entry) => entry.op === "select"));
      assert.equal(rpcCalls.length, 0);
    });
    await t.test("operator catalog rejects revoked, foreign and invalid requests and fails closed", async () => {
      for (const status of ["requested", "declined", "ended"]) {
        reset();
        tables.growth_operator_requests[0].status = status;
        assert.equal((await call("operator-services", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 403);
        assert.ok(!log.some((entry) => entry.table.startsWith("clinic_")));
      }
      reset();
      tables.growth_operator_requests[0].status = "accepted";
      tables.growth_operator_requests[0].operator_id = OTHER;
      assert.equal((await call("operator-services", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 403);
      reset();
      tables.growth_operator_profiles[0].status = "suspended";
      assert.equal((await call("operator-services", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST })).statusCode, 403);
      reset();
      for (const query of [{}, { requestId: [REQUEST] }, { requestId: REQUEST, doctorId: "bad" }, { requestId: REQUEST, offset: "-1" }])
        assert.equal((await call("operator-services", "GET", undefined, undefined, WORKSPACE, query)).statusCode, 400);
      for (const table of ["growth_operator_profiles", "growth_operator_requests", "clinic_doctors", "clinic_services"]) {
        reset();
        tables.growth_operator_requests[0].status = "accepted";
        tables.clinic_doctors = [{ id: LEAD, workspace_id: WORKSPACE, is_active: true }];
        dbFailure = "PGRST205";
        dbFailureTable = table;
        const response = await call("operator-services", "GET", undefined, undefined, WORKSPACE, { requestId: REQUEST, doctorId: LEAD });
        assert.equal(response.statusCode, 503);
        assert.doesNotMatch(JSON.stringify(response.body), /sensitive-db-detail|private/);
      }
    });
    await t.test("operator catalog paginates masters and services without silent truncation", async () => {
      reset();
      tables.growth_operator_requests[0].status = "accepted";
      tables.clinic_doctors = Array.from({ length: 21 }, (_, i) => ({ id: i === 0 ? LEAD : `doctor-${i}`, workspace_id: WORKSPACE, is_active: true, full_name: `Мастер ${i}` }));
      tables.clinic_services = Array.from({ length: 21 }, (_, i) => ({ id: `service-${i}`, workspace_id: WORKSPACE, doctor_id: LEAD, is_active: true, name: `Услуга ${i}`, base_price_minor: "9007199254740993" }));
      for (const doctorQuery of [{}, { doctorId: LEAD }]) {
        const query = { requestId: REQUEST, ...doctorQuery };
        const first = await call("operator-services", "GET", undefined, undefined, WORKSPACE, query);
        assert.equal(first.statusCode, 200);
        assert.equal((first.body.data as { items: Row[] }).items.length, 20);
        assert.equal((first.body.data as Row).hasMore, true);
        const last = await call("operator-services", "GET", undefined, undefined, WORKSPACE, { ...query, offset: "20" });
        assert.equal((last.body.data as { items: Row[] }).items.length, 1);
        assert.equal((last.body.data as Row).hasMore, false);
        if ("doctorId" in doctorQuery)
          assert.equal((last.body.data as { items: Row[] }).items[0].priceMinor, "9007199254740993");
      }
    });
    await t.test("operator booking RPC receives verified identity and IDs only, returns a narrow receipt", async () => {
      reset();
      rpcData = { timeZone: "Asia/Almaty", private: "must-not-return" };
      const query = { requestId: REQUEST, leadId: LEAD };
      const context = await call("operator-bookings", "GET", undefined, undefined, FOREIGN, query);
      assert.equal(context.statusCode,200);
      assert.deepEqual(context.body.data,{timeZone:"Asia/Almaty"});
      const body = {leadId:LEAD,requestKey:STAGE,doctorId:OPERATOR,serviceIds:[OTHER],startsLocal:"2030-01-07T10:00",timeZone:"Asia/Almaty"};
      rpcData = {id:STAGE,startsAt:"2030-01-07T05:00:00Z",priceMinor:"100000",durationMinutes:60,status:"scheduled",service:"Услуга",doctorName:"Мастер",timeZone:"Asia/Almaty",notes:"must-not-return",clientPhone:"private"};
      const created = await call("operator-bookings", "POST", body, undefined, FOREIGN, query);
      assert.equal(created.statusCode,200);
      assert.equal(rpcCalls.at(-1)?.name,"create_growth_operator_booking");
      assert.deepEqual(rpcCalls.at(-1)?.args,{p_request_id:REQUEST,p_operator_user_id:USER,p_lead_id:LEAD,p_request_key:STAGE,p_doctor_id:OPERATOR,p_service_ids:[OTHER],p_starts_local:body.startsLocal,p_time_zone:body.timeZone});
      assert.doesNotMatch(JSON.stringify(created.body),/must-not-return|private|clientPhone/);
      for (const patch of [{priceMinor:1},{clientId:OTHER},{userId:OTHER},{status:"paid"},{serviceIds:[]},{serviceIds:[OTHER,OTHER]},{startsLocal:"2030-02-31T10:00"}]) {
        const count = rpcCalls.length;
        assert.equal((await call("operator-bookings","POST",{...body,...patch},undefined,WORKSPACE,query)).statusCode,400);
        assert.equal(rpcCalls.length,count);
      }
      assert.equal((await call("operator-bookings","POST",body,null,WORKSPACE,query)).statusCode,401);
      validToken=false;
      assert.equal((await call("operator-bookings","POST",body,undefined,WORKSPACE,query)).statusCode,401);
    });
    await t.test("operator booking schema lag, permissions and conflicts have safe errors without fallback writes", async () => {
      for (const [code,message,status] of [
        ["PGRST202","private-db-detail",503], ["P0001","operator_access_denied",403],
        ["P0001","operator_booking_time_taken",409], ["P0001","operator_booking_outside_schedule",409],
        ["P0001","operator_booking_price_required",409], ["42P01","private-db-detail",503],
      ] as const) {
        reset();rpcFailure=code;rpcMessage=message;
        const result=await call("operator-bookings","POST",{leadId:LEAD,requestKey:STAGE,doctorId:OPERATOR,serviceIds:[OTHER],startsLocal:"2030-01-07T10:00",timeZone:"Asia/Almaty"},undefined,WORKSPACE,{requestId:REQUEST});
        assert.equal(result.statusCode,status);
        assert.doesNotMatch(JSON.stringify(result.body),/private-db-detail/);
        assert.equal(log.length,0);
      }
    });
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

test("operator catalog UI is read-only, scoped to accepted operator requests and uncached", async () => {
  const read = (name: string) => readFile(path.join(root, name), "utf8");
  const ui = await read("artifacts/negis/src/components/operators/OperatorServiceCatalog.tsx");
  const requests = await read("artifacts/negis/src/components/operators/OperatorRequests.tsx");
  assert.match(ui, /operator-services\?requestId/);
  assert.match(ui, /doctorId=/);
  assert.match(ui, /Услуги и цены/);
  assert.match(ui, /Цена не указана/);
  assert.match(ui, /Длительность не указана/);
  assert.match(ui, /window.addEventListener\("focus", list.refresh\)/);
  assert.match(ui, /key=\{`\$\{requestId\}:\$\{doctor.id\}`\}/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|<input|operatorApi\(|meta-launch/);
  assert.match(requests, /!workspaceId && item.status === "accepted" && openCatalog === item.id/);
  const server = await read("lib/crm/operator-services.ts");
  assert.doesNotMatch(server, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  assert.match(server, /requireAuthenticatedUser/);
});

test("operator booking UI submits only catalog IDs, retains retry key and handles access denial", async () => {
  const ui = await readFile(path.join(root,"artifacts/negis/src/components/operators/OperatorBookingForm.tsx"),"utf8");
  assert.match(ui,/useState\(\(\) => crypto.randomUUID\(\)\)/);
  assert.match(ui,/serviceIds: selected.map/);
  assert.match(ui,/OperatorApiError/);
  assert.match(ui,/onAccessDenied\(\)/);
  assert.match(ui,/Дата и время клиники/);
  assert.match(ui,/Создать запись/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|type="number"|clientId:|priceMinor:/);
  const backend = await readFile(path.join(root,"lib/crm/operator-bookings.ts"),"utf8");
  assert.match(backend,/requireAuthenticatedUser/);
  assert.match(backend,/create_growth_operator_booking/);
  assert.doesNotMatch(backend,/\.insert\(|\.update\(|handleCrmCreate|role: "owner"/);
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

test("operator contact UI uses explicit scope and guarded stage writes without general CRM editing", async () => {
  const read = (name: string) => readFile(path.join(root, name), "utf8");
  const clinic = await read("artifacts/negis/src/components/admin/ClinicOperators.tsx");
  const requests = await read("artifacts/negis/src/components/operators/OperatorRequests.tsx");
  const leads = await read("artifacts/negis/src/components/operators/OperatorLeads.tsx");
  assert.match(clinic, /useState<OperatorLeadScope>\("assigned"\)/);
  assert.match(clinic, /value="assigned"/);
  assert.match(clinic, /value="clinic"/);
  assert.match(requests, /status === "accepted"/);
  assert.match(requests, /operatorLeadScopeLabels/);
  assert.match(leads, /clinic-operator-leads/);
  assert.match(leads, /operator-leads\?requestId/);
  assert.match(leads, /leadScope === "assigned"/);
  assert.match(leads, /key=\{`\$\{requestId\}/);
  assert.match(leads, /window.addEventListener\("focus", refresh\)/);
  assert.doesNotMatch(leads, /localStorage|sessionStorage|medicalHistory|notes|meta-launch|appointments|responsible_user_id/);
  assert.match(leads, /Доступен только просмотр/);
  assert.match(leads, /stageEditingAvailable/);
  assert.match(leads, /expectedStageId: item.stageId/);
  assert.match(leads, /expectedStatus: item.status/);
  assert.match(leads, /Сохранить стадию/);
  assert.match(leads, /!clinic &&\s+list.data\?\.stageEditingAvailable/);
  const backend = await read("lib/crm/operator-leads.ts");
  assert.match(backend, /set_growth_operator_lead_stage/);
  assert.doesNotMatch(backend, /\.update\(|\.insert\(|localStorage|launchMeta/);
});

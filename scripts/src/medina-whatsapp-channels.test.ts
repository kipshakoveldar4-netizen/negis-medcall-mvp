import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// WC — the clinic's own view of its WhatsApp connection.
//
// One route unions two provider tables (wazzup_channels from 026,
// whatsapp_cloud_numbers from 027) so a clinic sees "our WhatsApp" rather than
// our implementation history. That makes it a tenancy surface: it reads the
// very tables the webhooks trust to decide which workspace an inbound message
// belongs to, and it can switch one off.
//
// These tests drive the real router — authorization included — with a spying
// database client. Nothing here touches production, and every fixture is
// fictional.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ROW_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "header.payload.signature";

type QueryLog = {
  table: string;
  op: string;
  filters: Record<string, unknown>;
  row?: unknown;
  /** An aggregate read: PostgREST returns a count and no rows. */
  head?: boolean;
  ordered?: string;
  limited?: number;
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

type LoadOptions = {
  rows?: Record<string, unknown[]>;
  /** Tables that answer "relation does not exist" — a provider not provisioned. */
  missingTables?: string[];
  errors?: Record<string, string>;
  role?: string;
};

function membershipFor(role: string) {
  return { id: "staff-a", workspace_id: WORKSPACE_A, role, status: "active" };
}

async function loadRouter(options: LoadOptions = {}) {
  const log: QueryLog[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

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
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const settle = (shape: "one" | "list") => {
        if (options.missingTables?.includes(table)) {
          // The shape hosted Supabase actually returns: PostgREST answers a
          // table that is not in its schema cache itself, without reaching
          // Postgres — HTTP 404, code PGRST205, no 42P01 and no "does not
          // exist". Pinning the Postgres shape instead is what let the first
          // version of this route pass its tests while failing in production.
          return Promise.resolve({
            data: null,
            count: null,
            error: {
              code: "PGRST205",
              details: null,
              hint: null,
              message: `Could not find the table 'public.${table}' in the schema cache`,
            },
          });
        }
        const message = options.errors?.[table];
        if (message) return Promise.resolve({ data: null, count: null, error: { code: "08006", message } });
        const rows =
          table === "staff_users"
            ? [membershipFor(options.role ?? "owner")]
            : options.rows?.[table] ?? [];
        // Only columns the fixture row actually carries are matched, so a
        // fixture may stay minimal without silently filtering itself out.
        const matches = (row: unknown) => {
          const record = row as Record<string, unknown>;
          return Object.entries(entry.filters).every(([column, value]) =>
            column.includes(":") || !(column in record) ? true : record[column] === value,
          );
        };

        // Aggregate reads (head: true) answer with a count and no body.
        if (entry.head) {
          return Promise.resolve({ data: null, error: null, count: rows.filter(matches).length });
        }

        // An update ... select() returns the rows AS THEY NOW ARE, which is
        // what the caller reports back. Returning the pre-update fixture would
        // let a handler that writes nothing still look correct.
        if (entry.op === "update") {
          const updated = rows
            .filter(matches)
            .map((row) => ({ ...(row as Record<string, unknown>), ...(entry.row as Record<string, unknown>) }));
          return Promise.resolve({ data: updated, error: null, count: updated.length });
        }

        const visible = rows.filter(matches);
        return Promise.resolve(
          shape === "list"
            ? { data: visible, error: null, count: visible.length }
            : { data: visible[0] ?? null, error: null },
        );
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (_columns?: unknown, options?: { count?: string; head?: boolean }) => {
          if (options?.head) entry.head = true;
          return builder;
        },
        insert: (row: unknown) => { entry.op = "insert"; entry.row = row; return builder; },
        update: (row: unknown) => { entry.op = "update"; entry.row = row; return builder; },
        order: (column: string, options?: { ascending?: boolean }) => {
          entry.ordered = `${column}:${options?.ascending === false ? "desc" : "asc"}`;
          return builder;
        },
        limit: (value: number) => { entry.limited = value; return builder; },
        eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
        in(column: string, value: unknown) { entry.filters[column] = value; return builder; },
        is: () => builder,
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

  const call = async (input: { method?: string; body?: unknown; query?: Record<string, unknown> }) => {
    log.length = 0;
    warnings.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: ["whatsapp-channels"], ...(input.query ?? {}) },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log], warnings: [...warnings] };
  };

  return {
    call,
    restore: () => {
      console.warn = originalWarn;
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

const wazzupChannel = {
  id: CHANNEL_ROW_A,
  workspace_id: WORKSPACE_A,
  channel_id: "339a18e7-0000-4000-8000-00000000abcd",
  enabled: true,
  created_at: "2026-08-01T10:00:00.000Z",
};

function channelsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = (body.data ?? {}) as Record<string, unknown>;
  return Array.isArray(data.channels) ? (data.channels as Array<Record<string, unknown>>) : [];
}

// ===========================================================================
// A. What the clinic sees
// ===========================================================================

test("WC1 both providers are unioned into one list the clinic can read", async () => {
  await withRouter({
    rows: {
      wazzup_channels: [wazzupChannel],
      whatsapp_cloud_numbers: [{
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        workspace_id: WORKSPACE_A,
        phone_number_id: "111000111000111",
        enabled: true,
        created_at: "2026-08-03T10:00:00.000Z",
      }],
      wazzup_inbound_messages: [],
      whatsapp_cloud_inbound_messages: [],
    },
  }, async (ctx) => {
    const { res } = await ctx.call({});

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const channels = channelsOf(res.body);
    assert.deepEqual(channels.map((c) => c.provider).sort(), ["wazzup", "whatsapp_cloud"]);
  });
});

test("WC2 activity is counted, never quoted — no ledger row reaches the caller", async () => {
  await withRouter({
    rows: {
      wazzup_channels: [wazzupChannel],
      whatsapp_cloud_numbers: [],
      wazzup_inbound_messages: [
        { channel_id: wazzupChannel.channel_id, kind: "created", received_at: "2026-08-01T11:00:00.000Z", lead_id: "lead-1" },
        { channel_id: wazzupChannel.channel_id, kind: "repeat", received_at: "2026-08-02T12:00:00.000Z", lead_id: "lead-1" },
        // Another channel's row must not be counted into this one.
        { channel_id: "another-channel", kind: "created", received_at: "2026-08-02T13:00:00.000Z" },
      ],
      whatsapp_cloud_inbound_messages: [],
    },
  }, async (ctx) => {
    const { res, log } = await ctx.call({});

    const channel = channelsOf(res.body)[0];
    assert.ok(channel, "the channel must be listed");
    assert.equal(channel.leadsFiled, 1);
    assert.equal(channel.repeatsSeen, 1);

    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes("lead-1"), false, "ledger rows are counted, not returned");
    assert.equal(serialized.includes("message_id"), false);

    // Counted by the database, not tallied in code from an unbounded read.
    const ledgerReads = log.filter((entry) => entry.table === "wazzup_inbound_messages");
    assert.ok(ledgerReads.length > 0, "the ledger must be consulted");
    for (const read of ledgerReads) {
      assert.equal(read.filters.channel_id, wazzupChannel.channel_id, "each read is scoped to this channel");
      assert.ok(
        read.head === true || typeof read.limited === "number",
        "every ledger read is either an aggregate or a bounded one — never an open scan",
      );
    }
  });
});

test("WC2b the last inbound is the newest, asked of the database in order", async () => {
  // The first version sorted ISO strings from an unbounded, unordered read.
  // The fixture is deliberately out of order: a query that does not order
  // would hand back the first row and be wrong.
  await withRouter({
    rows: {
      wazzup_channels: [wazzupChannel],
      whatsapp_cloud_numbers: [],
      wazzup_inbound_messages: [
        { channel_id: wazzupChannel.channel_id, kind: "created", received_at: "2026-08-03T09:00:00.000Z" },
        { channel_id: wazzupChannel.channel_id, kind: "repeat", received_at: "2026-08-01T08:00:00.000Z" },
      ],
      whatsapp_cloud_inbound_messages: [],
    },
  }, async (ctx) => {
    const { res, log } = await ctx.call({});

    const lastRead = log.find((entry) => entry.table === "wazzup_inbound_messages" && entry.ordered);
    assert.ok(lastRead, "the last-inbound read must order");
    assert.equal(lastRead.ordered, "received_at:desc", "newest first");
    assert.equal(lastRead.limited, 1, "and one row is enough");

    const channel = channelsOf(res.body)[0];
    assert.equal(channel.lastInboundAt, "2026-08-03T09:00:00.000Z");
  });
});

test("WC3 the channel key is masked — the operator recognises it, nothing more", async () => {
  await withRouter({
    rows: { wazzup_channels: [wazzupChannel], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    const { res } = await ctx.call({});
    const channel = channelsOf(res.body)[0];
    assert.equal(channel.keyMasked, "…abcd");
    assert.equal(JSON.stringify(res.body).includes(wazzupChannel.channel_id), false, "the full key is not published");
  });
});

// ===========================================================================
// B. Tenancy
// ===========================================================================

test("WC4 every read is filtered by the verified workspace", async () => {
  await withRouter({
    rows: { wazzup_channels: [wazzupChannel], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    const { res, log } = await ctx.call({});
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const tenantQueries = log.filter((entry) => entry.table !== "staff_users" && entry.table !== "workspaces");
    assert.ok(tenantQueries.length > 0, "the handler must query something");
    for (const entry of tenantQueries) {
      assert.equal(entry.filters.workspace_id, WORKSPACE_A, `${entry.table} must be scoped to the verified workspace`);
    }
  });
});

test("WC4b naming another workspace in the request is refused, not quietly ignored", async () => {
  // The router resolves the tenant before dispatching, so a request that asks
  // for a workspace the caller is not a member of never reaches this handler.
  // Pinned here because the guarantee is what makes WC4's scoping meaningful.
  await withRouter({
    rows: { wazzup_channels: [wazzupChannel], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    const { res, log } = await ctx.call({ query: { workspaceId: WORKSPACE_B } });

    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
    assert.equal(
      log.some((entry) => entry.table === "wazzup_channels" || entry.table === "whatsapp_cloud_numbers"),
      false,
      "no tenancy table may be read for a workspace the caller does not belong to",
    );
    assert.equal(JSON.stringify(res.body).includes(WORKSPACE_B), false, "and the answer discloses nothing about it");
  });
});

test("WC5 the switch cannot reach another clinic's channel", async () => {
  await withRouter({
    rows: { wazzup_channels: [], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    const { res, log } = await ctx.call({
      method: "PATCH",
      body: { id: CHANNEL_ROW_A, provider: "wazzup", enabled: false, workspaceId: WORKSPACE_B },
    });

    const update = log.find((entry) => entry.op === "update");
    assert.ok(update, "the update must run");
    assert.equal(update.filters.workspace_id, WORKSPACE_A, "the tenant filter is unconditional");
    assert.equal(update.filters.id, CHANNEL_ROW_A);
    // No row matched, because the fixture has none in this workspace.
    assert.equal(res.statusCode, 404, "an id from another clinic is simply not found");
    assert.equal(JSON.stringify(res.body).includes(WORKSPACE_B), false);
  });
});

test("WC5b a switch inside the clinic writes exactly what it claims to write", async () => {
  // WC5 proves the update cannot reach another clinic. Nothing proved the
  // successful path: what column is written, with what value, and what the
  // caller is told. A route whose PATCH silently wrote nothing would have
  // passed the whole suite.
  await withRouter({
    rows: {
      wazzup_channels: [{ ...wazzupChannel, enabled: false }],
      whatsapp_cloud_numbers: [],
      wazzup_inbound_messages: [],
      whatsapp_cloud_inbound_messages: [],
    },
  }, async (ctx) => {
    const { res, log } = await ctx.call({
      method: "PATCH",
      body: { id: CHANNEL_ROW_A, provider: "wazzup", enabled: true },
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const update = log.find((entry) => entry.op === "update");
    assert.ok(update, "the update must run");
    assert.equal(update.table, "wazzup_channels", "the provider decides the table, not the request");

    const written = update.row as Record<string, unknown>;
    assert.equal(written.enabled, true, "the flag the caller asked for");
    assert.ok(typeof written.updated_at === "string", "and a fresh updated_at");
    assert.equal(Object.keys(written).sort().join(","), "enabled,updated_at", "nothing else may be written");

    const data = res.body.data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    assert.equal(item.id, CHANNEL_ROW_A);
    assert.equal(item.enabled, true, "the caller is told the state the database now holds");
  });
});

test("WC6 a non-administrator is refused before any query runs", async () => {
  await withRouter({
    role: "receptionist",
    rows: { wazzup_channels: [wazzupChannel], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    const { res, log } = await ctx.call({});

    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
    assert.equal(
      log.some((entry) => entry.table === "wazzup_channels"),
      false,
      "authorization must come before the tenancy tables are touched",
    );
  });
});

// ===========================================================================
// C. Degrading without lying
// ===========================================================================

test("WC7 a provider whose migration is not applied reads as unavailable, not as an error", async () => {
  // Production runs ahead of hand-applied migrations here by design: 027 may
  // not exist yet. A clinic opening its settings must still see its working
  // Wazzup channel rather than a failure.
  await withRouter({
    rows: { wazzup_channels: [wazzupChannel], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
    missingTables: ["whatsapp_cloud_numbers"],
  }, async (ctx) => {
    const { res } = await ctx.call({});

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const channels = channelsOf(res.body);
    assert.deepEqual(channels.map((c) => c.provider), ["wazzup"], "the working provider still lists");

    const data = res.body.data as Record<string, unknown>;
    const providers = data.providers as Array<Record<string, unknown>>;
    const cloud = providers.find((entry) => entry.provider === "whatsapp_cloud");
    assert.equal(cloud?.available, false, "and the missing one is reported as not provisioned");
  });
});

test("WC8 a real database failure is a 502, not an empty clinic", async () => {
  await withRouter({
    rows: { whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
    errors: { wazzup_channels: "connection refused" },
  }, async (ctx) => {
    const { res, warnings } = await ctx.call({});

    assert.equal(res.statusCode, 502, "an empty list would read as 'nothing connected'");
    assert.equal(res.body.success, false);
    assert.equal(
      JSON.stringify(res.body).includes("connection refused"),
      false,
      "the database's own words stay in the operator log",
    );
    assert.ok(warnings.join("\n").includes("whatsapp-channels"), "and the operator still gets the scope");
  });
});

test("WC9 a malformed switch request is refused without touching the database", async () => {
  await withRouter({
    rows: { wazzup_channels: [wazzupChannel], whatsapp_cloud_numbers: [], wazzup_inbound_messages: [], whatsapp_cloud_inbound_messages: [] },
  }, async (ctx) => {
    for (const body of [
      { id: CHANNEL_ROW_A, provider: "wazzup" },
      { id: "not-a-uuid", provider: "wazzup", enabled: false },
      { id: CHANNEL_ROW_A, provider: "telegram", enabled: false },
      { id: CHANNEL_ROW_A, provider: "wazzup", enabled: "false" },
    ]) {
      const { res, log } = await ctx.call({ method: "PATCH", body });
      assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must be refused`);
      assert.equal(log.some((entry) => entry.op === "update"), false, "nothing may be written");
    }
  });
});

test("WC10 an unsupported method is refused", async () => {
  await withRouter({ rows: {} }, async (ctx) => {
    const { res } = await ctx.call({ method: "DELETE" });
    assert.equal(res.statusCode, 405);
  });
});

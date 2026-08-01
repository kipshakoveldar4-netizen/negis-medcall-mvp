import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Wazzup inbound webhook — phase 1: an inbound WhatsApp message becomes a lead
// in the workspace that owns the channel.
//
// These tests drive the real handler with a spying database. Every phone,
// name and message text below is fictional; nothing here touches production
// or the network.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL_A = "c04a11e1-0000-4000-8000-000000000001";
const MESSAGE_1 = "0e000000-0000-4000-8000-000000000001";
const SECRET = "test-webhook-secret";

type QueryLog = { table: string; op: string; filters: Record<string, unknown>; row?: unknown };

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

type SpyOptions = {
  rows?: Record<string, unknown[]>;
  errors?: Record<string, string>;
};

function spyClient(options: SpyOptions, log: QueryLog[]) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const settle = (shape: "one" | "list") => {
        const message = options.errors?.[table];
        if (message) return Promise.resolve({ data: null, error: { message } });
        const rows = options.rows?.[table] ?? [];
        if (shape === "list") return Promise.resolve({ data: rows, error: null });
        if (entry.op === "insert" && rows.length === 0) {
          const row = { id: "11111111-1111-4111-8111-111111111199", ...(entry.row as object) };
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        insert: (row: unknown) => { entry.op = "insert"; entry.row = row; return builder; },
        eq(column: string, value: unknown) { entry.filters[column] = value; return builder; },
        neq(column: string, value: unknown) { entry.filters[`neq:${column}`] = value; return builder; },
        not(column: string, op: string) { entry.filters[`not:${column}`] = op; return builder; },
        limit: () => builder,
        single: () => settle("one"),
        maybeSingle: () => settle("one"),
        then(onFulfilled: (value: unknown) => unknown) {
          if (entry.op === "insert") {
            const message = options.errors?.[table];
            return Promise.resolve(message ? { data: null, error: { message } } : { data: null, error: null }).then(onFulfilled);
          }
          return settle("list").then(onFulfilled);
        },
      });
      return builder;
    },
  };
}

async function loadHandler(options: SpyOptions = {}, env: { secret?: string | null } = {}) {
  const log: QueryLog[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

  if (env.secret === null) delete process.env.WAZZUP_WEBHOOK_SECRET;
  else process.env.WAZZUP_WEBHOOK_SECRET = env.secret ?? SECRET;
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  let clientCreations = 0;
  supabaseModule.setSupabaseServerClientFactoryForTests(() => {
    clientCreations += 1;
    if (options.rows === undefined && options.errors === undefined) return null;
    return spyClient(options, log);
  });

  const module = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "wazzup", "webhook.ts")).href
  )) as { handleWazzupWebhook: (req: unknown, res: MockResponse) => Promise<unknown> };

  const call = async (input: {
    method?: string;
    body?: unknown;
    secret?: string | null;
    bearer?: string;
  }) => {
    log.length = 0;
    warnings.length = 0;
    const res = mockResponse();
    const headers: Record<string, string> = {};
    if (input.bearer) headers.authorization = `Bearer ${input.bearer}`;
    const query: Record<string, string> = {};
    if (input.secret !== null && input.secret !== undefined) query.secret = input.secret;
    await module.handleWazzupWebhook(
      { method: input.method ?? "POST", headers, query, body: input.body },
      res,
    );
    return { res, log: [...log], warnings: [...warnings] };
  };

  return {
    call,
    get clientCreations() { return clientCreations; },
    restore: () => {
      console.warn = originalWarn;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
    },
  };
}

async function withHandler<T>(
  options: SpyOptions,
  env: { secret?: string | null },
  fn: (ctx: Awaited<ReturnType<typeof loadHandler>>) => Promise<T>,
): Promise<T> {
  const ctx = await loadHandler(options, env);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

const channelRow = { workspace_id: WORKSPACE_A, enabled: true };

function inboundMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: MESSAGE_1,
    channelId: CHANNEL_A,
    chatType: "whatsapp",
    chatId: "77010000001",
    status: "inbound",
    isEcho: false,
    type: "text",
    text: "Здравствуйте, хочу записаться на консультацию",
    contact: { name: "Тестовый Пациент" },
    ...overrides,
  };
}

function leadInserts(log: QueryLog[]): QueryLog[] {
  return log.filter((entry) => entry.table === "leads" && entry.op === "insert");
}

// ===========================================================================
// A. The door
// ===========================================================================

test("WZ1 anything but POST is refused", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res } = await ctx.call({ method: "GET", secret: SECRET });
    assert.equal(res.statusCode, 405);
  });
});

test("WZ2 a wrong secret is a generic 401 and the database is never touched", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res, log } = await ctx.call({ secret: "wrong", body: { messages: [inboundMessage()] } });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.stringify(res.body).includes("secret"), false, "the reason must not name the mechanism");
    assert.equal(log.length, 0, "no query may run before authentication");
    assert.equal(ctx.clientCreations, 0, "no service-role client before authentication");
  });
});

test("WZ3 an unconfigured webhook fails closed with 503", async () => {
  await withHandler({ rows: {} }, { secret: null }, async (ctx) => {
    const { res } = await ctx.call({ secret: "anything", body: { test: true } });
    assert.equal(res.statusCode, 503, "Wazzup keeps retrying while the operator fixes the env");
  });
});

test("WZ4 the subscription test request gets its 200", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res, log } = await ctx.call({ secret: SECRET, body: { test: true } });
    assert.equal(res.statusCode, 200);
    assert.equal(log.length, 0, "the test request needs no database");
  });
});

test("WZ5 the secret is honoured from the Authorization header too", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res } = await ctx.call({ secret: null, bearer: SECRET, body: { test: true } });
    assert.equal(res.statusCode, 200);
  });
});

test("WZ6 a database outage answers 503 so Wazzup retries", async () => {
  // Factory returns null — the configured-but-unreachable shape.
  await withHandler({}, {}, async (ctx) => {
    const { res } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
    assert.equal(res.statusCode, 503);
  });
});

// ===========================================================================
// B. Tenancy and the lead
// ===========================================================================

test("WZ7 an unknown channel is acknowledged and ignored, without disclosure", async () => {
  await withHandler({ rows: { wazzup_channels: [] } }, {}, async (ctx) => {
    const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
    assert.equal(res.statusCode, 200, "an unknown channel must not be an error the sender can probe");
    assert.equal(leadInserts(log).length, 0);
    assert.equal(JSON.stringify(res.body).includes(CHANNEL_A), false);
  });
});

test("WZ8 a disabled channel is ignored the same way", async () => {
  await withHandler(
    { rows: { wazzup_channels: [{ workspace_id: WORKSPACE_A, enabled: false }] } },
    {},
    async (ctx) => {
      const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
      assert.equal(res.statusCode, 200);
      assert.equal(leadInserts(log).length, 0);
    },
  );
});

test("WZ9 an inbound message becomes a lead in the channel's workspace", async () => {
  await withHandler({ rows: { wazzup_channels: [channelRow], leads: [] } }, {}, async (ctx) => {
    const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, 1);

    const insert = leadInserts(log)[0];
    assert.ok(insert, "the lead must be inserted");
    const row = insert.row as Record<string, unknown>;
    assert.equal(row.workspace_id, WORKSPACE_A, "tenancy comes from the channel row, never the payload");
    assert.equal(row.source, "whatsapp");
    assert.equal(row.status, "new");
    assert.equal(row.phone, "+77010000001", "the chatId digits are stored in canonical form");
    assert.equal(row.full_name, "Тестовый Пациент");
    assert.ok(String(row.notes).includes("хочу записаться"), "the first message is kept in notes");

    const ledger = log.find((entry) => entry.table === "wazzup_inbound_messages" && entry.op === "insert");
    assert.ok(ledger, "the ledger row must be written");
    assert.equal((ledger.row as Record<string, unknown>).kind, "created");
  });
});

test("WZ10 outgoing, deleted and non-WhatsApp entries in the batch are ignored", async () => {
  await withHandler({ rows: { wazzup_channels: [channelRow], leads: [] } }, {}, async (ctx) => {
    const { res, log } = await ctx.call({
      secret: SECRET,
      body: {
        messages: [
          inboundMessage({ isEcho: true, status: "sent" }),
          inboundMessage({ chatType: "telegram", messageId: "0e000000-0000-4000-8000-000000000002" }),
          inboundMessage({ isDeleted: true, messageId: "0e000000-0000-4000-8000-000000000003" }),
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(leadInserts(log).length, 0, "none of these are new inbound WhatsApp messages");
  });
});

// ===========================================================================
// C. Idempotency and dedup
// ===========================================================================

test("WZ11 a replayed messageId is a no-op", async () => {
  await withHandler(
    {
      rows: {
        wazzup_inbound_messages: [{ id: "ledger-1" }],
        wazzup_channels: [channelRow],
        leads: [],
      },
    },
    {},
    async (ctx) => {
      const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
      assert.equal(res.statusCode, 200, "Wazzup retries until it sees 200; the replay must return it");
      assert.equal(leadInserts(log).length, 0, "and must not file a second lead");
    },
  );
});

test("WZ12 an open lead with the same phone in another spelling is a repeat, not a duplicate", async () => {
  await withHandler(
    {
      rows: {
        wazzup_channels: [channelRow],
        // The operator typed the trunk-8 national form; the webhook brings the
        // international digits. They are the same subscriber.
        leads: [{ id: "lead-1", phone: "8 (701) 000-00-01" }],
      },
    },
    {},
    async (ctx) => {
      const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.repeats, 1);
      assert.equal(leadInserts(log).length, 0, "a repeat contact must not duplicate the lead");

      const ledger = log.find((entry) => entry.table === "wazzup_inbound_messages" && entry.op === "insert");
      assert.ok(ledger, "the repeat is recorded in the ledger");
      const row = ledger.row as Record<string, unknown>;
      assert.equal(row.kind, "repeat");
      assert.equal(row.lead_id, "lead-1", "pointing at the lead that already exists");
    },
  );
});

test("WZ13 a lost lead does not block a new one — the W3 default, pinned", async () => {
  // The spy applies no SQL filters, so the handler's own neq('status','lost')
  // cannot be observed through rows; instead pin that the filter is issued.
  await withHandler({ rows: { wazzup_channels: [channelRow], leads: [] } }, {}, async (ctx) => {
    const { log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
    const candidateQuery = log.find((entry) => entry.table === "leads" && entry.op === "select");
    assert.ok(candidateQuery, "the dedup lookup must happen");
    assert.equal(candidateQuery.filters["neq:status"], "lost", "only lost leads are out of the dedup window");
    assert.equal(candidateQuery.filters.workspace_id, WORKSPACE_A, "and only within the channel's workspace");
  });
});

test("WZ14 a failed lead insert answers 503 and leaves no ledger row", async () => {
  await withHandler(
    { rows: { wazzup_channels: [channelRow], leads: [] }, errors: { leads: "insert failed" } },
    {},
    async (ctx) => {
      const { res, log } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
      assert.equal(res.statusCode, 503, "a retry must find a clean slate");
      assert.equal(
        log.some((entry) => entry.table === "wazzup_inbound_messages" && entry.op === "insert"),
        false,
        "a ledger row without a lead would turn the retry into a no-op and lose the message",
      );
    },
  );
});

// ===========================================================================
// D. Personal data stays out of the logs
// ===========================================================================

test("WZ15 neither the phone nor the message text reaches the logs", async () => {
  await withHandler(
    { rows: { wazzup_channels: [channelRow], leads: [] }, errors: { leads: "insert failed" } },
    {},
    async (ctx) => {
      const { warnings } = await ctx.call({ secret: SECRET, body: { messages: [inboundMessage()] } });
      const logged = warnings.join("\n");
      assert.ok(logged.includes("[wazzup]"), "the failure itself must be logged for the operator");
      assert.equal(logged.includes("77010000001"), false, "the phone is patient data");
      assert.equal(logged.includes("хочу записаться"), false, "and so is the message text");
      assert.equal(logged.includes("Тестовый Пациент"), false, "and the name");
    },
  );
});

// ===========================================================================
// E. The phone canonicalizer
// ===========================================================================

test("NP1 the spellings of one number compare equal", async () => {
  const { normalizePhone } = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "phone.ts")).href
  )) as { normalizePhone: (raw: unknown) => string };

  assert.equal(normalizePhone("77010000001"), "+77010000001");
  assert.equal(normalizePhone("8 (701) 000-00-01"), "+77010000001");
  assert.equal(normalizePhone("+7 701 000 00 01"), "+77010000001");
  assert.equal(normalizePhone("007 701 000 00 01".replace(/\s/g, "")), "+77010000001");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(undefined), "");
  assert.equal(normalizePhone("not a phone"), "");
});

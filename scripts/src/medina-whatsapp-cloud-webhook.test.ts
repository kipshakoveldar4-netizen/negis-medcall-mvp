import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// WhatsApp Cloud API inbound webhook (§14 phase 2) — the door, the handshake
// and the pipeline, driven end-to-end against the real handler with a spying
// database client. Signatures are real HMAC-SHA256 values computed the way
// Meta computes them; nothing here is source-pinning. All data is fictional.
//
// The processing half (tenancy, ledger, dedup, taxonomy) is the same code the
// Wazzup adapter runs — lib/crm/inbound-whatsapp.ts — so CW12/CW13/CW14/CW17
// double as proof that the shared core behaves identically for both callers.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE_NUMBER_ID = "111000111000111";
const WAMID_1 = "wamid.HBgLNzcwMTAwMDAwMDEVAgARGBIwRkVDQ0NDRTdGN0E1QUYwMDA=";
const STAGE_NEW = "5ba0e000-0000-4000-8000-000000000001";
const SOURCE_WHATSAPP = "50c0e000-0000-4000-8000-000000000001";
const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

type QueryLog = { table: string; op: string; filters: Record<string, unknown>; row?: unknown };

type MockResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  text: string;
  status: (code: number) => MockResponse;
  setHeader: () => MockResponse;
  json: (payload: unknown) => MockResponse;
  send: (payload: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: {},
    text: "",
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
    json(payload) { res.body = (payload ?? {}) as Record<string, unknown>; return res; },
    send(payload) { res.text = String(payload ?? ""); return res; },
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
        order(column: string) { entry.filters[`order:${column}`] = true; return builder; },
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

function sign(rawBody: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex")}`;
}

async function loadHandler(
  options: SpyOptions = {},
  env: { appSecret?: string | null; verifyToken?: string | null } = {},
) {
  const log: QueryLog[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

  if (env.appSecret === null) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = env.appSecret ?? APP_SECRET;
  if (env.verifyToken === null) delete process.env.WHATSAPP_VERIFY_TOKEN;
  else process.env.WHATSAPP_VERIFY_TOKEN = env.verifyToken ?? VERIFY_TOKEN;
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
    pathToFileURL(path.join(repoRoot, "lib", "whatsapp-cloud", "webhook.ts")).href
  )) as { handleWhatsAppCloudWebhook: (req: unknown, res: MockResponse, raw: Buffer) => Promise<unknown> };

  const call = async (input: {
    method?: string;
    rawBody?: string;
    signature?: string | null;
    query?: Record<string, unknown>;
  }) => {
    log.length = 0;
    warnings.length = 0;
    const res = mockResponse();
    const raw = input.rawBody ?? "";
    const headers: Record<string, string> = {};
    if (input.signature !== null && input.signature !== undefined) {
      headers["x-hub-signature-256"] = input.signature;
    }
    await module.handleWhatsAppCloudWebhook(
      { method: input.method ?? "POST", headers, query: input.query ?? {} },
      res,
      Buffer.from(raw, "utf8"),
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
  env: { appSecret?: string | null; verifyToken?: string | null },
  fn: (ctx: Awaited<ReturnType<typeof loadHandler>>) => Promise<T>,
): Promise<T> {
  const ctx = await loadHandler(options, env);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

const numberRow = { workspace_id: WORKSPACE_A, enabled: true };

function inboundPayload(overrides: {
  messageId?: string;
  from?: string;
  text?: string | null;
  type?: string;
  phoneNumberId?: string;
  contactName?: string;
} = {}): string {
  const from = overrides.from ?? "77010000001";
  const type = overrides.type ?? "text";
  const message: Record<string, unknown> = {
    from,
    id: overrides.messageId ?? WAMID_1,
    timestamp: "1770000000",
    type,
  };
  if (type === "text") message.text = { body: overrides.text ?? "Здравствуйте, хочу записаться" };
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "10000000000000",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "77470000000", phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: [{ wa_id: from, profile: { name: overrides.contactName ?? "Тестовый Пациент" } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

function statusesPayload(): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "10000000000000",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "77470000000", phone_number_id: PHONE_NUMBER_ID },
              statuses: [{ id: WAMID_1, status: "delivered", timestamp: "1770000001", recipient_id: "77010000001" }],
            },
          },
        ],
      },
    ],
  });
}

function leadInserts(log: QueryLog[]): QueryLog[] {
  return log.filter((entry) => entry.table === "leads" && entry.op === "insert");
}

// ===========================================================================
// A. The handshake
// ===========================================================================

test("CW1 the subscription GET echoes hub.challenge for the exact verify token", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res } = await ctx.call({
      method: "GET",
      query: { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.text, "1158201444", "Meta requires the challenge echoed verbatim");
  });
});

test("CW2 a wrong verify token is refused without detail", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res } = await ctx.call({
      method: "GET",
      query: { "hub.mode": "subscribe", "hub.verify_token": "not-the-token", "hub.challenge": "1158201444" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.text, "", "the challenge must never leak on a failed handshake");
    assert.equal(JSON.stringify(res.body).includes("token"), false, "the reason must not name the mechanism");
  });
});

test("CW3 a handshake with no verify token configured fails closed", async () => {
  await withHandler({ rows: {} }, { verifyToken: null }, async (ctx) => {
    const { res } = await ctx.call({
      method: "GET",
      query: { "hub.mode": "subscribe", "hub.verify_token": "anything", "hub.challenge": "1" },
    });
    assert.equal(res.statusCode, 503, "a mis-deploy must be visible in the App Dashboard, not confirmed");
  });
});

test("CW4 anything but GET and POST is refused", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res } = await ctx.call({ method: "DELETE", rawBody: "{}" });
    assert.equal(res.statusCode, 405);
  });
});

// ===========================================================================
// B. The door
// ===========================================================================

test("CW5 an unconfigured app secret fails closed with 503", async () => {
  await withHandler({ rows: {} }, { appSecret: null }, async (ctx) => {
    const body = inboundPayload();
    const { res } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 503, "Meta keeps retrying while the operator fixes the env");
  });
});

test("CW6 a missing signature is a generic 401 and the database is never touched", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const { res, log } = await ctx.call({ rawBody: inboundPayload(), signature: null });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.stringify(res.body).includes("signature"), false, "the reason must not name the mechanism");
    assert.equal(log.length, 0, "no query may run before authentication");
    assert.equal(ctx.clientCreations, 0, "no service-role client before authentication");
  });
});

test("CW7 a signature keyed with the wrong secret is refused", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body, "some-other-secret") });
    assert.equal(res.statusCode, 401);
    assert.equal(log.length, 0);
  });
});

test("CW8 a valid signature over different bytes is refused — the body cannot be swapped", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const signedBody = inboundPayload({ text: "оригинал" });
    const tamperedBody = inboundPayload({ text: "подмена" });
    const { res } = await ctx.call({ rawBody: tamperedBody, signature: sign(signedBody) });
    assert.equal(res.statusCode, 401);
  });
});

test("CW9 signed garbage is 400, not a crash and not a 500 retry-storm", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const body = "this is not json";
    const { res } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 400);
  });
});

// ===========================================================================
// C. The pipeline — the same core the Wazzup adapter runs
// ===========================================================================

test("CW10 a status update is acknowledged without touching the database", async () => {
  await withHandler({ rows: {} }, {}, async (ctx) => {
    const body = statusesPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 200, "a non-200 would make Meta retry a receipt forever");
    assert.equal(log.length, 0, "statuses carry nothing to file");
  });
});

test("CW11 an unknown phone_number_id is acknowledged and ignored, without disclosure", async () => {
  await withHandler({ rows: { whatsapp_cloud_numbers: [], whatsapp_cloud_inbound_messages: [], leads: [] } }, {}, async (ctx) => {
    const body = inboundPayload({ phoneNumberId: "999888777666555" });
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, 1);
    assert.equal(leadInserts(log).length, 0, "no lead may be filed for an unmapped number");
  });
});

test("CW12 an inbound message becomes a lead in the number's workspace, inside the funnel", async () => {
  await withHandler({
    rows: {
      whatsapp_cloud_numbers: [numberRow],
      whatsapp_cloud_inbound_messages: [],
      leads: [],
      lead_stages: [{ id: STAGE_NEW }],
      lead_sources: [{ id: SOURCE_WHATSAPP }],
    },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, 1);

    const insert = leadInserts(log)[0];
    assert.ok(insert, "the lead must be inserted");
    const row = insert.row as Record<string, unknown>;
    assert.equal(row.workspace_id, WORKSPACE_A, "tenancy comes from the number row, never the payload");
    assert.equal(row.source, "whatsapp");
    assert.equal(row.status, "new");
    assert.equal(row.phone, "+77010000001", "the from digits are stored in canonical form");
    assert.equal(row.full_name, "Тестовый Пациент", "the profile name travels from contacts[]");
    assert.ok(String(row.notes).includes("хочу записаться"), "the first message is kept in notes");
    assert.equal(row.stage_id, STAGE_NEW, "the lead enters the funnel — WZ18 parity through the shared core");
    assert.equal(row.source_id, SOURCE_WHATSAPP);

    const ledger = log.find((entry) => entry.table === "whatsapp_cloud_inbound_messages" && entry.op === "insert");
    assert.ok(ledger, "the ledger row must be written");
    const ledgerRow = ledger.row as Record<string, unknown>;
    assert.equal(ledgerRow.kind, "created");
    assert.equal(ledgerRow.message_id, WAMID_1);
    assert.equal(ledgerRow.channel_id, PHONE_NUMBER_ID, "the ledger records which number the message arrived through");
  });
});

test("CW13 a replayed wamid is a no-op", async () => {
  await withHandler({
    rows: {
      whatsapp_cloud_numbers: [numberRow],
      whatsapp_cloud_inbound_messages: [{ id: "seen-row" }],
      leads: [],
    },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, 1);
    assert.equal(leadInserts(log).length, 0, "Meta retries until it sees 200; a retry must not file twice");
  });
});

test("CW14 an open lead with the same phone in another spelling is a repeat, not a duplicate", async () => {
  await withHandler({
    rows: {
      whatsapp_cloud_numbers: [numberRow],
      whatsapp_cloud_inbound_messages: [],
      leads: [{ id: "22222222-2222-4222-8222-222222222222", phone: "8 701 000-00-01" }],
    },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.repeats, 1);
    assert.equal(leadInserts(log).length, 0, "the canonical phone comparison must catch the operator spelling");

    const ledger = log.find((entry) => entry.table === "whatsapp_cloud_inbound_messages" && entry.op === "insert");
    assert.ok(ledger, "the repeat is recorded");
    assert.equal((ledger.row as Record<string, unknown>).kind, "repeat");
  });
});

test("CW15 a database outage answers 503 so Meta retries", async () => {
  await withHandler({
    rows: { whatsapp_cloud_numbers: [numberRow], leads: [] },
    errors: { whatsapp_cloud_inbound_messages: "connection refused" },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 503, "a 200 here would drop the message forever");
  });
});

test("CW16 a disabled number is ignored the same way as an unknown one", async () => {
  await withHandler({
    rows: {
      whatsapp_cloud_numbers: [{ workspace_id: WORKSPACE_A, enabled: false }],
      whatsapp_cloud_inbound_messages: [],
      leads: [],
    },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, 1);
    assert.equal(leadInserts(log).length, 0);
  });
});

test("CW17 a reshaped funnel costs the classification, never the lead — WZ19 parity", async () => {
  await withHandler({
    rows: {
      whatsapp_cloud_numbers: [numberRow],
      whatsapp_cloud_inbound_messages: [],
      leads: [],
      lead_stages: [],
      lead_sources: [],
    },
  }, {}, async (ctx) => {
    const body = inboundPayload();
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.created, 1);
    const row = leadInserts(log)[0]?.row as Record<string, unknown>;
    assert.ok(row, "the lead must still be inserted");
    assert.equal(row.stage_id, undefined, "an unresolved stage is left unset, not invented");
    assert.equal(row.source_id, undefined);
  });
});

test("CW18 a non-text message still files the lead — the contact is the value, not the media", async () => {
  await withHandler({
    rows: { whatsapp_cloud_numbers: [numberRow], whatsapp_cloud_inbound_messages: [], leads: [] },
  }, {}, async (ctx) => {
    const body = inboundPayload({ type: "image" });
    const { res, log } = await ctx.call({ rawBody: body, signature: sign(body) });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.created, 1);
    const row = leadInserts(log)[0]?.row as Record<string, unknown>;
    assert.equal(row.notes, null, "no text body — no invented notes");
    assert.equal(row.phone, "+77010000001");
  });
});

// ===========================================================================
// D. The entry point reads the bytes Meta signed — not what a parser rebuilt
//
// The adversarial review caught the original entry point trusting
// `config.api.bodyParser = false`, a Next.js convention @vercel/node ignores:
// the platform helpers had already buffered the body and installed req.body
// as a lazy JSON getter, the entry read it first, and the HMAC was computed
// over JSON.stringify(JSON.parse(bytes)) — which differs from Meta's bytes on
// any \uXXXX-escaped Cyrillic, i.e. on essentially all real traffic of this
// CRM. These tests drive the REAL entry point in a faithful model of each
// environment. What the runtime actually does is pinned from its source
// (@vercel/node dist: addHelpers → readBody → restoreBody replays the exact
// bytes through a PassThrough redirected to req.on("data"/"end")).
// ===========================================================================

async function loadEntryPoint() {
  const module = (await import(
    pathToFileURL(path.join(repoRoot, "api", "webhooks", "whatsapp.ts")).href
  )) as { default: (req: unknown, res: MockResponse & { end?: (body: string) => void }) => Promise<unknown> };
  return module.default;
}

/** A request the way the Vercel helpers leave it: raw bytes replayed through
 * a PassThrough behind req.on("data"/"end"), req.body a LAZY getter. */
function helpersShapedRequest(rawBytes: Buffer, headers: Record<string, string>) {
  const stream = new PassThrough();
  let lazyGetterTouched = false;
  const req = Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    query: {},
  });
  Object.defineProperty(req, "body", {
    configurable: true,
    get() {
      lazyGetterTouched = true;
      return JSON.parse(rawBytes.toString("utf8"));
    },
  });
  stream.write(rawBytes);
  stream.end();
  return { req, wasLazyGetterTouched: () => lazyGetterTouched };
}

function entryResponse() {
  const res = mockResponse() as MockResponse & { end: (body: string) => void };
  res.end = (payload: string) => {
    try { res.body = JSON.parse(payload); } catch { res.text = payload; }
    return res;
  };
  return res;
}

test("CW20 under Vercel helpers the signature is verified over Meta's bytes, not a re-serialization", async () => {
  await withHandler({
    rows: { whatsapp_cloud_numbers: [numberRow], whatsapp_cloud_inbound_messages: [], leads: [] },
  }, {}, async () => {
    const entry = await loadEntryPoint();

    // Meta-style bytes: \uXXXX-escaped Cyrillic and an escaped slash. A
    // JSON.parse → JSON.stringify round-trip of these bytes produces
    // DIFFERENT bytes (raw UTF-8, bare slash), so a handler that verifies
    // the round-trip would answer 401 to a perfectly signed delivery.
    const rawBytes = Buffer.from(
      JSON.stringify(JSON.parse(inboundPayload({ text: "Здравствуйте, хочу записаться" })))
        .replace(/[-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
        .replace(/\//g, "\\/"),
      "utf8",
    );
    assert.notEqual(
      JSON.stringify(JSON.parse(rawBytes.toString("utf8"))),
      rawBytes.toString("utf8"),
      "the fixture must be a payload whose round-trip differs — otherwise this test proves nothing",
    );

    const { req, wasLazyGetterTouched } = helpersShapedRequest(rawBytes, {
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(rawBytes).digest("hex")}`,
    });
    const res = entryResponse();
    await entry(req, res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, 1, "the signed Cyrillic delivery must file its lead");
    assert.equal(wasLazyGetterTouched(), false, "req.body is a lazy parse of the wrong bytes and must never be read");
  });
});

test("CW21 the dev middleware shape (plain body value, consumed stream) neither hangs nor crashes", async () => {
  await withHandler({ rows: {} }, {}, async () => {
    const entry = await loadEntryPoint();

    // vite.config's middleware consumes the stream WITHOUT restoring it and
    // assigns req.body as a plain value property. The entry must take the
    // fallback instead of waiting forever on an "end" that already fired.
    const stream = new PassThrough();
    stream.end();
    const req = Object.assign(stream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      query: {},
      body: { object: "whatsapp_business_account", entry: [] },
    });
    const res = entryResponse();

    const outcome = await Promise.race([
      entry(req, res).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    assert.equal(outcome, "settled", "a consumed stream with a value body is the dev shape and must settle");
    assert.equal(res.statusCode, 401, "no signature over the fallback bytes — still a closed door");
  });
});

test("CW22 a body over the limit is answered 413 — and the limit clears a maximal legitimate batch", async () => {
  await withHandler({ rows: {} }, {}, async () => {
    const entry = await loadEntryPoint();

    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61);
    const { req } = helpersShapedRequest(oversized, {});
    const res = entryResponse();
    await entry(req, res);
    assert.equal(res.statusCode, 413);
  });
});

test("CW19 neither the phone nor the message text reaches the logs", async () => {
  await withHandler({
    rows: { whatsapp_cloud_numbers: [numberRow], leads: [] },
    errors: { whatsapp_cloud_inbound_messages: "connection refused" },
  }, {}, async (ctx) => {
    const body = inboundPayload({ text: "секретный текст пациента" });
    const { warnings } = await ctx.call({ rawBody: body, signature: sign(body) });
    const joined = warnings.join("\n");
    assert.ok(joined.length > 0, "the failure itself must be logged");
    assert.equal(joined.includes("77010000001"), false, "the phone is patient data");
    assert.equal(joined.includes("секретный"), false, "the text is patient data");
    assert.equal(joined.includes("Тестовый"), false, "the name is patient data");
  });
});

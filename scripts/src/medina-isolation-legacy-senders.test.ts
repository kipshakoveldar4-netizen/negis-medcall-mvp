import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Characterization, not an isolation guarantee: the Edge webhook's missing-key
// bypass is deliberately preserved below as a separately named source finding.
// No application module is imported, no host environment is inspected, and all
// SDK/fetch boundaries are in-memory mocks with no network fallback.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");

async function program(relative: string, names?: readonly string[], expose: readonly string[] = []) {
  const source = await readFile(path.join(root, relative), "utf8");
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = names ? names.map(name => {
    const matches = ast.statements.filter(node =>
      ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ? node.name?.text === name
        : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
    assert.equal(matches.length, 1, `${relative}: select exactly one actual ${name} declaration`);
    return matches[0];
  }) : ast.statements.filter(node => !ts.isImportDeclaration(node));
  // Copy actual AST declarations verbatim; never trim or rewrite their readers.
  const compiled = ts.transpileModule([
    ...statements.map(node => node.getText(ast)),
    `exports.selected = { ${expose.join(", ")} };`,
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return { relative, compiled };
}

const rootTelegramCode = await program("api/content-studio/[...path].ts", [
  "CONTENT_STUDIO_AUTHORIZATION", "sendJson", "readBody", "readPathSegment", "splitLongText",
  "splitTelegramMessage", "telegramHint", "readTelegramBody", "sendTelegramMessage", "handleSendTelegram", "handler",
]);
const rootGuardCode = await program("lib/auth/route-guard.ts");
const expressCode = await program("artifacts/api-server/src/routes/webhook.ts");
const edgeAuthCode = await program("supabase/functions/_shared/auth.ts");
const edgeCorsCode = await program("supabase/functions/_shared/cors.ts");
const edgeWazzupCode = await program("supabase/functions/_shared/wazzup.ts");
const edgeSendCode = await program("supabase/functions/wazzup-send/index.ts");
const edgeWebhookCode = await program("supabase/functions/wazzup-webhook/index.ts", undefined, ["webhookKeyMatches"]);
const rootWebhookCode = await program("lib/wazzup/webhook.ts");

type Program = Awaited<ReturnType<typeof program>>;
type AnyObject = Record<string, any>;
type Outbound = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
type AsyncHandler = (req: AnyObject, res?: AnyObject) => Promise<any>;

function safety() {
  const forbidden: string[] = [];
  function trap(message: string): never {
    forbidden.push(message);
    throw new Error(`Forbidden fixture boundary: ${message}`);
  }
  return {
    trap,
    check() { assert.deepEqual(forbidden, [], "No forbidden boundary, including a swallowed error, may be reached"); },
  };
}

function evaluate<T = AnyObject>(code: Program, bindings: AnyObject, guard: ReturnType<typeof safety>): T {
  const exports = {};
  new Script(code.compiled, { filename: `${code.relative}.legacy-senders.vm.cjs` }).runInNewContext({
    exports, Error, TypeError, RangeError, Response, URL,
    require: (name: string) => guard.trap(`import ${name}`),
    fetch: () => guard.trap("unmocked fetch"),
    process: new Proxy({}, { get: (_target, key) => guard.trap(`host process ${String(key)}`) }),
    Deno: new Proxy({}, { get: (_target, key) => guard.trap(`unmocked Deno ${String(key)}`) }),
    console: { log: () => guard.trap("unexpected log"), warn: () => guard.trap("unexpected warning") },
    ...bindings,
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  return exports as T;
}

function environment(values: Record<string, string | undefined>, events: string[], guard: ReturnType<typeof safety>) {
  const get = (key: string) => {
    if (!Object.hasOwn(values, key)) return guard.trap(`unlisted synthetic environment key ${key}`);
    events.push(`env:${key}`);
    return values[key];
  };
  return {
    get,
    raw: new Proxy(Object.create(null), {
      get: (_target, key) => typeof key === "string" ? get(key) : guard.trap("symbol environment read"),
      ownKeys: () => guard.trap("environment enumeration"),
      set: () => guard.trap("environment mutation"),
    }),
  };
}

function response() {
  return {
    statusCode: 0, headers: {} as Record<string, string>, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

const ACTOR = "SYNTHETIC_ACTOR_ONLY";
const BOT = "SYNTHETIC_BOT_ONLY";
const CHAT = "-424242";
const KEY = "SYNTHETIC_WAZZUP_ONLY";
const UUID = "11111111-1111-4111-8111-111111111111";
const variants = [
  { name: "unset", value: undefined, raw: false, trimmed: false },
  { name: "empty", value: "", raw: false, trimmed: false },
  { name: "whitespace", value: " \t\r\n ", raw: true, trimmed: false },
  { name: "literal false", value: "false", raw: true, trimmed: true },
  { name: "padded synthetic value", value: " \tSYNTHETIC_READER_ONLY\r\n ", raw: true, trimmed: true },
] as const;

function rootTelegramFixture(settings: Record<string, string | undefined>, deny?: 401 | 403) {
  const guard = safety(), events: string[] = [], outbound: Outbound[] = [];
  const env = environment(settings, events, guard);
  class WorkspaceAdminAuthError extends Error {
    constructor(readonly statusCode: number, readonly code: string) { super("Synthetic auth refusal"); }
  }
  const routeGuard = evaluate(rootGuardCode, {
    WorkspaceAdminAuthError,
    async requireWorkspaceAccess(_req: unknown, _workspace: unknown, options: AnyObject) {
      events.push("auth:workspace");
      assert.equal(options.permission, "manage_ai_content");
      if (deny) throw new WorkspaceAdminAuthError(deny, deny === 401 ? "authentication_required" : "permission_denied");
      return { workspaceId: UUID, staffUserId: "SYNTHETIC_STAFF", role: "owner" };
    },
    async lookupWorkspacePurposes() { events.push("auth:purpose-lookup"); return { [UUID]: "clinic" }; },
    requirePurposeRoute() { events.push("auth:purpose-allowed"); },
  }, guard);
  const app = evaluate(rootTelegramCode, {
    ...routeGuard, process: { env: env.raw },
    telegramPackageText() { events.push("package"); return "Synthetic local-only package"; },
    async resolveTelegramRecipient(input: AnyObject) {
      assert.equal(input.chatId, CHAT, "This characterization only uses its fixed numeric recipient");
      return CHAT;
    },
    async admitTelegramDelivery(input: AnyObject) {
      events.push("delivery:admit");
      assert.equal(input.actor.workspaceId, UUID);
      return { replayed: false };
    },
    async beginTelegramDeliveryPart() { events.push("delivery:begin"); },
    acknowledgeTelegramDeliveryPart: () => guard.trap("unexpected acknowledgement"),
    persistContentVideoPatchIfAvailable: () => guard.trap("unexpected content write"),
    updateContentVideo: () => guard.trap("unexpected content cache write"),
    telegramDeliveryHash: () => guard.trap("unexpected acknowledgement hash"),
    TelegramDeliveryError: class extends Error {},
    async fetch(url: string, init: Outbound["init"]) {
      events.push("outbound:telegram"); outbound.push({ url, init });
      return { ok: false, status: 401, async text() { return '{"ok":false,"error_code":401}'; } };
    },
  }, guard);
  return {
    events, outbound, check: guard.check,
    async call(body: AnyObject = {}, method = "POST") {
      const res = response();
      await app.default({ method, query: { path: "send-telegram" }, headers: {}, get body() {
        events.push("body"); return body;
      } }, res);
      guard.check();
      return res;
    },
  };
}

function expressFixture(bot: string | undefined, chat: string | null | undefined, secret: string | undefined) {
  const guard = safety(), events: string[] = [], outbound: Outbound[] = [];
  const env = environment({ TELEGRAM_BOT_TOKEN: bot }, events, guard);
  let handler: AsyncHandler | undefined;
  const clinic = { id: UUID, telegram_chat_id: chat, webhook_secret: secret };
  const supabaseAdmin = {
    from(table: string) {
      if (!["clinics", "lead_statuses", "leads"].includes(table)) return guard.trap(`Express table ${table}`);
      events.push(`sdk:${table}`);
      let inserted = false;
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; },
        order() { return query; }, limit() { return query; },
        insert() { events.push("sdk:leads:insert"); inserted = true; return query; },
        update: () => guard.trap("unexpected Express lead update"),
        async single() {
          return { data: table === "clinics" ? clinic : { id: "SYNTHETIC_LEAD" }, error: null };
        },
        async maybeSingle() { return { data: { id: "SYNTHETIC_STATUS" }, error: null }; },
        then(resolve: (value: unknown) => unknown) {
          if (table !== "leads" || inserted) return guard.trap("unexpected Express thenable query");
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return query;
    },
  };
  evaluate(expressCode, {
    process: { env: env.raw }, supabaseAdmin,
    Router: () => ({ post(route: string, callback: AsyncHandler) {
      assert.equal(route, "/leads/webhook/:clinic_id");
      assert.equal(handler, undefined); handler = callback;
    } }),
    async fetch(url: string, init: Outbound["init"]) {
      events.push("outbound:telegram"); outbound.push({ url, init });
      return { ok: false, status: 401 };
    },
  }, guard);
  assert.ok(handler);
  return {
    events, outbound, check: guard.check,
    async call(provided: string | undefined, testBody = false) {
      const res = response();
      await handler!({ params: { clinic_id: UUID }, query: {},
        headers: provided === undefined ? {} : { authorization: `Bearer ${provided}` },
        body: testBody ? { test: true } : { phone: "00000000000", full_name: "Synthetic fixture lead" },
      }, res);
      guard.check();
      return res;
    },
  };
}

function edgeFixture(key: string | undefined, mode: "send" | "webhook" = "send", membership = true) {
  const guard = safety(), events: string[] = [], outbound: Outbound[] = [], writes: AnyObject[] = [];
  const env = environment({ SUPABASE_URL: "https://legacy-sender.fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "SYNTHETIC_SDK_ONLY",
    WAZZUP_API_KEY: key, WAZZUP_CRM_KEY: key,
  }, events, guard);
  let handler: AsyncHandler | undefined;
  const sdk = {
    auth: { async getUser(token: string) {
      events.push("auth:user");
      return token === ACTOR ? { data: { user: { id: UUID } }, error: null }
        : { data: { user: null }, error: { message: "Synthetic rejected actor" } };
    } },
    from(table: string) {
      if (table === "user_roles") {
        events.push("auth:membership");
        const query = {
          select() { return query; }, eq() { return query; },
          async maybeSingle() { events.push(membership ? "auth:membership-allowed" : "auth:membership-denied");
            return { data: membership ? { clinic_id: UUID } : null, error: null }; },
        };
        return query;
      }
      if (table === "wz_messages" && mode === "send") return { async upsert(row: AnyObject) {
        events.push("sdk:message-write"); writes.push(row); return { error: null };
      } };
      return guard.trap(`unexpected Edge table ${table}`);
    },
  };
  const deno = {
    env: { get: env.get },
    serve(callback: AsyncHandler) { assert.equal(handler, undefined); handler = callback; },
  };
  const auth = evaluate(edgeAuthCode, {
    Deno: deno,
    createClient(url: string, credential: string, options: AnyObject) {
      events.push("sdk:create");
      assert.equal(url, "https://legacy-sender.fixture.invalid");
      assert.equal(credential, "SYNTHETIC_SDK_ONLY");
      assert.equal(options.auth.persistSession, false);
      assert.equal(options.auth.autoRefreshToken, false);
      return sdk;
    },
  }, guard);
  const cors = evaluate(edgeCorsCode, {}, guard);
  const wazzup = evaluate(edgeWazzupCode, {
    Deno: deno,
    async fetch(url: string, init: Outbound["init"]) {
      events.push("outbound:wazzup"); outbound.push({ url, init });
      return { ok: true, status: 200, async text() { return '{"messageId":"SYNTHETIC_MESSAGE"}'; } };
    },
  }, guard);
  const app = evaluate(mode === "send" ? edgeSendCode : edgeWebhookCode, {
    ...auth, ...cors, ...wazzup, Deno: deno, crypto: { randomUUID: () => UUID },
  }, guard);
  assert.ok(handler);
  function request(authorization?: string, queryKey?: string, method = "POST") {
    const url = new URL("https://legacy-sender.fixture.invalid/edge");
    if (queryKey !== undefined) url.searchParams.set("key", queryKey);
    const headers = new Headers(authorization === undefined ? {} : { Authorization: authorization });
    return { url: url.href, method, headers, async json() {
      events.push("body");
      return mode === "webhook" ? { messages: [] } : {
        clinicId: UUID, channelId: "SYNTHETIC_CHANNEL", chatId: "00000000000", text: "Synthetic local-only text",
      };
    } };
  }
  return {
    events, outbound, writes, check: guard.check,
    apiKey: wazzup.wazzupApiKey as () => string,
    fetch: wazzup.wazzupFetch as (route: string, init: AnyObject) => Promise<unknown>,
    keyMatches(authorization?: string, queryKey?: string) {
      const result = app.selected.webhookKeyMatches(request(authorization, queryKey));
      guard.check(); return result;
    },
    async call(authorization?: string, queryKey?: string, method = "POST") {
      const res = await handler!(request(authorization, queryKey, method)) as Response;
      guard.check(); return res;
    },
  };
}

function rootWebhookFixture(secret: string | undefined) {
  const guard = safety(), events: string[] = [];
  const env = environment({ WAZZUP_WEBHOOK_SECRET: secret }, events, guard);
  const app = evaluate(rootWebhookCode, {
    process: { env: env.raw }, createHash, timingSafeEqual,
    getSupabaseServerClient: () => guard.trap("root webhook SDK"),
    processInboundWhatsAppMessages: () => guard.trap("root webhook write"),
    normalizePhone: () => guard.trap("unexpected inbound message parsing"),
  }, guard);
  return {
    events, check: guard.check,
    async call(provided?: string) {
      const res = response();
      await app.handleWazzupWebhook({ method: "POST", headers: {},
        query: provided === undefined ? {} : { secret: provided },
        get body() { events.push("body"); return { test: true }; },
      }, res);
      guard.check(); return res;
    },
  };
}

for (const variant of variants) {
  for (const setting of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const) {
    test(`root Telegram trims ${setting}: ${variant.name}`, { timeout: 2000 }, async () => {
      // Root's current recipient boundary requires a valid numeric destination;
      // keep the exact whitespace/absence matrix without inventing an alias.
      const settingValue = setting === "TELEGRAM_CHAT_ID" && variant.trimmed
        ? variant.name === "padded synthetic value" ? ` \t${CHAT}\r\n ` : CHAT : variant.value;
      const fixture = rootTelegramFixture({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: CHAT, [setting]: settingValue });
      const res = await fixture.call({ chatId: "SYNTHETIC_CALLER_DESTINATION" });
      assert.equal(fixture.outbound.length, variant.trimmed ? 1 : 0);
      assert.equal(res.statusCode, variant.trimmed ? 502 : 200);
      assert.equal(res.body.mode, variant.trimmed ? undefined : "demo");
      if (!variant.trimmed) {
        assert.equal(res.body.data.sent, false);
        assert.equal(fixture.events.includes("delivery:admit"), false);
      } else {
        const call = fixture.outbound[0];
        assert.equal(call.url, `https://api.telegram.org/bot${setting === "TELEGRAM_BOT_TOKEN" ? settingValue!.trim() : BOT}/sendMessage`);
        assert.equal(JSON.parse(call.init.body).chat_id, setting === "TELEGRAM_CHAT_ID" ? settingValue!.trim() : CHAT);
        assert.ok(fixture.events.indexOf("auth:purpose-allowed") < fixture.events.indexOf("delivery:admit"));
        assert.ok(fixture.events.indexOf("delivery:begin") < fixture.events.indexOf("outbound:telegram"));
      }
      fixture.check();
    });
  }

  test(`Express Telegram preserves raw bot token: ${variant.name}`, { timeout: 2000 }, async () => {
    const fixture = expressFixture(variant.value, CHAT, KEY);
    const res = await fixture.call(KEY);
    assert.equal(res.statusCode, 200);
    assert.equal(fixture.outbound.length, variant.raw ? 1 : 0);
    if (variant.raw) {
      assert.equal(fixture.outbound[0].url, `https://api.telegram.org/bot${variant.value}/sendMessage`);
      assert.equal(JSON.parse(fixture.outbound[0].init.body).chat_id, CHAT);
      assert.ok(fixture.events.indexOf("sdk:leads:insert") < fixture.events.indexOf("outbound:telegram"));
    }
    fixture.check();
  });

  test(`Express Telegram preserves raw clinic chat ID: ${variant.name}`, { timeout: 2000 }, async () => {
    const fixture = expressFixture(BOT, variant.value, KEY);
    await fixture.call(KEY);
    assert.equal(fixture.outbound.length, variant.raw ? 1 : 0);
    assert.equal(fixture.events.includes("env:TELEGRAM_BOT_TOKEN"), variant.raw);
    if (variant.raw) assert.equal(JSON.parse(fixture.outbound[0].init.body).chat_id, variant.value);
    fixture.check();
  });

  test(`Edge Wazzup raw API key helper and outbound header: ${variant.name}`, { timeout: 2000 }, async () => {
    const fixture = edgeFixture(variant.value);
    if (variant.raw) assert.equal(fixture.apiKey(), variant.value);
    else assert.throws(() => fixture.apiKey(), { message: "WAZZUP_API_KEY is not configured" });
    const res = await fixture.call(`Bearer ${ACTOR}`);
    assert.equal(res.status, variant.raw ? 200 : 500);
    assert.equal(fixture.outbound.length, variant.raw ? 1 : 0);
    assert.equal(fixture.writes.length, variant.raw ? 1 : 0);
    assert.ok(fixture.events.indexOf("auth:user") < fixture.events.indexOf("body"));
    if (variant.raw) {
      const call = fixture.outbound[0];
      assert.equal(call.url, "https://api.wazzup24.com/v3/message");
      assert.equal(call.init.headers.Authorization, `Bearer ${variant.value}`, "Inspect raw fetch init, before any HTTP header normalization");
      assert.equal(call.init.method, "POST");
      assert.ok(fixture.events.indexOf("auth:membership-allowed") < fixture.events.indexOf("outbound:wazzup"));
      assert.ok(fixture.events.indexOf("outbound:wazzup") < fixture.events.indexOf("sdk:message-write"));
    }
    fixture.check();
  });

  test(`root and Edge Wazzup webhook configuration remain distinct: ${variant.name}`, { timeout: 2000 }, async () => {
    const rootFixture = rootWebhookFixture(variant.value);
    const rootRes = await rootFixture.call();
    assert.equal(rootRes.statusCode, variant.trimmed ? 401 : 503);
    assert.equal(rootFixture.events.includes("body"), false);
    const edge = edgeFixture(variant.value, "webhook");
    assert.equal(edge.keyMatches(), !variant.raw);
    const edgeRes = await edge.call();
    assert.equal(edgeRes.status, variant.raw ? 401 : 200);
    assert.equal(edge.events.includes("sdk:create"), !variant.raw);
    assert.equal(edge.events.includes("body"), !variant.raw);
    assert.equal(edge.outbound.length, 0);
    assert.equal(edge.writes.length, 0);
    rootFixture.check(); edge.check();
  });
}

test("root Telegram requires workspace auth even for test/demo requests before body, config or outbound", { timeout: 2000 }, async () => {
  for (const deny of [401, 403] as const) {
    for (const variant of variants) {
      for (const isTest of [false, true]) {
        const fixture = rootTelegramFixture({ TELEGRAM_BOT_TOKEN: variant.value, TELEGRAM_CHAT_ID: CHAT }, deny);
        const res = await fixture.call({ test: isTest });
        assert.equal(res.statusCode, deny);
        assert.deepEqual(fixture.events, ["auth:workspace"]);
        assert.equal(fixture.outbound.length, 0);
        fixture.check();
      }
    }
  }
});

test("root Telegram rejects wrong methods before workspace auth and outbound", { timeout: 2000 }, async () => {
  const fixture = rootTelegramFixture({ TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: CHAT });
  const res = await fixture.call({}, "GET");
  assert.equal(res.statusCode, 405);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.outbound.length, 0);
});

test("Express webhook missing, blank or mismatched shared secret prevents lead writes and Telegram", { timeout: 2000 }, async () => {
  for (const configured of [undefined, "", " \t ", KEY]) {
    for (const provided of [undefined, "", " \t ", "false"]) {
      const fixture = expressFixture(BOT, CHAT, configured);
      const res = await fixture.call(provided);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(fixture.events, ["sdk:clinics"]);
      assert.equal(fixture.outbound.length, 0);
      fixture.check();
    }
  }
});

test("Express webhook trims configured secret and treats literal false as a credential, not a disable switch", { timeout: 2000 }, async () => {
  for (const value of [KEY, "false"]) {
    const fixture = expressFixture(BOT, CHAT, ` \t${value}\r\n `);
    const res = await fixture.call(value);
    assert.equal(res.statusCode, 200);
    assert.equal(fixture.outbound.length, 1);
    fixture.check();
  }
});

test("Express webhook test:true bypasses auth only for an inert acknowledgement, unlike Edge writes gate", { timeout: 2000 }, async () => {
  const fixture = expressFixture(BOT, CHAT, "");
  const res = await fixture.call("", true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.outbound.length, 0);
});

test("Edge sender requires a valid actor before parsing body or reading provider config", { timeout: 2000 }, async () => {
  for (const authorization of [undefined, "", " ", "false", "Bearer ", "Bearer false", `bearer ${ACTOR}`]) {
    const fixture = edgeFixture(KEY);
    const res = await fixture.call(authorization);
    assert.equal(res.status, 401);
    assert.equal(fixture.events.includes("body"), false);
    assert.equal(fixture.events.includes("auth:membership"), false);
    assert.equal(fixture.events.includes("env:WAZZUP_API_KEY"), false);
    assert.equal(fixture.outbound.length, 0);
    assert.equal(fixture.writes.length, 0);
    fixture.check();
  }
});

test("Edge sender denies missing clinic membership before provider config, outbound or message write", { timeout: 2000 }, async () => {
  const fixture = edgeFixture(KEY, "send", false);
  const res = await fixture.call(`Bearer ${ACTOR}`);
  assert.equal(res.status, 403);
  assert.ok(fixture.events.includes("auth:membership-denied"));
  assert.equal(fixture.events.includes("env:WAZZUP_API_KEY"), false);
  assert.equal(fixture.outbound.length, 0);
  assert.equal(fixture.writes.length, 0);
});

test("Edge sender preflight and wrong methods never construct an SDK or reach outbound", { timeout: 2000 }, async () => {
  for (const [method, status] of [["OPTIONS", 200], ["GET", 405]] as const) {
    const fixture = edgeFixture(KEY);
    const res = await fixture.call(undefined, undefined, method);
    assert.equal(res.status, status);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.outbound.length, 0);
  }
});

test("Edge Wazzup helper is not an actor-auth boundary and caller headers override its API-key header", { timeout: 2000 }, async () => {
  const fixture = edgeFixture(KEY);
  await fixture.fetch("/message", { method: "POST", headers: { Authorization: "Bearer SYNTHETIC_OVERRIDE_ONLY" }, body: "{}" });
  assert.equal(fixture.outbound.length, 1);
  assert.equal(fixture.outbound[0].init.headers.Authorization, "Bearer SYNTHETIC_OVERRIDE_ONLY");
  assert.equal(fixture.events.includes("auth:user"), false);
  assert.equal(fixture.events.includes("auth:membership"), false);
  fixture.check();
});

test("SOURCE FINDING: Edge Wazzup webhook allows missing/empty CRM key; root webhook fails closed", { timeout: 2000 }, async () => {
  for (const value of [undefined, ""]) {
    const edge = edgeFixture(value, "webhook");
    const edgeRes = await edge.call();
    assert.equal(edgeRes.status, 200, "Characterize existing bypass, not desired authorization");
    assert.deepEqual(await edgeRes.json(), { ok: true, savedMessages: [], skippedMessages: [] });
    assert.ok(edge.events.includes("sdk:create"), "Unauthenticated request passes the gate and reaches the mocked SDK");
    assert.ok(edge.events.includes("body"));
    const rootFixture = rootWebhookFixture(value);
    assert.equal((await rootFixture.call()).statusCode, 503);
    assert.deepEqual(rootFixture.events, ["env:WAZZUP_WEBHOOK_SECRET"]);
    edge.check(); rootFixture.check();
  }
});

test("Edge webhook compares raw CRM keys while root webhook trims its separate secret", { timeout: 2000 }, async () => {
  for (const value of [" \t ", "false", ` \t${KEY}\r\n `]) {
    const edge = edgeFixture(value, "webhook");
    assert.equal(edge.keyMatches(undefined, value), true, "URL query preserves raw whitespace, unlike Headers");
    if (value !== value.trim()) assert.equal(edge.keyMatches(undefined, value.trim()), false);
    assert.equal((await edge.call(undefined, value)).status, 200);
    const rootFixture = rootWebhookFixture(value);
    assert.equal((await rootFixture.call(value)).statusCode, value.trim() ? 200 : 503);
    edge.check(); rootFixture.check();
  }
});

test("VM safety records forbidden operations even when a legacy catch swallows the thrown error", { timeout: 2000 }, () => {
  const guard = safety();
  evaluate({ relative: "synthetic-trap-probe", compiled: "try { fetch('https://forbidden.invalid'); } catch {}" }, {}, guard);
  assert.throws(guard.check, /unmocked fetch/);
});

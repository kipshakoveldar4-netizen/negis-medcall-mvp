import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { controllerActor, telegramControllerRpcFixture } from "./telegram-controller-rpc.fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiPath = "api/content-studio/[...path].ts";
// Explicit local baseline mode; ordinary regression runs always read the working API.
const baselineRef = process.env.MEDINA_TELEGRAM_PRIVACY_BASELINE_REF;
const baselineSource = baselineRef
  ? execFileSync("git", ["show", `${baselineRef}:${apiPath}`], { cwd: root, encoding: "utf8" })
  : undefined;
const markers = {
  token: "SYNTHETIC_NOT_A_REAL_BOT_TOKEN_PRIVACY_714",
  chat: "-1000000000714",
  customer: "SYNTHETIC_CUSTOMER_TEXT_PRIVACY_714",
  echo: "SYNTHETIC_ARBITRARY_REQUEST_ECHO_PRIVACY_714",
};
const botUrl = `https://api.telegram.org/bot${markers.token}/sendMessage`;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const videoId = "33333333-3333-4333-8333-333333333333";
const expectedUpdatedAt = "2026-10-24T08:00:00.123456+00:00";
const jsonContentType = "application/json; charset=utf-8";

type LocalResponse = {
  status(code: number): LocalResponse;
  setHeader(name: string, value: string): LocalResponse;
  json(payload: unknown): void;
};
type Selected = {
  handleSendTelegram(
    req: { body: Record<string, unknown> },
    res: LocalResponse,
    context: { workspaceId: string },
  ): Promise<unknown>;
  telegramHint(description: string, status: number): string;
};
type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  chat_id: string;
  text: string;
  part: number;
};

async function localFunctions(dependencies: Record<string, unknown>): Promise<Selected> {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const select = async (relativePath: string, names: string[]) => {
    const source = relativePath === apiPath && baselineSource !== undefined
      ? baselineSource : await readFile(path.join(root, relativePath), "utf8");
    const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return names.map((name) => {
      const matches = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.equal(matches.length, 1, `execute exactly one actual ${name} declaration`);
      return matches[0].getText(ast);
    }).join("\n");
  };
  // Execute actual declarations without importing providers, auth, CRM or application environment.
  const source = [
    await select("lib/content-studio/core.ts", ["telegramPackageText"]),
    await select(apiPath, [
      "sendJson", "readBody", "splitLongText", "splitTelegramMessage",
      "telegramHint", "readTelegramBody", "sendTelegramMessage", "handleSendTelegram",
    ]),
    "exports.selected = { handleSendTelegram, telegramHint };",
  ].join("\n");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported: { selected?: Selected } = {};
  new Script(compiled, { filename: "telegram-error-privacy.fixture.cjs" }).runInNewContext({
    ...telegramControllerRpcFixture(),
    ...dependencies,
    // Injected fetch/body failures must take the actual instanceof Error branch in the VM.
    Error,
    exports: exported,
    process: { env: Object.freeze({ TELEGRAM_BOT_TOKEN: markers.token, TELEGRAM_CHAT_ID: markers.chat }) },
  }, { timeout: 1000 });
  assert.equal(typeof exported.selected?.handleSendTelegram, "function");
  const selected = exported.selected!;
  return { ...selected, handleSendTelegram: (req, res, context) =>
    selected.handleSendTelegram(req, res, { ...controllerActor, ...context }) };
}

function acknowledgement(call: Call) {
  return { ok: true, result: {
    message_id: call.part, date: 0, chat: { id: -1000000000714 }, text: call.text,
  } };
}

function providerReply(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

function privatePayload(call: Call): string {
  return `provider request dump: ${call.url}; token=${markers.token}; private_chat=${markers.chat}; `
    + `customer=${markers.customer}; arbitrary_echo=${markers.echo}; request=${call.body}`;
}

async function deliver(replyFor: (call: Call) => FetchResponse | Promise<FetchResponse>, multipart = false) {
  const calls: Call[] = [], effects: string[] = [], writes: Record<string, unknown>[] = [];
  const selected = await localFunctions({
    async fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
      const body = JSON.parse(init.body) as { chat_id: string; text: string };
      const call = { url, ...init, ...body, part: calls.length + 1 };
      calls.push(call);
      if (calls.length > 3) throw new Error("Synthetic fixture dispatch limit exceeded");
      return replyFor(call);
    },
    updateContentVideo() { effects.push("local"); },
    async persistContentVideoPatchIfAvailable(input: Record<string, unknown>) {
      effects.push("persistent");
      writes.push(JSON.parse(JSON.stringify(input)) as Record<string, unknown>);
      return true;
    },
  });
  let status = 0;
  const headers: Record<string, string> = {}, replies: unknown[] = [];
  const response: LocalResponse = {
    status(code) { status = code; return this; },
    setHeader(name, value) { headers[name] = value; return this; },
    json(payload) { replies.push(payload); },
  };
  await selected.handleSendTelegram({ body: {
    title: markers.customer,
    hook: multipart ? "A".repeat(3200) : "Synthetic privacy fixture",
    script: markers.echo + (multipart ? "B".repeat(3200) : ""),
    ...(multipart ? { caption: "C".repeat(3200) } : {}),
    videoId,
    expectedUpdatedAt,
  } }, response, { workspaceId });
  assert.equal(replies.length, 1, "delivery produces exactly one public reply");
  for (const call of calls) {
    assert.equal(call.url, botUrl, "all dispatches use only the injected fake fetch");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.deepEqual(Object.keys(JSON.parse(call.body)).sort(), ["chat_id", "text"]);
    assert.equal(call.chat_id, markers.chat);
  }
  const reply = JSON.parse(JSON.stringify(replies[0])) as {
    success: boolean;
    error?: string;
    details?: string[];
    telegramDescription?: string;
    telegramErrorCode?: number;
    status?: number;
    part?: number;
    totalParts?: number;
    hint?: string;
    mode?: string;
    data?: { sent: boolean; parts: number; statusPersisted: boolean; packageText: string; test: boolean };
  };
  return { status, headers, reply, calls, effects, writes, selected };
}

type Delivery = Awaited<ReturnType<typeof deliver>>;

function assertFailure(result: Delivery, sends: number) {
  assert.equal(result.status, 502);
  assert.equal(result.headers["Content-Type"], jsonContentType);
  assert.equal(result.reply.success, false);
  assert.equal(typeof result.reply.error, "string");
  assert.ok(result.reply.error);
  assert.ok(Array.isArray(result.reply.details) && result.reply.details.length > 0);
  assert.equal(typeof result.reply.hint, "string");
  assert.ok(result.reply.hint);
  assert.equal(Object.hasOwn(result.reply, "data"), false, "no sent receipt on failure");
  assert.equal(result.calls.length, sends, "no retry or later-part dispatch after failure");
  assert.deepEqual(result.effects, [], "failure must not promote persistent or local readiness");
  assert.deepEqual(result.writes, []);
}

function assertPrivate(result: Delivery) {
  const serialized = JSON.stringify({ status: result.status, headers: result.headers, body: result.reply });
  for (const [name, marker] of Object.entries({ ...markers, botUrl })) {
    assert.equal(serialized.includes(marker), false, `public response must not expose synthetic ${name} marker`);
  }
}

const rejections = [
  { name: "unauthorized", status: 401, code: 401, reason: "Unauthorized" },
  { name: "missing chat", status: 400, code: 400, reason: "Bad Request: chat not found" },
  { name: "blocked bot", status: 403, code: 403, reason: "Forbidden: bot was blocked by the user" },
  { name: "oversized message", status: 400, code: 400, reason: "Bad Request: message is too long" },
  { name: "rate limit", status: 429, code: 429, reason: "Too Many Requests: retry after 30" },
  { name: "HTTP 200 logical rejection and arbitrary echo", status: 200, code: 400, reason: "Synthetic unclassified provider rejection" },
] as const;

for (const scenario of rejections) {
  test(`Telegram privacy: ${scenario.name} hides upstream description while preserving safe diagnostics`, async () => {
    const result = await deliver((call) => providerReply(scenario.status, {
      ok: false, error_code: scenario.code, description: `${scenario.reason}; ${privatePayload(call)}`,
    }));
    assertFailure(result, 1);
    assert.equal(result.reply.status, scenario.status);
    assert.equal(result.reply.telegramErrorCode, scenario.code);
    assert.equal(result.reply.totalParts, 1);
    assert.ok(result.reply.part === undefined || result.reply.part === 1);
    assert.equal(result.reply.hint, result.selected.telegramHint(scenario.reason, scenario.status));
    assertPrivate(result);
  });
}

test("Telegram privacy: non-JSON response never exposes its raw request dump", async () => {
  const result = await deliver((call) => ({ ok: false, status: 502, async text() { return privatePayload(call); } }));
  assertFailure(result, 1);
  assert.equal(result.reply.status, 502);
  assert.equal(result.reply.totalParts, 1);
  assert.equal(Object.hasOwn(result.reply, "telegramErrorCode"), false);
  assertPrivate(result);
});

for (const stage of ["network", "body-read"] as const) {
  test(`Telegram privacy: first-part ${stage} Error.message never exposes the request dump`, async () => {
    const result = await deliver((call) => {
      const failure = new Error(privatePayload(call));
      if (stage === "network") throw failure;
      return { ok: true, status: 200, async text() { throw failure; } };
    });
    assertFailure(result, 1);
    assertPrivate(result);
  });
}

for (const stage of ["provider", "network", "body-read"] as const) {
  test(`Telegram privacy: part 2/3 ${stage} failure stops delivery without persistence or request echo`, async () => {
    const reason = "Forbidden: bot was blocked by the user";
    const result = await deliver((call) => {
      if (call.part === 1) return providerReply(200, acknowledgement(call));
      const description = `${reason}; ${privatePayload(call)}`;
      if (stage === "provider") return providerReply(403, { ok: false, error_code: 403, description });
      if (stage === "network") throw new Error(description);
      return { ok: true, status: 200, async text() { throw new Error(description); } };
    }, true);
    assertFailure(result, 2);
    result.calls.forEach((call, index) => assert.ok(call.text.split("\n\n")[0].endsWith(` ${index + 1}/3`)));
    assert.ok(result.calls[0].text.includes(markers.customer));
    assert.ok(result.calls[1].text.includes(markers.echo));
    assert.ok(result.calls.every((call) => !call.text.includes("C".repeat(3200))), "part 3 is never sent");
    if (stage === "provider") {
      assert.equal(result.reply.status, 403);
      assert.equal(result.reply.telegramErrorCode, 403);
      assert.equal(result.reply.part, 2);
      assert.equal(result.reply.totalParts, 3);
      assert.equal(result.reply.hint, result.selected.telegramHint(reason, 403));
    }
    assertPrivate(result);
  });
}

for (const [name, errorCode] of [
  ["string request echo", markers.echo],
  ["fractional number", 429.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
] as const) {
  test(`Telegram privacy: ${name} error_code is not a public diagnostic`, async () => {
    const result = await deliver(() => providerReply(503, { ok: false, error_code: errorCode }));
    assertFailure(result, 1);
    assert.equal(result.reply.status, 503);
    assert.equal(result.reply.totalParts, 1);
    assert.equal(Object.hasOwn(result.reply, "telegramErrorCode"), false);
    assertPrivate(result);
  });
}

for (const malformed of ["missing result", "invalid message fields"] as const) {
  test(`Telegram privacy: ${malformed} acknowledgement stays unsent without exposing echoed fields`, async () => {
    const result = await deliver((call) => providerReply(200, malformed === "missing result"
      ? { ok: true, request_echo: privatePayload(call) }
      : { ok: true, result: { message_id: "1", date: 0, chat: { id: markers.chat }, text: privatePayload(call) } }));
    assertFailure(result, 1);
    assert.equal(result.reply.status, 200);
    assert.equal(result.reply.totalParts, 1);
    assertPrivate(result);
  });
}

test("Telegram privacy: valid sent-message acknowledgement still confirms delivery and conditional readiness", async () => {
  const result = await deliver((call) => providerReply(200, acknowledgement(call)));
  assert.equal(result.status, 200);
  assert.equal(result.headers["Content-Type"], jsonContentType);
  assert.equal(result.calls.length, 1);
  assert.equal(result.reply.success, true);
  assert.equal(result.reply.mode, "telegram");
  assert.equal(result.reply.data?.sent, true);
  assert.equal(result.reply.data?.parts, 1);
  assert.equal(result.reply.data?.test, false);
  assert.equal(result.reply.data?.statusPersisted, true);
  assert.equal(result.reply.data?.packageText, result.calls[0].text);
  assert.deepEqual(result.effects, ["persistent", "local"]);
  assert.deepEqual(result.writes, [{ videoId, workspaceId, patch: { status: "telegram_ready" }, expectedUpdatedAt }]);
});

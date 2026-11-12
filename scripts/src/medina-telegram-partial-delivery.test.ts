import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { controllerActor, telegramControllerRpcFixture } from "./telegram-controller-rpc.fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type LocalResponse = {
  status(code: number): LocalResponse;
  setHeader(name: string, value: string): LocalResponse;
  json(payload: unknown): void;
};
type TelegramHandler = (
  req: { body: Record<string, unknown> },
  res: LocalResponse,
  context: { workspaceId: string },
) => Promise<unknown>;

async function localHandler(dependencies: Record<string, unknown>, env: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "synthetic-not-a-bot-token",
  TELEGRAM_CHAT_ID: "-1007654321",
}): Promise<TelegramHandler> {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const select = async (relativePath: string, names: string[]) => {
    const source = await readFile(path.join(root, relativePath), "utf8");
    const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return names.map((name) => {
      const matches = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.equal(matches.length, 1, `execute exactly one actual ${name} declaration`);
      return matches[0].getText(ast);
    }).join("\n");
  };

  // Select real declarations without loading provider, CRM, auth or app environment imports.
  const source = [
    await select("lib/content-studio/core.ts", ["telegramPackageText"]),
    await select("api/content-studio/[...path].ts", [
      "sendJson", "readBody", "splitLongText", "splitTelegramMessage",
      "telegramHint", "readTelegramBody", "sendTelegramMessage", "handleSendTelegram",
    ]),
    "exports.selected = handleSendTelegram;",
  ].join("\n");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported: { selected?: TelegramHandler } = {};
  new Script(compiled, { filename: "telegram-partial-delivery.fixture.cjs" }).runInNewContext({
    ...telegramControllerRpcFixture(),
    ...dependencies,
    exports: exported,
    process: { env: Object.freeze({ ...env }) },
  }, { timeout: 1000 });
  assert.equal(typeof exported.selected, "function");
  const actual = exported.selected!;
  return (req, res, context) => actual(req, res, { ...controllerActor, ...context });
}

for (const isTest of [false, true]) {
  test(`G5C14 blank Telegram config with videoId (${isTest ? "test:true" : "non-test"}) stays unsent without fetch or status writes`, async () => {
    let fetches = 0;
    const effects: string[] = [];
    const handler = await localHandler({
      async fetch() { fetches++; throw new Error("No provider request allowed"); },
      updateContentVideo() { effects.push("local status write"); },
      async persistContentVideoPatchIfAvailable() { effects.push("persistent status write"); },
    }, { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" });
    let status = 0;
    const replies: unknown[] = [];
    const response: LocalResponse = {
      status(code) { status = code; return this; },
      setHeader() { return this; },
      json(payload) { replies.push(payload); },
    };
    await handler({ body: {
      title: "Synthetic unsent package",
      videoId: "33333333-3333-4333-8333-333333333333",
      ...(isTest ? { test: true } : {}),
    } }, response, { workspaceId: "11111111-1111-4111-8111-111111111111" });

    assert.equal(status, 200);
    assert.equal(replies.length, 1);
    const reply = JSON.parse(JSON.stringify(replies[0])) as {
      success: boolean; mode: string; warning?: string;
      data: { sent: boolean; test: boolean; packageText: string };
    };
    assert.equal(reply.success, true); assert.equal(reply.mode, "demo");
    assert.equal(reply.data.sent, false); assert.equal(reply.data.test, isTest);
    assert.equal(typeof reply.data.packageText, "string"); assert.ok(reply.data.packageText);
    assert.equal(typeof reply.warning, "string"); assert.ok(reply.warning);
    assert.equal(fetches, 0);
    assert.deepEqual(effects, [], "sent:false must not mark any local or persistent row telegram_ready");
  });
}

test("G5C14 server stops after part 2/3 fails without retry, status writes or a delivery receipt", { timeout: 5000 }, async () => {
  const calls: { chat_id: string; text: string }[] = [];
  const effects: string[] = [];
  let bodyReads = 0;
  let finishFirst!: () => void;
  const firstAcknowledgement = new Promise<void>((resolve) => { finishFirst = resolve; });
  let markFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirst = resolve; });
  const description = "Too Many Requests: retry after 30";
  const handler = await localHandler({
    async fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
      assert.equal(url, "https://api.telegram.org/botsynthetic-not-a-bot-token/sendMessage");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/json");
      const body = JSON.parse(init.body) as { chat_id: string; text: string };
      calls.push(body);
      const part = calls.length;
      assert.ok(part <= 2, "no retry or third-part dispatch is allowed after the rejection");
      assert.equal(body.chat_id, "-1007654321");
      assert.deepEqual(Object.keys(body).sort(), ["chat_id", "text"]);
      assert.ok(body.text.split("\n\n")[0].endsWith(` ${part}/3`));
      return {
        ok: part === 1,
        status: part === 1 ? 200 : 429,
        async text() {
          bodyReads++;
          if (part === 1) {
            markFirst();
            await firstAcknowledgement;
            return JSON.stringify({ ok: true, result: {
              message_id: 17, date: 0, chat: { id: -1007654321 }, text: body.text,
            } });
          }
          return JSON.stringify({ ok: false, error_code: 429, description });
        },
      };
    },
    updateContentVideo() { effects.push("local status write"); },
    async persistContentVideoPatchIfAvailable() { effects.push("persistent status write"); },
  });
  let status = 0;
  const replies: unknown[] = [];
  const headers: Record<string, string> = {};
  const response: LocalResponse = {
    status(code) { status = code; return this; },
    setHeader(name, value) { headers[name] = value; return this; },
    json(payload) { replies.push(payload); },
  };
  // Three paragraph-sized parts use the actual package formatter and splitter.
  const body = {
    title: "Synthetic partial delivery",
    hook: "A".repeat(3200),
    script: "B".repeat(3200),
    caption: "C".repeat(3200),
    videoId: "33333333-3333-4333-8333-333333333333",
    expectedUpdatedAt: "2026-10-24T08:00:00.123456+00:00",
  };
  const work = handler({ body }, response, { workspaceId: "11111111-1111-4111-8111-111111111111" });
  try {
    await Promise.race([firstStarted, work.then(() => assert.fail("handler must reach the held first acknowledgement"))]);
    assert.equal(calls.length, 1, "part 2 must wait for the first acknowledgement body");
    assert.deepEqual(effects, []);
    assert.deepEqual(replies, [], "an in-flight delivery cannot issue a receipt");
    finishFirst();
    await work;

    assert.equal(calls.length, 2, "part 1 is not repeated and part 3 is never attempted");
    assert.equal(bodyReads, 2);
    assert.ok(calls[0].text.includes(body.hook));
    assert.ok(calls[1].text.includes(body.script));
    assert.ok(calls.every((call) => !call.text.includes(body.caption)));
    assert.deepEqual(effects, [], "partial delivery must not mark the package telegram_ready");
    assert.equal(status, 502);
    assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(replies.length, 1);
    const reply = JSON.parse(JSON.stringify(replies[0])) as Record<string, unknown>;
    assert.deepEqual(reply, {
      success: false,
      error: "Telegram API request failed",
      details: ["Part 2/3: Telegram не подтвердил доставку сообщения."],
      telegramDescription: "Telegram не подтвердил доставку сообщения.",
      telegramErrorCode: 429,
      status: 429,
      part: 2,
      totalParts: 3,
      hint: reply.hint,
    });
    assert.equal(typeof reply.hint, "string");
    assert.ok(reply.hint);
    assert.equal("data" in reply, false, "never return sent:true or a full delivery receipt");
  } finally {
    finishFirst();
    await work;
  }
});

for (const outcome of ["success", "network-failure", "invalid-ack"] as const) {
  test(`G5C34 long Unicode package: ${outcome}, ordered chunks and no automatic retry`, async () => {
    const calls: { chat_id: string; text: string }[] = [], effects: string[] = [];
    const handler = await localHandler({
      async fetch(_url: string, init: { body: string }) {
        const body = JSON.parse(init.body) as { chat_id: string; text: string };
        calls.push(body);
        assert.ok(body.text.length <= 4096);
        for (let offset = 0; offset < body.text.length; offset++) {
          const unit = body.text.charCodeAt(offset);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = body.text.charCodeAt(++offset);
            assert.ok(next >= 0xdc00 && next <= 0xdfff, "no surrogate half crosses the provider boundary");
          } else assert.ok(unit < 0xdc00 || unit > 0xdfff);
        }
        if (calls.length === 2 && outcome === "network-failure") throw Error("Synthetic connection lost after the first acknowledgement");
        return { ok: true, status: 200, async text() {
          return JSON.stringify(calls.length === 2 && outcome === "invalid-ack" ? { ok: true } : {
            ok: true, result: { message_id: calls.length, date: 0, chat: { id: -1007654321 }, text: body.text },
          });
        } };
      },
      updateContentVideo() { effects.push("local"); },
      async persistContentVideoPatchIfAvailable(input: Record<string, unknown>) {
        effects.push("persistent");
        assert.equal(input.expectedUpdatedAt, "2026-10-24T08:00:00.123456+00:00");
        return true;
      },
    });
    let status = 0; let reply: any;
    const response: LocalResponse = { status(code) { status = code; return this; }, setHeader() { return this; }, json(body) { reply = body; } };
    await handler({ body: { title: "QA long Unicode", script: "A".repeat(3499) + "\uD83D\uDE00" + "B".repeat(3501),
      videoId: "33333333-3333-4333-8333-333333333333",
      expectedUpdatedAt: "2026-10-24T08:00:00.123456+00:00" } }, response, { workspaceId: "11111111-1111-4111-8111-111111111111" });
    assert.ok(calls.length >= 2);
    assert.equal(new Set(calls.map(call => call.text)).size, calls.length);
    calls.forEach((call, index) => assert.ok(call.text.split("\n\n")[0].includes(`часть ${index + 1}/`)));
    if (outcome === "success") {
      assert.equal(status, 200); assert.equal(reply.data.sent, true); assert.equal(reply.data.parts, calls.length);
      assert.equal(reply.data.statusPersisted, true);
      assert.deepEqual(effects, ["persistent", "local"], "memory readiness follows the confirmed conditional database write");
    } else {
      assert.equal(status, 502); assert.equal(calls.length, 2, "never repeat part one or dispatch part three after failure");
      assert.equal(reply.success, false); assert.equal(reply.data, undefined); assert.deepEqual(effects, []);
    }
  });
}

for (const version of [undefined, "invalid", "2026-10-24T08:00:00.123456+00:00"]) {
  test(`G5C37 compatibility videoId delivery does not promote memory after version refusal (${version ?? "missing"})`, async () => {
    const effects: string[] = [];
    let sends = 0;
    const handler = await localHandler({
      async fetch(_url: string, init: { body: string }) {
        sends++;
        return { ok: true, status: 200, async text() {
          return JSON.stringify({ ok: true, result: { message_id: 19, date: 0, chat: { id: -1007654321 }, text: JSON.parse(init.body).text } });
        } };
      },
      async persistContentVideoPatchIfAvailable(input: Record<string, unknown>) {
        effects.push("conditional persistence refused");
        assert.equal(input.expectedUpdatedAt, version);
        assert.equal(input.workspaceId, "11111111-1111-4111-8111-111111111111");
        assert.equal(input.videoId, "33333333-3333-4333-8333-333333333333");
        assert.deepEqual(JSON.parse(JSON.stringify(input.patch)), { status: "telegram_ready" });
        return false;
      },
      updateContentVideo() { effects.push("incorrect memory promotion"); },
    });
    let status = 0; let reply: any;
    const response: LocalResponse = { status(code) { status = code; return this; }, setHeader() { return this; }, json(body) { reply = body; } };
    await handler({ body: { title: "Synthetic CAS conflict", videoId: "33333333-3333-4333-8333-333333333333",
      ...(version === undefined ? {} : { expectedUpdatedAt: version }) } }, response,
    { workspaceId: "11111111-1111-4111-8111-111111111111" });
    if (version === undefined || version === "invalid") {
      assert.equal(status, 400); assert.equal(sends, 0);
      assert.deepEqual(effects, [], "invalid admission must precede any dispatch or status mutation");
      return;
    }
    assert.equal(status, 200); assert.equal(sends, 1);
    assert.equal(reply.data.sent, true, "physical delivery remains acknowledged, not a reason to resend");
    assert.equal(reply.data.statusPersisted, false, "no claim that the database accepted readiness");
    assert.deepEqual(effects, ["conditional persistence refused"]);
  });
}

test("G5C37 test:true with a legacy videoId never attempts readiness persistence", async () => {
  let sends = 0;
  const handler = await localHandler({
    async fetch(_url: string, init: { body: string }) {
      sends++;
      return { ok: true, status: 200, async text() {
        return JSON.stringify({ ok: true, result: { message_id: 20, date: 0, chat: { id: -1007654321 }, text: JSON.parse(init.body).text } });
      } };
    },
    async persistContentVideoPatchIfAvailable() { assert.fail("test packets do not update content rows"); },
    updateContentVideo() { assert.fail("test packets do not promote memory status"); },
  });
  let reply: any;
  const response: LocalResponse = { status() { return this; }, setHeader() { return this; }, json(body) { reply = body; } };
  await handler({ body: { test: true, testRequestId: "55555555-5555-4555-8555-555555555555",
    videoId: "33333333-3333-4333-8333-333333333333" } }, response,
    { workspaceId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(sends, 1); assert.equal(reply.data.sent, true); assert.equal(reply.data.test, true);
  assert.equal(Object.hasOwn(reply.data, "statusPersisted"), false);
});

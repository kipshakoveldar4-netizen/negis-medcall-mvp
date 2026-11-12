import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { resolveTelegramRecipient, admitTelegramDelivery } = await import(pathToFileURL(path.join(root, "lib/crm/telegram-delivery.ts")).href) as {
  resolveTelegramRecipient(input: { token: string; chatId: string; fetcher: typeof fetch }): Promise<string>;
  admitTelegramDelivery(input: Record<string, unknown>, client: unknown): Promise<unknown>;
};
const token = "synthetic-recipient-token", alias = "@OwnedQa";
const reply = (id: unknown = -100123, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: true, result: { id, type: "supergroup", username: "OwnedQa", ...extra } }));
const refused = (error: unknown) => {
  const value = error as { status?: number; code?: string; message?: string };
  assert.equal(value.status, 503);assert.equal(value.code, "telegram_recipient_unconfirmed");
  assert.doesNotMatch(String(value.message), /synthetic-recipient-token|OwnedQa|api\.telegram|PRIVATE/);
  return true;
};

test("the durable admission adapter cannot bypass resolution by accepting an alias", async () => {
  let calls = 0;
  await assert.rejects(() => admitTelegramDelivery({
    actor: { workspaceId: "11111111-1111-4111-8111-111111111111", staffUserId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333" },
    isTest: true, payload: { testRequestId: "44444444-4444-4444-8444-444444444444" },
    token, chatId: alias, packageText: "Owned package", parts: ["Owned package"],
  }, { async rpc() { calls++;throw Error("No admission allowed"); } }), (error: unknown) => {
    const value = error as { status?: number; code?: string };
    return value.status === 400 && value.code === "telegram_delivery_invalid";
  });
  assert.equal(calls, 0);
});

for (const chatId of ["1", "-1", "4503599627370495", "-4503599627370495"]) test("canonical numeric chat requires no lookup: " + chatId, async () => {
  let calls = 0;
  const result = await resolveTelegramRecipient({ token, chatId, fetcher: async () => { calls++;throw Error("No lookup allowed"); } });
  assert.equal(result, chatId);assert.equal(calls, 0);
});
for (const chatId of ["", "0", "-0", "+123", "0123", "123 ", "1e3", "4503599627370496", "-4503599627370496", "9007199254740991", "@a", "@OwnedQa/path"]) {
  test("invalid configured recipient refuses before any lookup: " + JSON.stringify(chatId), async () => {
    let calls = 0;
    await assert.rejects(() => resolveTelegramRecipient({ token, chatId, fetcher: async () => { calls++;throw Error("No lookup allowed"); } }), refused);
    assert.equal(calls, 0);
  });
}
for (const extra of [{ username: "OWNEDQA" }, { username: "MainAlias", active_usernames: ["OwnedQa", "OtherAlias"] }]) test("lookup pins the documented numeric ID for a matching active alias", async () => {
  let signal: AbortSignal | undefined, calls = 0;
  const id = await resolveTelegramRecipient({ token, chatId: alias, fetcher: async (url, init) => {
    calls++;assert.equal(url, `https://api.telegram.org/bot${token}/getChat`);
    assert.equal(init?.method, "POST");assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: alias });
    signal = init?.signal ?? undefined;assert.ok(signal instanceof AbortSignal);
    return reply(-100123, extra);
  } });
  assert.equal(id, "-100123");assert.equal(calls, 1);assert.equal(signal!.aborted, true, "The lookup owns and retires its signal");
});

for (const [name, make] of [
  ["network", async () => { throw Error("PRIVATE provider diagnostics " + token); }],
  ["HTTP refusal", async () => new Response("PRIVATE " + token, { status: 403 })],
  ["HTML", async () => new Response("<html>PRIVATE " + token + "</html>")],
  ["UTF-8", async () => new Response(new Uint8Array([0xc3, 0x28]))],
  ["empty object", async () => new Response("{}")],
  ["array envelope", async () => new Response("[]")],
  ["false success", async () => new Response(JSON.stringify({ ok: false, result: { id: -100123, type: "supergroup", username: "OwnedQa" } }))],
  ["string ID", async () => reply("-100123")],
  ["zero ID", async () => reply(0)],
  ["fractional ID", async () => reply(-100123.5)],
  ["oversized ID", async () => reply(2 ** 52)],
  ["private-chat alias", async () => reply(-100123, { type: "private" })],
  ["unrelated username", async () => reply(-100123, { username: "Unrelated" })],
  ["malformed aliases", async () => reply(-100123, { active_usernames: [null] })],
  ["redirected response", async () => { const response = reply();Object.defineProperty(response, "redirected", { value: true });return response; }],
] as Array<[string, () => Promise<Response>]>) test("unconfirmed lookup fails closed without diagnostics or retry: " + name, async () => {
  let calls = 0;
  await assert.rejects(() => resolveTelegramRecipient({ token, chatId: alias, fetcher: async () => { calls++;return make(); } }), refused);
  assert.equal(calls, 1);
});

test("lookup body has a real 64 KiB stream bound and cancels the owned reader", async () => {
  let cancelled = false, pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++;controller.enqueue(new Uint8Array(32 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(() => resolveTelegramRecipient({ token, chatId: alias, fetcher: async () => new Response(body) }), refused);
  assert.equal(cancelled, true);assert.ok(pulls <= 4, "The parser must not buffer an unbounded response before rejecting it");
});
test("a valid body exactly at the byte ceiling is accepted", async () => {
  const content = JSON.stringify({ ok: true, result: { id: -100123, type: "channel", username: "OwnedQa" } });
  const body = content + " ".repeat(64 * 1024 - Buffer.byteLength(content));
  assert.equal(await resolveTelegramRecipient({ token, chatId: alias, fetcher: async () => new Response(body) }), "-100123");
});
for (const phase of ["headers", "body"]) test("one bounded lookup deadline covers " + phase + " without retry or late adoption", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, signal: AbortSignal | undefined, cancelled = false;
  let release: ((response: Response) => void) | undefined;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = resolveTelegramRecipient({ token, chatId: alias, fetcher: async (_url, init) => {
    calls++;signal = init?.signal ?? undefined;
    return phase === "headers" ? new Promise<Response>(resolve => { release = resolve; }) : new Response(body);
  } });
  const failure = assert.rejects(pending, refused);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);await failure;
  assert.equal(signal!.aborted, true);assert.equal(calls, 1);
  if (phase === "headers") release!(new Response(body));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

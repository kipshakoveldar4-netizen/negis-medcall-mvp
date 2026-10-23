import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMediaDeliveryHttpFixture } from "./media-delivery-http-store.mjs";

const W1 = "aaaaaaaa-1111-4111-8111-111111111111";
const W2 = "bbbbbbbb-2222-4222-8222-222222222222";
const CONTROL = "/__fixture/media-delivery";
const VIDEO = "/api/content-studio/video-generation";
const TELEGRAM = "/api/content-studio/send-telegram";
const HANDLE = "synthetic-local-video-handle";
const videoPath = `${VIDEO}?workspaceId=${W1}&handle=${HANDLE}`;
const telegramPath = `${TELEGRAM}?workspaceId=${W1}`;
const auth = (actor = "A") => ({ Authorization: `Bearer fixture-ads-${actor}` });
const jsonHeaders = { "Content-Type": "application/json" };

async function until(predicate, message = "loopback fixture did not settle") {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function serverFixture(t) {
  const fixture = createMediaDeliveryHttpFixture();
  const clients = new Set(), arrivals = new Map(), unhandled = [];
  const server = createServer((req, res) => {
    arrivals.set(req.url, (arrivals.get(req.url) ?? 0) + 1);
    const handled = fixture.handle(req, res);
    assert.equal(typeof handled, "boolean", "middleware must return synchronously");
    if (!handled) {
      unhandled.push(req.url);
      req.resume(); res.writeHead(403); res.end("Unknown fixture path denied");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(address.address, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    fixture.close();
    for (const req of clients) req.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(fixture.snapshot().externalCalls, 0);
  });

  // Always connect to the ephemeral loopback listener, even for hostile raw targets/Host headers.
  function native(path, { method = "GET", headers = {}, body, stream = false } = {}) {
    let settled = false, headersSeen = false;
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers, agent: false,
      setHost: !Object.keys(headers).some((name) => name.toLowerCase() === "host"),
    });
    clients.add(req);
    req.once("close", () => clients.delete(req));
    req.setTimeout(3000, () => req.destroy(new Error("Loopback request timed out")));
    const done = new Promise((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => {
        headersSeen = true;
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("aborted", () => reject(new Error("Loopback response aborted")));
        res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    done.then(() => { settled = true; }, () => { settled = true; });
    if (stream) { req.flushHeaders(); if (body) req.write(body); }
    else req.end(body);
    return { req, done, get settled() { return settled; }, get headersSeen() { return headersSeen; } };
  }
  const call = (path, options) => native(path, options).done;
  const post = (path, body, headers = {}) => call(path, {
    method: "POST", headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(body),
  });
  const action = async (value) => {
    const result = await post(CONTROL, { action: value }, { Origin: origin });
    assert.equal(result.status, 200, `control action ${value}`);
    return JSON.parse(result.text);
  };
  const snapshot = async () => {
    const result = await call(CONTROL);
    assert.equal(result.status, 200);
    return JSON.parse(result.text);
  };
  const staged = async (path, prefix, headers = {}) => {
    const before = arrivals.get(path) ?? 0;
    const operation = native(path, {
      method: "POST", headers: { ...jsonHeaders, ...headers }, body: prefix, stream: true,
    });
    await until(() => (arrivals.get(path) ?? 0) > before, "streamed POST never reached the local store");
    return operation;
  };
  return { fixture, origin, native, call, post, action, snapshot, staged, unhandled };
}

function denied(result, status = 403) {
  assert.equal(result.status, status, result.text);
  if (result.text.startsWith("{")) {
    const body = JSON.parse(result.text);
    assert.equal(body.success, false);
    assert.equal(body.data, undefined);
  }
}

function completed(result) {
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.match(result.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(result.text), {
    success: true, mode: "synthetic", data: {
      status: "completed", progress: 100, creativeUrl: "/__fixture/synthetic.mp4",
      fileName: "synthetic.mp4", mimeType: "video/mp4", fileSize: 0,
    },
  });
}

test("fresh loopback control is synthetic, serializable and credential-free", async (t) => {
  const f = await serverFixture(t);
  const state = await f.snapshot();
  assert.deepEqual(state, {
    mode: "completed", telegram: "off", pending: 0, videoCompleted: 0, videoAborted: 0,
    externalCalls: 0, events: [], closed: false,
  });
  state.events.push({ resource: "forged" });
  assert.deepEqual((await f.snapshot()).events, []);
  assert.doesNotMatch(JSON.stringify(state), /Bearer|fixture-ads|api[_-]?key|access_token|https?:\/\//i);
});

test("only actor A can GET the fixed synthetic video; actor B is refused before tracing or counters", async (t) => {
  const f = await serverFixture(t);
  completed(await f.call(videoPath, { headers: { ...auth(), Origin: f.origin } }));
  await until(() => f.fixture.snapshot().videoCompleted === 1);
  const before = await f.snapshot();
  denied(await f.call(videoPath, { headers: auth("B") }));
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(before.events, [{ resource: "video", actor: "A", mode: "completed" }]);
  assert.equal(before.videoAborted, 0);
});

test("both synthetic actors may POST only test:true Telegram checks, never a delivery", async (t) => {
  const f = await serverFixture(t);
  for (const actor of ["A", "B"]) {
    const result = await f.post(telegramPath, { test: true }, auth(actor));
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    const reply = JSON.parse(result.text);
    assert.equal(reply.success, true); assert.equal(reply.mode, "demo");
    assert.equal(typeof reply.warning, "string"); assert.ok(reply.warning);
    assert.deepEqual(reply.data, { sent: false, test: true, packageText: "TEST synthetic connection" });
  }
  assert.deepEqual((await f.snapshot()).events, [
    { resource: "telegram", actor: "A", mode: "off" }, { resource: "telegram", actor: "B", mode: "off" },
  ]);
});

test("Host and Origin rejection precedes control mutations and authenticated media access", async (t) => {
  const f = await serverFixture(t), before = await f.snapshot();
  for (const headers of [
    { Host: "foreign.invalid" }, { Host: "127.0.0.1.foreign.invalid" }, { Host: "0.0.0.0" },
    { Host: "user@127.0.0.1" }, { Host: "" }, { Origin: "null" },
    { Origin: "https://foreign.invalid" }, { Origin: f.origin.replace("http:", "https:") },
    { Origin: "http://localhost:1" },
  ]) {
    const result = await f.call(CONTROL, { headers });
    assert.equal(result.status, 403, `Host/Origin guard: ${JSON.stringify(headers)}`);
    denied(result);
    denied(await f.post(CONTROL, { action: "missing" }, headers));
    denied(await f.call(videoPath, { headers: { ...auth(), ...headers } }));
    denied(await f.post(telegramPath, { test: true }, { ...auth(), ...headers }));
    assert.deepEqual(await f.snapshot(), before);
  }
  for (const host of [`localhost:${new URL(f.origin).port}`, `[::1]:${new URL(f.origin).port}`]) {
    assert.equal((await f.call(CONTROL, { headers: { Host: host, Origin: `http://${host}` } })).status, 200);
  }
});

test("an explicitly empty Origin is not the same as an absent Origin", async (t) => {
  const f = await serverFixture(t), before = await f.snapshot();
  const result = await f.post(CONTROL, { action: "missing" }, { Origin: "" });
  denied(result);
  assert.deepEqual(await f.snapshot(), before);
});

test("strict bearer and exact workspace/handle/query validation cannot create media events", async (t) => {
  const f = await serverFixture(t), before = await f.snapshot();
  for (const token of [undefined, "fixture-ads-A", "bearer fixture-ads-A", "Bearer fixture-ads-A-extra", "Bearer fixture-ads-C"]) {
    const headers = token === undefined ? {} : { Authorization: token };
    denied(await f.call(videoPath, { headers }));
    denied(await f.post(telegramPath, { test: true }, headers));
  }
  for (const query of ["", `?workspaceId=${W2}`, "?workspaceId=demo", `?workspaceId=${W1}&workspaceId=${W1}`]) {
    denied(await f.call(VIDEO + query + `${query ? "&" : "?"}handle=${HANDLE}`, { headers: auth() }));
    denied(await f.post(TELEGRAM + query, { test: true }, auth()));
  }
  for (const query of [
    `?workspaceId=${W1}`, `?workspaceId=${W1}&handle=unknown`,
    `?workspaceId=${W1}&handle=${HANDLE}&handle=${HANDLE}`,
    `?workspaceId=${W1}&handle=${HANDLE}&actor=A`,
  ]) denied(await f.call(VIDEO + query, { headers: auth() }));
  denied(await f.post(telegramPath + "&chatId=untrusted", { test: true }, auth()));
  assert.deepEqual(await f.snapshot(), before);
});

test("methods, unknown routes, quota mutations, generation and provider/storage writes stay denied", async (t) => {
  const f = await serverFixture(t);
  const usage = `/api/content-studio/usage?workspaceId=${W1}`;
  const videos = `/api/crm/content-videos?workspaceId=${W1}`;
  const baselineUsage = JSON.parse((await f.call(usage, { headers: auth() })).text);
  const baselineVideos = JSON.parse((await f.call(videos, { headers: auth() })).text);
  assert.equal(baselineUsage.data.textRequests, 1);
  assert.deepEqual(baselineVideos.data.videos, []);
  for (const [path, methods] of [
    [videoPath, ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
    [telegramPath, ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
    [CONTROL, ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]],
    [usage, ["POST", "PUT", "PATCH", "DELETE"]], [videos, ["POST", "PATCH", "DELETE"]],
  ]) for (const method of methods) denied(await f.call(path, { method, headers: auth() }));
  for (const path of [
    "/api/content-studio/generate-video", "/api/content-studio/generate-photo", "/api/content-studio/generate-package",
    "/api/content-studio/reserve-generation", "/api/crm/upload", "/api/crm/storage-health",
    "/api/crm/meta-launch", "/api/targeting/generate", "/__fixture/unknown", "/api/unknown",
  ]) for (const method of ["GET", "POST"]) {
    denied(await f.call(path, { method, headers: { ...auth(), ...jsonHeaders }, body: method === "POST" ? "{}" : undefined }));
    assert.ok(f.unhandled.includes(path), "unknown routes must reach the fail-closed wrapper");
  }
  assert.deepEqual(JSON.parse((await f.call(usage, { headers: auth() })).text), baselineUsage);
  assert.deepEqual(JSON.parse((await f.call(videos, { headers: auth() })).text), baselineVideos);
  assert.deepEqual((await f.snapshot()).events, []);
});

test("unknown controls and non-test Telegram payloads never mutate state or echo arbitrary content", async (t) => {
  const f = await serverFixture(t);
  await f.action("missing"); await f.action("telegram-partial");
  const before = await f.snapshot();
  for (const body of [null, [], 1, "reset", {}, { action: "launch" }, { action: "reset", extra: true },
    { command: "reset" }, { action: "telegram-send" }, { action: { value: "reset" } }]) {
    denied(await f.post(CONTROL, body), 400);
    assert.deepEqual(await f.snapshot(), before);
  }
  for (const body of [null, [], 1, {}, { test: false }, { test: "true" }, { test: true, chatId: "untrusted" },
    { test: true, videoId: "untrusted" }, { test: true, caption: "must not be echoed" }]) {
    const result = await f.post(telegramPath, body, auth());
    denied(result, 400); assert.doesNotMatch(result.text, /untrusted|must not be echoed/);
    assert.deepEqual(await f.snapshot(), before);
  }
  denied(await f.post(CONTROL + "?action=reset", { action: "reset" }), 400);
});

for (const [name, path, body] of [["control", CONTROL, '{"action":"reset"}'], ["Telegram", telegramPath, '{"test":true}']]) {
  test(`${name} rejects malformed JSON, UTF-8, media type and encoding before any mutation`, async (t) => {
    const f = await serverFixture(t), before = await f.snapshot();
    for (const [headers, value] of [
      [{ "Content-Type": "text/plain" }, body], [{ "Content-Type": "application/json; charset=iso-8859-1" }, body],
      [{ ...jsonHeaders, "Content-Encoding": "gzip" }, body], [jsonHeaders, "{"], [jsonHeaders, body + "{}"],
      [jsonHeaders, Buffer.concat([Buffer.from(body.slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from("}")])],
    ]) {
      denied(await f.call(path, { method: "POST", headers: { ...auth(), ...headers }, body: value }), 400);
      assert.deepEqual(await f.snapshot(), before);
    }
  });

  for (const chunked of [false, true]) test(`${name} rejects oversized ${chunked ? "chunked" : "Content-Length"} bodies without applying a valid prefix`, async (t) => {
    const f = await serverFixture(t);
    await f.action("missing");
    const before = await f.snapshot();
    const oversized = body + " ".repeat(20001);
    const operation = f.native(path, { method: "POST", headers: {
      ...auth(), ...jsonHeaders,
      ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(oversized) }),
    }, body: oversized });
    // A closed socket also denies the body; timeout or a successful response does not.
    try { denied(await operation.done, 400); }
    catch (error) { if (!["ECONNRESET", "EPIPE"].includes(error.code)) throw error; }
    assert.deepEqual(await f.snapshot(), before);
  });
}

test("missing URL stays a completed-but-fileless reply; available changes only server availability for retry", async (t) => {
  const f = await serverFixture(t);
  await f.action("missing");
  const missing = await f.call(videoPath, { headers: auth() });
  assert.equal(missing.status, 200);
  assert.deepEqual(JSON.parse(missing.text), { success: true, mode: "synthetic", data: { status: "completed", progress: 100 } });
  const before = await f.snapshot();
  const available = await f.action("available");
  assert.deepEqual(available, { ...before, mode: "completed" }, "available must not clear history, hold queues or fabricate another GET");
  completed(await f.call(videoPath, { headers: auth() }));
  await until(() => f.fixture.snapshot().videoCompleted === 2);
  assert.deepEqual((await f.snapshot()).events.map((event) => event.mode), ["missing", "completed"]);
});

test("Telegram off and partial are distinct synthetic HTTP outcomes, never sent:true", async (t) => {
  const f = await serverFixture(t);
  await f.action("telegram-partial");
  const partial = await f.post(telegramPath, { test: true }, auth());
  assert.equal(partial.status, 502);
  assert.deepEqual(JSON.parse(partial.text), {
    success: false, error: "Synthetic partial delivery", details: ["Part 2/3: synthetic refusal"], status: 429, part: 2, totalParts: 3,
  });
  await f.action("telegram-off");
  const off = JSON.parse((await f.post(telegramPath, { test: true }, auth())).text);
  assert.equal(off.mode, "demo"); assert.equal(off.data.sent, false); assert.equal(off.data.test, true);
  assert.deepEqual((await f.snapshot()).events.map((event) => event.mode), ["partial", "off"]);
  assert.equal(f.fixture.snapshot().videoCompleted, 0);
});

test("held video sends neither headers nor completion before cancellation; release cannot resurrect it", async (t) => {
  const f = await serverFixture(t);
  await f.action("held");
  const held = f.native(videoPath, { headers: auth() });
  await until(() => f.fixture.snapshot().pending === 1);
  assert.equal(held.headersSeen, false); assert.equal(held.settled, false);
  assert.equal(f.fixture.snapshot().videoCompleted, 0);
  held.req.destroy(new Error("Synthetic client cancellation"));
  await assert.rejects(held.done, /Synthetic client cancellation/);
  await until(() => f.fixture.snapshot().pending === 0 && f.fixture.snapshot().videoAborted === 1);
  const state = await f.action("release");
  assert.equal(state.pending, 0); assert.equal(state.videoCompleted, 0); assert.equal(state.videoAborted, 1);
  denied(await f.call(videoPath, { headers: auth("B") }));
  assert.deepEqual(await f.snapshot(), state);
});

test("release completes each held response once, keeps cancellation separate and is idempotent", async (t) => {
  const f = await serverFixture(t);
  await f.action("held");
  const first = f.native(videoPath, { headers: auth() });
  const second = f.native(videoPath, { headers: auth() });
  await until(() => f.fixture.snapshot().pending === 2);
  const available = await f.action("available");
  assert.equal(available.pending, 2); assert.equal(first.headersSeen, false); assert.equal(second.headersSeen, false);
  await f.action("release");
  completed(await first.done); completed(await second.done);
  await until(() => f.fixture.snapshot().videoCompleted === 2);
  const state = await f.snapshot();
  assert.equal(state.pending, 0); assert.equal(state.videoAborted, 0);
  assert.deepEqual(await f.action("release"), state);
});

test("reset destroys held video sockets and late close callbacks cannot pollute the fresh counters", async (t) => {
  const f = await serverFixture(t);
  await f.action("telegram-partial"); await f.action("held");
  const held = f.native(videoPath, { headers: auth() });
  await until(() => f.fixture.snapshot().pending === 1);
  await f.action("reset");
  await assert.rejects(held.done);
  const state = await f.snapshot();
  assert.deepEqual(state, {
    mode: "completed", telegram: "off", pending: 0, videoCompleted: 0, videoAborted: 0,
    externalCalls: 0, events: [], closed: false,
  });
  completed(await f.call(videoPath, { headers: auth() }));
  await until(() => f.fixture.snapshot().videoCompleted === 1);
  assert.equal(f.fixture.snapshot().videoAborted, 0);
});

test("close is idempotent, aborts held requests once and denies all new media/control requests", async (t) => {
  const f = await serverFixture(t);
  await f.action("held");
  const held = f.native(videoPath, { headers: auth() });
  await until(() => f.fixture.snapshot().pending === 1);
  f.fixture.close(); f.fixture.close();
  await assert.rejects(held.done);
  await until(() => f.fixture.snapshot().videoAborted === 1);
  denied(await f.call(CONTROL)); denied(await f.post(CONTROL, { action: "reset" }));
  denied(await f.call(videoPath, { headers: auth() })); denied(await f.post(telegramPath, { test: true }, auth()));
  assert.equal(f.fixture.snapshot().pending, 0); assert.equal(f.fixture.snapshot().videoCompleted, 0);
});

for (const kind of ["control", "Telegram"]) test(`close also fences an already-reading ${kind} POST`, async (t) => {
  const f = await serverFixture(t);
  const isControl = kind === "control";
  const operation = await f.staged(isControl ? CONTROL : telegramPath, isControl ? '{"action":' : '{"test":', auth());
  f.fixture.close();
  const before = f.fixture.snapshot();
  operation.req.end(isControl ? '"missing"}' : 'true}');
  const result = await operation.done.catch((error) => {
    assert.ok(["ECONNRESET", "EPIPE"].includes(error.code), error.message);
    return null;
  });
  assert.deepEqual(f.fixture.snapshot(), before, "a late body cannot change a closed store");
  if (result) assert.ok(result.status >= 400, "a closed fixture cannot acknowledge an in-flight mutation");
});

test("the 100-event ceiling is checked when concurrent Telegram bodies commit, not only at arrival", async (t) => {
  const f = await serverFixture(t);
  for (let i = 0; i < 99; i++) completed(await f.call(videoPath, { headers: auth() }));
  const first = await f.staged(telegramPath, '{"test":', auth());
  const second = await f.staged(telegramPath, '{"test":', auth());
  assert.equal(f.fixture.snapshot().events.length, 99);
  first.req.end("true}"); second.req.end("true}");
  const results = await Promise.all([first.done, second.done]);
  assert.equal(f.fixture.snapshot().events.length, 100, "streamed bodies must not overflow the bounded trace");
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 429]);
  denied(await f.call(videoPath, { headers: auth() }), 429);
});

for (const rawPath of [
  `/api/content-studio/not-allowed/../video-generation?workspaceId=${W1}&handle=${HANDLE}`,
  `http://foreign.invalid${videoPath}`,
]) test(`noncanonical raw request target is not an allowed media route: ${rawPath.split("?")[0]}`, async (t) => {
  const f = await serverFixture(t), before = await f.snapshot();
  denied(await f.call(rawPath, { headers: auth() }));
  assert.deepEqual(await f.snapshot(), before);
});

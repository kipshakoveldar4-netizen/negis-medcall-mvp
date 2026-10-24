import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createTelegramDeliveryHttpFixture } from "./telegram-delivery-http-store.mjs";

const W1 = "aaaaaaaa-1111-4111-8111-111111111111";
const W2 = "bbbbbbbb-2222-4222-8222-222222222222";
const CONTROL = "/__fixture/telegram-delivery";
const VIDEOS = `/api/crm/content-videos?workspaceId=${W1}`;
const SEND = `/api/content-studio/send-telegram?workspaceId=${W1}`;
const auth = (actor = "A") => ({ Authorization: `Bearer fixture-ads-${actor}` });
const jsonHeaders = (actor = "A") => ({ ...auth(actor), "Content-Type": "application/json" });
const readyPatch = (video) => ({ id: video.id, status: "telegram_ready", expectedUpdatedAt: video.updatedAt });

async function until(predicate) {
  for (let index = 0; index < 400; index++) { if (predicate()) return; await delay(5); }
  assert.fail("native fixture state did not settle");
}

async function serverFixture(t) {
  const fixture = createTelegramDeliveryHttpFixture();
  const server = createServer((req, res) => {
    const handled = fixture.handle(req, res);
    assert.equal(typeof handled, "boolean", "middleware handles synchronously");
    if (!handled) { req.resume(); res.writeHead(404); res.end("Not a fixture path"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  assert.equal(server.address().address, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    fixture.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  });
  const get = (path = VIDEOS, actor = "A") => fetch(base + path, { headers: auth(actor) });
  const post = (body, actor = "A", options = {}) => fetch(base + SEND, {
    ...options, method: "POST", headers: jsonHeaders(actor), body: JSON.stringify(body),
  });
  const patch = (body, actor = "A") => native(base, VIDEOS, {
    method: "PATCH", headers: jsonHeaders(actor), body: JSON.stringify(body),
  }).done;
  const command = async (action) => {
    const response = await fetch(base + CONTROL, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ action }) });
    assert.equal(response.status, 200, action); return response.json();
  };
  const video = async (actor = "A") => (await (await get(VIDEOS, actor)).json()).data.videos[0];
  return { fixture, server, base, get, post, patch, command, video };
}

// Native HTTP permits a body to remain unfinished across reset/close.
function native(base, path, { method = "GET", headers = {}, body, slow = false } = {}) {
  let headersSeen = false, text = "", status;
  const req = request(base, { path, method, headers, agent: false });
  const done = new Promise((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      headersSeen = true; status = res.statusCode;
      res.on("data", (chunk) => { text += chunk.toString(); });
      res.on("end", () => resolve({ status, text }));
      res.on("aborted", () => reject(new Error("response aborted"))); res.on("error", reject);
    });
  });
  done.catch(() => {});
  if (slow) { req.flushHeaders(); if (body) req.write(body); } else req.end(body);
  return { req, done, get headersSeen() { return headersSeen; }, get text() { return text; }, get status() { return status; } };
}

test("fresh snapshot is detached, bounded, synthetic and token-free", async (t) => {
  const f = await serverFixture(t);
  const first = f.fixture.snapshot();
  assert.deepEqual(first, { mode: "success", pending: [], received: [], receivedCount: 0, completed: 0,
    aborted: 0, statusWrites: 0, inFlight: 0, externalCalls: 0, closed: false });
  first.received.push({ actor: "foreign" });
  const remote = await (await fetch(f.base + CONTROL)).json();
  assert.deepEqual(remote, f.fixture.snapshot()); assert.deepEqual(remote.received, []);
  assert.doesNotMatch(JSON.stringify(remote), /Bearer|fixture-ads|authorization|https?:/i);
});

test("seeded GET is actor-separated, fully shaped, stable and A has exactly 7000 ASCII script characters", async (t) => {
  const f = await serverFixture(t);
  const [a, b] = await Promise.all([f.video(), f.video("B")]);
  assert.notEqual(a.id, b.id); assert.notEqual(a.title, b.title);
  for (const [actor, video] of [["A", a], ["B", b]]) {
    assert.match(video.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    for (const field of ["title", "niche", "goal", "duration", "style", "audience", "hook", "script", "voiceover", "cta", "caption", "avatarPrompt", "tapnowPrompt"])
      assert.equal(typeof video[field], "string", field);
    assert.equal(video.status, "idea"); assert.ok(Number.isFinite(Date.parse(video.createdAt)));
    assert.equal(video.updatedAt, "2026-10-23T08:00:00.123456Z");
    assert.equal(Object.hasOwn(video, "expectedUpdatedAt"), false);
    assert.ok(Array.isArray(video.hashtags) && video.hashtags.every((tag) => typeof tag === "string"));
    assert.match(video.title, new RegExp(`QA Telegram ${actor}`));
    assert.deepEqual(await f.video(actor), video);
  }
  assert.equal(a.script.length, 7000); assert.match(a.script, /^[\x00-\x7f]{7000}$/);
  assert.ok(b.script.length < 7000); assert.equal(f.fixture.snapshot().statusWrites, 0);
});

test("existing synthetic auth/status/usage are read-only, fixed to W1 and disabled for providers", async (t) => {
  const f = await serverFixture(t);
  for (const actor of ["A", "B"]) {
    const context = await (await f.get(`/api/crm/auth-context?workspaceId=${W1}`, actor)).json();
    assert.equal(context.data.userId, actor === "A" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222");
    assert.equal(context.data.workspaceId, W1);
    const status = await (await f.get(`/api/content-studio/status?workspaceId=${W1}`, actor)).json();
    assert.equal(status.data.configured, false); assert.equal(status.data.enabled, false);
    assert.equal(status.data.textEnabled, false); assert.equal(status.data.videoEnabled, false); assert.equal(status.data.imageEnabled, false);
    assert.equal((await (await f.get(`/api/content-studio/usage?workspaceId=${W1}`, actor)).json()).success, true);
  }
  for (const path of ["/api/crm/auth-context", "/api/content-studio/status", "/api/content-studio/usage"]) {
    assert.equal((await fetch(f.base + path + `?workspaceId=${W1}`, { method: "POST", headers: jsonHeaders(), body: "{}" })).status, 403);
    assert.equal((await f.get(path + `?workspaceId=${W2}`)).status, 403);
  }
  assert.equal((await fetch(f.base + "/__fixture/ads-reports", { method: "POST", headers: jsonHeaders(), body: '{"command":"reset"}' })).status, 403);
  assert.equal(f.fixture.snapshot().externalCalls, 0);
});

test("native PATCH accepts exactly the authenticated actor's own id/status/expectedUpdatedAt shape", async (t) => {
  const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
  for (const [actor, own, other] of [["A", a, b], ["B", b, a]]) {
    const valid = readyPatch(own);
    for (const body of [readyPatch(other), { ...valid, status: "idea" }, { ...valid, extra: true },
      { ...valid, updatedAt: own.updatedAt }, { id: own.id, status: "telegram_ready" }, { id: own.id },
      ...[null, 1, true, [], {}, ""].map((expectedUpdatedAt) => ({ ...valid, expectedUpdatedAt })), null, []]) {
      const response = await f.patch(body, actor);
      assert.equal(response.status, 400); assert.equal(f.fixture.snapshot().statusWrites, 0);
      assert.equal(JSON.parse(response.text).data, undefined);
    }
    assert.deepEqual(await f.video(actor), own);
  }
});

test("native correct CAS advances updatedAt, returns camelCase receipt and never stores expectedUpdatedAt", async (t) => {
  const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
  for (const [actor, original] of [["A", a], ["B", b]]) {
    const response = await f.patch(readyPatch(original), actor);
    assert.equal(response.status, 200);
    const receipt = JSON.parse(response.text), saved = receipt.data.video;
    assert.deepEqual(receipt, { success: true, mode: "supabase", data: {
      video: { ...original, status: "telegram_ready", updatedAt: saved.updatedAt },
    } });
    assert.match(saved.updatedAt, /^2026-10-23T08:00:00\.\d{6}Z$/);
    assert.ok(Date.parse(saved.updatedAt) > Date.parse(original.updatedAt));
    assert.equal(Object.hasOwn(saved, "expectedUpdatedAt"), false);
    assert.deepEqual(await f.video(actor), saved);
    if (actor === "A") assert.deepEqual(await f.video("B"), b);
  }
  assert.equal(f.fixture.snapshot().statusWrites, 2);
});

test("native stale CAS compares the exact microsecond token without rounding or changing content", async (t) => {
  const f = await serverFixture(t), a = await f.video();
  for (const expectedUpdatedAt of ["2026-10-23T08:00:00.123455Z", "2026-10-23T08:00:00.123457Z",
    new Date(a.updatedAt).toISOString()]) {
    assert.equal(Date.parse(expectedUpdatedAt), Date.parse(a.updatedAt), "Date alone cannot distinguish these versions");
    const response = await f.patch({ ...readyPatch(a), expectedUpdatedAt });
    assert.equal(response.status, 409);
    const body = JSON.parse(response.text);
    assert.equal(body.success, false); assert.equal(body.code, "content_version_conflict"); assert.equal(body.data, undefined);
    assert.deepEqual(await f.video(), a); assert.equal(f.fixture.snapshot().statusWrites, 0);
  }
});

test("native double CAS uploads race atomically with exactly one winner and stale replays stay rejected", async (t) => {
  const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
  const uploads = Array.from({ length: 2 }, () => native(f.base, VIDEOS, {
    method: "PATCH", headers: jsonHeaders(), slow: true, body: JSON.stringify(readyPatch(a)).slice(0, -1),
  }));
  await until(() => f.fixture.snapshot().inFlight === 2);
  for (const upload of uploads) upload.req.end("}");
  const replies = await Promise.all(uploads.map((upload) => upload.done));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  const saved = JSON.parse(replies.find((reply) => reply.status === 200).text).data.video;
  const conflict = JSON.parse(replies.find((reply) => reply.status === 409).text);
  assert.equal(conflict.code, "content_version_conflict"); assert.equal(conflict.data, undefined);
  assert.deepEqual(saved, { ...a, status: "telegram_ready", updatedAt: saved.updatedAt });
  assert.notEqual(saved.updatedAt, a.updatedAt); assert.equal(Object.hasOwn(saved, "expectedUpdatedAt"), false);
  const replay = await f.patch(readyPatch(a));
  assert.equal(replay.status, 409); assert.equal(JSON.parse(replay.text).code, "content_version_conflict");
  assert.deepEqual(await f.video(), saved); assert.deepEqual(await f.video("B"), b);
  assert.equal(f.fixture.snapshot().statusWrites, 1);
});

test("success text matches the actual ContentStudio formatter including every separator", async (t) => {
  const f = await serverFixture(t);
  const source = await readFile(new URL("../../artifacts/negis/src/pages/ContentStudio.tsx", import.meta.url), "utf8");
  const formatter = source.match(/function buildTelegramPackage\(video: ContentVideo\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(formatter, "actual formatter is still present");
  const format = runInNewContext(`(${formatter.replace("video: ContentVideo", "video")})`);
  for (const actor of ["A", "B"]) {
    const video = await f.video(actor), response = await f.post(video, actor);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, mode: "telegram", data: {
      sent: true, test: false, parts: 3, packageText: format(video),
    } });
  }
  const response = await f.post({ test: true }, "B");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "telegram"); assert.equal(body.data.test, true); assert.equal(body.data.sent, true);
  assert.equal(body.data.parts, 1); assert.match(body.data.packageText, /TEST ONLY/);
  await until(() => f.fixture.snapshot().completed === 3);
  assert.deepEqual(f.fixture.snapshot().received.map(({ actor, test }) => ({ actor, test })),
    [{ actor: "A", test: false }, { actor: "B", test: false }, { actor: "B", test: true }]);
  assert.equal(f.fixture.snapshot().statusWrites, 0, "only the browser's explicit PATCH may write a status");
});

test("delivery rejects foreign, edited, incomplete, extra-field and incorrectly typed bodies", async (t) => {
  const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
  for (const [actor, own, foreign] of [["A", a, b], ["B", b, a]]) {
    for (const body of [foreign, { ...own, title: "edited" }, { ...own, id: foreign.id }, { ...own, videoId: own.id },
      { ...own, hashtags: "#QA" }, { ...own, test: false }, { id: own.id }, { test: true, id: own.id },
      { test: "true" }, { test: false }, true, 1, "text", null, [], {}]) {
      assert.equal((await f.post(body, actor)).status, 400, JSON.stringify(body).slice(0, 100));
    }
  }
  assert.deepEqual(f.fixture.snapshot().received, []); assert.equal(f.fixture.snapshot().statusWrites, 0);
});

for (const phase of ["headers", "body"]) {
  test(`hold-${phase}: real fetch AbortController cancels A while B proceeds, with no status write`, async (t) => {
    const f = await serverFixture(t), a = await f.video();
    await f.command(`hold-${phase}`);
    const controller = new AbortController();
    const response = f.post(a, "A", { signal: controller.signal });
    const parsing = response.then((res) => res.json()); parsing.catch(() => {});
    await until(() => f.fixture.snapshot().pending.length === 1);
    const pending = f.fixture.snapshot().pending[0];
    assert.deepEqual({ actor: pending.actor, test: pending.test, phase: pending.phase }, { actor: "A", test: false, phase });
    if (phase === "body") assert.equal((await response).status, 200);
    await f.command("success");
    assert.equal((await f.post(await f.video("B"), "B")).status, 200);
    controller.abort(); await assert.rejects(parsing);
    await until(() => f.fixture.snapshot().pending.length === 0 && f.fixture.snapshot().aborted === 1);
    await f.command("release");
    assert.equal(f.fixture.snapshot().completed, 1); assert.equal(f.fixture.snapshot().statusWrites, 0);
  });

  test(`hold-${phase}: native headers/body really stall and release preserves the captured actor package`, async (t) => {
    const f = await serverFixture(t), a = await f.video();
    await f.command(`hold-${phase}`);
    const held = native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(a) });
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await until(() => held.text === "{");
    await delay(25);
    assert.equal(held.headersSeen, phase === "body"); assert.equal(held.text, phase === "body" ? "{" : "");
    await f.command("partial");
    assert.equal((await f.post(await f.video("B"), "B")).status, 502);
    await f.command("release");
    const reply = await held.done, body = JSON.parse(reply.text);
    assert.equal(reply.status, 200); assert.equal(body.mode, "telegram"); assert.equal(body.data.parts, 3);
    assert.ok(body.data.packageText.includes(a.script)); assert.ok(body.data.packageText.includes(a.title));
    assert.equal(f.fixture.snapshot().pending.length, 0); assert.equal(f.fixture.snapshot().statusWrites, 0);
  });

  test(`hold-${phase}: native send/edit-A/release keeps the old reply and stale CAS leaves newer content as idea`, async (t) => {
    const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
    await f.command(`hold-${phase}`);
    const held = native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(a) });
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await until(() => held.text === "{");
    const before = f.fixture.snapshot();
    const after = await f.command("edit-A"), edited = await f.video();
    assert.deepEqual(after.pending, before.pending); assert.equal(after.mode, before.mode);
    assert.deepEqual(edited, { ...a, caption: edited.caption, updatedAt: edited.updatedAt });
    assert.notEqual(edited.caption, a.caption); assert.notEqual(edited.updatedAt, a.updatedAt);
    assert.ok(Date.parse(edited.updatedAt) > Date.parse(a.updatedAt));
    assert.equal(edited.status, "idea"); assert.deepEqual(await f.video("B"), b);
    assert.equal(Object.hasOwn(edited, "expectedUpdatedAt"), false);
    assert.equal(held.headersSeen, phase === "body"); assert.equal(held.text, phase === "body" ? "{" : "");
    await f.command("release");
    const reply = await held.done, body = JSON.parse(reply.text);
    assert.equal(reply.status, 200); assert.equal(body.success, true); assert.equal(body.data.parts, 3);
    assert.ok(body.data.packageText.includes(`Caption:\n${a.caption}\n\n---\n\n`));
    assert.ok(body.data.packageText.includes(a.script)); assert.equal(body.data.packageText.includes(edited.caption), false);
    const stale = await f.patch(readyPatch(a));
    assert.equal(stale.status, 409); assert.equal(JSON.parse(stale.text).code, "content_version_conflict");
    assert.equal(JSON.parse(stale.text).data, undefined);
    assert.deepEqual(await f.video(), edited); assert.deepEqual(await f.video("B"), b);
    assert.equal(f.fixture.snapshot().pending.length, 0); assert.equal(f.fixture.snapshot().statusWrites, 0);
    assert.equal(f.fixture.snapshot().externalCalls, 0);
  });
}

test("edit-A is bounded to a held non-test A delivery and rejects arbitrary actor/content/version edits", async (t) => {
  const f = await serverFixture(t), a = await f.video(), b = await f.video("B");
  const edit = (body = { action: "edit-A" }, extraHeaders = {}) => native(f.base, CONTROL, {
    method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
  }).done;
  assert.equal((await edit()).status, 400);
  await f.command("hold-headers");
  const held = [native(f.base, SEND, { method: "POST", headers: jsonHeaders("B"), body: JSON.stringify(b) }),
    native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: '{"test":true}' })];
  await until(() => f.fixture.snapshot().pending.length === 2);
  assert.equal((await edit()).status, 400);
  held.push(native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(a) }));
  await until(() => f.fixture.snapshot().pending.length === 3);
  for (const body of [{ action: "edit-B" }, { action: "edit-A", actor: "B" }, { action: "edit-A", caption: "injected" },
    { action: "edit-A", updatedAt: "2026-10-23T08:00:00.999999Z" }, { action: "edit-A", status: "telegram_ready" }])
    assert.equal((await edit(body)).status, 400);
  for (const headers of [{ Origin: "null" }, { Origin: "https://foreign.invalid" }, { Host: "foreign.invalid" },
    { Origin: [f.base, f.base] }]) assert.equal((await edit({ action: "edit-A" }, headers)).status, 400);
  assert.deepEqual(await f.video(), a); assert.deepEqual(await f.video("B"), b);
  assert.equal((await edit()).status, 200);
  const edited = await f.video();
  assert.equal(edited.caption, "QA A caption edited while delivery was held");
  assert.equal((await edit()).status, 200);
  const editedAgain = await f.video();
  assert.deepEqual(editedAgain, { ...edited, updatedAt: editedAgain.updatedAt });
  assert.ok(Date.parse(editedAgain.updatedAt) > Date.parse(edited.updatedAt));
  assert.deepEqual(await f.video("B"), b); assert.equal(f.fixture.snapshot().statusWrites, 0);
  await f.command("release");
  for (const pending of held) assert.equal((await pending.done).status, 200);
  assert.equal((await edit()).status, 400);
  assert.deepEqual(await f.video(), editedAgain);
});

test("partial is a synthetic 502/429 part 2 of 3, never writes status or calls a provider", async (t) => {
  const f = await serverFixture(t), original = await f.video();
  await f.command("partial");
  const response = await f.post(original), body = await response.json();
  assert.equal(response.status, 502); assert.equal(body.success, false);
  assert.equal(body.status, 429); assert.equal(body.telegramErrorCode, 429);
  assert.equal(body.part, 2); assert.equal(body.totalParts, 3); assert.equal(body.data, undefined);
  assert.match(body.details[0], /synthetic/); assert.deepEqual(await f.video(), original);
  await until(() => f.fixture.snapshot().completed === 1);
  assert.equal(f.fixture.snapshot().statusWrites, 0); assert.equal(f.fixture.snapshot().externalCalls, 0);
});

for (const action of ["reset", "close"]) {
  test(`${action} destroys both held phases and late delivery/PATCH/control uploads cannot dispatch`, async (t) => {
    const f = await serverFixture(t), a = await f.video();
    const held = [];
    for (const phase of ["headers", "body"]) {
      await f.command(`hold-${phase}`);
      held.push(native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(a) }));
      await until(() => f.fixture.snapshot().pending.length === held.length);
    }
    await f.command("edit-A");
    assert.notEqual((await f.video()).updatedAt, a.updatedAt);
    const slowDelivery = native(f.base, SEND, { method: "POST", headers: jsonHeaders(), slow: true, body: '{"test":' });
    const slowPatch = native(f.base, VIDEOS, { method: "PATCH", headers: jsonHeaders(), slow: true, body: `{"id":"${a.id}","status":` });
    const slowControl = native(f.base, CONTROL, { method: "POST", headers: { "Content-Type": "application/json" }, slow: true, body: '{"action":' });
    await until(() => f.fixture.snapshot().inFlight === 5);
    if (action === "reset") await f.command("reset"); else f.fixture.close();
    slowDelivery.req.end("true}");
    slowPatch.req.end(`"telegram_ready","expectedUpdatedAt":"${a.updatedAt}"}`); slowControl.req.end('"partial"}');
    for (const pending of [...held, slowDelivery, slowPatch, slowControl]) await assert.rejects(pending.done);
    await delay(25);
    const state = f.fixture.snapshot();
    assert.equal(state.inFlight, 0); assert.deepEqual(state.pending, []); assert.equal(state.statusWrites, 0);
    assert.equal(state.externalCalls, 0); assert.equal(state.closed, action === "close");
    if (action === "reset") {
      assert.equal(state.mode, "success"); assert.deepEqual(state.received, []);
      assert.equal(state.completed, 0); assert.equal(state.aborted, 0); assert.equal(state.receivedCount, 0);
      assert.deepEqual(await f.video(), a); assert.equal((await f.post({ test: true })).status, 200);
    } else {
      assert.equal(state.aborted, 2); assert.equal(state.completed, 0);
      f.fixture.close();
      for (const path of [CONTROL, VIDEOS, SEND, `/api/crm/auth-context?workspaceId=${W1}`])
        assert.equal((await f.get(path)).status, 503);
    }
  });
}

test("exact fake bearer auth and one canonical W1 query apply to every data endpoint", async (t) => {
  const f = await serverFixture(t);
  for (const path of ["/api/crm/content-videos", "/api/content-studio/send-telegram", "/api/crm/auth-context", "/api/content-studio/status", "/api/content-studio/usage"]) {
    const method = path.endsWith("send-telegram") ? "POST" : "GET";
    for (const token of [undefined, "fixture-ads-A", "Bearer fixture-ads-A-extra", "bearer fixture-ads-A", "Bearer fixture-ads-C", "Bearer real-token"]) {
      const result = await native(f.base, path + `?workspaceId=${W1}`, { method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, body: method === "POST" ? '{"test":true}' : undefined }).done;
      assert.equal(result.status, 401); assert.equal(JSON.parse(result.text).data, undefined);
    }
    for (const query of ["", "?", `?workspaceId=${W2}`, `?workspaceId=${W1}&workspaceId=${W1}`,
      `?workspaceId=${W1}&actor=B`, `?%77orkspaceId=${W1}`, `?workspaceId=${W1}&`, `?workspaceId=${W1.toUpperCase()}`]) {
      const result = await native(f.base, path + query, { method, headers: jsonHeaders(), body: method === "POST" ? '{"test":true}' : undefined }).done;
      assert.equal(result.status, 403, path + query); assert.equal(JSON.parse(result.text).data, undefined);
    }
  }
  assert.deepEqual(f.fixture.snapshot().received, []);
});

test("malformed and noncanonical paths, foreign/null Origin, foreign Host and duplicate security headers are denied", async (t) => {
  const f = await serverFixture(t);
  for (const path of [CONTROL, VIDEOS, SEND, `/api/content-studio/usage?workspaceId=${W1}`]) {
    for (const extra of [{ Origin: "null" }, { Origin: "https://foreign.invalid" }, { Origin: "http://localhost:1" },
      { Host: "foreign.invalid" }, { Host: "127.0.0.2" }, { Host: "127.0.0.1:99999" },
      { Origin: [f.base, f.base] }, { Authorization: ["Bearer fixture-ads-A", "Bearer fixture-ads-B"] }]) {
      const reply = await native(f.base, path, { headers: { ...auth(), ...extra } }).done;
      assert.equal(reply.status, 400); assert.equal(JSON.parse(reply.text).data, undefined);
    }
  }
  for (const path of ["//api/crm/content-videos", `/api/crm/../crm/content-videos?workspaceId=${W1}`,
    `/api/crm/%63ontent-videos?workspaceId=${W1}`, `/%61pi/crm/content-videos?workspaceId=${W1}`,
    `${SEND}#fragment`, "http://foreign.invalid/api/crm/content-videos", "/api/%ff", "/api\\crm/content-videos"]) {
    assert.equal((await native(f.base, path, { headers: auth() }).done).status, 400, path);
  }
  for (const path of ["/api/content-studio/generate-video", "/api/crm/meta-launches", "/__fixture/ads-reports", "/__fixture/synthetic.mp4", "/api/crm/content-videos/"])
    assert.equal((await native(f.base, path, { headers: auth() }).done).status, 403, path);
  assert.equal((await f.get("/content-studio?telegram=delivery")).status, 404, "ordinary browser assets/routes remain main's responsibility");
  assert.equal((await native(f.base, VIDEOS, { headers: { ...auth(), Origin: f.base } }).done).status, 200);
});

test("remote address must be loopback even with otherwise valid Host and auth", () => {
  const fixture = createTelegramDeliveryHttpFixture();
  let status, body;
  const req = { url: VIDEOS, method: "GET", headers: { host: "127.0.0.1:5242", authorization: "Bearer fixture-ads-A" },
    rawHeaders: ["Host", "127.0.0.1:5242", "Authorization", "Bearer fixture-ads-A"], socket: { remoteAddress: "192.0.2.1" }, resume() {} };
  const res = { writeHead(value) { status = value; }, end(text) { body = JSON.parse(text); } };
  assert.equal(fixture.handle(req, res), true); assert.equal(status, 400); assert.equal(body.data, undefined);
  fixture.close();
});

test("JSON media type, UTF-8, encoding, 40KB cap and exact control shape fail closed", async (t) => {
  const f = await serverFixture(t);
  for (const path of [SEND, VIDEOS, CONTROL]) {
    const method = path === VIDEOS ? "PATCH" : "POST";
    for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Type": "application/json; charset=latin1" },
      { "Content-Type": "application/json", "Content-Encoding": "identity" }, { "Content-Type": "application/json", "Content-Encoding": "gzip" }, {}]) {
      const response = await native(f.base, path, { method, headers: { ...auth(), ...headers }, body: '{"test":true}' }).done;
      assert.equal(response.status, 400);
    }
    for (const body of ["{", "", Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]), Buffer.from("\ufeff{}")]) {
      assert.equal((await native(f.base, path, { method, headers: jsonHeaders(), body }).done).status, 400);
    }
    assert.equal((await native(f.base, path, { method, headers: { ...jsonHeaders(), "Content-Length": 40961 }, body: " ".repeat(40961) }).done).status, 413);
    assert.equal((await native(f.base, path, { method, headers: jsonHeaders(), body: " ".repeat(40961) }).done).status, 413);
  }
  const exactCap = `${" ".repeat(40960 - 13)}{"test":true}`;
  assert.equal(Buffer.byteLength(exactCap), 40960);
  assert.equal((await native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: exactCap }).done).status, 200);
  for (const body of [null, [], true, {}, { action: "unknown" }, { action: "reset", extra: true }, { command: "reset" }])
    assert.equal((await native(f.base, CONTROL, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) }).done).status, 400);
  assert.equal((await native(f.base, CONTROL + "?extra=1").done).status, 400);
  assert.equal((await native(f.base, CONTROL, { method: "PATCH" }).done).status, 403);
  assert.equal(f.fixture.snapshot().statusWrites, 0); assert.equal(f.fixture.snapshot().externalCalls, 0);
});

test("pending uploads/replies are capped at 32, control reset stays available, journal retains only 64 entries", async (t) => {
  const f = await serverFixture(t);
  for (let index = 0; index < 70; index++) assert.equal((await f.post({ test: true }, index % 2 ? "B" : "A")).status, 200);
  await until(() => f.fixture.snapshot().completed === 70);
  const journal = f.fixture.snapshot();
  assert.equal(journal.received.length, 64); assert.equal(journal.receivedCount, 70);
  assert.equal(new Set(journal.received.map((entry) => entry.id)).size, 64);
  await f.command("reset"); await f.command("hold-headers");
  const requests = [];
  for (let index = 0; index < 32; index++) {
    requests.push(native(f.base, SEND, { method: "POST", headers: jsonHeaders(), body: '{"test":true}' }));
    await until(() => f.fixture.snapshot().pending.length === requests.length);
  }
  assert.equal((await f.post({ test: true })).status, 503);
  assert.equal(f.fixture.snapshot().pending.length, 32);
  await f.command("reset");
  for (const held of requests) await assert.rejects(held.done);
  assert.deepEqual(f.fixture.snapshot().received, []); assert.equal(f.fixture.snapshot().inFlight, 0);
});

test("explicit browser reset clears only W1 fixture library/job and validated own actor/video guard keys", async () => {
  const source = await readFile(new URL("./telegram-delivery-browser.tsx", import.meta.url), "utf8");
  const reset = source.match(/function clearFixtureStorage\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(reset);
  assert.match(source, /if \(action === "reset"\) \{\s*clearFixtureStorage\(\); reportsAuthFixture\.reset\(\); setPageEpoch/);
  assert.equal(source.match(/clearFixtureStorage\(\);/g)?.length, 1, "never clear receipts on reload/mount");
  const reportIds = { A: "11111111-1111-4111-8111-111111111111", B: "22222222-2222-4222-8222-222222222222", W1 };
  const ideaA = "a7000000-1111-4111-8111-111111111111", ideaB = "b7000000-2222-4222-8222-222222222222";
  const digest = "a".repeat(64), prefix = "negis_telegram_delivery_v1::";
  const key = (scope) => prefix + JSON.stringify(scope);
  const own = [key([reportIds.A, W1, ideaA, digest]), key([reportIds.B, W1, ideaB, "0".repeat(64)]),
    `negis_content_studio_videos::${W1}`, `negis_content_studio_video_job::${W1}`];
  const foreign = ["unrelated", "negis_content_studio_videos", `negis_content_studio_videos::${W2}`,
    `negis_content_studio_video_job::${W2}`, prefix + "broken-json", key(["foreign", W1, ideaA, digest]),
    key([reportIds.A, W2, ideaA, digest]), key([reportIds.A, W1, ideaB, digest]), key([reportIds.B, W1, ideaA, digest]),
    key([reportIds.A, W1, "foreign-video", digest]), key([reportIds.A, W1, ideaA, "bad-digest"]),
    key([reportIds.A, W1, ideaA, digest, "extra"]), key({ actor: reportIds.A, workspace: W1 }), key(null),
    key(["__proto__", W1, ideaA, digest])];
  const entries = new Map([...own, ...foreign].map((name) => [name, "unchanged-value"]));
  const localStorage = { get length() { return entries.size; }, key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(name) { entries.delete(name); } };
  runInNewContext(`${stripTypeScriptTypes(reset)}\nclearFixtureStorage();`, { window: { localStorage }, reportIds });
  assert.deepEqual([...entries.keys()], foreign);
  assert.ok([...entries.values()].every((value) => value === "unchanged-value"));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; assert.fail("External fetch is forbidden in the Content Studio fixture"); };
const require = createRequire(import.meta.url);
const { contentStudioFixtureIds: ids, createContentStudioBrowserFixture, isContentStudioFixtureLocation } = require("./content-studio-browser-store.ts");
const { demoContentPackage } = require("../../lib/content-studio/core.ts");
test.after(() => { globalThis.fetch = originalFetch; assert.equal(externalCalls, 0); });

const target = (path = "/api/crm/content-videos") => new URL(`${path}?workspaceId=${ids.workspace}`, "http://fixture.invalid");
const scope = (fixture, overrides = {}) => ({ expectedUserId: fixture.snapshot().actorId,
  signal: new AbortController().signal, dispatchGuard: () => true, ...overrides });
const brief = { mode: "idea", format: "reels", service: "TEST fabricated service", city: "TEST city", offer: "TEST offer",
  audience: "TEST audience", goal: "leads", tone: "TEST tone", materialNotes: "" };

test("fresh node --import tsx ESM loading resolves the real core demo export without a prior require cache", () => {
  const moduleUrl = new URL("./content-studio-browser-store.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { assert.fail('External fetch is forbidden in the ESM import fixture'); };
    const { contentStudioFixtureIds: ids, createContentStudioBrowserFixture } = await import(${JSON.stringify(moduleUrl)});
    const fixture = createContentStudioBrowserFixture();
    const response = await fixture.request(new URL('/api/content-studio/generate-package?workspaceId=' + ids.workspace, 'http://fixture.invalid'), {
      method: 'POST', expectedUserId: ids.A, signal: new AbortController().signal, dispatchGuard: () => true,
      body: JSON.stringify(${JSON.stringify(brief)})
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.mode, 'demo');
    assert.equal(body.data.adVariants.length, 3);
    assert.ok(body.data.script.includes(${JSON.stringify(brief.service)}));
    assert.equal(body.data.ideaTitle, ${JSON.stringify(demoContentPackage(brief).ideaTitle)});
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public activation is restricted to the exact single-query HTTP loopback Content Studio route", () => {
  const location = { protocol: "http:", hostname: "127.0.0.1", pathname: "/content-studio", search: "?contentStudio=handoff" };
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) assert.equal(isContentStudioFixtureLocation({ ...location, hostname }), true);
  for (const change of [
    { protocol: "https:" }, { protocol: "file:" }, { hostname: "preview.invalid" }, { hostname: "localhost.invalid" },
    { hostname: "127.0.0.2" }, { hostname: "0.0.0.0" }, { hostname: "::1" }, { pathname: "/content-studio/" },
    { pathname: "/ads-automation" }, { pathname: "/" }, { search: "" }, { search: "?contentStudio=other" },
    { search: "?contentStudio=Handoff" }, { search: "?contentStudio=handoff&contentStudio=handoff" },
    { search: "?contentStudio=handoff&other=1" },
  ]) assert.equal(isContentStudioFixtureLocation({ ...location, ...change }), false);
  assert.equal(isContentStudioFixtureLocation({}), false);
});

test("fixture IDs, immutable snapshots and subscriptions expose only synthetic actor/workspace state", () => {
  assert.deepEqual(Object.values(ids), [1501, 1502, 1503, 1504, 1505].map((suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`));
  const fixture = createContentStudioBrowserFixture(), first = fixture.snapshot();
  assert.equal(Object.isFrozen(ids), true); assert.equal(Object.isFrozen(first), true); assert.equal(fixture.snapshot(), first);
  assert.equal(first.actor, "A"); assert.equal(first.actorId, ids.A); assert.equal(first.workspaceId, ids.workspace);
  assert.equal(first.sdkReads, 0); assert.equal(first.sdkHeld, 0); assert.equal(first.held, 0); assert.equal(first.armed, false);
  assert.equal(first.calls, 0); assert.equal(first.blocked, 0);
  let notifications = 0; const unsubscribe = fixture.subscribe(() => { notifications++; });
  fixture.switchActor(); assert.equal(notifications, 1); assert.notEqual(fixture.snapshot(), first);
  unsubscribe(); fixture.switchActor(); assert.equal(notifications, 1); assert.equal(first.actor, "A");
});

test("sync session and async getSession return fresh synthetic objects without sharing mutable SDK state", async () => {
  const fixture = createContentStudioBrowserFixture(), initial = fixture.session();
  assert.equal(initial.user.id, ids.A); assert.match(initial.access_token, /^content-studio-fixture-invalid-token-/);
  initial.user.id = "synthetic-corruption";
  const result = await fixture.getSession(); assert.equal(result.error, null); assert.equal(result.data.session.user.id, ids.A);
  assert.equal(fixture.snapshot().sdkReads, 1); result.data.session.user.id = "synthetic-corruption";
  assert.equal(fixture.session().user.id, ids.A);
});

test("raw ABA updates bound auth and emits B then A synchronously before one parent snapshot notification", () => {
  const fixture = createContentStudioBrowserFixture(); let bound;
  fixture.bindAuth((state) => { bound = state; });
  const events = [];
  const { data: { subscription } } = fixture.onAuthStateChange((event, session) => {
    assert.equal(bound.actorId, session.user.id); assert.equal(fixture.session().user.id, session.user.id);
    events.push([event, session.user.id]);
  });
  let notifications = 0; fixture.subscribe(() => { notifications++; }); fixture.switchABA();
  assert.deepEqual(events, [["SIGNED_IN", ids.B], ["SIGNED_IN", ids.A]]); assert.equal(notifications, 1);
  assert.equal(fixture.snapshot().revision, 2); assert.equal(fixture.snapshot().authEvents, 2); assert.equal(bound.actorId, ids.A);
  subscription.unsubscribe(); fixture.switchActor(); assert.equal(events.length, 2); assert.equal(bound.actorId, ids.B);
});

test("same-actor refresh changes only the synthetic token and refresh/event counters, not lifetime revision", () => {
  const fixture = createContentStudioBrowserFixture(); const original = fixture.session(); let bound;
  fixture.bindAuth((state) => { bound = state; }); const events = [];
  fixture.onAuthStateChange((event, session) => events.push([event, session.user.id])); fixture.refreshSameActor();
  assert.equal(bound.actorId, ids.A); assert.equal(fixture.snapshot().revision, 0); assert.equal(fixture.snapshot().refreshes, 1);
  assert.equal(fixture.snapshot().authEvents, 1); assert.notEqual(fixture.session().access_token, original.access_token);
  assert.deepEqual(events, [["TOKEN_REFRESHED", ids.A]]);
});

test("one-shot SDK hold captures the original read while other actor reads continue and cannot queue another hold", async () => {
  const fixture = createContentStudioBrowserFixture(); assert.equal(fixture.armNextSdk(), true); assert.equal(fixture.armNextSdk(), false);
  let settled = false; const pending = fixture.getSession().then((value) => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(fixture.snapshot().armed, false); assert.equal(fixture.snapshot().sdkHeld, 1);
  assert.equal(fixture.armNextSdk(), false); fixture.switchActor();
  assert.equal((await fixture.getSession()).data.session.user.id, ids.B); assert.equal(settled, false); assert.equal(fixture.snapshot().sdkReads, 2);
  assert.equal(fixture.release(), true); assert.equal(fixture.snapshot().sdkHeld, 0); assert.equal((await pending).data.session.user.id, ids.A);
  assert.equal(fixture.release(), false); assert.equal(fixture.armNextSdk(), true);
  const next = fixture.getSession(); fixture.release(); assert.equal((await next).data.session.user.id, ids.B);
});

test("SDK held read survives raw ABA and same-actor refresh for the real caller to accept or suppress", async () => {
  const fixture = createContentStudioBrowserFixture(); fixture.armNextSdk(); const before = fixture.session(), pending = fixture.getSession();
  fixture.switchABA(); fixture.refreshSameActor(); fixture.release();
  assert.deepEqual((await pending).data.session, before); assert.equal(fixture.snapshot().actorId, ids.A);
  assert.equal(fixture.snapshot().revision, 2); assert.notEqual(fixture.session().access_token, before.access_token);
});

test("readonly library returns one complete fabricated UUID idea per actor without mutable server storage", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const actor of ["A", "B"]) {
    const response = await fixture.request(target(), scope(fixture)); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.success, true); assert.equal(body.mode, "supabase"); assert.equal(body.data.videos.length, 1);
    const [row] = body.data.videos; assert.equal(row.id, actor === "A" ? ids.ideaA : ids.ideaB); assert.equal(row.title, `TEST local ${actor}`);
    assert.equal(row.status, "script_ready"); assert.ok(Number.isFinite(Date.parse(row.createdAt)));
    for (const key of ["niche", "goal", "duration", "style", "audience", "script", "caption", "avatarPrompt", "tapnowPrompt"]) assert.ok(typeof row[key] === "string" && row[key].trim());
    for (const key of ["script", "caption", "avatarPrompt", "tapnowPrompt"]) assert.ok(row[key].startsWith("TEST"));
    row.title = "synthetic corruption"; assert.equal((await (await fixture.request(target(), scope(fixture))).json()).data.videos[0].title, `TEST local ${actor}`);
    fixture.switchActor();
  }
  assert.equal(fixture.snapshot().blocked, 0);
});

test("usage never grants a paid subscription or enabled image/video capacity", async () => {
  const fixture = createContentStudioBrowserFixture(), body = await (await fixture.request(target("/api/content-studio/usage"), scope(fixture))).json();
  assert.equal(body.success, true); assert.equal(body.data.trackingAvailable, true); assert.equal(body.data.subscriptionActive, false);
  assert.equal(body.data.plan, null); assert.equal(body.data.videoSecondsPerGeneration, 8);
  for (const kind of ["images", "videoSeconds"]) assert.deepEqual(body.data[kind], { used: 0, enabled: false, limit: 0, remaining: 0 });
});

test("bounded package POST uses the existing pure demo function and cannot produce a server receipt", async () => {
  const fixture = createContentStudioBrowserFixture();
  const response = await fixture.request(target("/api/content-studio/generate-package"), scope(fixture, { method: "POST", body: JSON.stringify(brief) }));
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.mode, "demo"); assert.equal(body.success, true);
  assert.deepEqual(body.data, demoContentPackage(brief)); assert.equal(body.data.adVariants.length, 3); assert.ok(body.data.script); assert.ok(body.data.shotList.length);
  assert.equal("video" in body.data, false); assert.equal("id" in body.data, false); assert.equal(fixture.snapshot().calls, 1);
});

test("malformed or unbounded package briefs are refused rather than normalized into fake generated success", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const body of [undefined, "bad JSON", "null", "[]", "{}", " ".repeat(20_001), JSON.stringify({ ...brief, service: {} }),
    JSON.stringify({ ...brief, materialNotes: "x".repeat(2_001) }), JSON.stringify({ ...brief, tone: undefined }), JSON.stringify({ ...brief, workspaceId: ids.B })]) {
    const response = await fixture.request(target("/api/content-studio/generate-package"), scope(fixture, { method: "POST", body }));
    assert.equal(response.status, 400); assert.equal((await response.json()).success, false);
  }
  assert.equal(fixture.snapshot().blocked, 10);
});

test("all library POST/PATCH attempts return 501 and leave actor data unchanged without fabricating receipts", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const method of ["POST", "PATCH"]) {
    const response = await fixture.request(target(), scope(fixture, { method, body: JSON.stringify({ ...brief, id: ids.ideaA, status: "telegram_ready" }) }));
    assert.equal(response.status, 501); const body = await response.json(); assert.equal(body.success, false); assert.equal(body.data, undefined);
  }
  const [row] = (await (await fixture.request(target(), scope(fixture))).json()).data.videos;
  assert.equal(row.id, ids.ideaA); assert.equal(row.status, "script_ready"); assert.equal(fixture.snapshot().blocked, 2);
});

test("paid generation, poll, Telegram, storage, Meta, unknown CRM and unsupported methods always fail closed", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const path of ["/api/content-studio/generate-photo", "/api/content-studio/generate-video", "/api/content-studio/video-generation",
    "/api/content-studio/send-telegram", "/api/content-studio/generate-script", "/api/crm/ad-creatives/signed-upload",
    "/api/crm/ad-creatives", "/storage/v1/object", "/api/meta/launch", "/api/crm/clients", "/api/crm/content-videos/one"]) {
    for (const method of ["GET", "POST"]) {
      const response = await fixture.request(target(path), scope(fixture, { method })); assert.equal(response.status, 403); assert.equal((await response.json()).success, false);
    }
  }
  for (const method of ["DELETE", "PUT", "HEAD", "OPTIONS"]) assert.equal((await fixture.request(target(), scope(fixture, { method }))).status, 403);
  assert.equal((await fixture.request(target("/api/content-studio/usage"), scope(fixture, { method: "POST" }))).status, 403);
  assert.equal((await fixture.request(target("/api/content-studio/generate-package"), scope(fixture))).status, 403);
});

test("request URLs require the exact fake origin and a single fixed workspace without duplicates or hidden alternatives", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const url of [
    new URL("http://external.invalid/api/crm/content-videos?workspaceId=" + ids.workspace),
    new URL(target().href.replace("http:", "https:")), new URL(target().href.replace("fixture.invalid", "fixture.invalid:1234")),
    new URL(target().href.replace("fixture.invalid", "user@fixture.invalid")), new URL(target().href + "#hidden"),
    new URL(target().href.replace(ids.workspace, ids.B)), new URL("/api/crm/content-videos", target()),
    new URL(target().href + "&workspaceId=" + ids.workspace), new URL(target().href + "&workspaceId=" + ids.B),
    new URL(target().href + "&other=1"),
  ]) assert.equal((await fixture.request(url, scope(fixture))).status, 403);
  assert.equal((await fixture.request("not a URL", scope(fixture))).status, 403);
  assert.equal(fixture.snapshot().calls, 11); assert.equal(fixture.snapshot().blocked, 11);
});

test("missing, false, throwing or nonboolean guards, expired signals and mismatched actors deny every allowed endpoint", async () => {
  const fixture = createContentStudioBrowserFixture();
  const invalid = [{ expectedUserId: undefined }, { expectedUserId: ids.B }, { signal: undefined }, { signal: AbortSignal.abort() },
    { dispatchGuard: undefined }, { dispatchGuard: () => false }, { dispatchGuard: () => 1 }, { dispatchGuard: () => { throw new Error("Synthetic guard failure"); } }];
  for (const overrides of invalid) {
    assert.equal((await fixture.request(target(), scope(fixture, overrides))).status, 403);
    assert.equal((await fixture.request(target("/api/content-studio/generate-package"), scope(fixture, { method: "POST", body: JSON.stringify(brief), ...overrides }))).status, 403);
  }
  assert.equal((await fixture.request(target())).status, 403);
});

test("raw ABA is rejected by the original caller lifetime guard even when its actor ID returns to A", async () => {
  const fixture = createContentStudioBrowserFixture(); let alive = true;
  fixture.onAuthStateChange((event) => { if (event !== "TOKEN_REFRESHED") alive = false; });
  const init = scope(fixture, { dispatchGuard: () => alive }); fixture.switchABA();
  assert.equal((await fixture.request(target(), init)).status, 403); assert.equal(fixture.snapshot().actorId, ids.A);
  assert.equal((await fixture.request(target(), scope(fixture))).status, 200);
});

test("scope is checked after a guard callback so a synchronous actor switch or abort cannot open a stale request", async () => {
  const fixture = createContentStudioBrowserFixture(), controller = new AbortController();
  assert.equal((await fixture.request(target(), scope(fixture, { dispatchGuard: () => { fixture.switchActor(); return true; } }))).status, 403);
  assert.equal((await fixture.request(target(), scope(fixture, { signal: controller.signal, dispatchGuard: () => { controller.abort(); return true; } }))).status, 403);
});

test("simulated clipboard records bounded synthetic text and actor, without changing auth or making an API call", async () => {
  const fixture = createContentStudioBrowserFixture(); await fixture.writeClipboard("TEST simulated clipboard A");
  assert.equal(fixture.snapshot().clipboardWrites, 1); assert.deepEqual(fixture.snapshot().lastClipboard, { actor: "A", text: "TEST simulated clipboard A" });
  assert.equal(Object.isFrozen(fixture.snapshot().lastClipboard), true); fixture.switchActor(); await fixture.writeClipboard("TEST simulated clipboard B");
  assert.equal(fixture.snapshot().clipboardWrites, 2); assert.equal(fixture.snapshot().lastClipboard.actor, "B");
  assert.equal(fixture.snapshot().clipboardFailures, 0); assert.equal(fixture.snapshot().sdkReads, 0); assert.equal(fixture.snapshot().calls, 0);
});

test("one-shot clipboard failure rejects locally then permits a normal write", async () => {
  const fixture = createContentStudioBrowserFixture(); assert.equal(fixture.failNextClipboard(), true); assert.equal(fixture.failNextClipboard(), false);
  assert.equal(fixture.snapshot().clipboardFailureArmed, true);
  await assert.rejects(fixture.writeClipboard("TEST rejected clipboard"), /simulated clipboard failure/);
  assert.equal(fixture.snapshot().clipboardFailureArmed, false); assert.equal(fixture.snapshot().clipboardFailures, 1);
  await fixture.writeClipboard("TEST recovered clipboard"); assert.equal(fixture.snapshot().clipboardWrites, 2); assert.equal(fixture.snapshot().clipboardFailures, 1);
});

test("clipboard hold captures A, allows B writes through, and cannot be armed twice or overwrite B on release", async () => {
  const fixture = createContentStudioBrowserFixture(); assert.equal(fixture.armNextClipboard(), true); assert.equal(fixture.armNextClipboard(), false);
  let settled = false; const pending = fixture.writeClipboard("TEST held A").then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(fixture.snapshot().clipboardHeld, 1); assert.equal(fixture.snapshot().clipboardArmed, false);
  assert.deepEqual(fixture.snapshot().lastClipboard, { actor: "A", text: "TEST held A" }); assert.equal(fixture.armNextClipboard(), false);
  fixture.switchActor(); await fixture.writeClipboard("TEST current B"); assert.equal(settled, false); assert.equal(fixture.snapshot().clipboardWrites, 2);
  assert.equal(fixture.releaseClipboard(), true); await pending; assert.equal(fixture.snapshot().clipboardHeld, 0); assert.equal(fixture.releaseClipboard(), false);
  assert.deepEqual(fixture.snapshot().lastClipboard, { actor: "B", text: "TEST current B" });
});

test("deferred clipboard failure is captured for that write and stays independent of the SDK gate", async () => {
  const fixture = createContentStudioBrowserFixture(); fixture.armNextSdk(); fixture.armNextClipboard(); fixture.failNextClipboard();
  const sdk = fixture.getSession(), clipboard = fixture.writeClipboard("TEST held rejection");
  const rejected = assert.rejects(clipboard, /simulated clipboard failure/);
  assert.equal(fixture.snapshot().sdkHeld, 1); assert.equal(fixture.snapshot().clipboardHeld, 1); assert.equal(fixture.snapshot().clipboardFailureArmed, false);
  fixture.switchABA(); fixture.releaseClipboard(); await rejected;
  assert.equal(fixture.snapshot().sdkHeld, 1); assert.equal(fixture.snapshot().clipboardHeld, 0); assert.equal(fixture.snapshot().clipboardFailures, 1);
  fixture.release(); assert.equal((await sdk).data.session.user.id, ids.A); assert.equal(fixture.snapshot().sdkHeld, 0);
});

test("invalid or oversized simulated clipboard values reject without retaining unbounded data", async () => {
  const fixture = createContentStudioBrowserFixture();
  for (const value of [null, {}, 42, "x".repeat(20_001)]) await assert.rejects(fixture.writeClipboard(value), /invalid simulated clipboard text/);
  assert.equal(fixture.snapshot().clipboardWrites, 0); assert.equal(fixture.snapshot().lastClipboard, null); assert.equal(fixture.snapshot().clipboardFailures, 4);
  await fixture.writeClipboard("x".repeat(20_000)); assert.equal(fixture.snapshot().lastClipboard.text.length, 20_000);
});

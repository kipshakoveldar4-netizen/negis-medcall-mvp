import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAdvertisingReportsHttpFixture } from "./advertising-reports-http-store.mjs";

const W1 = "aaaaaaaa-1111-4111-8111-111111111111";
const W2 = "bbbbbbbb-2222-4222-8222-222222222222";
const CONTROL = "/__fixture/ads-reports";
const PATHS = ["meta-launches", "auth-context", "meta-insights-history", "advertising-outcomes", "meta-summary", "workspace-settings", "health", "content-videos"]
  .map((key) => `/api/crm/${key}`).concat(["/api/content-studio/status", "/api/content-studio/usage"]);
const auth = (actor = "A") => ({ Authorization: `Bearer fixture-ads-${actor}` });
const scoped = (resource, workspace = W1) => `/api/crm/${resource}?workspaceId=${workspace}`;
const usagePath = (workspace = W1) => `/api/content-studio/usage?workspaceId=${workspace}`;

async function until(predicate, message = "fixture state did not settle") {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(5); }
  assert.fail(message);
}

async function serverFixture(t) {
  const fixture = createAdvertisingReportsHttpFixture();
  const server = createServer((req, res) => {
    const handled = fixture.handle(req, res);
    assert.equal(typeof handled, "boolean", "middleware must return synchronously");
    if (!handled) { req.resume(); res.writeHead(req.method === "GET" ? 404 : 403); res.end("Unknown fixture path"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { fixture.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const get = (path, actor = "A", options = {}) => fetch(base + path, { ...options, headers: { ...auth(actor), ...options.headers } });
  const command = async (body) => {
    const response = await fetch(base + CONTROL, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, JSON.stringify(body));
    return response.json();
  };
  return { fixture, base, get, command };
}

// Native sockets expose header delivery and the first body byte independently.
function native(base, path, { method = "GET", headers = {}, body } = {}) {
  let headersSeen = false, status, text = "";
  let response;
  const req = request(base + path, { method, headers });
  const done = new Promise((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      headersSeen = true; status = res.statusCode; response = res;
      res.on("data", (chunk) => { text += chunk.toString(); });
      res.on("end", () => resolve({ status, text }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
    });
  });
  done.catch(() => {});
  req.end(body);
  return { req, done, get headersSeen() { return headersSeen; }, get status() { return status; },
    get text() { return text; }, get response() { return response; } };
}

test("fresh snapshot is stable, detached, serializable, synthetic and contains no tokens", async (t) => {
  const f = await serverFixture(t);
  const first = f.fixture.snapshot();
  assert.deepEqual(first.roles, { A: "owner", B: "owner" });
  assert.deepEqual(first.workspaces, { A: "W1", B: "W1" });
  assert.deepEqual(first.actorIds, { A: "11111111-1111-4111-8111-111111111111", B: "22222222-2222-4222-8222-222222222222" });
  assert.deepEqual(first.workspaceIds, { W1, W2 });
  assert.equal(first.revision, 1); assert.equal(first.externalCalls, 0); assert.equal(first.forbiddenWrites, 0);
  assert.deepEqual(first.pending, []);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  first.roles.A = "lead_manager"; first.armed.push({ resource: "bogus" });
  const response = await fetch(f.base + CONTROL);
  assert.deepEqual(await response.json(), f.fixture.snapshot(), "control GET returns snapshot directly, without envelope");
  assert.equal(f.fixture.snapshot().roles.A, "owner");
  assert.doesNotMatch(JSON.stringify(f.fixture.snapshot()), /Bearer|fixture-ads|authorization/i);
});

test("actual page envelopes contain two QA PAUSED launches, fresh/stale mixed currency and zero money", async (t) => {
  const f = await serverFixture(t);
  const launches = await (await f.get(scoped("meta-launches"))).json();
  assert.equal(launches.success, true); assert.equal(launches.mode, "supabase");
  assert.equal(launches.data.launches.length, 2);
  for (const launch of launches.data.launches) {
    assert.match(launch.campaignName, /^QA A r1 W1/);
    assert.equal(launch.status, "paused"); assert.equal(launch.metaStatus, "PAUSED"); assert.equal(launch.budgetDailyMinor, 0);
  }
  const reports = (await (await f.get(scoped("meta-insights-history"))).json()).data;
  assert.deepEqual(reports.summaries.map((item) => item.freshness), ["fresh", "stale"]);
  assert.deepEqual(reports.summaries.map((item) => item.metaCampaignLaunchId), launches.data.launches.map((item) => item.id));
  assert.deepEqual(reports.summaries[1].spendByCurrency.map((item) => item.currency), ["USD", "KZT"]);
  for (const item of reports.summaries) {
    assert.ok(BigInt(item.impressions) > 0n && BigInt(item.clicks) > 0n && BigInt(item.metaLeads) > 0n);
    for (const money of item.spendByCurrency) assert.equal(money.spendMinor, "0");
  }
  const outcomes = (await (await f.get(scoped("advertising-outcomes"))).json()).data.outcomes;
  assert.ok(outcomes.attributedLeads > 0 && outcomes.pendingDeals > 0);
  assert.equal(outcomes.attributedRevenueByCurrency[0].amountMinor, "0");
  await f.command({ command: "revision", value: 2 });
  const next = (await (await f.get(scoped("meta-insights-history"))).json()).data;
  assert.equal(next.revision, 2); assert.notEqual(next.summaries[0].impressions, reports.summaries[0].impressions);
  assert.notEqual(next.summaries[0].clicks, reports.summaries[0].clicks);
  assert.equal(f.fixture.snapshot().externalCalls, 0);
});

test("owner/admin reads and lead_manager private denials are enforced by server mapping", async (t) => {
  const f = await serverFixture(t);
  await f.command({ command: "actorRole", actor: "A", role: "lead_manager" });
  for (const path of PATHS) {
    const response = await f.get(path + `?workspaceId=${W1}&role=owner&actor=B`);
    if (path.endsWith("/auth-context")) {
      const data = (await response.json()).data;
      assert.equal(response.status, 200); assert.equal(data.isAdmin, false); assert.equal(data.role, "lead_manager");
    } else if (path.endsWith("/meta-launches")) assert.equal(response.status, 200);
    else { assert.equal(response.status, 403); assert.equal((await response.json()).data, undefined); }
  }
  for (const role of ["admin", "owner"]) {
    await f.command({ command: "actorRole", actor: "A", role });
    for (const path of PATHS) assert.equal((await f.get(path + `?workspaceId=${W1}`)).status, 200);
  }
  const body = await (await f.get(scoped("meta-launches"), "B")).json();
  assert.match(body.data.launches[0].campaignName, /^QA B r1 W1/);
  assert.doesNotMatch(JSON.stringify(body), /QA A /);
});

test("strict fake bearer tokens, missing membership and cross-workspace queries never leak reports", async (t) => {
  const f = await serverFixture(t);
  for (const token of [undefined, "fixture-ads-A", "Bearer fixture-ads-A-extra", "bearer fixture-ads-A", "Bearer fixture-ads-C", "Bearer real-token"]) {
    const response = await fetch(f.base + scoped("meta-insights-history"), { headers: token ? { Authorization: token } : {} });
    assert.equal(response.status, 401); assert.equal((await response.json()).data, undefined);
  }
  for (const query of ["", `?workspaceId=${W2}`, `?workspaceId=${W1}&workspaceId=${W1}`, "?workspaceId=demo-workspace"]) {
    const response = await f.get("/api/crm/advertising-outcomes" + query);
    assert.equal(response.status, 403); assert.equal((await response.json()).data, undefined);
  }
  await f.command({ command: "actorWorkspace", actor: "A", workspace: "W2" });
  assert.equal((await f.get(scoped("meta-launches"))).status, 403);
  assert.equal((await f.get(scoped("meta-launches", W2))).status, 200);
  assert.equal((await f.get(scoped("meta-launches"), "B")).status, 200);
  assert.equal((await f.get(scoped("meta-launches", W2), "B")).status, 403);
  const context = (await (await f.get(scoped("auth-context", W2))).json()).data;
  assert.equal(context.workspaceId, W2); assert.equal(context.userId, f.fixture.snapshot().actorIds.A);
});

test("health without query and content status never enable providers or return keys", async (t) => {
  const f = await serverFixture(t);
  const health = (await (await f.get("/api/crm/health")).json()).data;
  assert.deepEqual(health.meta, { configured: false, hasAccessToken: false, videoLaunchEnabled: false,
    videoOptimization: { enabled: false, workerSecretConfigured: false } });
  const status = (await (await f.get(`/api/content-studio/status?workspaceId=${W1}`)).json()).data;
  const usage = (await (await f.get(`/api/content-studio/usage?workspaceId=${W1}`)).json()).data;
  assert.equal(status.configured, false); assert.equal(status.enabled, false);
  assert.equal(status.textEnabled, false); assert.equal(status.imageEnabled, false); assert.equal(status.videoEnabled, false);
  assert.doesNotMatch(JSON.stringify([health, status, usage]), /api[_-]?key|access_token|https?:\/\/|secret\s*:/i);
  assert.equal((await f.get("/api/crm/health", "C")).status, 401);
});

test("synthetic quota revisions match the usage API and empty videos stay actor/workspace scoped", async (t) => {
  const f = await serverFixture(t);
  await f.command({ command: "actorWorkspace", actor: "B", workspace: "W2" });
  for (const revision of [1, 2, 9]) {
    await f.command({ command: "revision", value: revision });
    for (const [actor, workspace, label] of [["A", W1, "W1"], ["B", W2, "W2"]]) {
      const response = await f.get(usagePath(workspace), actor);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { success: true, mode: "tracked", data: {
        revision, fixtureMarker: `QA ${actor} r${revision} ${label}`,
        trackingAvailable: true, subscriptionActive: true, plan: "pro",
        planTitle: `QA quota ${actor}/${label} r${revision}`, periodStart: "2026-10-01", textRequests: revision,
        images: { used: revision === 1 ? 1 : 150, limit: 150, remaining: revision === 1 ? 149 : 0, enabled: true },
        videoSeconds: { used: revision === 1 ? 8 : 180, limit: 180, remaining: revision === 1 ? 172 : 0, enabled: true },
        videoSecondsPerGeneration: 8,
      } });
      const videos = await (await f.get(scoped("content-videos", workspace), actor)).json();
      assert.deepEqual(videos, { success: true, mode: "supabase", data: {
        revision, fixtureMarker: `QA ${actor} r${revision} ${label}`, videos: [],
      } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(JSON.stringify([body, videos]), /api[_-]?key|access_token|https?:\/\/|fixture-ads/i);
    }
  }
  assert.equal(f.fixture.snapshot().requestCounters.byResource["content-usage"].completed, 6);
  assert.equal(f.fixture.snapshot().requestCounters.byResource["content-videos"].completed, 6);
  assert.equal(f.fixture.snapshot().externalCalls, 0);
});

test("usage and empty videos require strict fake auth, same origin and current workspace membership", async (t) => {
  const f = await serverFixture(t);
  for (const path of ["/api/content-studio/usage", "/api/crm/content-videos"]) {
    for (const token of [undefined, "fixture-ads-A", "Bearer fixture-ads-A-extra", "bearer fixture-ads-A", "Bearer fixture-ads-C", "Bearer real-token"]) {
      const response = await fetch(f.base + path + `?workspaceId=${W1}`, { headers: token ? { Authorization: token } : {} });
      assert.equal(response.status, 401); assert.equal((await response.json()).data, undefined);
    }
    for (const query of ["", `?workspaceId=${W2}`, `?workspaceId=${W1}&workspaceId=${W1}`, "?workspaceId=demo-workspace"]) {
      const response = await f.get(path + query);
      assert.equal(response.status, 403); assert.equal((await response.json()).data, undefined);
    }
    for (const headers of [{ Origin: "https://foreign.invalid" }, { Origin: "null" }, { Host: "evil.invalid" }]) {
      const result = await native(f.base, path + `?workspaceId=${W1}`, { headers: { ...auth(), ...headers } }).done;
      assert.equal(result.status, 400); assert.equal(JSON.parse(result.text).data, undefined);
    }
  }
  await f.command({ command: "actorWorkspace", actor: "A", workspace: "W2" });
  for (const path of [usagePath, workspace => scoped("content-videos", workspace)]) {
    assert.equal((await f.get(path(W1))).status, 403);
    assert.equal((await f.get(path(W2))).status, 200);
    assert.equal((await f.get(path(W1), "B")).status, 200);
    assert.equal((await f.get(path(W2), "B")).status, 403);
  }
});

for (const phase of ["headers", "body"]) {
  test(`usage ${phase} gate freezes old quota across newer revision, actor and workspace reads`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "content-usage", phase });
    const old = native(f.base, usagePath(), { headers: auth() });
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await until(() => old.text.length > 0);
    await delay(30);
    assert.equal(old.headersSeen, phase === "body"); assert.equal(old.text, phase === "body" ? "{" : "");
    const first = f.fixture.snapshot().pending[0];
    assert.equal(first.resource, "content-usage"); assert.equal(first.actor, "A"); assert.equal(first.phase, phase);
    assert.deepEqual((await (await f.get(scoped("content-videos"))).json()).data.videos, []);
    assert.equal((await (await f.get(usagePath())).json()).data.textRequests, 1, "one arm holds only one matching GET");
    await f.command({ command: "revision", value: 2 });
    await f.command({ command: "actorWorkspace", actor: "A", workspace: "W2" });
    await f.command({ command: "arm", resource: "content-usage", phase });
    const newer = native(f.base, usagePath(), { headers: auth("B") });
    await until(() => f.fixture.snapshot().pending.length === 2);
    await f.command({ command: "release", id: f.fixture.snapshot().pending[1].id });
    const latest = JSON.parse((await newer.done).text).data;
    assert.equal(latest.planTitle, "QA quota B/W1 r2");
    assert.equal(latest.images.remaining, 0); assert.equal(latest.videoSeconds.remaining, 0);
    assert.equal(f.fixture.snapshot().pending[0].id, first.id);
    assert.equal((await (await f.get(usagePath(W2))).json()).data.planTitle, "QA quota A/W2 r2");
    await f.command({ command: "actorRole", actor: "A", role: "lead_manager" });
    await f.command({ command: "release", id: first.id });
    const original = await old.done;
    assert.equal(original.status, 200);
    const data = JSON.parse(original.text).data;
    assert.equal(data.planTitle, "QA quota A/W1 r1"); assert.equal(data.textRequests, 1);
    assert.equal(data.images.remaining, 149); assert.equal(data.videoSeconds.remaining, 172);
    await until(() => f.fixture.snapshot().requestCounters.byResource["content-usage"].completed === 4);
    assert.equal(f.fixture.snapshot().pending.length, 0); assert.equal(f.fixture.snapshot().externalCalls, 0);
  });

  test(`usage ${phase} controls preserve HTTP errors, malformed JSON and authorization denials`, async (t) => {
    const f = await serverFixture(t);
    for (const status of [200, 401, 403, 500]) for (const malformed of [false, true]) {
      await f.command({ command: "arm", resource: "content-usage", phase, status, malformed, shape: "valid" });
      const held = native(f.base, usagePath(), { headers: auth() });
      await until(() => f.fixture.snapshot().pending.length === 1);
      assert.equal(f.fixture.snapshot().pending[0].status, status);
      await f.command({ command: "release" });
      const result = await held.done;
      assert.equal(result.status, status);
      if (malformed) assert.throws(() => JSON.parse(result.text), SyntaxError);
      else {
        const body = JSON.parse(result.text);
        assert.equal(body.success, status === 200);
        if (status !== 200) { assert.equal(body.data, undefined); assert.doesNotMatch(result.text, /QA quota|planTitle/); }
      }
    }
    for (const [actor, workspace, role, expected] of [["C", W1, "owner", 401], ["A", W2, "owner", 403], ["A", W1, "lead_manager", 403]]) {
      await f.command({ command: "actorRole", actor: "A", role });
      await f.command({ command: "arm", resource: "content-usage", phase, status: 200 });
      const held = native(f.base, usagePath(workspace), { headers: auth(actor) });
      await until(() => f.fixture.snapshot().pending.length === 1);
      await f.command({ command: "release" });
      const result = await held.done;
      assert.equal(result.status, expected); assert.equal(JSON.parse(result.text).data, undefined);
    }
  });

  test(`usage ${phase} abort and reset remove held sockets and restore revision one`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "content-usage", phase });
    const controller = new AbortController();
    const response = f.get(usagePath(), "A", { signal: controller.signal });
    const parsing = response.then(res => res.json()); parsing.catch(() => {});
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await response;
    controller.abort(); await assert.rejects(parsing);
    await until(() => f.fixture.snapshot().pending.length === 0);
    assert.deepEqual(f.fixture.snapshot().requestCounters.byResource["content-usage"], { received: 1, completed: 0, aborted: 1 });
    await f.command({ command: "revision", value: 9 });
    await f.command({ command: "arm", resource: "content-usage", phase });
    const held = native(f.base, usagePath(), { headers: auth() });
    await until(() => f.fixture.snapshot().pending.length === 1);
    const reset = await f.command({ command: "reset" });
    await assert.rejects(held.done);
    assert.deepEqual(reset.pending, []); assert.deepEqual(reset.armed, []);
    assert.deepEqual(reset.requestCounters.byResource["content-usage"], { received: 0, completed: 0, aborted: 0 });
    const data = (await (await f.get(usagePath())).json()).data;
    assert.equal(data.textRequests, 1); assert.equal(data.images.remaining, 149);
    assert.equal(data.videoSeconds.remaining, 172); assert.equal(f.fixture.snapshot().externalCalls, 0);
  });
}

test("every known non-control write is forbidden; unknown routes remain unhandled", async (t) => {
  const f = await serverFixture(t);
  for (const path of PATHS) for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await f.get(path + `?workspaceId=${W1}`, "A", { method });
    assert.equal(response.status, 403);
  }
  assert.equal(f.fixture.snapshot().forbiddenWrites, PATHS.length * 6);
  const before = f.fixture.snapshot();
  for (const path of ["/api/crm/meta-launch", "/api/content-studio/generate-video", "/api/crm/upload", "/api/crm/storage-health", "/other"])
    assert.equal((await f.get(path, "A", { method: "POST", body: "arbitrary provider payload" })).status, 403);
  assert.deepEqual(f.fixture.snapshot(), before);
  assert.equal(f.fixture.handle({ url: "https://provider.invalid/api/crm/meta-launches" }, {}), false);
  assert.equal(f.fixture.snapshot().externalCalls, 0);
});

for (const phase of ["headers", "body"]) {
  test(`${phase} gate proves actual native HTTP boundary and freezes arrival payload`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "meta-launches", phase });
    const held = native(f.base, scoped("meta-launches"), { headers: auth() });
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await until(() => held.text.length > 0);
    await delay(30);
    assert.equal(held.headersSeen, phase === "body");
    assert.equal(held.text, phase === "body" ? "{" : "");
    const pending = f.fixture.snapshot().pending[0];
    assert.deepEqual(Object.keys(pending).sort(), ["actor", "id", "phase", "resource", "status"]);
    assert.equal(pending.actor, "A"); assert.equal(pending.phase, phase);
    await f.command({ command: "revision", value: 9 });
    await f.command({ command: "actorWorkspace", actor: "A", workspace: "W2" });
    await f.command({ command: "actorRole", actor: "A", role: "lead_manager" });
    await f.command({ command: "release", id: pending.id });
    const result = await held.done;
    assert.equal(result.status, 200);
    assert.match(JSON.parse(result.text).data.launches[0].campaignName, /^QA A r1 W1/);
    await until(() => f.fixture.snapshot().requestCounters.completed === 1);
    assert.equal(f.fixture.snapshot().pending.length, 0);
    assert.equal(f.fixture.snapshot().requestCounters.aborted, 0);
  });

  test(`${phase} gate holds builtin fetch ${phase === "headers" ? "response" : "JSON body"} until release`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "advertising-outcomes", phase });
    let headersSeen = false, bodySeen = false;
    const response = f.get(scoped("advertising-outcomes")).then((res) => { headersSeen = true; return res; });
    const body = response.then((res) => res.json()).then((value) => { bodySeen = true; return value; });
    body.catch(() => {});
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await until(() => headersSeen);
    await delay(30);
    assert.equal(headersSeen, phase === "body"); assert.equal(bodySeen, false);
    const released = await f.command({ command: "release" });
    assert.equal(released.pending.length, 0);
    assert.equal((await body).data.outcomes.pendingDeals, 6);
  });

  test(`${phase} fetch abort removes held response and counts once, including subsequent reset`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "meta-insights-history", phase });
    const controller = new AbortController();
    const response = f.get(scoped("meta-insights-history"), "A", { signal: controller.signal });
    const body = response.then((res) => res.json()); body.catch(() => {});
    await until(() => f.fixture.snapshot().pending.length === 1);
    if (phase === "body") await response;
    controller.abort(); await assert.rejects(body);
    await until(() => f.fixture.snapshot().pending.length === 0);
    assert.equal(f.fixture.snapshot().requestCounters.aborted, 1);
    assert.equal(f.fixture.snapshot().requestCounters.completed, 0);
    assert.equal(f.fixture.snapshot().requestCounters.inFlight, 0);
    await f.command({ command: "reset" }); await delay(10);
    assert.equal(f.fixture.snapshot().requestCounters.aborted, 0);
  });
}

test("one arm consumes only the next matching GET; response IDs release out of order", async (t) => {
  const f = await serverFixture(t);
  await f.command({ command: "arm", resource: "meta-launches", phase: "headers" });
  assert.equal((await f.get(scoped("auth-context"))).status, 200);
  const old = native(f.base, scoped("meta-launches"), { headers: auth() });
  await until(() => f.fixture.snapshot().pending.length === 1);
  const first = f.fixture.snapshot().pending[0].id;
  assert.equal((await f.get(scoped("meta-launches"))).status, 200, "arm does not capture a second matching GET");
  await f.command({ command: "revision", value: 3 });
  await f.command({ command: "arm", resource: "meta-launches", phase: "body" });
  const newer = native(f.base, scoped("meta-launches"), { headers: auth("B") });
  await until(() => f.fixture.snapshot().pending.length === 2);
  const second = f.fixture.snapshot().pending[1].id;
  await f.command({ command: "release", id: second });
  assert.match(JSON.parse((await newer.done).text).data.launches[0].campaignName, /^QA B r3 W1/);
  assert.equal(f.fixture.snapshot().pending[0].id, first); assert.equal(old.headersSeen, false);
  await f.command({ command: "release" });
  assert.match(JSON.parse((await old.done).text).data.launches[0].campaignName, /^QA A r1 W1/);
  await until(() => f.fixture.snapshot().requestCounters.completed === 4);
  assert.equal(f.fixture.snapshot().requestCounters.received, 4);
});

for (const status of [401, 403, 500]) {
  test(`armed HTTP ${status} retains status and never exposes a success payload`, async (t) => {
    const f = await serverFixture(t);
    await f.command({ command: "arm", resource: "meta-launches", phase: "body", status });
    const response = await f.get(scoped("meta-launches"));
    assert.equal(response.status, status);
    const body = response.json(); await f.command({ command: "release" });
    const value = await body;
    assert.equal(value.success, false); assert.equal(value.data, undefined);
    assert.doesNotMatch(JSON.stringify(value), /campaignName|summaries|QA A|QA B/);
  });
}

test("malformed bodies are actual invalid JSON, never an arbitrary injection channel", async (t) => {
  const f = await serverFixture(t);
  for (const status of [200, 500]) {
    await f.command({ command: "arm", resource: "meta-insights-history", phase: "body", status, malformed: true });
    const response = await f.get(scoped("meta-insights-history"));
    const parsing = response.json(); parsing.catch(() => {});
    await f.command({ command: "release" });
    assert.equal(response.status, status); await assert.rejects(parsing, SyntaxError);
  }
});

for (const shape of ["valid", "null-spend", "object-summaries", "foreign-auth", "contradictory-role"]) {
  test(`bounded shape ${shape} is real JSON, held and frozen at arrival`, async (t) => {
    const f = await serverFixture(t);
    const resource = ["foreign-auth", "contradictory-role"].includes(shape) ? "auth-context" : "meta-insights-history";
    if (shape === "contradictory-role") await f.command({ command: "actorRole", actor: "A", role: "lead_manager" });
    await f.command({ command: "arm", resource, phase: "body", status: 200, malformed: false, shape });
    const response = await f.get(scoped(resource));
    const parsing = response.json();
    await f.command({ command: "revision", value: 8 });
    await f.command({ command: "actorWorkspace", actor: "A", workspace: "W2" });
    await f.command({ command: "release" });
    const data = (await parsing).data;
    assert.equal(data.revision, 1); assert.equal(data.fixtureMarker, "QA A r1 W1");
    if (shape === "null-spend") assert.equal(data.summaries[0].spendByCurrency, null);
    else if (shape === "object-summaries") assert.deepEqual(data.summaries, { broken: true });
    else if (shape === "foreign-auth") { assert.equal(data.isAdmin, true); assert.equal(data.workspaceId, W2); }
    else if (shape === "contradictory-role") { assert.equal(data.isAdmin, true); assert.equal(data.role, "lead_manager"); assert.equal(data.workspaceId, W1); }
    else assert.ok(Array.isArray(data.summaries[0].spendByCurrency));
  });
}

test("armed success cannot override missing authentication, role denial or foreign workspace", async (t) => {
  const f = await serverFixture(t);
  for (const [actor, workspace, expected] of [["C", W1, 401], ["A", W2, 403]]) {
    await f.command({ command: "arm", resource: "meta-insights-history", phase: "headers", status: 200 });
    const held = f.get(scoped("meta-insights-history", workspace), actor);
    await until(() => f.fixture.snapshot().pending.length === 1);
    await f.command({ command: "release" });
    const response = await held;
    assert.equal(response.status, expected); assert.equal((await response.json()).data, undefined);
  }
  await f.command({ command: "actorRole", actor: "A", role: "lead_manager" });
  await f.command({ command: "arm", resource: "advertising-outcomes", phase: "headers", status: 200 });
  const held = f.get(scoped("advertising-outcomes"));
  await until(() => f.fixture.snapshot().pending.length === 1); await f.command({ command: "release" });
  assert.equal((await held).status, 403);
});

test("invalid controls, JSON, size, content type, Host and Origin leave all fixture state untouched", async (t) => {
  const f = await serverFixture(t);
  const bodies = [null, [], 1, {}, { command: "reset", extra: true }, { command: "launch" },
    { command: "actorRole", actor: "C", role: "owner" }, { command: "actorRole", actor: "A", role: "superadmin" },
    { command: "actorWorkspace", actor: "A", workspace: W2 }, { command: "revision", value: 0 },
    { command: "revision", value: 1.5 }, { command: "revision", value: "2" },
    { command: "arm", resource: "meta-launches", phase: "body", status: 201 },
    { command: "arm", resource: "upload", phase: "body" }, { command: "arm", resource: "meta-launches", phase: "headers", malformed: "yes" },
    { command: "arm", resource: "meta-launches", phase: "body", shape: "arbitrary" },
    { command: "arm", resource: "meta-launches", phase: "body", shape: "foreign-auth" },
    { command: "arm", resource: "content-studio-usage", phase: "body" },
    { command: "arm", resource: "content-videos", phase: "body" },
    ...["null-spend", "object-summaries", "foreign-auth", "contradictory-role", "null-usage"].map(shape =>
      ({ command: "arm", resource: "content-usage", phase: "body", shape })),
    { command: "arm", resource: "content-usage", phase: "body", payload: { private: true } },
    { command: "arm", resource: "meta-insights-history", phase: "body", payload: { private: true } },
    { command: "release", id: "ads-report-999" }, { command: "release", id: 2 }, { command: "release" }];
  const before = f.fixture.snapshot();
  for (const body of bodies) {
    const response = await fetch(f.base + CONTROL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body)); assert.deepEqual(f.fixture.snapshot(), before);
  }
  for (const [headers, body, path = CONTROL] of [
    [{ "Content-Type": "text/plain" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json; charset=iso-8859-1" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json", "Content-Encoding": "gzip" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json" }, "{"],
    [{ "Content-Type": "application/json" }, " ".repeat(4097)],
    [{ "Content-Type": "application/json", Origin: "https://foreign.invalid" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json", Origin: "null" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json", Host: "evil.invalid" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json", Host: "127.0.0.1.evil.invalid" }, '{"command":"reset"}'],
    [{ "Content-Type": "application/json" }, '{"command":"reset"}', CONTROL + "?command=reset"],
  ]) {
    assert.equal((await native(f.base, path, { method: "POST", headers, body }).done).status, 400);
    assert.deepEqual(f.fixture.snapshot(), before);
  }
  assert.equal((await native(f.base, CONTROL, { headers: { Origin: "https://foreign.invalid" } }).done).status, 400);
  assert.deepEqual(f.fixture.snapshot(), before);
});

test("chunked oversized control and invalid UTF-8 never partially apply a command", async (t) => {
  const f = await serverFixture(t), before = f.fixture.snapshot();
  const oversized = native(f.base, CONTROL, { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    body: '{"command":"revision","value":5}' + " ".repeat(4096) });
  assert.equal((await oversized.done).status, 400); assert.deepEqual(f.fixture.snapshot(), before);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"command":"reset","'), Buffer.from([0xc3, 0x28]), Buffer.from('":1}')]);
  assert.equal((await native(f.base, CONTROL, { method: "POST", headers: { "Content-Type": "application/json" }, body: invalidUtf8 }).done).status, 400);
  assert.deepEqual(f.fixture.snapshot(), before);
});

test("arm queue is bounded and reset destroys held sockets without reusing request IDs", async (t) => {
  const f = await serverFixture(t);
  for (let i = 0; i < 32; i++) await f.command({ command: "arm", resource: "meta-launches", phase: "headers" });
  const before = f.fixture.snapshot();
  const overflow = await fetch(f.base + CONTROL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "arm", resource: "meta-launches", phase: "headers" }) });
  assert.equal(overflow.status, 400); assert.deepEqual(f.fixture.snapshot(), before);
  const old = native(f.base, scoped("meta-launches"), { headers: auth() });
  await until(() => f.fixture.snapshot().pending.length === 1);
  const id = f.fixture.snapshot().pending[0].id;
  const reset = await f.command({ command: "reset" });
  await assert.rejects(old.done);
  assert.deepEqual(reset.pending, []); assert.deepEqual(reset.armed, []); assert.equal(reset.requestCounters.received, 0);
  await f.command({ command: "arm", resource: "meta-launches", phase: "headers" });
  const next = native(f.base, scoped("meta-launches"), { headers: auth() });
  await until(() => f.fixture.snapshot().pending.length === 1);
  assert.notEqual(f.fixture.snapshot().pending[0].id, id);
  await f.command({ command: "release" }); await next.done;
});

test("close is idempotent, aborts held native connections and does not count completion", async (t) => {
  const f = await serverFixture(t);
  await f.command({ command: "arm", resource: "meta-launches", phase: "body" });
  const held = native(f.base, scoped("meta-launches"), { headers: auth() });
  await until(() => held.text === "{");
  f.fixture.close(); f.fixture.close(); await assert.rejects(held.done);
  assert.equal(f.fixture.snapshot().closed, true); assert.equal(f.fixture.snapshot().pending.length, 0);
  assert.equal(f.fixture.snapshot().requestCounters.aborted, 1); assert.equal(f.fixture.snapshot().requestCounters.completed, 0);
  assert.equal((await f.get(scoped("meta-launches"))).status, 503); assert.equal(f.fixture.snapshot().externalCalls, 0);
});

test("pending connections are capped at 32; overflow is denied without hanging or leaking data", async (t) => {
  const f = await serverFixture(t), requests = [];
  for (let i = 0; i < 32; i++) {
    await f.command({ command: "arm", resource: "meta-launches", phase: "headers" });
    requests.push(native(f.base, scoped("meta-launches"), { headers: auth() }));
    await until(() => f.fixture.snapshot().pending.length === i + 1);
  }
  await f.command({ command: "arm", resource: "meta-launches", phase: "body" });
  const response = await f.get(scoped("meta-launches"));
  assert.equal(response.status, 503); assert.equal((await response.json()).data, undefined);
  await until(() => f.fixture.snapshot().requestCounters.completed === 1);
  const state = f.fixture.snapshot();
  assert.equal(state.pending.length, 32); assert.equal(state.requestCounters.received, 33);
  assert.equal(state.requestCounters.inFlight, 32);
  f.fixture.close();
  for (const held of requests) await assert.rejects(held.done);
  assert.equal(f.fixture.snapshot().requestCounters.aborted, 32);
  assert.equal(f.fixture.snapshot().requestCounters.completed, 1);
  assert.equal(f.fixture.snapshot().requestCounters.inFlight, 0);
});

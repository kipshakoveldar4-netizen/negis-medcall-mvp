import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentCreateFixtureIds as ids,
  createAppointmentCreateBrowserFixture,
  isAppointmentCreateFixtureLocation,
} from "./appointment-create-browser-store.ts";

const url = new URL(`/api/crm/appointments?workspaceId=${ids.workspace}`, "http://fixture.invalid");
const requestKey = "00000000-0000-4000-8000-000000001290";
const payload = { workspaceId: ids.workspace, requestKey, client: "TEST fictional client", service: "TEST service" };
const write = (fixture, overrides = {}) => ({
  method: "POST", body: JSON.stringify(payload),
  expectedUserId: fixture.snapshot().actorId, dispatchGuard: () => true, ...overrides,
});
const counts = (fixture) => {
  const { calls, queued, dispatched, blocked, replies, lateReplies, keys, held } = fixture.snapshot();
  return { calls, queued, dispatched, blocked, replies, lateReplies, keys, held };
};
const finish = async (fixture, init = write(fixture)) => {
  const pending = fixture.request(url, init);
  await Promise.resolve();
  fixture.release();
  return pending;
};

test("activation requires the explicit deferred query on the exact HTTP loopback appointments route", () => {
  const location = { pathname: "/appointments", hostname: "127.0.0.1", protocol: "http:", search: "?appointmentCreate=deferred" };
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(isAppointmentCreateFixtureLocation({ ...location, hostname }), true);
    assert.equal(isAppointmentCreateFixtureLocation({ ...location, hostname, search: "?phase=response&appointmentCreate=deferred" }), true);
  }
  for (const overrides of [
    { pathname: "/appointments/" }, { pathname: "/clients" }, { pathname: "/" },
    { hostname: "preview.invalid" }, { hostname: "localhost.invalid" }, { hostname: "127.0.0.1.invalid" },
    { hostname: "0.0.0.0" }, { protocol: "https:" }, { protocol: "file:" },
    { search: "" }, { search: "?appointmentCreate=other" }, { search: "?appointmentCreate=Deferred" },
  ]) assert.equal(isAppointmentCreateFixtureLocation({ ...location, ...overrides }), false);
  assert.equal(isAppointmentCreateFixtureLocation({}), false);
});

test("only a scoped fake appointment POST is accepted; no other origins, reads or writes are enabled", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  for (const target of [
    new URL("/api/crm/clients", url), new URL("/api/crm/deals", url), new URL("/api/crm/appointments/one", url),
    new URL(url.pathname, url), new URL(url.href.replace(ids.workspace, ids.A)),
    new URL(url.href.replace("fixture.invalid", "external.invalid")),
    new URL(url.href.replace("http:", "https:")), new URL(url.href.replace("fixture.invalid", "fixture.invalid:1234")),
  ]) assert.equal((await fixture.request(target, write(fixture))).status, 403);
  for (const method of ["GET", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    assert.equal((await fixture.request(url, write(fixture, { method }))).status, 403);
  }
  assert.equal((await fixture.request(url)).status, 403);
  assert.deepEqual(counts(fixture), { calls: 0, queued: 0, dispatched: 0, blocked: 0, replies: 0, lateReplies: 0, keys: 0, held: 0 });
});

test("malformed, unkeyed, oversized and foreign-workspace bodies never queue or dispatch", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  for (const body of [undefined, "bad json", "null", "[]", "{}", " ".repeat(256_001),
    JSON.stringify({ ...payload, id: ids.A }), JSON.stringify({ ...payload, workspaceId: ids.A }),
    JSON.stringify({ ...payload, requestKey: undefined }), JSON.stringify({ ...payload, requestKey: "invalid" }),
  ]) assert.equal((await fixture.request(url, write(fixture, { body }))).status, 400);
  assert.equal(fixture.snapshot().queued, 0);
  assert.equal(fixture.snapshot().dispatched, 0);
  assert.equal(fixture.snapshot().keys, 0);
});

test("an aborted signal, missing or mismatched expected actor, or false/missing guard fails before queuing", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  for (const overrides of [
    { signal: AbortSignal.abort() }, { expectedUserId: undefined }, { expectedUserId: ids.B },
    { dispatchGuard: undefined }, { dispatchGuard: () => false },
  ]) await assert.rejects(fixture.request(url, write(fixture, overrides)), { name: "AbortError" });
  assert.deepEqual(counts(fixture), { calls: 5, queued: 0, dispatched: 0, blocked: 5, replies: 0, lateReplies: 0, keys: 0, held: 0 });
});

test("queued requests stay pending until release and the caller guard is checked across the wait", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  let checks = 0;
  let current = true;
  const pending = fixture.request(url, write(fixture, { dispatchGuard: () => { checks++; return current; } }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(checks, 1);
  assert.equal(fixture.snapshot().heldQueued, 1);
  current = false;
  fixture.release();
  await rejected;
  assert.equal(checks, 2);
  assert.deepEqual(counts(fixture), { calls: 1, queued: 1, dispatched: 0, blocked: 1, replies: 0, lateReplies: 0, keys: 0, held: 0 });
});

for (const invalidation of ["actor", "role", "abort", "expected actor"]) {
  test(`queued ${invalidation} invalidation prevents dispatch`, async () => {
    const fixture = createAppointmentCreateBrowserFixture();
    const role = fixture.snapshot().role;
    const controller = new AbortController();
    const init = write(fixture, { signal: controller.signal, dispatchGuard: () => fixture.snapshot().role === role });
    const pending = fixture.request(url, init);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    if (invalidation === "actor") fixture.switchActor();
    if (invalidation === "role") fixture.toggleRole();
    if (invalidation === "abort") controller.abort();
    if (invalidation === "expected actor") init.expectedUserId = ids.B;
    fixture.release();
    await rejected;
    assert.equal(fixture.snapshot().dispatched, 0);
    assert.equal(fixture.snapshot().blocked, 1);
    assert.equal(fixture.snapshot().keys, 0);
  });
}

test("raw ABA updates bound auth and emits B then A synchronously, publishing only the final React snapshot", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  let bound;
  fixture.bindAuth((state) => { bound = state; });
  const events = [];
  let callerCurrent = true;
  const { data: { subscription } } = fixture.onAuthStateChange((event, session) => {
    assert.equal(bound.actorId, session.user.id);
    assert.equal(fixture.session().user.id, session.user.id);
    events.push([event, session.user.id]);
    callerCurrent = false;
  });
  let notifications = 0;
  const unsubscribe = fixture.subscribe(() => { notifications++; });
  const before = fixture.snapshot();
  assert.equal(fixture.snapshot(), before);
  assert.equal(Object.isFrozen(before), true);
  const pending = fixture.request(url, write(fixture, { dispatchGuard: () => callerCurrent }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  notifications = 0;
  fixture.switchABA();
  assert.deepEqual(events, [["SIGNED_IN", ids.B], ["SIGNED_IN", ids.A]]);
  assert.equal(notifications, 1);
  assert.equal(fixture.snapshot().actorId, ids.A);
  assert.equal(fixture.snapshot().revision, before.revision + 2);
  assert.equal(fixture.snapshot().authEvents, 2);
  fixture.release();
  await rejected;
  assert.equal(fixture.snapshot().dispatched, 0);
  subscription.unsubscribe();
  unsubscribe();
  const previousNotifications = notifications;
  fixture.switchActor();
  assert.equal(events.length, 2);
  assert.equal(notifications, previousNotifications);
});

test("same-actor synthetic token refresh preserves the bound actor and a queued caller", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  let bound;
  fixture.bindAuth((state) => { bound = state; });
  const initial = fixture.session();
  const revision = fixture.snapshot().revision;
  const events = [];
  fixture.onAuthStateChange((event, session) => events.push([event, session.user.id]));
  const pending = fixture.request(url, write(fixture));
  fixture.refreshSameActor();
  assert.equal(bound.actorId, initial.user.id);
  assert.equal(fixture.session().user.id, initial.user.id);
  assert.notEqual(fixture.session().access_token, initial.access_token);
  assert.match(fixture.session().access_token, /^visual-fixture-invalid-token-/);
  assert.deepEqual(events, [["TOKEN_REFRESHED", ids.A]]);
  assert.equal(fixture.snapshot().revision, revision);
  fixture.release();
  assert.equal((await pending).status, 200);
  assert.equal(fixture.snapshot().blocked, 0);
  assert.equal(fixture.snapshot().lateReplies, 0);
});

test("response phase still checks the asynchronous pre-dispatch boundary", async () => {
  const fixture = createAppointmentCreateBrowserFixture("?phase=response");
  let current = true;
  const pending = fixture.request(url, write(fixture, { dispatchGuard: () => current }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  current = false;
  await rejected;
  assert.equal(fixture.snapshot().dispatched, 0);
  assert.equal(fixture.snapshot().held, 0);
});

for (const transition of ["switchActor", "switchABA", "toggleRole", "refreshSameActor"]) {
  test(`held response after ${transition} deliberately returns for the UI caller to accept or suppress`, async () => {
    const fixture = createAppointmentCreateBrowserFixture("?phase=response");
    const original = fixture.snapshot();
    let callerCurrent = true;
    fixture.onAuthStateChange((event) => { if (event !== "TOKEN_REFRESHED") callerCurrent = false; });
    let displayed = null;
    const pending = fixture.request(url, write(fixture, { dispatchGuard: () => callerCurrent }));
    const received = pending.then(async (response) => {
      assert.equal(response.status, 200);
      const body = await response.json();
      if (callerCurrent) displayed = body.data.item;
      return body;
    });
    await Promise.resolve();
    assert.equal(fixture.snapshot().dispatched, 1);
    assert.equal(fixture.snapshot().heldResponse, 1);
    assert.equal(fixture.snapshot().replies, 0);
    fixture[transition]();
    fixture.release();
    const body = await received;
    const stale = transition !== "refreshSameActor";
    assert.equal(body.success, true);
    assert.equal(body.data.localOnly, true);
    assert.equal(body.data.replayed, false);
    assert.equal(fixture.snapshot().lastReply.actor, original.actor);
    assert.equal(fixture.snapshot().lastReply.role, original.role);
    assert.equal(fixture.snapshot().lastReply.stale, stale);
    assert.equal(fixture.snapshot().lateReplies, Number(stale));
    assert.equal(fixture.snapshot().blocked, 0);
    assert.equal(fixture.snapshot().keys, 1);
    assert.equal(displayed === null, stale);
  });
}

test("same actor/key/payload replays a synthetic reply without creating another key", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  const first = await (await finish(fixture)).json();
  const second = await (await finish(fixture)).json();
  assert.equal(first.data.replayed, false);
  assert.equal(second.data.replayed, true);
  assert.deepEqual(second.data.item, first.data.item);
  assert.equal(second.data.localOnly, true);
  assert.equal(fixture.snapshot().keys, 1);
  assert.equal(fixture.snapshot().calls, 2);
  assert.equal(fixture.snapshot().dispatched, 2);
  assert.equal((await finish(fixture, write(fixture, { body: JSON.stringify({ ...payload, client: "TEST changed" }) }))).status, 409);
  assert.equal(fixture.snapshot().keys, 1);
  assert.equal(fixture.snapshot().replies, 2);
});

for (const phase of ["lookup", "response"]) {
  test(`${phase} phase bounds concurrent held requests at eight, including microtask overlap`, async () => {
    const fixture = createAppointmentCreateBrowserFixture(`?phase=${phase}`);
    const pending = Array.from({ length: 9 }, () => fixture.request(url, write(fixture)));
    await Promise.resolve();
    assert.equal(fixture.snapshot().held, 8);
    assert.equal((await pending[8]).status, 429);
    for (let i = 0; i < 8; i++) fixture.release();
    assert.equal((await Promise.all(pending.slice(0, 8))).every((reply) => reply.status === 200), true);
    assert.equal(fixture.snapshot().held, 0);
    assert.equal(fixture.snapshot().dispatched, 8);
    assert.equal(fixture.snapshot().keys, 1);
  });
}

test("the 32-key cap rejects new fake keys but still permits an existing-key replay", async () => {
  const fixture = createAppointmentCreateBrowserFixture();
  for (let i = 0; i < 32; i++) {
    const body = JSON.stringify({ ...payload, requestKey: `00000000-0000-4000-8000-${String(1300 + i).padStart(12, "0")}` });
    assert.equal((await finish(fixture, write(fixture, { body }))).status, 200);
  }
  assert.equal((await finish(fixture)).status, 429);
  assert.equal(fixture.snapshot().keys, 32);
  const body = JSON.stringify({ ...payload, requestKey: "00000000-0000-4000-8000-000000001300" });
  assert.equal((await (await finish(fixture, write(fixture, { body }))).json()).data.replayed, true);
  assert.equal(fixture.snapshot().keys, 32);
});

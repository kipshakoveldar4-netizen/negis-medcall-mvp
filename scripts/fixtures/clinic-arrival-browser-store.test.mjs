import assert from "node:assert/strict";
import test from "node:test";
import {
  clinicArrivalFixtureIds as ids,
  createClinicArrivalBrowserFixture,
  isClinicArrivalFixtureLocation,
} from "./clinic-arrival-browser-store.ts";

const url = new URL(`/api/crm/clinic-operator-arrivals?workspaceId=${ids.workspace}&requestId=${ids.request}`, "http://fixture.invalid");
const write = (fixture, overrides = {}) => {
  const lifetime = fixture.snapshot().lifetime;
  return {
    method: "POST", body: JSON.stringify({ appointmentId: ids.appointment }),
    expectedUserId: lifetime.actorId, dispatchGuard: lifetime.isSessionCurrent, ...overrides,
  };
};
const counts = (fixture) => {
  const { queued, dispatched, canceled } = fixture.snapshot();
  return { queued, dispatched, canceled };
};

test("clinic arrival activation requires the exact HTTP loopback route", () => {
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(isClinicArrivalFixtureLocation({ pathname: "/clinic-arrival", hostname, protocol: "http:" }), true);
  }
  for (const location of [
    {}, { pathname: "/clinic-arrival" },
    { pathname: "/clinic-arrival", hostname: "preview.invalid", protocol: "https:" },
    { pathname: "/clinic-arrival", hostname: "127.0.0.1", protocol: "https:" },
    { pathname: "/operator", hostname: "127.0.0.1", protocol: "http:" },
    { pathname: "/clinic-arrival/", hostname: "127.0.0.1", protocol: "http:" },
  ]) assert.equal(isClinicArrivalFixtureLocation(location), false);
});

test("only the scoped synthetic arrival endpoint and a single appointment body are allowed", async () => {
  const fixture = createClinicArrivalBrowserFixture();
  for (const target of [
    new URL("/api/crm/clients", url), new URL("/api/crm/operator-arrivals", url),
    new URL(url.pathname, url), new URL(url.href.replace(ids.workspace, "other")),
    new URL(url.href.replace(ids.request, "other")), new URL(url.href.replace("fixture.invalid", "external.invalid")),
  ]) {
    assert.equal((await fixture.request(target)).status, 403);
    assert.equal((await fixture.request(target, write(fixture))).status, 403);
  }
  for (const method of ["PATCH", "PUT", "DELETE"]) {
    assert.equal((await fixture.request(url, write(fixture, { method }))).status, 403);
  }
  for (const body of [undefined, "bad json", "null", "[]", "{}", JSON.stringify({ appointmentId: "other" }),
    JSON.stringify({ appointmentId: ids.appointment, extra: true })]) {
    assert.equal((await fixture.request(url, write(fixture, { body }))).status, 403);
  }
  assert.deepEqual(counts(fixture), { queued: 0, dispatched: 0, canceled: 0 });
});

test("every list read stays synthetic, actor scoped, arrived and contact free", async () => {
  const fixture = createClinicArrivalBrowserFixture();
  for (const actor of ["A", "B", "A"]) {
    const { data } = await (await fixture.request(url)).json();
    assert.equal(data.items.length, 1);
    assert.equal(data.hasMore, false);
    const item = data.items[0];
    assert.equal(item.clientName, `TEST ${actor}: synthetic patient`);
    assert.equal(item.appointmentId, ids.appointment);
    assert.equal(item.status, "arrived");
    assert.equal(item.arrivalId, null);
    assert.equal(item.clinicConfirmedAt, null);
    assert.doesNotMatch(JSON.stringify(item), /phone|email|whatsapp|https?:|tel:/i);
    fixture.switchActor();
  }
  assert.deepEqual(counts(fixture), { queued: 0, dispatched: 0, canceled: 0 });
});

test("lifetimes and published snapshots are immutable and never revive after single-click ABA", () => {
  const fixture = createClinicArrivalBrowserFixture();
  let notifications = 0;
  const unsubscribe = fixture.subscribe(() => { notifications++; });
  const initial = fixture.snapshot();
  assert.equal(fixture.snapshot(), initial);
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.lifetime), true);
  fixture.switchABA();
  assert.equal(initial.lifetime.isSessionCurrent(), false);
  assert.equal(fixture.snapshot().lifetime.isSessionCurrent(), true);
  assert.equal(fixture.snapshot().lifetime.actorId, initial.lifetime.actorId);
  assert.notEqual(fixture.snapshot().lifetime, initial.lifetime);
  assert.equal(fixture.snapshot().lifetime.revision, initial.lifetime.revision + 2);
  assert.equal(notifications, 1);
  unsubscribe();
  fixture.switchActor();
  assert.equal(notifications, 1);
});

test("same-actor lookup waits for release, checks both boundaries and returns only local success", async () => {
  const fixture = createClinicArrivalBrowserFixture();
  let checks = 0;
  const pending = fixture.request(url, write(fixture, { dispatchGuard: () => { checks++; return true; } }));
  assert.deepEqual(counts(fixture), { queued: 1, dispatched: 0, canceled: 0 });
  assert.equal(fixture.snapshot().held, true);
  assert.equal(checks, 1);
  fixture.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { localOnly: true, arrivalId: ids.arrival });
  assert.equal(checks, 2);
  assert.equal(fixture.snapshot().held, false);
  assert.deepEqual(counts(fixture), { queued: 1, dispatched: 1, canceled: 0 });
  assert.equal(fixture.snapshot().lastOutcome.actor, "A");
  assert.equal((await (await fixture.request(url)).json()).data.items[0].arrivalId, null);
});

test("invalid signal, expected actor or guard cancels before queuing or dispatch", async () => {
  const fixture = createClinicArrivalBrowserFixture();
  const controller = new AbortController();
  controller.abort();
  for (const overrides of [
    { signal: controller.signal }, { expectedUserId: undefined }, { expectedUserId: "other" },
    { dispatchGuard: undefined }, { dispatchGuard: () => false },
  ]) await assert.rejects(fixture.request(url, write(fixture, overrides)), { name: "AbortError" });
  assert.deepEqual(counts(fixture), { queued: 0, dispatched: 0, canceled: 5 });
  await assert.rejects(fixture.request(url, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fixture.snapshot().canceled, 5);
});

for (const transition of ["switchActor", "switchABA"]) {
  test(`lookup ${transition} invalidates the queued action before any React commit`, async () => {
    const fixture = createClinicArrivalBrowserFixture();
    const old = fixture.snapshot().lifetime;
    const pending = fixture.request(url, write(fixture));
    const rejected = assert.rejects(pending, { name: "AbortError" });
    fixture[transition]();
    assert.equal(old.isSessionCurrent(), false);
    fixture.release();
    await rejected;
    assert.deepEqual(counts(fixture), { queued: 1, dispatched: 0, canceled: 1 });
    assert.equal(fixture.snapshot().lastOutcome, null);
    const fresh = fixture.request(url, write(fixture));
    fixture.release();
    assert.equal((await fresh).status, 200);
    assert.deepEqual(counts(fixture), { queued: 2, dispatched: 1, canceled: 1 });
  });
}

for (const condition of ["abort", "guard", "expected actor"]) {
  test(`lookup rechecks ${condition} after the simulated session wait`, async () => {
    const fixture = createClinicArrivalBrowserFixture();
    const controller = new AbortController();
    let current = true;
    const init = write(fixture, { signal: controller.signal, dispatchGuard: () => current });
    const pending = fixture.request(url, init);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    if (condition === "abort") controller.abort();
    if (condition === "guard") current = false;
    if (condition === "expected actor") init.expectedUserId = "other";
    fixture.release();
    await rejected;
    assert.deepEqual(counts(fixture), { queued: 1, dispatched: 0, canceled: 1 });
  });
}

test("response phase also rechecks the simulated lookup boundary before dispatch", async () => {
  const fixture = createClinicArrivalBrowserFixture("?phase=response");
  const pending = fixture.request(url, write(fixture));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  fixture.switchABA();
  await rejected;
  assert.deepEqual(counts(fixture), { queued: 0, dispatched: 0, canceled: 1 });
  assert.equal(fixture.snapshot().held, false);
});

for (const reply of ["success", "error"]) {
  for (const transition of ["same actor", "switchActor", "switchABA", "abort"]) {
    test(`response ${reply}, ${transition}: dispatched outcome is held but never falsely canceled`, async () => {
      const fixture = createClinicArrivalBrowserFixture(`?phase=response&reply=${reply}`);
      const old = fixture.snapshot().lifetime;
      const controller = new AbortController();
      let guardCurrent = true;
      const pending = fixture.request(url, write(fixture, {
        signal: controller.signal, dispatchGuard: () => guardCurrent && old.isSessionCurrent(),
      }));
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      assert.deepEqual(counts(fixture), { queued: 0, dispatched: 1, canceled: 0 });
      assert.equal(fixture.snapshot().held, true);
      assert.equal(settled, false);
      if (transition === "abort") controller.abort();
      else if (transition !== "same actor") fixture[transition]();
      guardCurrent = false;
      fixture.release();
      const response = await pending;
      assert.equal(response.status, reply === "success" ? 200 : 500);
      const body = await response.json();
      assert.equal(body.success, reply === "success");
      if (reply === "success") assert.equal(body.data.localOnly, true);
      else assert.equal(body.error, "TEST: local arrival failure");
      assert.deepEqual(counts(fixture), { queued: 0, dispatched: 1, canceled: 0 });
      assert.deepEqual(fixture.snapshot().lastOutcome, { actor: "A", revision: old.revision, reply });
      assert.equal((await (await fixture.request(url)).json()).data.items[0].arrivalId, null);
    });
  }
}

test("each lookup write has its own wait and error replies do not pretend to persist", async () => {
  const fixture = createClinicArrivalBrowserFixture("?phase=lookup&reply=error");
  for (let i = 1; i <= 2; i++) {
    const pending = fixture.request(url, write(fixture));
    assert.equal(fixture.snapshot().held, true);
    fixture.release();
    assert.equal((await pending).status, 500);
    assert.deepEqual(counts(fixture), { queued: i, dispatched: i, canceled: 0 });
  }
  const defaults = createClinicArrivalBrowserFixture("?phase=other&reply=other").snapshot();
  assert.equal(defaults.phase, "lookup");
  assert.equal(defaults.reply, "success");
});

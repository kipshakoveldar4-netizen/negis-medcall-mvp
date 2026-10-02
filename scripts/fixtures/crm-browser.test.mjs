import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingRetryFixture } from "./booking-retry.ts";

// Supply only the two browser globals consumed by the fixture bootstrap.
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map();
const fixtureWindow = {};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: (key, value) => storage.set(key, value) } });
Object.defineProperty(globalThis, "window", { configurable: true, value: fixtureWindow });
let fixture;
try {
  fixture = await import("./crm-browser-mocks.ts");
} finally {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else delete globalThis.localStorage;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
}

test("visual fixture uses fabricated contacts and filters the displayed client list", async () => {
  const response = await fixture.crmFetch("/api/crm/clients?search=" + encodeURIComponent("Мария"));
  const body = await response.json();
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].phone, "+77000000002");
  assert.equal(storage.get("negis_workspace_selector"), "00000000-0000-4000-8000-000000000001");
  assert.equal(fixture.useAuth().user.email, "test@example.invalid");
});

test("visual fixture rejects every mutation and direct request helper", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fixture.crmFetch("/api/crm/appointments", { method });
    assert.equal(response.status, 403);
  }
  await assert.rejects(() => fixture.crmRequest(), /отключены/);
});

test("visual fixture blocks external fetch, real login and non-CRM resources", async () => {
  await assert.rejects(() => fixture.crmFetch("https://example.invalid/api/crm/clients"), /External request forbidden/);
  await assert.rejects(() => fixture.crmFetch("/api/meta/launch"), /External request forbidden/);
  await assert.rejects(() => fixtureWindow.fetch("https://example.invalid"), /Network disabled/);
  assert.equal((await fixture.supabase.auth.getSession()).data.session, null);
  assert.ok((await fixture.supabase.auth.signInWithPassword()).error);
});

test("visual fixture server cannot load application config or fall back to real app entry", async () => {
  const source = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  assert.match(source, /configFile: false/);
  assert.match(source, /envDir: false/);
  assert.match(source, /appType: "custom"/);
  assert.match(source, /host: "127\.0\.0\.1"/);
  assert.match(source, /res\.statusCode = 403/);
  assert.match(source, /res\.statusCode = 404/);
  assert.match(source, /form-action 'none'/);
});

test("opt-in retry simulation keeps one in-memory row and demands the identical body and key", async () => {
  const retry = createBookingRetryFixture();
  const body = { requestKey: "00000000-0000-4000-8000-000000000080", client: "Synthetic retry" };
  await assert.rejects(() => retry.send(body), /reply lost/);
  assert.deepEqual(retry.stats(), { calls: 1, rows: 1 });
  assert.equal((await retry.send({ ...body, requestKey: "changed" })).status, 409);
  assert.equal((await retry.send({ ...body, client: "Changed client" })).status, 409);
  const restored = await (await retry.send(body)).json();
  assert.equal(restored.data.replayed, true);
  assert.equal(restored.data.item.client, "Synthetic retry");
  assert.deepEqual(retry.stats(), { calls: 4, rows: 1 });
});

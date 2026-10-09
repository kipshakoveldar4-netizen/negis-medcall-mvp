import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
type CreateAttempt = { workspaceId: string; actorId: string; requestKey: string; payload: Record<string, unknown>; uncertain: boolean; leadId?: string };
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const moduleUrl = new URL("../../artifacts/negis/src/lib/appointmentCreateAttempt.ts", import.meta.url);
const { canReleaseAppointmentAttempt, clearPersistedAppointmentCreateAttempt, confirmedAppointmentCreate, isCurrentAppointmentAttempt, mergeCreatedAppointment, newAppointmentCreateAttempt, persistAppointmentCreateAttempt, restoreAppointmentCreateAttempt } = await import(moduleUrl.href) as {
  newAppointmentCreateAttempt(workspaceId: string, actorId: string, payload: Record<string, unknown>, makeKey?: () => string): CreateAttempt;
  isCurrentAppointmentAttempt(attempt: CreateAttempt, workspaceId: string, actorId: string): boolean;
  canReleaseAppointmentAttempt(attempt: CreateAttempt, status: number, body: unknown): boolean;
  confirmedAppointmentCreate(body: unknown): Record<string, unknown> | null;
  mergeCreatedAppointment<T extends { id: string }>(items: T[], saved: T): T[];
  persistAppointmentCreateAttempt(storage: AttemptStorage, attempt: CreateAttempt): boolean;
  restoreAppointmentCreateAttempt(storage: AttemptStorage, workspaceId: string, actorId: string): CreateAttempt | null;
  clearPersistedAppointmentCreateAttempt(storage: AttemptStorage): void;
};

const key = "00000000-0000-4000-8000-000000000080";
const draft = () => ({ id: "local-generated-id", client: "Synthetic client", startsAt: "2026-10-03T09:00:00Z",
  phone: "+77000000080", serviceItems: [{ name: "Synthetic service", priceMinor: 123450, durationMinutes: 60 }] });
const attempt = () => newAppointmentCreateAttempt("test-workspace", "test-actor", draft(), () => key);

function memoryStorage(): AttemptStorage & { size(): number } {
  const values = new Map<string, string>();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); },
    removeItem: (name) => { values.delete(name); },
    size: () => values.size,
  };
}

test("attempt takes one UUID and a detached original snapshot, without the generated appointment id", () => {
  let calls = 0;
  const input = draft();
  const saved = newAppointmentCreateAttempt("test-workspace", "test-actor", { ...input, requestKey: "untrusted" }, () => { calls++; return key; });
  input.serviceItems[0].priceMinor = 1;
  assert.equal(calls, 1);
  assert.equal(saved.requestKey, key);
  assert.equal(saved.payload.id, undefined);
  assert.equal(saved.payload.requestKey, undefined);
  assert.equal((saved.payload.serviceItems as Array<{ priceMinor: number }>)[0].priceMinor, 123450);
});

test("attempt cannot cross the workspace or signed-in account", () => {
  assert.ok(isCurrentAppointmentAttempt(attempt(), "test-workspace", "test-actor"));
  assert.equal(isCurrentAppointmentAttempt(attempt(), "other-workspace", "test-actor"), false);
  assert.equal(isCurrentAppointmentAttempt(attempt(), "test-workspace", "other-actor"), false);
  assert.throws(() => newAppointmentCreateAttempt("", "test-actor", {}));
  assert.throws(() => newAppointmentCreateAttempt("test-workspace", "", {}));
});

test("same-tab reload restores the exact attempt as uncertain and keeps an optional lead link", () => {
  const storage = memoryStorage();
  const current = attempt();
  current.leadId = "00000000-0000-4000-8000-000000000081";
  assert.ok(persistAppointmentCreateAttempt(storage, current));

  const restored = restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor");
  assert.deepEqual(restored, { ...current, uncertain: true });
  assert.notEqual(restored?.payload, current.payload);
  assert.equal((restored?.payload as { phone?: string }).phone, "+77000000080");

  clearPersistedAppointmentCreateAttempt(storage);
  assert.equal(storage.size(), 0);
});

test("temporary attempt storage refuses corrupt data and cannot cross an account or workspace", () => {
  for (const scope of [["other-workspace", "test-actor"], ["test-workspace", "other-actor"]] as const) {
    const storage = memoryStorage();
    assert.ok(persistAppointmentCreateAttempt(storage, attempt()));
    assert.equal(restoreAppointmentCreateAttempt(storage, scope[0], scope[1]), null);
    assert.equal(storage.size(), 0);
  }

  const storage = memoryStorage();
  storage.setItem("medina_appointment_create_attempt_v1", "not-json");
  assert.equal(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), null);
  assert.equal(storage.size(), 0);
});

test("creation stops when the tab cannot retain and read back the retry key", () => {
  const volatile: AttemptStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  assert.equal(persistAppointmentCreateAttempt(volatile, attempt()), false);

  const denied: AttemptStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => undefined,
  };
  assert.equal(persistAppointmentCreateAttempt(denied, attempt()), false);
});

for (const [status, code] of [[400, "validation"], [401, "authentication_required"], [403, "forbidden"],
  [409, "appointment_conflict"], [409, "outside_doctor_schedule"], [409, "arrival_payment"], [503, "appointment_create_unavailable"]] as const) {
  test(`definite refusal ${code} releases only an attempt with no prior uncertainty`, () => {
    const current = attempt();
    const body = { success: false, code };
    assert.ok(canReleaseAppointmentAttempt(current, status, body));
    current.uncertain = true;
    assert.equal(canReleaseAppointmentAttempt(current, status, body), false);
  });
}

test("network failures, ambiguous server errors and receipt conflicts retain the original intent", () => {
  for (const [status, body] of [[0, null], [200, null], [200, { success: true }], [502, { success: false }],
    [503, { success: false }], [409, { success: false, code: "appointment_request_conflict" }],
    [409, { success: false, code: "appointment_request_unavailable" }]] as const) {
    assert.equal(canReleaseAppointmentAttempt(attempt(), status, body), false);
  }
});

test("only a complete database acknowledgment can finish keyed creation", () => {
  const item = { id: key, client: "Synthetic client" };
  for (const replayed of [true, false]) {
    assert.deepEqual(confirmedAppointmentCreate({ success: true, mode: "supabase", data: { item, replayed } }), item);
  }
  for (const body of [null, {}, { success: true, mode: "demo", data: { item, replayed: false } },
    { success: true, mode: "supabase", data: { item } }, { success: true, mode: "supabase", data: { replayed: false } },
    { success: true, mode: "supabase", data: { item: { id: "temporary" }, replayed: false } }]) {
    assert.equal(confirmedAppointmentCreate(body), null);
  }
});

test("replay replaces a concurrently loaded row, removes duplicates and preserves other visits", () => {
  const other = { id: "other", value: "unchanged" };
  const old = { id: key, value: "stale" };
  const saved = { id: key, value: "current" };
  assert.deepEqual(mergeCreatedAppointment([other, old, old], saved), [other, saved]);
  assert.deepEqual(mergeCreatedAppointment([other], saved), [saved, other]);
  assert.deepEqual(mergeCreatedAppointment([saved, other], saved), [saved, other]);
});

test("booking form sends the saved attempt through crmFetch and protects uncertainty", async () => {
  const source = await readFile(new URL("../../artifacts/negis/src/pages/AppointmentsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /body: JSON\.stringify\(\{ \.\.\.attempt\.payload, requestKey: attempt\.requestKey \}\)/);
  assert.match(source, /response = await crmFetch/);
  assert.match(source, /mergeCreatedAppointment\(current, appointmentFromApi\(saved\)\)/);
  assert.match(source, /if \(submitLock\.current \|\| saving\) return/);
  assert.match(source, /if \(!retrying && localConflict/);
  assert.match(source, /<fieldset[^>]*disabled=\{saving \|\| unconfirmedCreate\}/);
  assert.match(source, /!submitLock\.current && !createAttempt\.current\?\.uncertain/);
  assert.match(source, /window\.addEventListener\("beforeunload", warnBeforeLeaving\)/);
  assert.match(source, /persistAppointmentCreateAttempt\(storage, attempt\)/);
  assert.match(source, /!storage \|\| !persistAppointmentCreateAttempt\(storage, attempt\)/);
  const createBlock = source.slice(
    source.indexOf("const createAppointment = async"),
    source.indexOf("const startSaleFromAppointment"),
  );
  assert.ok(
    createBlock.indexOf("persistAppointmentCreateAttempt(storage, attempt)") <
      createBlock.indexOf("response = await crmFetch"),
    "the retry key must be retained before the appointment request",
  );
  assert.match(source, /restoreAppointmentCreateAttempt\(storage, scope\.workspaceId, scope\.actorId\)/);
  assert.match(source, /clearPersistedAppointmentCreateAttempt\(storage\)/);
  assert.doesNotMatch(source, /saved \? appointmentFromApi\(saved\) : appointment, \.\.\.current/);

  const helper = await readFile(moduleUrl, "utf8");
  assert.match(helper, /medina_appointment_create_attempt_v1/);
  assert.doesNotMatch(helper, /localStorage/);
});

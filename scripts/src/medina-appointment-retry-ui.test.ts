import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
type AttemptContext = { originRole?: string; leadId?: string };
type CreateAttempt = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly requestKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly originRole?: string;
  readonly leadId?: string;
  uncertain: boolean;
};
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RestoreReason = "unreadable" | "invalid" | "conflict";
const moduleUrl = new URL("../../artifacts/negis/src/lib/appointmentCreateAttempt.ts", import.meta.url);
const { AppointmentAttemptRestoreError, canReleaseAppointmentAttempt, clearPersistedAppointmentCreateAttempt, confirmedAppointmentCreate, isCurrentAppointmentAttempt, mergeCreatedAppointment, newAppointmentCreateAttempt, persistAppointmentCreateAttempt, restoreAppointmentCreateAttempt, sameAppointmentCreateIntent } = await import(moduleUrl.href) as {
  AppointmentAttemptRestoreError: new (reason: RestoreReason) => Error & { reason: RestoreReason };
  newAppointmentCreateAttempt(workspaceId: string, actorId: string, payload: Record<string, unknown>, makeKey?: () => string, context?: AttemptContext): CreateAttempt;
  isCurrentAppointmentAttempt(attempt: CreateAttempt, workspaceId: string, actorId: string): boolean;
  canReleaseAppointmentAttempt(attempt: CreateAttempt, status: number, body: unknown): boolean;
  confirmedAppointmentCreate(body: unknown): Record<string, unknown> | null;
  mergeCreatedAppointment<T extends { id: string }>(items: T[], saved: T): T[];
  persistAppointmentCreateAttempt(storage: AttemptStorage, attempt: CreateAttempt): boolean;
  restoreAppointmentCreateAttempt(storage: AttemptStorage, workspaceId: string, actorId: string): CreateAttempt | null;
  clearPersistedAppointmentCreateAttempt(storage: AttemptStorage, attempt: CreateAttempt): boolean;
  sameAppointmentCreateIntent(left: CreateAttempt, right: CreateAttempt): boolean;
};

const key = "00000000-0000-4000-8000-000000000080";
const otherKey = "00000000-0000-4000-8000-000000000082";
const leadId = "00000000-0000-4000-8000-000000000081";
const legacyKey = "medina_appointment_create_attempt_v1";
const scopedKey = (workspaceId = "test-workspace", actorId = "test-actor") =>
  `medina_appointment_create_attempt_v2::${encodeURIComponent(workspaceId)}:${encodeURIComponent(actorId)}`;
const draft = () => ({ id: "local-generated-id", client: "Synthetic client", startsAt: "2026-10-03T09:00:00Z",
  phone: "+77000000080", serviceItems: [{ name: "Synthetic service", priceMinor: 123450, durationMinutes: 60 }] });
const attempt = (context?: AttemptContext) => newAppointmentCreateAttempt("test-workspace", "test-actor", draft(), () => key, context);
const serialized = (current: CreateAttempt, version = 2) => JSON.stringify({ version, ...current });

function memoryStorage(entries: Array<[string, string]> = []): AttemptStorage & { size(): number; snapshot(): Array<[string, string]> } {
  const values = new Map<string, string>(entries);
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value); },
    removeItem: (name) => { values.delete(name); },
    size: () => values.size,
    snapshot: () => [...values.entries()],
  };
}

function assertRestoreError(storage: AttemptStorage, reason: RestoreReason) {
  assert.throws(() => restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), (error: unknown) => {
    assert.ok(error instanceof AppointmentAttemptRestoreError);
    assert.equal(error.reason, reason);
    return true;
  });
}

function assertFrozenSnapshot(current: CreateAttempt) {
  const before = serialized(current);
  assert.ok(Object.isFrozen(current.payload));
  assert.ok(Object.isFrozen(current.payload.serviceItems));
  const items = current.payload.serviceItems as Array<{ priceMinor: number }>;
  assert.ok(Object.isFrozen(items[0]));
  assert.equal(Reflect.set(items[0], "priceMinor", 1), false);
  assert.equal(Reflect.set(items, "0", {}), false);
  assert.equal(serialized(current), before);
  current.uncertain = true;
  assert.equal(current.uncertain, true, "outcome uncertainty remains mutable");
}

test("attempt takes one UUID and a detached, deeply frozen snapshot without id or supplied requestKey", () => {
  let calls = 0;
  const input = draft();
  const saved = newAppointmentCreateAttempt("test-workspace", "test-actor", { ...input, requestKey: "untrusted" }, () => { calls++; return key; });
  input.serviceItems[0].priceMinor = 1;
  assert.equal(calls, 1);
  assert.equal(saved.requestKey, key);
  assert.equal(saved.payload.id, undefined);
  assert.equal(saved.payload.requestKey, undefined);
  assert.equal((saved.payload.serviceItems as Array<{ priceMinor: number }>)[0].priceMinor, 123450);
  assert.notEqual(saved.payload.serviceItems, input.serviceItems);
  assert.equal(saved.uncertain, false);
  assert.equal(saved.originRole, undefined);
  assert.equal(saved.leadId, undefined);
  assertFrozenSnapshot(saved);
});

test("creation captures optional role and lead context as immutable intent", () => {
  const context = { originRole: "lead_manager", leadId };
  const current = attempt(context);
  context.originRole = "admin";
  context.leadId = otherKey;
  assert.equal(current.originRole, "lead_manager");
  assert.equal(current.leadId, leadId);
  assertFrozenSnapshot(current);
});

test("context can be supplied while the UUID factory stays optional", () => {
  const current = newAppointmentCreateAttempt("test-workspace", "test-actor", draft(), undefined, { originRole: "lead_manager", leadId });
  assert.match(current.requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(current.originRole, "lead_manager");
  assert.equal(current.leadId, leadId);
});

for (const invalidKey of ["", "not-a-uuid", "00000000-0000-1000-8000-000000000080",
  "00000000-0000-4000-7000-000000000080", `${key} `]) {
  test(`creation rejects a non-UUIDv4 request key: ${JSON.stringify(invalidKey)}`, () => {
    assert.throws(() => newAppointmentCreateAttempt("test-workspace", "test-actor", draft(), () => invalidKey));
  });
}

test("attempt cannot cross the workspace or signed-in account", () => {
  assert.ok(isCurrentAppointmentAttempt(attempt(), "test-workspace", "test-actor"));
  assert.equal(isCurrentAppointmentAttempt(attempt(), "other-workspace", "test-actor"), false);
  assert.equal(isCurrentAppointmentAttempt(attempt(), "test-workspace", "other-actor"), false);
  assert.throws(() => newAppointmentCreateAttempt("", "test-actor", {}));
  assert.throws(() => newAppointmentCreateAttempt("test-workspace", "", {}));
});

test("same intent compares the whole immutable snapshot but ignores uncertainty", () => {
  const current = attempt({ originRole: "lead_manager", leadId });
  const copy = attempt({ originRole: "lead_manager", leadId });
  copy.uncertain = true;
  assert.notEqual(copy.payload, current.payload);
  assert.ok(sameAppointmentCreateIntent(current, copy));
  assert.ok(sameAppointmentCreateIntent(copy, current));
  for (const different of [
    { ...copy, requestKey: otherKey }, { ...copy, workspaceId: "other-workspace" },
    { ...copy, actorId: "other-actor" }, { ...copy, originRole: "admin" },
    { ...copy, originRole: undefined }, { ...copy, leadId: otherKey }, { ...copy, leadId: undefined },
    { ...copy, payload: { ...copy.payload, phone: "+77000000082" } },
    { ...copy, payload: { ...copy.payload, serviceItems: [{ name: "Different service", priceMinor: 1, durationMinutes: 30 }] } },
  ]) {
    assert.equal(sameAppointmentCreateIntent(current, different), false);
    assert.equal(sameAppointmentCreateIntent(different, current), false);
  }
});

test("same-tab reload restores the exact immutable snapshot as uncertain with role and lead", () => {
  const storage = memoryStorage();
  const current = attempt({ originRole: "lead_manager", leadId });
  assert.ok(persistAppointmentCreateAttempt(storage, current));
  assert.equal(storage.size(), 1);
  const raw = storage.getItem(scopedKey());
  assert.ok(raw, "creation must use the scoped v2 address");
  assert.equal(storage.getItem(legacyKey), null);

  const restored = restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor");
  assert.deepEqual(restored, { ...current, uncertain: true });
  assert.ok(restored);
  assert.notEqual(restored.payload, current.payload);
  assert.equal(restored.payload.phone, "+77000000080");
  assertFrozenSnapshot(restored);
  assert.equal(storage.getItem(scopedKey()), raw, "restoration must not rewrite the saved snapshot");

  assert.equal(clearPersistedAppointmentCreateAttempt(storage, restored), true);
  assert.equal(storage.size(), 0);
});

test("UUIDv1 lead metadata survives scoped reload and legacy migration while requestKey stays UUIDv4", () => {
  const uuid1Lead = "00000000-0000-1000-8000-000000000081";
  const current = attempt({ originRole: "lead_manager", leadId: uuid1Lead });
  assert.equal(current.leadId, uuid1Lead);
  assert.equal(current.requestKey, key);
  assert.equal(current.payload.leadId, undefined, "lead linkage belongs to retry metadata, not the appointment payload");
  for (const legacy of [false, true]) {
    const storage = memoryStorage(legacy ? [[legacyKey, serialized(current, 1)]] : []);
    if (!legacy) assert.ok(persistAppointmentCreateAttempt(storage, current));
    const restored = restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor");
    assert.deepEqual(restored, { ...current, uncertain: true });
    assert.ok(restored);
    assert.equal(restored.leadId, uuid1Lead);
    assert.ok(sameAppointmentCreateIntent(current, restored));
    assert.ok(persistAppointmentCreateAttempt(storage, restored));
    assert.ok(clearPersistedAppointmentCreateAttempt(storage, restored));
    assert.equal(storage.size(), 0);
  }
});

test("looking up another account or workspace preserves the original scoped attempt", () => {
  for (const scope of [["other-workspace", "test-actor"], ["test-workspace", "other-actor"]] as const) {
    const storage = memoryStorage();
    assert.ok(persistAppointmentCreateAttempt(storage, attempt()));
    const before = storage.snapshot();
    assert.equal(restoreAppointmentCreateAttempt(storage, scope[0], scope[1]), null);
    assert.deepEqual(storage.snapshot(), before);
  }
});

test("separate actors and workspaces coexist, restore separately and clear only their own slot", () => {
  const storage = memoryStorage();
  const attempts = [attempt(),
    newAppointmentCreateAttempt("test-workspace", "other-actor", draft(), () => otherKey),
    newAppointmentCreateAttempt("other-workspace", "test-actor", draft(), () => key),
  ];
  for (const current of attempts) assert.ok(persistAppointmentCreateAttempt(storage, current));
  assert.equal(storage.size(), 3);
  for (const current of attempts) {
    assert.ok(storage.getItem(scopedKey(current.workspaceId, current.actorId)));
    assert.deepEqual(restoreAppointmentCreateAttempt(storage, current.workspaceId, current.actorId), { ...current, uncertain: true });
  }
  assert.ok(clearPersistedAppointmentCreateAttempt(storage, attempts[1]));
  assert.equal(storage.size(), 2);
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...attempts[0], uncertain: true });
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "other-workspace", "test-actor"), { ...attempts[2], uncertain: true });
});

test("v2 addresses encode workspace and actor independently without delimiter collisions", () => {
  const storage = memoryStorage();
  const scopes = [["workspace:part", "actor/% value"], ["workspace", "part:actor/% value"]] as const;
  for (const [workspace, actor] of scopes) {
    const current = newAppointmentCreateAttempt(workspace, actor, draft(), () => key);
    assert.ok(persistAppointmentCreateAttempt(storage, current));
    assert.ok(storage.getItem(scopedKey(workspace, actor)));
    assert.deepEqual(restoreAppointmentCreateAttempt(storage, workspace, actor), { ...current, uncertain: true });
  }
  assert.equal(storage.size(), 2);
});

test("missing scoped and legacy slots restore as empty", () => {
  const storage = memoryStorage();
  assert.equal(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), null);
  assert.equal(storage.size(), 0);
});

const invalidSnapshots: Array<[string, string]> = [
  ["unparseable JSON", "not-json"], ["empty slot contents", ""], ["null", "null"], ["array", "[]"],
  ["unknown version", serialized(attempt(), 99)],
  ["wrong workspace", serialized({ ...attempt(), workspaceId: "other-workspace" })],
  ["wrong actor", serialized({ ...attempt(), actorId: "other-actor" })],
  ["non-UUIDv4 key", serialized({ ...attempt(), requestKey: "00000000-0000-1000-8000-000000000080" })],
  ["payload id", serialized({ ...attempt(), payload: { ...attempt().payload, id: key } })],
  ["payload requestKey", serialized({ ...attempt(), payload: { ...attempt().payload, requestKey: key } })],
  ["invalid lead", serialized({ ...attempt(), leadId: "not-a-uuid" })],
  ["invalid payload", JSON.stringify({ version: 2, ...attempt(), payload: [] })],
  ["invalid role", JSON.stringify({ version: 2, ...attempt(), originRole: 7 })],
];

for (const [name, raw] of invalidSnapshots) {
  test(`corrupt scoped snapshot (${name}) blocks restoration and is never discarded or overwritten`, () => {
    const storage = memoryStorage([[scopedKey(), raw]]);
    const before = storage.snapshot();
    assertRestoreError(storage, "invalid");
    assert.equal(persistAppointmentCreateAttempt(storage, attempt()), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, attempt()), false);
    assert.deepEqual(storage.snapshot(), before);
  });
}

const invalidLegacySnapshots: Array<[string, string]> = [
  ["unparseable JSON", "not-json"], ["empty contents", ""], ["null", "null"], ["array", "[]"],
  ["unknown ownership", "{}"], ["unknown version", serialized(attempt(), 99)],
  ["unknown actor", JSON.stringify({ version: 1, workspaceId: "foreign-workspace" })],
  ["invalid key", serialized({ ...attempt(), requestKey: "not-a-uuid" }, 1)],
  ["payload id", serialized({ ...attempt(), payload: { ...attempt().payload, id: key } }, 1)],
  ["invalid lead", serialized({ ...attempt(), leadId: "not-a-uuid" }, 1)],
];
for (const [name, raw] of invalidLegacySnapshots) {
  test(`malformed or unknown legacy data (${name}) blocks even a valid scoped snapshot`, () => {
    const storage = memoryStorage([[scopedKey(), serialized(attempt())], [legacyKey, raw]]);
    const before = storage.snapshot();
    assertRestoreError(storage, "invalid");
    assert.equal(persistAppointmentCreateAttempt(storage, attempt()), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, attempt()), false);
    assert.deepEqual(storage.snapshot(), before);
  });
}

for (const unreadable of [scopedKey(), legacyKey]) {
  test(`unreadable ${unreadable} fails closed without mutating storage`, () => {
    const backing = memoryStorage([[scopedKey(), serialized(attempt())], [legacyKey, serialized(attempt(), 1)]]);
    const before = backing.snapshot();
    const storage: AttemptStorage = { ...backing, getItem(name) {
      if (name === unreadable) throw new Error("synthetic storage denial");
      return backing.getItem(name);
    } };
    assertRestoreError(storage, "unreadable");
    assert.equal(persistAppointmentCreateAttempt(storage, attempt()), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, attempt()), false);
    assert.deepEqual(backing.snapshot(), before);
  });
}

test("matching legacy data migrates by scoped write and successful readback before legacy removal", () => {
  const current = attempt({ leadId, originRole: "lead_manager" });
  const backing = memoryStorage([[legacyKey, serialized(current, 1)]]);
  const events: string[] = [];
  const storage: AttemptStorage = {
    getItem(name) { events.push(`get:${name}`); return backing.getItem(name); },
    setItem(name, raw) { events.push(`set:${name}`); backing.setItem(name, raw); },
    removeItem(name) {
      events.push(`remove:${name}`);
      assert.ok(backing.getItem(scopedKey()), "legacy cannot be removed until a scoped copy exists");
      backing.removeItem(name);
    },
  };
  const restored = restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor");
  assert.deepEqual(restored, { ...current, uncertain: true });
  assert.ok(restored);
  assertFrozenSnapshot(restored);
  const written = events.indexOf(`set:${scopedKey()}`);
  const verified = events.indexOf(`get:${scopedKey()}`, written + 1);
  const removed = events.indexOf(`remove:${legacyKey}`);
  assert.ok(written >= 0 && verified > written && removed > verified, "migration must write, verify, then remove legacy");
  assert.equal(backing.getItem(legacyKey), null);
  assert.equal(backing.size(), 1);
  assert.deepEqual(restoreAppointmentCreateAttempt(backing, "test-workspace", "test-actor"), { ...current, uncertain: true });
});

test("same-intent scoped and legacy snapshots restore without a false conflict", () => {
  const current = attempt({ originRole: "lead_manager", leadId });
  const storage = memoryStorage([[scopedKey(), serialized({ ...current, uncertain: true })], [legacyKey, serialized(current, 1)]]);
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...current, uncertain: true });
  assert.ok(storage.getItem(scopedKey()));
  assert.ok(persistAppointmentCreateAttempt(storage, current));
});

test("foreign legacy snapshots are preserved, hidden and do not prevent a separate scope", () => {
  for (const foreign of [{ ...attempt(), workspaceId: "other-workspace" }, { ...attempt(), actorId: "other-actor" }]) {
    const raw = serialized(foreign, 1);
    const storage = memoryStorage([[legacyKey, raw]]);
    assert.equal(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), null);
    assert.deepEqual(storage.snapshot(), [[legacyKey, raw]]);
    assert.ok(persistAppointmentCreateAttempt(storage, attempt()));
    assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...attempt(), uncertain: true });
    assert.ok(clearPersistedAppointmentCreateAttempt(storage, attempt()));
    assert.deepEqual(storage.snapshot(), [[legacyKey, raw]]);
  }
});

for (const changed of ["requestKey", "payload", "leadId", "originRole"] as const) {
  test(`different ${changed} in scoped and legacy intents raises conflict and preserves both`, () => {
    const current = attempt({ originRole: "lead_manager", leadId });
    const different = { ...current, [changed]: changed === "payload" ? { ...current.payload, phone: "+77000000082" }
      : changed === "originRole" ? "admin" : otherKey };
    const storage = memoryStorage([[scopedKey(), serialized(current)], [legacyKey, serialized(different, 1)]]);
    const before = storage.snapshot();
    assertRestoreError(storage, "conflict");
    assert.equal(persistAppointmentCreateAttempt(storage, current), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, current), false);
    assert.deepEqual(storage.snapshot(), before);
  });
}

for (const failure of ["write throws", "write lost", "readback throws", "readback changed"] as const) {
  test(`legacy migration ${failure} fails closed and retains the original legacy snapshot`, () => {
    const raw = serialized(attempt({ leadId }), 1);
    const backing = memoryStorage([[legacyKey, raw]]);
    let wrote = false;
    let removals = 0;
    const storage: AttemptStorage = {
      ...backing,
      setItem(name, value) {
        if (name === scopedKey()) {
          wrote = true;
          if (failure === "write throws") throw new Error("synthetic migration write denial");
          if (failure === "write lost") return;
          if (failure === "readback changed") { backing.setItem(name, serialized({ ...attempt(), requestKey: otherKey })); return; }
        }
        backing.setItem(name, value);
      },
      getItem(name) {
        if (name === scopedKey() && wrote && failure === "readback throws") throw new Error("synthetic migration read denial");
        return backing.getItem(name);
      },
      removeItem() { removals++; },
    };
    assertRestoreError(storage, "unreadable");
    assert.equal(removals, 0, "failed migration must not remove legacy or another scoped attempt");
    assert.equal(backing.getItem(legacyKey), raw);
    if (failure === "readback changed") assert.equal(JSON.parse(backing.getItem(scopedKey())!).requestKey, otherKey);
  });
}

test("migration does not clear legacy replaced during scoped write", () => {
  const original = attempt({ originRole: "lead_manager", leadId });
  const foreign = { ...attempt(), actorId: "other-actor", requestKey: otherKey };
  const replacement = serialized(foreign, 1);
  const backing = memoryStorage([[legacyKey, serialized(original, 1)]]);
  const storage: AttemptStorage = { ...backing, setItem(name, raw) {
    backing.setItem(name, raw);
    if (name === scopedKey()) backing.setItem(legacyKey, replacement);
  } };
  assertRestoreError(storage, "conflict");
  assert.equal(backing.getItem(legacyKey), replacement);
  assert.deepEqual(restoreAppointmentCreateAttempt(backing, "test-workspace", "test-actor"), { ...original, uncertain: true });
});

test("legacy cleanup denial never loses the already verified scoped copy", () => {
  const current = attempt({ leadId });
  const raw = serialized(current, 1);
  const backing = memoryStorage([[legacyKey, raw]]);
  const storage: AttemptStorage = { ...backing, removeItem() { throw new Error("synthetic removal denial"); } };
  assertRestoreError(storage, "unreadable");
  assert.equal(backing.getItem(legacyKey), raw);
  assert.ok(backing.getItem(scopedKey()));
  assert.deepEqual(restoreAppointmentCreateAttempt(backing, "test-workspace", "test-actor"), { ...current, uncertain: true });
});

test("persistence accepts the same intent after uncertainty changes", () => {
  const storage = memoryStorage();
  const current = attempt({ originRole: "lead_manager", leadId });
  assert.ok(persistAppointmentCreateAttempt(storage, current));
  current.uncertain = true;
  assert.ok(persistAppointmentCreateAttempt(storage, current));
  assert.equal(storage.size(), 1);
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), current);
});

test("persisting a certain copy cannot downgrade existing stored uncertainty", () => {
  const storage = memoryStorage();
  const uncertain = attempt({ leadId, originRole: "lead_manager" });
  uncertain.uncertain = true;
  assert.ok(persistAppointmentCreateAttempt(storage, uncertain));
  const certain = attempt({ leadId, originRole: "lead_manager" });
  assert.equal(certain.uncertain, false);
  assert.ok(persistAppointmentCreateAttempt(storage, certain));
  const raw = storage.getItem(scopedKey());
  assert.ok(raw);
  assert.equal(JSON.parse(raw).uncertain, true);
  assert.equal(certain.uncertain, false, "storage protection must not mutate its caller");
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), uncertain);
});

const differentIntents: Array<[string, CreateAttempt]> = [
  ["request key", { ...attempt({ originRole: "lead_manager", leadId }), requestKey: otherKey }],
  ["payload", { ...attempt({ originRole: "lead_manager", leadId }), payload: { ...attempt().payload, phone: "+77000000082" } }],
  ["lead", { ...attempt({ originRole: "lead_manager", leadId }), leadId: otherKey }],
  ["missing lead", { ...attempt({ originRole: "lead_manager", leadId }), leadId: undefined }],
  ["role", { ...attempt({ originRole: "lead_manager", leadId }), originRole: "admin" }],
  ["missing role", { ...attempt({ originRole: "lead_manager", leadId }), originRole: undefined }],
];
for (const [name, different] of differentIntents) {
  test(`persist and clear refuse another immutable intent (${name})`, () => {
    const current = attempt({ originRole: "lead_manager", leadId });
    const storage = memoryStorage();
    assert.ok(persistAppointmentCreateAttempt(storage, current));
    const before = storage.snapshot();
    assert.equal(persistAppointmentCreateAttempt(storage, different), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, different), false);
    assert.deepEqual(storage.snapshot(), before);
    assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...current, uncertain: true });
  });
}

for (const [name, context] of [
  ["invalid lead", { leadId: "not-a-uuid" }],
  ["invalid role type", { originRole: 7 }],
] as const) {
  test(`invalid context (${name}) cannot create or overwrite a scoped attempt`, () => {
    const invalidContext = context as unknown as AttemptContext;
    assert.throws(() => attempt(invalidContext));
    const current = attempt({ leadId, originRole: "lead_manager" });
    const storage = memoryStorage();
    assert.ok(persistAppointmentCreateAttempt(storage, current));
    const before = storage.snapshot();
    const invalid = { ...current, ...invalidContext };
    assert.equal(persistAppointmentCreateAttempt(storage, invalid), false);
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, invalid), false);
    assert.deepEqual(storage.snapshot(), before);
    assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...current, uncertain: true });
  });
}

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

for (const failure of ["write throws", "readback throws", "readback changed"] as const) {
  test(`scoped persistence ${failure} is not reported as durable`, () => {
    const backing = memoryStorage();
    const replacement = serialized({ ...attempt(), requestKey: otherKey });
    let wrote = false;
    let removals = 0;
    const storage: AttemptStorage = {
      ...backing,
      setItem(name, raw) {
        wrote = true;
        if (failure === "write throws") throw new Error("synthetic write denial");
        backing.setItem(name, failure === "readback changed" ? replacement : raw);
      },
      getItem(name) {
        if (wrote && failure === "readback throws") throw new Error("synthetic readback denial");
        return backing.getItem(name);
      },
      removeItem() { removals++; },
    };
    assert.equal(persistAppointmentCreateAttempt(storage, attempt()), false);
    assert.equal(removals, 0, "persistence failure cannot discard a stored attempt");
    if (failure === "readback changed") assert.equal(backing.getItem(scopedKey()), replacement);
    if (failure === "readback throws") assert.ok(backing.getItem(scopedKey()));
    if (failure === "write throws") assert.equal(backing.size(), 0);
  });
}

test("persist refuses a different same-scope legacy intent without losing its retry key", () => {
  const original = attempt({ leadId });
  const storage = memoryStorage([[legacyKey, serialized(original, 1)]]);
  const different = { ...original, requestKey: otherKey };
  assert.equal(persistAppointmentCreateAttempt(storage, different), false);
  assert.deepEqual(restoreAppointmentCreateAttempt(storage, "test-workspace", "test-actor"), { ...original, uncertain: true });
});

test("clear accepts an independent exact-intent copy regardless of uncertainty", () => {
  const storage = memoryStorage();
  const current = attempt({ originRole: "lead_manager", leadId });
  assert.ok(persistAppointmentCreateAttempt(storage, current));
  const copy = attempt({ originRole: "lead_manager", leadId });
  copy.uncertain = true;
  assert.notEqual(copy, current);
  assert.ok(clearPersistedAppointmentCreateAttempt(storage, copy));
  assert.equal(storage.size(), 0);
});

test("clear of a missing slot succeeds without touching another account or workspace", () => {
  const storage = memoryStorage();
  const other = newAppointmentCreateAttempt("other-workspace", "other-actor", draft(), () => otherKey);
  assert.ok(persistAppointmentCreateAttempt(storage, other));
  const before = storage.snapshot();
  assert.equal(clearPersistedAppointmentCreateAttempt(storage, attempt()), true);
  assert.deepEqual(storage.snapshot(), before);
  assert.equal(clearPersistedAppointmentCreateAttempt(memoryStorage(), attempt()), true);
});

test("clear refuses an unreadable scoped slot without attempting deletion", () => {
  let removals = 0;
  let writes = 0;
  const storage: AttemptStorage = {
    getItem() { throw new Error("synthetic read denial"); },
    setItem() { writes++; },
    removeItem() { removals++; },
  };
  assert.equal(clearPersistedAppointmentCreateAttempt(storage, attempt()), false);
  assert.equal(removals, 0);
  assert.equal(writes, 0);
});

for (const failure of ["removal throws", "removal ignored", "readback throws", "replacement appears"] as const) {
  test(`clear ${failure} returns false and never deletes a replacement or foreign slot`, () => {
    const current = attempt({ leadId });
    const foreignKey = scopedKey("test-workspace", "other-actor");
    const foreign = serialized({ ...attempt(), actorId: "other-actor", requestKey: otherKey });
    const original = serialized(current);
    const replacement = serialized({ ...current, requestKey: otherKey });
    const backing = memoryStorage([[scopedKey(), original], [foreignKey, foreign]]);
    let removed = false;
    let removals = 0;
    const storage: AttemptStorage = {
      ...backing,
      getItem(name) {
        if (name === scopedKey() && removed && failure === "readback throws") throw new Error("synthetic readback denial");
        return backing.getItem(name);
      },
      removeItem(name) {
        assert.equal(name, scopedKey());
        assert.equal(++removals, 1, "never retry removal against a replacement");
        if (failure === "removal throws") throw new Error("synthetic removal denial");
        removed = true;
        if (failure === "removal ignored") return;
        backing.removeItem(name);
        if (failure === "replacement appears") backing.setItem(name, replacement);
      },
    };
    assert.equal(clearPersistedAppointmentCreateAttempt(storage, current), false);
    assert.equal(removals, 1, "clearing must target the original scope exactly once");
    assert.equal(backing.getItem(foreignKey), foreign);
    if (failure === "removal throws" || failure === "removal ignored") assert.equal(backing.getItem(scopedKey()), original);
    if (failure === "replacement appears") assert.equal(backing.getItem(scopedKey()), replacement);
  });
}

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
  assert.match(source, /const savedAppointment = appointmentFromApi\(saved\);/);
  assert.match(source, /mergeCreatedAppointment\(current, savedAppointment\)/);
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
  assert.ok(createBlock.startsWith("const createAppointment = async"), "inspect the actual creation path");
  const persisted = createBlock.indexOf("persistAppointmentCreateAttempt(storage, attempt)");
  const requested = createBlock.indexOf("response = await crmFetch");
  assert.ok(
    persisted >= 0 && requested > persisted,
    "the retry key must be retained before the appointment request",
  );
  assert.match(createBlock, /if \(!isCurrentMutationScope\(\)\) throw/);
  assert.match(createBlock, /if \(createRecoveryError\) throw/);
  assert.match(createBlock, /expectedUserId: scope\.actorId/);
  assert.match(createBlock, /dispatchGuard: \(\) => isCurrentMutationScope\(\) && createAttempt\.current === attempt/);
  assert.match(createBlock, /if \(!isCurrentMutationScope\(\) \|\| createAttempt\.current !== attempt\) throw/);
  assert.match(createBlock, /setItems\(\(current\) => isCurrentMutationScope\(\) \? mergeCreatedAppointment\(current, savedAppointment\) : current\)/);
  assert.match(createBlock, /startsAt: savedAppointment\.startsAt/);
  assert.match(createBlock, /status: savedAppointment\.status/);
  const submitBlock = source.slice(source.indexOf("const submitForm = async"), source.indexOf("const recoveryErrorNotice"));
  assert.match(submitBlock, /nextCalendarStartsAt = result\.startsAt/);
  assert.match(submitBlock, /setSelectedDate\(dateKeyFromStartsAt\(nextCalendarStartsAt, clinicTimeZone\)\)/);
  assert.match(submitBlock, /if \(activeStatuses\.includes\(result\.status\)\) void markLeadBooked\(result\.leadId\)/);
  assert.match(createBlock, /originRole: scope\.role/);
  assert.match(createBlock, /leadId: prefillLeadRef\.current/);
  assert.doesNotMatch(createBlock, /attempt\.(?:payload|workspaceId|actorId|requestKey|originRole|leadId)\s*=(?!=)/);
  assert.match(source, /restoreAppointmentCreateAttempt\(storage, scope\.workspaceId, scope\.actorId\)/);
  assert.match(source, /setCreateRecoveryError\(error instanceof Error \? error\.message/);
  assert.match(source, /if \(!editingId && createRecoveryError\) \{ toast\.error\(createRecoveryError\); return; \}/);
  assert.match(createBlock, /if \(!clearPersistedAppointmentCreateAttempt\(storage, attempt\)\)\s*\{\s*throw new AppointmentCreateRecoveryError/);
  assert.match(createBlock, /if \(current && canReleaseAppointmentAttempt\(attempt, response\?\.status \?\? 0, body\)\s*&& clearPersistedAppointmentCreateAttempt\(storage, attempt\)\)\s*\{\s*createAttempt\.current = null/);
  const confirmed = createBlock.indexOf("const saved = confirmedAppointmentCreate(body)");
  const cleared = createBlock.indexOf("if (!clearPersistedAppointmentCreateAttempt(storage, attempt))");
  const normalized = createBlock.indexOf("const savedAppointment = appointmentFromApi(saved)");
  const merged = createBlock.indexOf("mergeCreatedAppointment(current, savedAppointment)");
  assert.ok(confirmed >= 0 && cleared > confirmed && normalized > cleared && merged > normalized,
    "confirmation and verified exact-intent clearing must precede publishing success");
  assert.doesNotMatch(source, /clearPersistedAppointmentCreateAttempt\(storage\)/);
  assert.doesNotMatch(source, /saved \? appointmentFromApi\(saved\) : appointment, \.\.\.current/);

  const helper = await readFile(moduleUrl, "utf8");
  assert.match(helper, /medina_appointment_create_attempt_v1/);
  assert.match(helper, /medina_appointment_create_attempt_v2/);
  assert.doesNotMatch(helper, /localStorage/);
});

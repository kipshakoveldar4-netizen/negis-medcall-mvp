import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual push.ts, evaluated unchanged. All native boundaries are synthetic;
// no SDK, browser, permission prompt, subscription service or HTTP is used.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-push-helper-lifetime.test.ts scripts/src/medina-push-notifications.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const file = "artifacts/negis/src/lib/push.ts";
const compiled = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compiled.diagnostics ?? [], [], "The actual helper must transpile");

type Guard = () => boolean;
type Device = { endpoint: string; p256dh: string; auth: string; label: string };
type PushModule = {
  readThisDeviceSubscription(isCurrent?: Guard): Promise<Device | null>;
  subscribeThisDevice(key: string, isCurrent?: Guard): Promise<Device>;
  unsubscribeThisDevice(isCurrent?: Guard): Promise<string>;
};
type Boundary = "permission" | "ready" | "getSubscription" | "subscribe" | "unsubscribe";
type Operation = "read" | "enable" | "disable";
type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };
const observed = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(
  value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }),
);
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(existing = false) {
  const entries: Boundary[] = [], held = new Map<Boundary, ReturnType<typeof deferred>>();
  let current = true, here = existing, permission: unknown = "granted", acknowledgement: unknown = true;
  let endpointReads = 0, keyReads = 0, subscribeEffects = 0, unsubscribeEffects = 0;
  const options: Array<{ userVisibleOnly: boolean; applicationServerKey: number[] }> = [];
  const enter = (boundary: Boundary, value: unknown) => {
    entries.push(boundary);
    return held.get(boundary)?.promise ?? Promise.resolve(value);
  };
  const subscription = {
    get endpoint() { endpointReads++; return "https://push.example.test/synthetic-endpoint"; },
    getKey(name: string) { keyReads++; return new Uint8Array(name === "auth" ? [11, 12] : [21, 22]).buffer; },
    unsubscribe() {
      return enter("unsubscribe", acknowledgement).then(ack => {
        if (ack === true) { here = false; unsubscribeEffects++; }
        return ack;
      });
    },
  };
  const registration = { pushManager: {
    getSubscription() { return enter("getSubscription", here ? subscription : null); },
    subscribe(value: { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer }) {
      options.push({ userVisibleOnly: value.userVisibleOnly, applicationServerKey: Array.from(new Uint8Array(value.applicationServerKey)) });
      return enter("subscribe", subscription).then(result => { here = true; subscribeEffects++; return result; });
    },
  } };
  const navigator = { userAgent: "Synthetic Windows Chrome/100", maxTouchPoints: 0,
    serviceWorker: { get ready() { return enter("ready", registration); } } };
  const exports = {};
  new Script(compiled.outputText, { filename: file }).runInNewContext({ exports, Error, DOMException, Uint8Array, atob, btoa, navigator,
    window: { isSecureContext: true, navigator, PushManager: class SyntheticPushManager {}, matchMedia: () => ({ matches: false }) },
    Notification: { permission: "default", requestPermission() { return enter("permission", permission); } },
    fetch() { assert.fail("No network is allowed in helper tests"); },
    require(name: string) { assert.fail(`Unexpected dependency: ${name}`); },
  });
  const push = exports as PushModule;
  const guard = () => current;
  const start = (operation: Operation, guarded = true) => observed<Device | string | null>(operation === "read"
    ? push.readThisDeviceSubscription(guarded ? guard : undefined)
    : operation === "enable" ? push.subscribeThisDevice("AQID", guarded ? guard : undefined)
      : push.unsubscribeThisDevice(guarded ? guard : undefined));
  async function entered(boundary: Boundary) {
    for (let i = 0; i < 40; i++) { if (entries.includes(boundary)) return; await Promise.resolve(); }
    assert.fail(`Actual helper never entered ${boundary}; observed ${entries.join(",")}`);
  }
  const release = (boundary: Boundary, value?: unknown) => {
    const gate = held.get(boundary); assert.ok(gate, `Expected deferred ${boundary}`); held.delete(boundary);
    gate.resolve(value === undefined ? boundary === "permission" ? "granted" : boundary === "ready" ? registration
      : boundary === "getSubscription" ? here ? subscription : null : boundary === "subscribe" ? subscription : true : value);
  };
  return { push, guard, start, entered, entries, options, subscription, registration, release,
    hold(boundary: Boundary) { const gate = deferred(); held.set(boundary, gate); return gate; },
    retire() { current = false; },
    permission(value: unknown) { permission = value; },
    acknowledgement(value: unknown) { acknowledgement = value; },
    state: () => ({ here, endpointReads, keyReads, subscribeEffects, unsubscribeEffects }),
  };
}

function rejected(result: Outcome<unknown>) {
  assert.equal(result.status, "rejected", "A retired helper must reject, not return a stale device or off result");
  if (result.status === "rejected") assert.ok(result.error instanceof Error, "Rejection must be an Error");
}
function deviceResult(result: Outcome<unknown>) {
  assert.equal(result.status, "fulfilled");
  if (result.status !== "fulfilled") return;
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), { endpoint: "https://push.example.test/synthetic-endpoint",
    p256dh: "FRY", auth: "Cww", label: "Windows \u00b7 Chrome" });
}

for (const guarded of [true, false]) {
  test(`positive enable creates the device with ${guarded ? "current" : "omitted optional"} guard`, async () => {
    const f = fixture(); deviceResult(await f.start("enable", guarded));
    assert.deepEqual(f.entries, ["permission", "ready", "getSubscription", "subscribe"]);
    assert.deepEqual(f.options, [{ userVisibleOnly: true, applicationServerKey: [1, 2, 3] }]);
    assert.equal(f.state().here, true); assert.equal(f.state().subscribeEffects, 1);
  });
  test(`positive read and acknowledged disable with ${guarded ? "current" : "omitted optional"} guard`, async () => {
    const f = fixture(true); deviceResult(await f.start("read", guarded));
    assert.deepEqual(f.entries, ["ready", "getSubscription"]);
    assert.deepEqual(await f.start("disable", guarded), { status: "fulfilled", value: "https://push.example.test/synthetic-endpoint" });
    assert.deepEqual(f.entries, ["ready", "getSubscription", "ready", "getSubscription", "unsubscribe"]);
    assert.equal(f.state().here, false); assert.equal(f.state().unsubscribeEffects, 1);
  });
}

test("positive enable reuses an existing subscription without another native subscribe", async () => {
  const f = fixture(true); deviceResult(await f.start("enable"));
  assert.deepEqual(f.entries, ["permission", "ready", "getSubscription"]); assert.equal(f.state().subscribeEffects, 0);
});

test("positive absent subscription is null on read and empty endpoint on disable", async () => {
  const f = fixture(); assert.deepEqual(await f.start("read"), { status: "fulfilled", value: null });
  assert.deepEqual(await f.start("disable"), { status: "fulfilled", value: "" });
  assert.equal(f.entries.includes("unsubscribe"), false); assert.equal(f.state().keyReads, 0);
});

test("missing public key never requests native permission", async () => {
  const f = fixture(); rejected(await observed(f.push.subscribeThisDevice("", f.guard))); assert.deepEqual(f.entries, []);
});

for (const permission of ["denied", "default", "true", true, null]) {
  test(`permission ${JSON.stringify(permission)} cannot reach service worker or subscription`, async () => {
    const f = fixture(); f.permission(permission); rejected(await f.start("enable")); assert.deepEqual(f.entries, ["permission"]);
  });
}

for (const operation of ["read", "enable", "disable"] as const) {
  test(`already-retired ${operation} never enters any native boundary`, async () => {
    const f = fixture(true); f.retire(); rejected(await f.start(operation));
    assert.deepEqual(f.entries, []); assert.equal(f.state().keyReads, 0); assert.equal(f.state().endpointReads, 0);
  });
  for (const boundary of operation === "enable" ? ["permission", "ready", "getSubscription"] as const : ["ready", "getSubscription"] as const) {
    test(`${operation} retired during ${boundary} cannot enter a later browser boundary or return credentials`, async () => {
      const f = fixture(operation !== "enable"); f.hold(boundary); const pending = f.start(operation); await f.entered(boundary);
      const entered = [...f.entries], before = f.state(); f.retire(); f.release(boundary); rejected(await pending);
      assert.deepEqual(f.entries, entered, "No later permission, subscription lookup or native mutation may start");
      assert.deepEqual(f.state(), before, "No endpoint/key extraction or local subscription change is allowed after retirement");
    });
  }
}

for (const operation of ["read", "enable", "disable"] as const) {
  test(`${operation} retired after an empty pending lookup still rejects instead of returning stale absence`, async () => {
    const f = fixture(); f.hold("getSubscription"); const pending = f.start(operation); await f.entered("getSubscription");
    const before = [...f.entries]; f.retire(); f.release("getSubscription", null); rejected(await pending);
    assert.deepEqual(f.entries, before); assert.equal(f.state().subscribeEffects, 0); assert.equal(f.state().unsubscribeEffects, 0);
  });
}

test("enable retired while reusing an existing subscription cannot extract its endpoint or keys", async () => {
  const f = fixture(true); f.hold("getSubscription"); const pending = f.start("enable"); await f.entered("getSubscription");
  f.retire(); f.release("getSubscription"); rejected(await pending);
  assert.equal(f.state().endpointReads, 0); assert.equal(f.state().keyReads, 0); assert.equal(f.entries.includes("subscribe"), false);
});

for (const operation of ["read", "enable", "disable"] as const) {
  test(`${operation} honors the original scope guard across caller A/B/A without reviving a stale result`, async () => {
    const f = fixture(true); f.hold("ready");
    let actor = "A", epoch = 0;
    const originalEpoch = epoch, originalScope = () => actor === "A" && epoch === originalEpoch;
    const pending = observed<Device | string | null>(operation === "read" ? f.push.readThisDeviceSubscription(originalScope)
      : operation === "enable" ? f.push.subscribeThisDevice("AQID", originalScope) : f.push.unsubscribeThisDevice(originalScope));
    await f.entered("ready"); actor = "B"; epoch++; actor = "A"; epoch++;
    f.release("ready"); rejected(await pending);
    assert.equal(f.entries.includes("getSubscription"), false); assert.equal(f.state().endpointReads, 0);
    assert.equal(f.state().subscribeEffects, 0); assert.equal(f.state().unsubscribeEffects, 0);
  });
}

test("native subscribe already dispatched can finish, but retirement rejects its result without rollback", async () => {
  const f = fixture(); f.hold("subscribe"); const pending = f.start("enable"); await f.entered("subscribe");
  assert.equal(f.state().subscribeEffects, 0); const before = [...f.entries]; f.retire(); f.release("subscribe"); rejected(await pending);
  assert.equal(f.state().here, true, "An already-dispatched native subscribe cannot be undone by the guard");
  assert.equal(f.state().subscribeEffects, 1); assert.equal(f.state().endpointReads, 0); assert.equal(f.state().keyReads, 0);
  assert.deepEqual(f.entries, before); assert.equal(f.entries.includes("unsubscribe"), false, "No compensating native action is claimed");
});

test("native unsubscribe already dispatched can finish, but retirement never returns an off endpoint", async () => {
  const f = fixture(true); f.hold("unsubscribe"); const pending = f.start("disable"); await f.entered("unsubscribe");
  const before = [...f.entries], endpointReads = f.state().endpointReads; f.retire(); f.release("unsubscribe", true); rejected(await pending);
  assert.equal(f.state().here, false, "The acknowledged native unsubscribe is not rolled back");
  assert.equal(f.state().unsubscribeEffects, 1); assert.equal(f.state().endpointReads, endpointReads);
  assert.deepEqual(f.entries, before); assert.equal(f.entries.includes("subscribe"), false);
});

for (const acknowledgement of [false, undefined, null, 0, 1, "true", "false", {}, [], { success: true }]) {
  test(`unsubscribe acknowledgement ${JSON.stringify(acknowledgement)} rejects instead of claiming off`, async () => {
    const f = fixture(true); f.acknowledgement(acknowledgement); rejected(await f.start("disable"));
    assert.deepEqual(f.entries, ["ready", "getSubscription", "unsubscribe"]);
    assert.equal(f.state().here, true); assert.equal(f.state().unsubscribeEffects, 0);
  });
}

for (const [operation, boundary] of [["read", "ready"], ["read", "getSubscription"], ["enable", "permission"],
  ["enable", "ready"], ["enable", "getSubscription"], ["enable", "subscribe"],
  ["disable", "ready"], ["disable", "getSubscription"], ["disable", "unsubscribe"]] as const) {
  test(`rejected ${operation} ${boundary} promise never continues to a later native action`, async () => {
    const f = fixture(operation !== "enable"), gate = f.hold(boundary);
    const pending = f.start(operation); await f.entered(boundary); const before = [...f.entries];
    gate.reject(new Error("Synthetic native rejection")); rejected(await pending); assert.deepEqual(f.entries, before);
    assert.equal(f.state().subscribeEffects, 0); assert.equal(f.state().unsubscribeEffects, 0);
  });
}

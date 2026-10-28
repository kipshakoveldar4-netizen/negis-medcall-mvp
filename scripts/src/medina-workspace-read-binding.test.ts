import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual demoStorage exports/hook body; synthetic hook scheduling, storage and CRM
// responses. No AuthProvider, React DOM, App route barriers, HTTP, SQL or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const sourceFile = "artifacts/negis/src/lib/demoStorage.ts";
const source = await readFile(path.join(root, sourceFile), "utf8");
const compiled = ts.transpileModule(source, { fileName: sourceFile, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
assert.deepEqual(compiled.diagnostics ?? [], [], "Actual demoStorage must transpile");

const oldWorkspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetWorkspace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const selectorKey = "negis_workspace_selector";
const endpoint = "/api/crm/clients";
const collectionKey = "synthetic_clients";
type Item = { id: string; name?: string };
const demoSeed: Item = { id: "SYNTHETIC-DEMO-SEED" };
const oldRow: Item = { id: "SYNTHETIC-OLD-PRIVATE-ROW" };
const freshRow: Item = { id: "SYNTHETIC-FRESH-ROW" };
type View = { items: Item[]; loaded: boolean; loadError: boolean;
  setItems(items: Item[] | ((current: Item[]) => Item[])): void;
  addItem(item: Item): Promise<boolean>; updateItem(id: string, patch: Partial<Item>): Promise<boolean> };
type StorageMode = "normal" | "writes-fail" | "all-fail" | "getter-fails";
type StorageCall = { method: string; key?: string };
type Slot = { kind: "state" | "ref" | "effect"; value?: any; deps?: readonly unknown[]; cleanup?: () => void };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const settle = async () => { await tick(); await tick(); };

function hookDriver() {
  const slots: Slot[] = [], pending: Array<() => void> = [];
  let cursor = 0, disposed = false, lateWrites = 0, writes = 0, hookCount: number | undefined;
  function slot(kind: Slot["kind"], create: () => Slot) {
    const state = slots[cursor++] ??= create();
    assert.equal(state.kind, kind, "Actual hook must retain hook order");
    return state;
  }
  const hooks = {
    useRef(initial: unknown) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useState(initial: unknown) {
      const state = slot("state", () => ({ kind: "state", value: typeof initial === "function" ? initial() : initial }));
      return [state.value, (update: unknown) => {
        if (disposed) { lateWrites++; return; }
        writes++;
        state.value = typeof update === "function" ? update(state.value) : update;
      }];
    },
    useEffect(create: () => void | (() => void), deps?: readonly unknown[]) {
      const effect = slot("effect", () => ({ kind: "effect" }));
      if (!deps || !effect.deps || deps.length !== effect.deps.length || deps.some((v, i) => !Object.is(v, effect.deps?.[i]))) {
        effect.deps = deps;
        pending.push(() => { effect.cleanup?.(); effect.cleanup = create() || undefined; });
      }
    },
  };
  return {
    hooks,
    render(read: () => View) {
      assert.equal(disposed, false, "Cannot render a retired synthetic mount");
      cursor = 0;
      const view = read();
      hookCount ??= cursor;
      assert.equal(cursor, hookCount, "Actual hook must not add conditional hooks");
      pending.splice(0).forEach(run => run());
      return view;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      slots.forEach(state => state.cleanup?.());
    },
    get lateWrites() { return lateWrites; },
    get writes() { return writes; },
  };
}

type RequestRecord = { path: string; init?: RequestInit; answered: boolean; bodyStarted: boolean;
  answer(data: Record<string, unknown>, status?: number, bodyGate?: Promise<void>): void };
type StorageModule = {
  WORKSPACE_SELECTOR_KEY: string;
  bindWorkspaceReadScope(owner: object, workspaceId: string | null): void;
  clearWorkspaceReadScope(owner: object): void;
  readWorkspaceId(): string;
  workspaceScopedKey(key: string): string;
  isRealWorkspace(workspaceId?: string): boolean;
  clearListReadCache(): void;
  useDemoCollection(key: string, seed: Item[], options: Record<string, unknown>): View;
};

function fixture(t: TestContext, options: { entries?: [string, string][]; mode?: StorageMode; noWindow?: boolean } = {}) {
  const values = new Map(options.entries ?? [[selectorKey, oldWorkspace]]);
  const storageCalls: StorageCall[] = [], requests: RequestRecord[] = [], toasts: unknown[] = [];
  const drivers: ReturnType<typeof hookDriver>[] = [], bodyGates: ReturnType<typeof deferred<void>>[] = [];
  let storageMode = options.mode ?? "normal", currentDriver: ReturnType<typeof hookDriver> | null = null;
  const storage = {
    getItem(key: string) {
      storageCalls.push({ method: "getItem", key });
      if (storageMode === "all-fail") throw Error("Synthetic storage unavailable");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storageCalls.push({ method: "setItem", key });
      if (storageMode === "writes-fail" || storageMode === "all-fail") throw Error("Synthetic storage write refused");
      values.set(key, value);
    },
    removeItem(key: string) {
      storageCalls.push({ method: "removeItem", key });
      if (storageMode === "writes-fail" || storageMode === "all-fail") throw Error("Synthetic storage removal refused");
      values.delete(key);
    },
  };
  const window = Object.defineProperty({}, "localStorage", { get() {
    storageCalls.push({ method: "localStorage" });
    if (storageMode === "getter-fails") throw Error("Synthetic storage getter unavailable");
    return storage;
  } });
  const request = (requestPath: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestPath, "https://workspace-read.example.invalid");
    assert.equal(url.origin, "https://workspace-read.example.invalid");
    assert.equal(url.pathname, endpoint, "Synthetic transport is limited to this collection");
    assert.deepEqual([...url.searchParams.keys()], ["workspaceId"]);
    assert.ok(["GET", "POST", "PATCH"].includes(init?.method ?? "GET"));
    const response = deferred<Response>();
    const record: RequestRecord = { path: requestPath, init, answered: false, bodyStarted: false,
      answer(data, status = 200, bodyGate) {
        if (record.answered) return;
        record.answered = true;
        response.resolve({ ok: status >= 200 && status < 300, status, text: async () => {
          record.bodyStarted = true;
          await bodyGate;
          return JSON.stringify(status === 200 ? { success: true, mode: "supabase", data }
            : { success: false, error: "Synthetic collection refusal" });
        } } as Response);
      } };
    requests.push(record);
    return response.promise;
  };
  const react = {
    useRef(initial: unknown) { assert.ok(currentDriver); return currentDriver.hooks.useRef(initial); },
    useState(initial: unknown) { assert.ok(currentDriver); return currentDriver.hooks.useState(initial); },
    useEffect(create: () => void | (() => void), deps?: readonly unknown[]) {
      assert.ok(currentDriver); return currentDriver.hooks.useEffect(create, deps);
    },
  };
  const exports: Record<string, unknown> = {};
  new Script(compiled.outputText, { filename: sourceFile }).runInNewContext({
    exports, URL, ...(options.noWindow ? {} : { window }),
    fetch() { assert.fail("No actual network is allowed"); },
    require(name: string) {
      if (name === "react") return react;
      if (name === "sonner") return { toast: { error: (...args: unknown[]) => toasts.push(args) } };
      if (name === "@/lib/api") return { crmFetch: request };
      assert.fail(`Unexpected actual import in isolated collection test: ${name}`);
    },
  });
  const module = exports as unknown as StorageModule;
  assert.equal(module.WORKSPACE_SELECTOR_KEY, selectorKey);
  function mount(config: { strict?: { workspaceId: string; isCurrent(): boolean }; allowScopedCreate?: boolean } = {}) {
    const driver = hookDriver();
    drivers.push(driver);
    return {
      render: () => driver.render(() => {
        currentDriver = driver;
        try { return module.useDemoCollection(collectionKey, [demoSeed], { endpoint, listKey: "items", itemKey: "item",
          allowScopedCreate: config.allowScopedCreate,
          ...(config.strict ? { strictAccess: { actorId: "SYNTHETIC-EXTERNAL-OPERATOR", ...config.strict, request } } : {}) }); }
        finally { currentDriver = null; }
      }),
      dispose: () => driver.dispose(),
      get writes() { return driver.writes; },
    };
  }
  t.after(async () => {
    drivers.forEach(driver => driver.dispose());
    bodyGates.forEach(gate => gate.resolve());
    requests.forEach(record => record.answer({ items: [] }));
    await settle();
    assert.ok(drivers.every(driver => driver.lateWrites === 0), "Actual hook cannot write after fixture retirement");
  });
  return { module, mount, values, storage, storageCalls, requests, toasts,
    mode(value: StorageMode) { storageMode = value; },
    holdBody() { const gate = deferred<void>(); bodyGates.push(gate); return gate; },
  };
}

function assertBoundReads(f: ReturnType<typeof fixture>, expected: string) {
  const before = f.storageCalls.length;
  assert.equal(f.module.readWorkspaceId(), expected);
  assert.equal(f.module.workspaceScopedKey("synthetic-draft"), `synthetic-draft::${expected}`);
  assert.equal(f.module.isRealWorkspace(), expected === oldWorkspace || expected === targetWorkspace);
  assert.equal(f.storageCalls.length, before, "A bound read must never consult or probe storage");
}

const legacyCases: { name: string; entries: [string, string][]; expected: string }[] = [
  { name: "stored selector", entries: [[selectorKey, oldWorkspace]], expected: oldWorkspace },
  { name: "legacy staff camel-case", entries: [["negis_staff_user", JSON.stringify({ workspaceId: oldWorkspace })]], expected: oldWorkspace },
  { name: "legacy staff snake-case", entries: [["negis_staff_user", JSON.stringify({ workspace_id: oldWorkspace })]], expected: oldWorkspace },
  { name: "legacy staff session", entries: [["negis_staff_session", JSON.stringify({ workspaceId: oldWorkspace })]], expected: oldWorkspace },
  { name: "legacy demo", entries: [["negis_demo_workspace", JSON.stringify({ id: "synthetic-demo" })]], expected: "synthetic-demo" },
  { name: "missing legacy state", entries: [], expected: "demo-workspace" },
];

for (const entry of legacyCases) {
  test(`pre-provider compatibility: ${entry.name} remains available only before a binding`, t => {
    const f = fixture(t, { entries: entry.entries });
    assert.equal(f.module.readWorkspaceId(), entry.expected);
    assert.ok(f.storageCalls.length > 0, "The unbound compatibility path actually consulted synthetic storage");
    f.module.bindWorkspaceReadScope({}, null);
    assertBoundReads(f, "");
  });
}

test("bound target wins over readable old W even when selector removal and persistence fail", async t => {
  const f = fixture(t, { mode: "writes-fail" });
  assert.equal(f.storage.getItem(selectorKey), oldWorkspace);
  assert.throws(() => f.storage.removeItem(selectorKey), /removal refused/);
  assert.throws(() => f.storage.setItem(selectorKey, targetWorkspace), /write refused/);
  f.module.bindWorkspaceReadScope({}, targetWorkspace);
  assertBoundReads(f, targetWorkspace);
  const count = f.storageCalls.length, h = f.mount();
  assert.equal(h.render().items.length, 0, "No demo seed or old list is painted");
  assert.equal(f.requests[0].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  f.requests[0].answer({ items: [freshRow] }); await settle();
  assert.deepEqual(Array.from(h.render().items, item => item.id), [freshRow.id]);
  assert.equal(f.storageCalls.length, count, "The production collection never falls back to browser storage");
  assert.equal(f.values.get(selectorKey), oldWorkspace, "The stale readable selector really remains unchanged");
});

for (const mode of ["all-fail", "getter-fails"] as const) {
  test(`bound target and actual collection survive ${mode} without a storage probe or demo fallback`, async t => {
    const f = fixture(t, { mode });
    f.module.bindWorkspaceReadScope({}, targetWorkspace);
    assertBoundReads(f, targetWorkspace);
    const h = f.mount();
    assert.equal(h.render().items.length, 0);
    assert.equal(f.requests[0].path, `${endpoint}?workspaceId=${targetWorkspace}`);
    f.requests[0].answer({ items: [freshRow] }); await settle();
    assert.equal(h.render().items[0].id, freshRow.id);
    assert.deepEqual(f.storageCalls, []);
    assert.deepEqual(f.toasts, []);
  });
}

test("shared selector overwritten after entry cannot retarget collection reads or synthetic writes", async t => {
  const f = fixture(t);
  f.module.bindWorkspaceReadScope({}, targetWorkspace);
  f.storage.setItem(selectorKey, oldWorkspace);
  f.storage.setItem("negis_staff_user", JSON.stringify({ workspaceId: oldWorkspace }));
  assertBoundReads(f, targetWorkspace);
  const h = f.mount(); h.render();
  assert.equal(f.requests[0].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  f.requests[0].answer({ items: [freshRow] }); await settle();
  f.storage.setItem(selectorKey, oldWorkspace);
  const update = h.render().updateItem(freshRow.id, { name: "Synthetic edit" });
  assert.equal(f.requests[1].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  assert.equal(f.requests[1].init?.method, "PATCH");
  assert.equal(JSON.parse(String(f.requests[1].init?.body)).workspaceId, targetWorkspace);
  f.requests[1].answer({ item: { ...freshRow, name: "Synthetic edit" } });
  assert.equal(await update, true);
  const add = h.render().addItem({ id: "SYNTHETIC-ADDED" });
  assert.equal(f.requests[2].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  assert.equal(f.requests[2].init?.method, "POST");
  assert.equal(JSON.parse(String(f.requests[2].init?.body)).workspaceId, targetWorkspace);
  f.requests[2].answer({ item: { id: "SYNTHETIC-ADDED" } });
  assert.equal(await add, true);
  assertBoundReads(f, targetWorkspace);
  assert.equal(f.values.has(collectionKey), false, "Synthetic API-backed rows were not persisted as demo data");
});

test("neutral binding never consults selector, legacy staff or demo even as storage changes or fails", t => {
  const f = fixture(t, { entries: [[selectorKey, oldWorkspace],
    ["negis_staff_user", JSON.stringify({ workspaceId: oldWorkspace })],
    ["negis_staff_session", JSON.stringify({ workspaceId: oldWorkspace })],
    ["negis_demo_workspace", JSON.stringify({ id: "synthetic-demo" })]] });
  const owner = {};
  f.module.bindWorkspaceReadScope(owner, null);
  for (const mode of ["normal", "writes-fail", "all-fail", "getter-fails"] as const) {
    f.mode(mode);
    assertBoundReads(f, "");
  }
  assert.deepEqual(f.storageCalls, []);
  assert.equal(f.requests.length, 0, "Helper reads do not start a collection or request");
});

test("clearing the current owner remains neutral instead of re-enabling pre-provider legacy fallback", t => {
  const f = fixture(t), owner = {};
  f.module.bindWorkspaceReadScope(owner, targetWorkspace);
  f.module.clearWorkspaceReadScope(owner);
  assertBoundReads(f, "");
  f.module.clearWorkspaceReadScope(owner);
  assertBoundReads(f, "");
  assert.equal(f.values.get(selectorKey), oldWorkspace);
});

test("old-owner cleanup cannot clear newer target or neutral scopes, including workspace A-B-A", t => {
  const f = fixture(t), firstA = { actor: "A" }, ownerB = { actor: "B" }, nextA = { actor: "A" };
  f.module.bindWorkspaceReadScope(firstA, oldWorkspace);
  f.module.bindWorkspaceReadScope(ownerB, targetWorkspace);
  f.module.clearWorkspaceReadScope(firstA);
  assertBoundReads(f, targetWorkspace);
  f.module.bindWorkspaceReadScope(nextA, oldWorkspace);
  f.module.clearWorkspaceReadScope(firstA);
  f.module.clearWorkspaceReadScope(ownerB);
  f.module.clearWorkspaceReadScope({ actor: "A" });
  assertBoundReads(f, oldWorkspace);
  f.module.bindWorkspaceReadScope(nextA, null);
  f.module.clearWorkspaceReadScope(firstA);
  assertBoundReads(f, "");
  f.module.bindWorkspaceReadScope(nextA, targetWorkspace);
  f.module.clearWorkspaceReadScope(firstA);
  assertBoundReads(f, targetWorkspace);
});

for (const [name, workspace] of [["staff", targetWorkspace], ["demo", "synthetic-demo"]] as const) {
  test(`explicit ${name} binding selects its supplied workspace without consulting legacy storage`, t => {
    const f = fixture(t, { mode: "getter-fails" });
    f.module.bindWorkspaceReadScope({}, workspace);
    assertBoundReads(f, workspace);
  });
}

test("bound memory is checked before the no-window compatibility fallback", t => {
  const f = fixture(t, { noWindow: true });
  assert.equal(f.module.readWorkspaceId(), "demo-workspace");
  const owner = {};
  f.module.bindWorkspaceReadScope(owner, targetWorkspace);
  assertBoundReads(f, targetWorkspace);
  f.module.bindWorkspaceReadScope(owner, null);
  assertBoundReads(f, "");
});

test("cache control: a successful post-binding read really warms the next actual-hook mount", async t => {
  const f = fixture(t); f.module.bindWorkspaceReadScope({}, targetWorkspace);
  const first = f.mount(); first.render();
  f.requests[0].answer({ items: [freshRow] }); await settle(); first.dispose();
  const next = f.mount(), view = next.render();
  assert.deepEqual(Array.from(view.items, item => item.id), [freshRow.id], "Positive control proves cache reads are observable");
  assert.equal(view.loaded, true);
  assert.equal(f.requests.length, 2, "A cached initial view still refreshes on mount");
});

test("clearing a warm list cache removes its rows from the next actual-hook mount", async t => {
  const f = fixture(t); f.module.bindWorkspaceReadScope({}, targetWorkspace);
  const first = f.mount(); first.render();
  f.requests[0].answer({ items: [oldRow] }); await settle(); first.dispose();
  f.module.clearListReadCache();
  const next = f.mount(), view = next.render();
  assert.equal(view.items.length, 0);
  assert.equal(view.loaded, false);
  assert.equal(f.requests.length, 2);
  f.requests[1].answer({ items: [freshRow] }); await settle();
  assert.equal(next.render().items[0].id, freshRow.id);
});

for (const boundary of ["response", "body"] as const) {
  test(`cache epoch: clearing while an earlier ${boundary} is held prevents repopulation on remount`, async t => {
    const f = fixture(t); f.module.bindWorkspaceReadScope({}, targetWorkspace);
    const first = f.mount(); first.render();
    const gate = f.holdBody();
    if (boundary === "body") {
      f.requests[0].answer({ items: [oldRow] }, 200, gate.promise); await settle();
      assert.equal(f.requests[0].bodyStarted, true, "The actual hook has reached the held body");
    }
    // Keep the original hook mounted: unmount cancellation must not mask a broken cache epoch.
    f.module.clearListReadCache();
    if (boundary === "response") f.requests[0].answer({ items: [oldRow] });
    else gate.resolve();
    await settle();
    assert.equal(first.render().items[0].id, oldRow.id, "This test fences future cache reuse, not the old mounted view");
    first.dispose();
    const next = f.mount(), view = next.render();
    assert.equal(view.items.length, 0, "The pre-clear response must not resurrect old rows in the next mount");
    assert.equal(view.loaded, false);
    assert.equal(f.requests.length, 2);
    f.requests[1].answer({ items: [freshRow] }); await settle(); next.dispose();
    const final = f.mount().render();
    assert.deepEqual(Array.from(final.items, item => item.id), [freshRow.id], "Post-clear reads may warm the current epoch");
  });
}

test("a delayed pre-clear response cannot overwrite a newer post-clear cached list", async t => {
  const f = fixture(t); f.module.bindWorkspaceReadScope({}, targetWorkspace);
  const old = f.mount(); old.render();
  f.module.clearListReadCache();
  const current = f.mount(); assert.equal(current.render().items.length, 0);
  f.requests[1].answer({ items: [freshRow] }); await settle();
  assert.equal(current.render().items[0].id, freshRow.id);
  f.requests[0].answer({ items: [oldRow] }); await settle();
  assert.equal(old.render().items[0].id, oldRow.id, "The old consumer deliberately stayed alive for the cache race");
  old.dispose(); current.dispose();
  assert.deepEqual(Array.from(f.mount().render().items, item => item.id), [freshRow.id]);
});

test("multiple clears and owner A-B-A cannot re-admit an earlier cache generation", async t => {
  const f = fixture(t), oldOwner = {}, interimOwner = {}, newOwner = {};
  f.module.bindWorkspaceReadScope(oldOwner, targetWorkspace);
  const old = f.mount(); old.render();
  f.module.clearListReadCache();
  f.module.bindWorkspaceReadScope(interimOwner, oldWorkspace);
  f.module.clearListReadCache();
  f.module.bindWorkspaceReadScope(newOwner, targetWorkspace);
  f.module.clearWorkspaceReadScope(oldOwner);
  assertBoundReads(f, targetWorkspace);
  f.requests[0].answer({ items: [oldRow] }); await settle(); old.dispose();
  const next = f.mount();
  assert.equal(next.render().items.length, 0);
  assert.equal(f.requests[1].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  f.requests[1].answer({ items: [freshRow] }); await settle();
  assert.equal(next.render().items[0].id, freshRow.id);
});

for (const mode of ["normal", "all-fail", "getter-fails"] as const) {
  test(`neutral actual API hook has no seed, storage, request or mutation under ${mode}`, async t => {
    const f = fixture(t, { mode, entries: [[selectorKey, oldWorkspace],
      ["negis_staff_user", JSON.stringify({ workspaceId: oldWorkspace })],
      ["negis_demo_workspace", JSON.stringify({ id: "synthetic-demo" })],
      [collectionKey, JSON.stringify([oldRow])]] });
    f.module.bindWorkspaceReadScope({}, null);
    const h = f.mount(), initial = h.render();
    assert.equal(initial.items.length, 0, "Neither the seed nor a stored private row is exposed initially");
    await settle();
    const view = h.render(), writes = h.writes;
    assert.equal(view.items.length, 0);
    assert.equal(view.loaded, true, "Neutral access settles without waiting for a request that must never start");
    assert.equal(view.loadError, false);
    let updaterCalls = 0;
    view.setItems(() => { updaterCalls++; return [oldRow]; });
    assert.equal(await view.addItem({ id: "SYNTHETIC-NEUTRAL-ADD" }), false);
    assert.equal(await view.updateItem(oldRow.id, { name: "Synthetic neutral edit" }), false);
    await settle();
    assert.equal(updaterCalls, 0, "Neutral setItems does not even evaluate a caller's updater");
    assert.equal(h.writes, writes, "Neutral callbacks must not create optimistic state");
    assert.equal(h.render().items.length, 0);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.storageCalls, []);
    assert.deepEqual(f.toasts, []);
  });
}

test("a neutral mounted hook can enter fresh authority and return neutral without reviving old callbacks", async t => {
  const f = fixture(t, { mode: "getter-fails" }), owner = {};
  f.module.bindWorkspaceReadScope(owner, null);
  const h = f.mount(), neutralCallbacks = h.render();
  assert.equal(h.render().items.length, 0);
  assert.equal(f.requests.length, 0);
  f.module.bindWorkspaceReadScope(owner, targetWorkspace);
  assert.equal(await neutralCallbacks.addItem(oldRow), false);
  assert.equal(await neutralCallbacks.updateItem(oldRow.id, { name: "Synthetic retired neutral edit" }), false);
  assert.equal(f.requests.length, 0);
  assert.equal(h.render().items.length, 0);
  assert.equal(f.requests.length, 1, "A new authority object re-arms the existing mount's effect");
  assert.equal(f.requests[0].path, `${endpoint}?workspaceId=${targetWorkspace}`);
  f.requests[0].answer({ items: [freshRow] }); await settle();
  const targetCallbacks = h.render();
  assert.equal(targetCallbacks.items[0].id, freshRow.id);
  f.module.bindWorkspaceReadScope(owner, null);
  h.render();
  assert.equal(h.render().items.length, 0, "The committed neutral effect drops the mounted collection's rows");
  assert.equal(await targetCallbacks.addItem(oldRow), false);
  assert.equal(await targetCallbacks.updateItem(freshRow.id, { name: "Synthetic retired target edit" }), false);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.storageCalls, []);
  assert.deepEqual(f.toasts, []);
});

for (const replacement of ["same owner refresh", "different owner"] as const) {
  test(`same-workspace ${replacement} retires old callbacks and rechecks the mounted hook`, async t => {
    const f = fixture(t), owner = {};
    f.module.bindWorkspaceReadScope(owner, targetWorkspace);
    const h = f.mount(), callbacks = h.render();
    f.module.bindWorkspaceReadScope(replacement === "same owner refresh" ? owner : {}, targetWorkspace);
    const writes = h.writes;
    let updaterCalls = 0;
    callbacks.setItems(() => { updaterCalls++; return [oldRow]; });
    assert.equal(await callbacks.addItem(oldRow), false);
    assert.equal(await callbacks.updateItem(oldRow.id, { name: "Synthetic stale callback" }), false);
    assert.equal(updaterCalls, 0);
    assert.equal(h.writes, writes);
    assert.equal(f.requests.length, 1, "Stale mutation callbacks cannot dispatch despite the unchanged workspace ID");
    h.render();
    assert.equal(f.requests.length, 2, "Effect dependency includes the authority object, not merely the workspace ID");
    assert.equal(f.requests[1].path, `${endpoint}?workspaceId=${targetWorkspace}`);
    f.requests[0].answer({ items: [oldRow] });
    f.requests[1].answer({ items: [freshRow] }); await settle();
    assert.deepEqual(Array.from(h.render().items, item => item.id), [freshRow.id]);
    assert.deepEqual(f.toasts, []);
  });
}

for (const boundary of ["response", "body"] as const) {
  test(`new owner at the same workspace rejects the held old ${boundary} without relying on cache clear or effect cleanup`, async t => {
    const f = fixture(t);
    f.module.bindWorkspaceReadScope({}, targetWorkspace);
    const old = f.mount(); old.render();
    const gate = f.holdBody();
    if (boundary === "body") {
      f.requests[0].answer({ items: [oldRow] }, 200, gate.promise); await settle();
      assert.equal(f.requests[0].bodyStarted, true);
    }
    const writes = old.writes;
    f.module.bindWorkspaceReadScope({}, targetWorkspace);
    // Do not clear the cache, rerender or dispose the old hook before its reply.
    if (boundary === "response") f.requests[0].answer({ items: [oldRow] });
    else gate.resolve();
    await settle();
    assert.equal(old.writes, writes, "Retired response and finally cannot write rows, loaded or errors");
    const next = f.mount(), view = next.render();
    assert.equal(view.items.length, 0, "The old authority cannot populate a same-workspace cache for the new owner");
    assert.equal(view.loaded, false);
    assert.equal(f.requests.length, 2);
    f.requests[1].answer({ items: [freshRow] }); await settle(); next.dispose();
    assert.deepEqual(Array.from(f.mount().render().items, item => item.id), [freshRow.id]);
    assert.deepEqual(f.toasts, []);
  });
}

test("authority replacement plus cache clear cannot let an old body overwrite the new owner's cached rows", async t => {
  const f = fixture(t);
  f.module.bindWorkspaceReadScope({}, targetWorkspace);
  const old = f.mount(); old.render();
  const gate = f.holdBody();
  f.requests[0].answer({ items: [oldRow] }, 200, gate.promise); await settle();
  assert.equal(f.requests[0].bodyStarted, true);
  f.module.clearListReadCache();
  f.module.bindWorkspaceReadScope({}, targetWorkspace);
  const current = f.mount(); current.render();
  f.requests[1].answer({ items: [freshRow] }); await settle();
  assert.equal(current.render().items[0].id, freshRow.id);
  const writes = old.writes;
  gate.resolve(); await settle();
  assert.equal(old.writes, writes);
  old.dispose(); current.dispose();
  assert.deepEqual(Array.from(f.mount().render().items, item => item.id), [freshRow.id]);
});

for (const operation of ["add", "update"] as const) {
  test(`held ${operation} result cannot report success or update state after same-workspace authority replacement`, async t => {
    const f = fixture(t);
    f.module.bindWorkspaceReadScope({}, targetWorkspace);
    const h = f.mount(); h.render();
    f.requests[0].answer({ items: [freshRow] }); await settle();
    const view = h.render();
    const pending = operation === "add" ? view.addItem({ id: "SYNTHETIC-HELD-ADD" })
      : view.updateItem(freshRow.id, { name: "Synthetic held update" });
    assert.equal(f.requests[1].init?.method, operation === "add" ? "POST" : "PATCH");
    const gate = f.holdBody();
    f.requests[1].answer({ item: { id: "SYNTHETIC-SAVED" } }, 200, gate.promise); await settle();
    assert.equal(f.requests[1].bodyStarted, true);
    f.module.bindWorkspaceReadScope({}, targetWorkspace);
    const writes = h.writes;
    gate.resolve();
    assert.equal(await pending, false);
    assert.equal(h.writes, writes, "A retired write cannot commit or roll back through a stale state updater");
    assert.deepEqual(f.toasts, []);
  });
}

test("external strict-access hook ignores generic neutral/replacement bindings but honors its own guard", async t => {
  const f = fixture(t, { mode: "getter-fails" });
  let externalCurrent = true;
  f.module.bindWorkspaceReadScope({}, null);
  const h = f.mount({ strict: { workspaceId: oldWorkspace, isCurrent: () => externalCurrent }, allowScopedCreate: true });
  h.render();
  assert.equal(f.requests[0].path, `${endpoint}?workspaceId=${oldWorkspace}`);
  f.module.bindWorkspaceReadScope({}, targetWorkspace);
  h.render();
  assert.equal(f.requests.length, 1, "Generic authority replacement does not re-arm an external operator's read");
  f.requests[0].answer({ items: [oldRow] }); await settle();
  const view = h.render();
  assert.equal(view.items[0].id, oldRow.id, "An external scope's valid held read is not retired by a generic binding");
  f.module.bindWorkspaceReadScope({}, null);
  const update = view.updateItem(oldRow.id, { name: "Synthetic external edit" });
  assert.equal(f.requests[1].path, `${endpoint}?workspaceId=${oldWorkspace}`);
  f.requests[1].answer({ item: { ...oldRow, name: "Synthetic external edit" } });
  assert.equal(await update, true);
  const add = h.render().addItem({ id: "SYNTHETIC-EXTERNAL-ADD" });
  assert.equal(f.requests[2].path, `${endpoint}?workspaceId=${oldWorkspace}`);
  f.requests[2].answer({ item: { id: "SYNTHETIC-EXTERNAL-ADD" } });
  assert.equal(await add, true);
  externalCurrent = false;
  assert.equal(await view.addItem(oldRow), false);
  assert.equal(await view.updateItem(oldRow.id, { name: "Synthetic denied external edit" }), false);
  let updaterCalls = 0;
  view.setItems(() => { updaterCalls++; return []; });
  assert.equal(updaterCalls, 0);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.storageCalls, []);
  assert.deepEqual(f.toasts, []);
});

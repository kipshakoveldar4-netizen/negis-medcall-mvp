import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Executes the real collection hook with isolated React/HTTP/Storage fixtures.
// Session SDK delivery and browser rendering are separate acceptance points.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const source = readFile(path.join(root, "artifacts/negis/src/lib/demoStorage.ts"), "utf8");
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Item = { id: string; phone?: string; notes?: string };
type View = { items: Item[]; loaded: boolean; loadError: boolean; addItem(item: Item): Promise<boolean>;
  updateItem(id: string, patch: Partial<Item>): Promise<boolean> };
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };

function driver() {
  const slots: Slot[] = [];
  let cursor = 0, alive = true, late = 0;
  const pending: Array<() => void> = [];
  const hooks = {
    useRef(value: unknown) { const s = slots[cursor++] ??= { value: { current: value } }; return s.value; },
    useState(initial: unknown) {
      const s = slots[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
      return [s.value, (update: unknown) => {
        if (!alive) { late++; return; }
        s.value = typeof update === "function" ? update(s.value) : update;
      }];
    },
    useEffect(create: () => void | (() => void), deps: unknown[]) {
      const s = slots[cursor++] ??= {};
      if (!s.deps || deps.some((v, i) => !Object.is(v, s.deps?.[i]))) {
        s.deps = deps;
        pending.push(() => { s.cleanup?.(); s.cleanup = create() || undefined; });
      }
    },
  };
  return { hooks, render(fn: () => View) { cursor = 0; const view = fn(); pending.splice(0).forEach(f => f()); return view; },
    dispose() { alive = false; slots.forEach(s => s.cleanup?.()); }, get late() { return late; } };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}

async function fixture() {
  const storage = new Map([["negis_workspace_selector", W1]]);
  const requests: Array<{ path: string; init?: RequestInit; answer(data: unknown, status?: number, gate?: Promise<void>): void }> = [];
  const toasts: unknown[] = [];
  let currentDriver = driver();
  const hooks = {
    useRef: (v: unknown) => currentDriver.hooks.useRef(v),
    useState: (v: unknown) => currentDriver.hooks.useState(v),
    useEffect: (f: () => void | (() => void), d: unknown[]) => currentDriver.hooks.useEffect(f, d),
  };
  const request = (url: string, init?: RequestInit): Promise<Response> => {
    const d = deferred<Response>();
    requests.push({ path: url, init, answer(data, status = 200, gate) {
      const body = status === 200 ? { success: true, mode: "supabase", data } : { success: false, error: "fixture refusal" };
      d.resolve({ ok: status === 200, status, text: async () => { await gate; return JSON.stringify(body); } } as Response);
    } });
    return d.promise;
  };
  const exports: Record<string, unknown> = {};
  const require = (name: string) => {
    if (name === "react") return hooks;
    if (name === "sonner") return { toast: { error: (value: unknown) => toasts.push(value) } };
    if (name === "@/lib/api") return { crmFetch: request };
    throw new Error(`Unexpected fixture import ${name}`);
  };
  const compiled = ts.transpileModule(await source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Script(compiled).runInNewContext({ exports, require, console, Date, Map, window: { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } } });
  const use = exports.useDemoCollection as (key: string, seed: Item[], options: object) => View;
  function mount(strict = true) {
    const renderDriver = driver();
    const scope = { alive: true };
    const fn = () => {
      currentDriver = renderDriver;
      return use("negis_demo_leads", [{ id: "demo-contact", phone: "demo" }], {
        endpoint: "/api/crm/leads", listKey: "leads", fromApi: (x: unknown) => x,
        ...(strict ? { strictAccess: { actorId: "fixture-A", workspaceId: W1, isCurrent: () => scope.alive, request } } : {}),
      });
    };
    return { scope, render: () => renderDriver.render(fn), dispose() { scope.alive = false; renderDriver.dispose(); },
      get late() { return renderDriver.late; } };
  }
  return { mount, requests, storage, toasts };
}

const own = { id: "own-lead", phone: "synthetic-own-contact", notes: "before" };
const settle = async () => { await tick(); await tick(); };

test("assigned collection ignores workspace-wide owner cache and all demo storage", async () => {
  const f = await fixture();
  const owner = f.mount(false); owner.render(); f.requests[0].answer({ leads: [{ id: "all-workspace", phone: "private-owner" }] });
  await settle(); assert.equal(owner.render().items.length, 1); owner.dispose();
  const manager = f.mount();
  assert.deepEqual(Array.from(manager.render().items), []);
  assert.equal(f.requests.length, 2, "fresh scoped read rather than cache");
  f.requests[1].answer({ leads: [own] }); await settle();
  assert.equal(manager.render().items[0].id, own.id);
  assert.equal(f.storage.has("negis_demo_leads"), false);
  manager.dispose();
});

test("assigned collection cannot create leads or retarget a write via the local selector", async () => {
  const f = await fixture(); const h = f.mount(); h.render();
  f.requests[0].answer({ leads: [own] }); await settle(); const view = h.render();
  assert.equal(await view.addItem({ id: "forged" }), false); assert.equal(f.requests.length, 1);
  f.storage.set("negis_workspace_selector", W2);
  const save = view.updateItem(own.id, { notes: "after" });
  assert.equal(f.requests[1].path, `/api/crm/leads?workspaceId=${W1}`);
  assert.equal(JSON.parse(String(f.requests[1].init?.body)).workspaceId, W1);
  f.requests[1].answer({ item: { ...own, notes: "server normalized" } });
  assert.equal(await save, true); assert.equal(h.render().items[0].notes, "server normalized"); h.dispose();
});

test("assigned collection drops contacts after write denial instead of restoring a stale row", async () => {
  for (const status of [401,403,404,502]) {
    const f = await fixture(); const h = f.mount(); h.render(); f.requests[0].answer({ leads: [own] }); await settle();
    const save = h.render().updateItem(own.id, { notes: "after" }); f.requests[1].answer({}, status);
    assert.equal(await save, false); const view = h.render();
    assert.equal(view.items.length, 0); assert.equal(view.loadError, true); h.dispose();
  }
});

test("ordinary collection still restores a refused optimistic edit and allows demo-free create", async () => {
  const f = await fixture(); const h = f.mount(false); h.render(); f.requests[0].answer({ leads: [own] }); await settle();
  const save = h.render().updateItem(own.id, { notes: "after" }); f.requests[1].answer({}, 502);
  assert.equal(await save, false); assert.equal(h.render().items[0].notes, "before");
  assert.equal(h.render().loadError, false);
  const added = h.render().addItem({ id: "new" }); f.requests[2].answer({ item: { id: "saved" } });
  assert.equal(await added, true); assert.ok(h.render().items.some(x => x.id === "saved")); h.dispose();
});

test("assigned collection refuses malformed successful reads without showing seed contacts", async () => {
  const f = await fixture(); const h = f.mount(); h.render(); f.requests[0].answer({ leads: {} }); await settle();
  assert.equal(h.render().items.length, 0); assert.equal(h.render().loadError, true); h.dispose();
});

test("late GET body after account invalidation cannot update state or fill a future manager cache", async () => {
  const f = await fixture(); const h = f.mount(); h.render(); const bodyGate = deferred<void>();
  f.requests[0].answer({ leads: [own] }, 200, bodyGate.promise); await tick(); h.dispose(); bodyGate.resolve(); await settle();
  assert.equal(h.late, 0); assert.equal(f.toasts.length, 0);
  const next = f.mount(); assert.equal(next.render().items.length, 0); assert.equal(f.requests.length, 2); next.dispose();
});

test("late PATCH body after account invalidation cannot report success or restore contacts", async () => {
  const f = await fixture(); const h = f.mount(); h.render(); f.requests[0].answer({ leads: [own] }); await settle();
  const save = h.render().updateItem(own.id, { notes: "after" }); const bodyGate = deferred<void>();
  f.requests[1].answer({ item: own }, 200, bodyGate.promise); await tick(); h.dispose(); bodyGate.resolve();
  assert.equal(await save, false); assert.equal(h.late, 0); assert.equal(f.toasts.length, 0);
});

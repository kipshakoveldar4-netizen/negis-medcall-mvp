import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the actual component with synthetic hooks and native SW boundaries.
// No browser, worker source, HTTP, storage, application data or SDK is loaded.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-update-prompt-lifetime.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = "artifacts/negis/src/components/layout/UpdatePrompt.tsx";
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const source = process.argv.includes("--baseline")
  ? execFileSync("git", ["show", `41865a8:${file}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, file), "utf8");
const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
assert.deepEqual(compiled.diagnostics ?? [], [], "The actual component must transpile");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Listener = () => unknown;
class Signals {
  private listeners = new Map<string, Set<Listener>>();
  private history = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    this.history.set(type, [...this.captured(type), listener]);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of [...this.listeners.get(type) ?? []]) listener(); }
  count(type: string) { return this.listeners.get(type)?.size ?? 0; }
  captured(type: string) { return [...this.history.get(type) ?? []]; }
}
type WorkerState = "installing" | "installed" | "activating" | "activated" | "redundant";
class Worker extends Signals {
  messages: unknown[] = [];
  failPost = false;
  constructor(public state: WorkerState = "installed") { super(); }
  postMessage(message: unknown) {
    this.messages.push(message);
    if (this.failPost) throw new Error("Synthetic postMessage failure");
  }
}
type ViewNode = { type: unknown; props: Record<string, any> };
const nodes = (value: any): ViewNode[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const label = (value: any): string => Array.isArray(value) ? value.map(label).join("")
  : value?.props ? label(value.props.children) : value == null || typeof value === "boolean" ? "" : String(value);

function fixture(options: { controlled?: boolean; secure?: boolean; supported?: boolean;
  waiting?: Worker; installing?: Worker } = {}) {
  let reloads = 0, writes = 0, registerCalls = 0, mounted = true, dirty = false, cursor = 0, tree: any;
  const slots: any[] = [], updates: ReturnType<typeof deferred<unknown>>[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  const document = Object.assign(new Signals(), { visibilityState: "visible" });
  const registration = Object.assign(new Signals(), {
    waiting: options.waiting ?? null as Worker | null,
    installing: options.installing ?? null as Worker | null,
    update() { const gate = deferred<unknown>(); updates.push(gate); return gate.promise; },
  });
  const register = deferred<typeof registration>();
  const serviceWorker = Object.assign(new Signals(), {
    controller: options.controlled === false ? null : new Worker("activated") as Worker | null,
    register(url: string) { assert.equal(url, "/sw.js"); registerCalls++; return register.promise; },
  });
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, (value: any) => {
        writes++; slot.value = typeof value === "function" ? value(slot.value) : value; dirty = true;
      }];
    },
    useEffect(create: () => unknown, deps?: unknown[]) {
      const index = cursor++, previous = slots[index];
      const changed = !previous || !deps || deps.length !== previous.deps?.length
        || deps.some((value, i) => !Object.is(value, previous.deps?.[i]));
      slots[index] = { ...previous, effect: true, create, deps, pending: previous?.pending || changed };
    },
  };
  const jsx = (type: unknown, props: any) => ({ type, props });
  const exports: { UpdatePrompt?: () => unknown } = {};
  new Script(compiled.outputText, { filename: file }).runInNewContext({ exports, document,
    navigator: options.supported === false ? {} : { serviceWorker },
    window: { isSecureContext: options.secure !== false, location: { reload() { reloads++; } },
      setTimeout(callback: () => void, duration: number) { assert.equal(duration, 1000); const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id: number) { timers.delete(id); } },
    fetch() { assert.fail("No network is allowed"); },
    require(name: string) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      assert.fail(`Unexpected component dependency: ${name}`);
    },
  });
  function render() {
    assert.ok(mounted);
    for (let i = 0; i < 20; i++) {
      dirty = false; cursor = 0; tree = exports.UpdatePrompt!();
      const pending = slots.filter(slot => slot.effect && slot.pending);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
      if (!dirty) return;
    }
    assert.fail("Unbounded component renders");
  }
  async function flush() {
    for (let i = 0; i < 20; i++) { await Promise.resolve(); if (mounted && dirty) render(); }
  }
  render();
  return { document, serviceWorker, registration, register, updates, flush,
    timers,
    async cancelNavigation() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await flush(); },
    text: () => label(tree), writes: () => writes, reloads: () => reloads, registerCalls: () => registerCalls,
    button() { const button = nodes(tree).find(node => node.type === "button"); assert.ok(button, label(tree)); return button; },
    panel() { const panel = nodes(tree).find(node => node.props.role === "status"); assert.ok(panel, label(tree)); return panel; },
    action() { return this.button().props.onClick as () => void; },
    async ready() { register.resolve(registration); await flush(); },
    async control(worker: Worker) { serviceWorker.controller = worker; serviceWorker.emit("controllerchange"); await flush(); },
    async found(worker: Worker) { registration.installing = worker; registration.emit("updatefound"); await flush(); },
    async installed(worker: Worker) {
      registration.installing = null; registration.waiting = worker;
      worker.state = "installed"; worker.emit("statechange"); await flush();
    },
    async visibility(state = "visible") { document.visibilityState = state; document.emit("visibilitychange"); await flush(); },
    replayEffects() {
      const effects = slots.filter(slot => slot.effect);
      for (const slot of effects) slot.cleanup?.();
      for (const slot of effects) slot.cleanup = slot.create();
      render();
    },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) if (slot.effect) slot.cleanup?.(); },
  };
}

for (const options of [{ supported: false }, { secure: false }]) {
  test(`unsupported context ${JSON.stringify(options)} never registers or subscribes`, async () => {
    const f = fixture(options); await f.ready();
    assert.equal(f.registerCalls(), 0); assert.equal(f.text(), "");
    assert.equal(f.document.count("visibilitychange"), 0); assert.equal(f.serviceWorker.count("controllerchange"), 0);
    f.unmount();
  });
}

test("registration rejection is contained without blocking the application", async () => {
  const f = fixture(); f.register.reject(new Error("Synthetic registration failure")); await f.flush();
  await f.visibility(); assert.equal(f.updates.length, 0); assert.equal(f.reloads(), 0); assert.equal(f.text(), ""); f.unmount();
});

test("first install including an already installing worker never reloads or prompts", async () => {
  const worker = new Worker("installing"), f = fixture({ controlled: false, installing: worker });
  await f.ready(); assert.equal(worker.count("statechange"), 1);
  await f.installed(worker); assert.equal(f.text(), ""); assert.equal(worker.count("statechange"), 0);
  worker.state = "activated"; f.registration.waiting = null;
  await f.control(worker); await f.control(worker);
  assert.equal(f.reloads(), 0); assert.equal(f.text(), ""); assert.deepEqual(worker.messages, []); f.unmount();
});

test("first controller received while register is deferred is also silent", async () => {
  const f = fixture({ controlled: false }); await f.control(new Worker("activated")); await f.ready();
  assert.equal(f.reloads(), 0); assert.equal(f.text(), ""); f.unmount();
});

test("unrelated controllerchange before registration offers only a user-controlled reload", async () => {
  const stale = new Worker(), f = fixture({ waiting: stale });
  await f.control(new Worker("activated")); assert.equal(f.reloads(), 0);
  await f.ready(); assert.equal(label(f.button()), "Перезагрузить");
  const action = f.action(); action(); action(); await f.control(new Worker("activated"));
  assert.equal(f.reloads(), 1); assert.deepEqual(stale.messages, []); f.unmount();
});

test("another tab activation invalidates the old skip-waiting action and reloads only on click once", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
  const old = f.action(); assert.equal(f.reloads(), 0); assert.deepEqual(worker.messages, []);
  worker.state = "activated"; f.registration.waiting = null; await f.control(worker);
  old(); assert.equal(f.reloads(), 0); assert.equal(label(f.button()), "Перезагрузить");
  const late = new Worker("installing"); await f.found(late); await f.installed(late);
  assert.equal(label(f.button()), "Перезагрузить", "late installation cannot restore stale skip-waiting mode");
  const reload = f.action(); reload(); reload(); old(); await f.control(worker);
  assert.equal(f.reloads(), 1); assert.deepEqual(worker.messages, []); assert.deepEqual(late.messages, []); f.unmount();
});

for (const mode of ["waiting-at-registration", "already-installing", "updatefound"] as const) {
  test(`${mode}: own current click sends skip-waiting once and reloads on its activation exactly once`, async () => {
    const worker = new Worker(mode === "waiting-at-registration" ? "installed" : "installing");
    const f = fixture(mode === "waiting-at-registration" ? { waiting: worker }
      : mode === "already-installing" ? { installing: worker } : {});
    await f.ready();
    if (mode === "updatefound") await f.found(worker);
    if (mode !== "waiting-at-registration") await f.installed(worker);
    assert.equal(label(f.button()), "Обновить"); assert.equal(f.reloads(), 0);
    const action = f.action(); action(); action(); await f.flush();
    assert.deepEqual(worker.messages, ["skip-waiting"]); assert.equal(f.button().props.disabled, true);
    assert.equal(f.button().props["aria-busy"], true); assert.equal(f.reloads(), 0);
    f.serviceWorker.emit("controllerchange"); await f.flush(); assert.equal(f.reloads(), 0);
    worker.state = mode === "waiting-at-registration" ? "activating" : "activated";
    f.registration.waiting = null; await f.control(worker);
    await f.control(worker); await f.control(new Worker("activated")); action();
    assert.equal(f.reloads(), 1); assert.deepEqual(worker.messages, ["skip-waiting"]); f.unmount();
  });
}

test("a different activation cannot consume permission given to the requested worker", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
  const old = f.action(); old(); await f.flush(); await f.control(new Worker("activated"));
  assert.equal(f.reloads(), 0); assert.equal(f.button().props.disabled, false);
  assert.equal(label(f.button()), "Перезагрузить");
  worker.state = "activated"; await f.control(worker); old();
  assert.equal(f.reloads(), 0); const action = f.action(); action(); action();
  assert.equal(f.reloads(), 1); assert.deepEqual(worker.messages, ["skip-waiting"]); f.unmount();
});

test("synchronous postMessage failure disarms reload, clears busy and leaves user-controlled reload usable", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); worker.failPost = true; await f.ready();
  f.action()(); await f.flush(); assert.equal(f.button().props.disabled, false);
  assert.equal(f.button().props["aria-busy"], false); assert.match(f.text(), /Не удалось применить обновление/);
  worker.state = "activated"; f.registration.waiting = null; await f.control(worker);
  assert.equal(f.reloads(), 0); assert.equal(label(f.button()), "Перезагрузить");
  f.action()(); assert.equal(f.reloads(), 1); assert.deepEqual(worker.messages, ["skip-waiting"]); f.unmount();
});

test("a failed synchronous dispatch can be retried successfully in the same mount", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); worker.failPost = true; await f.ready();
  f.action()(); await f.flush(); worker.failPost = false; f.action()(); f.action()(); await f.flush();
  assert.equal(f.button().props.disabled, true); assert.doesNotMatch(f.text(), /Не удалось/);
  worker.state = "activated"; await f.control(worker); await f.control(worker);
  assert.deepEqual(worker.messages, ["skip-waiting", "skip-waiting"]); assert.equal(f.reloads(), 1); f.unmount();
});

test("activation before delivery of controllerchange uses the click to reload, never stale skip-waiting", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
  const action = f.action(); f.serviceWorker.controller = worker; worker.state = "activated"; f.registration.waiting = null;
  action(); action(); await f.control(worker);
  assert.equal(f.reloads(), 1); assert.deepEqual(worker.messages, []); f.unmount();
});

test("a worker which stopped waiting cannot be messaged or leave the button busy", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
  worker.state = "activating"; f.registration.waiting = null; f.action()(); await f.flush();
  assert.equal(f.reloads(), 0); assert.equal(f.button().props.disabled, false); assert.deepEqual(worker.messages, []);
  worker.state = "activated"; await f.control(worker); assert.equal(f.reloads(), 0);
  assert.equal(label(f.button()), "Перезагрузить"); f.unmount();
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`unmount before register ${outcome} leaves all late events inert`, async () => {
    const worker = new Worker("installing"), f = fixture({ installing: worker });
    const callbacks = [...f.document.captured("visibilitychange"), ...f.serviceWorker.captured("controllerchange")];
    f.unmount(); const writes = f.writes();
    if (outcome === "resolve") f.register.resolve(f.registration);
    else f.register.reject(new Error("Late synthetic register failure"));
    await f.flush(); f.serviceWorker.controller = new Worker("activated");
    for (const callback of callbacks) callback();
    f.registration.emit("updatefound"); worker.emit("statechange"); await f.flush();
    assert.equal(f.writes(), writes); assert.equal(f.reloads(), 0); assert.equal(f.updates.length, 0);
    assert.equal(f.registration.count("updatefound"), 0); assert.equal(worker.count("statechange"), 0);
    assert.equal(f.document.count("visibilitychange"), 0); assert.equal(f.serviceWorker.count("controllerchange"), 0);
  });
}

for (const pendingClick of [false, true]) {
  test(`unmount with ${pendingClick ? "pending own activation" : "retained waiting action"} revokes callbacks and reload permission`, async () => {
    const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready(); const action = f.action();
    if (pendingClick) action(); await f.flush();
    const callbacks = [...f.serviceWorker.captured("controllerchange"), ...f.document.captured("visibilitychange"),
      ...f.registration.captured("updatefound")];
    f.unmount(); const writes = f.writes(), messages = worker.messages.length;
    worker.state = "activated"; f.serviceWorker.controller = worker; f.registration.installing = new Worker("installing");
    action(); for (const callback of callbacks) callback(); await f.control(worker);
    assert.equal(f.writes(), writes); assert.equal(f.reloads(), 0); assert.equal(worker.messages.length, messages);
    assert.equal(f.updates.length, 0); assert.equal(f.registration.count("updatefound"), 0);
    assert.equal(f.registration.installing.count("statechange"), 0);
  });
}

test("unmount removes the installing listener and rejects already queued statechange callbacks", async () => {
  const worker = new Worker("installing"), f = fixture(); await f.ready(); await f.found(worker);
  assert.equal(worker.count("statechange"), 1);
  const callbacks = worker.captured("statechange"); f.unmount(); const writes = f.writes();
  await f.installed(worker); for (const callback of callbacks) callback(); await f.flush();
  assert.equal(worker.count("statechange"), 0); assert.equal(f.writes(), writes); assert.equal(f.reloads(), 0);
});

test("a retained reload-only action becomes inert on unmount", async () => {
  const f = fixture(); await f.ready(); await f.control(new Worker("activated"));
  const action = f.action(); f.unmount(); const writes = f.writes(); action(); action(); await f.flush();
  assert.equal(f.reloads(), 0); assert.equal(f.writes(), writes);
});

for (const mode of ["own", "foreign"] as const) {
  test(`${mode} activation: cancelled navigation releases busy and permits only a new explicit reload`, async () => {
    const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
    const old = f.action();
    if (mode === "own") { old(); worker.state = "activated"; f.registration.waiting = null; await f.control(worker); }
    else { await f.control(new Worker("activated")); f.action()(); await f.flush(); }
    assert.equal(f.reloads(), 1); assert.equal(f.timers.size, 1);
    assert.equal(f.button().props.disabled, true);
    await f.cancelNavigation();
    assert.equal(label(f.button()), "Перезагрузить"); assert.equal(f.button().props.disabled, false);
    assert.equal(f.reloads(), 1, "recovery must not itself retry navigation");
    const messages = worker.messages.length; old(); await f.flush();
    assert.equal(f.reloads(), 1); assert.equal(worker.messages.length, messages);
    const retry = f.action(); retry(); retry(); await f.flush();
    assert.equal(f.reloads(), 2); assert.equal(f.timers.size, 1);
    await f.cancelNavigation(); assert.equal(f.button().props.disabled, false);
    f.action()(); await f.flush();
    const late = [...f.timers.values()]; f.unmount(); const writes = f.writes();
    assert.equal(f.timers.size, 0);
    for (const callback of late) callback(); await f.flush();
    assert.equal(f.writes(), writes); assert.equal(f.reloads(), 3);
  });
}

test("an installed worker which is not the registration's waiting worker cannot publish an action", async () => {
  const worker = new Worker("installing"), f = fixture(); await f.ready(); await f.found(worker);
  worker.state = "installed"; f.registration.installing = null; worker.emit("statechange"); await f.flush();
  assert.equal(f.text(), ""); assert.equal(f.reloads(), 0); assert.equal(worker.count("statechange"), 0); f.unmount();
});

test("replaced or redundant installers release their listeners and cannot publish a stale prompt", async () => {
  const old = new Worker("installing"), current = new Worker("installing"), f = fixture(); await f.ready();
  await f.found(old); const obsolete = old.captured("statechange");
  await f.found(current); await f.found(current);
  assert.equal(old.count("statechange"), 0); assert.equal(current.count("statechange"), 1);
  old.state = "installed"; f.registration.waiting = old;
  for (const callback of obsolete) callback(); await f.flush(); assert.equal(f.text(), "");
  current.state = "redundant"; current.emit("statechange"); await f.flush();
  assert.equal(current.count("statechange"), 0); assert.equal(f.text(), "");
  const fresh = new Worker("installing"); await f.found(fresh); await f.installed(fresh);
  assert.equal(label(f.button()), "Обновить"); assert.equal(fresh.count("statechange"), 0); f.unmount();
});

test("visibility update rejection is handled and a subsequent check still discovers an update", async () => {
  const f = fixture(); await f.visibility(); assert.equal(f.updates.length, 0); await f.ready();
  await f.visibility("hidden"); assert.equal(f.updates.length, 0);
  await f.visibility(); assert.equal(f.updates.length, 1);
  f.updates[0].reject(new Error("Synthetic offline check")); await f.flush();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.reloads(), 0); assert.equal(f.text(), "");
  await f.visibility(); assert.equal(f.updates.length, 2);
  const worker = new Worker("installing"); await f.found(worker); await f.installed(worker);
  f.updates[1].resolve(f.registration); await f.flush(); assert.equal(label(f.button()), "Обновить"); f.unmount();
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`pending visibility update ${outcome} after unmount cannot publish or reload`, async () => {
    const f = fixture(); await f.ready(); await f.visibility();
    const callbacks = [...f.registration.captured("updatefound"), ...f.document.captured("visibilitychange")];
    f.unmount(); const writes = f.writes();
    if (outcome === "resolve") f.updates[0].resolve(f.registration);
    else f.updates[0].reject(new Error("Late synthetic update failure"));
    const worker = new Worker("installing"); f.registration.installing = worker;
    for (const callback of callbacks) callback(); await f.flush();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.writes(), writes); assert.equal(f.reloads(), 0); assert.equal(f.updates.length, 1);
    assert.equal(worker.count("statechange"), 0);
  });
}

test("effect replay cannot inherit old action permission or revive retired callbacks", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready(); const old = f.action(); old();
  const retired = f.serviceWorker.captured("controllerchange"); f.replayEffects(); await f.flush();
  old(); assert.deepEqual(worker.messages, ["skip-waiting"]);
  worker.state = "activated"; f.registration.waiting = null; f.serviceWorker.controller = worker;
  const writes = f.writes(); for (const callback of retired) callback();
  assert.equal(f.writes(), writes); assert.equal(f.reloads(), 0);
  await f.control(worker); assert.equal(f.reloads(), 0); assert.equal(label(f.button()), "Перезагрузить");
  f.action()(); assert.equal(f.reloads(), 1); f.unmount();
});

test("both activation modes retain Russian labels and a stacked full-width mobile button", async () => {
  const worker = new Worker(), f = fixture({ waiting: worker }); await f.ready();
  for (const reloadOnly of [false, true]) {
    if (reloadOnly) await f.control(new Worker("activated"));
    assert.match(f.text(), /Вышла новая версия/);
    const classes = f.button().props.className.split(/\s+/);
    assert.ok(classes.includes("w-full")); assert.ok(classes.includes("sm:w-auto"));
    assert.ok(classes.includes("whitespace-nowrap"));
    const panelClasses = f.panel().props.className.split(/\s+/);
    for (const token of ["flex-col", "items-stretch", "sm:flex-row", "sm:items-center"]) {
      assert.ok(panelClasses.includes(token));
    }
    assert.equal(label(f.button()), reloadOnly ? "Перезагрузить" : "Обновить");
  }
  f.unmount();
});

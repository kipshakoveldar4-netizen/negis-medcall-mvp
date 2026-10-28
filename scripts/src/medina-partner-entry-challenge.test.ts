import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const file = "artifacts/negis/src/pages/partner-entry-challenge.ts";
const compiled = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
assert.deepEqual(compiled.diagnostics ?? [], [], "The actual adapter must transpile");

type Listener = (event?: any) => void;
type AbortListener = (event: unknown) => void;
class Events {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(name: string, callback: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
  }
  removeEventListener(name: string, callback: Listener) {
    this.listeners.get(name)?.delete(callback);
    if (this.listeners.get(name)?.size === 0) this.listeners.delete(name);
  }
  fire(name: string, event?: unknown) {
    for (const callback of [...this.listeners.get(name) ?? []]) callback(event);
  }
}

class Clock {
  private next = 0;
  readonly pending = new Map<number, { callback: () => void; delay: number }>();
  readonly scheduled: { callback: () => void; delay: number }[] = [];
  setTimeout = (callback: () => void, delay: number) => {
    const task = { callback, delay };
    this.pending.set(++this.next, task);
    this.scheduled.push(task);
    return this.next;
  };
  clearTimeout = (id?: number) => { if (id !== undefined) this.pending.delete(id); };
  fire(delay: number) {
    const tasks = [...this.pending].filter(([, task]) => task.delay === delay);
    assert.equal(tasks.length, 1, `Expected one pending ${delay}ms timer`);
    this.pending.delete(tasks[0][0]);
    tasks[0][1].callback();
  }
}

type ProviderOptions = {
  sitekey: string; action: string; theme: string; size: string; language: string;
  "response-field": boolean; "refresh-expired": string;
  callback(token: unknown): void;
  "error-callback"(): void;
  "expired-callback"(): void;
  "timeout-callback"(): void;
};
type ChallengeError = Error & { reason: "blocked" | "unavailable" | "expired" };
type Adapter = {
  PARTNER_ENTRY_TURNSTILE_URL: string;
  challengePartnerEntry(siteKey: string, element: unknown, signal: AbortSignal): Promise<string>;
  PartnerEntryChallengeError: new (reason: ChallengeError["reason"]) => ChallengeError;
};
type Outcome = { value: string; error?: never } | { error: unknown; value?: never };
type Options = {
  createThrows?: boolean; appendThrows?: boolean; renderThrows?: boolean; removeThrows?: boolean;
  provider?: unknown; onRender?: (options: ProviderOptions) => void;
};

function fixture(options: Options = {}) {
  const clock = new Clock();
  const documentEvents = new Events();
  const script = Object.assign(new Events(), { src: "", async: false, referrerPolicy: "", removed: 0,
    remove() { this.removed++; } });
  const element = { children: [] as unknown[], clears: 0, replaceChildren() { this.children = []; this.clears++; } };
  const renders: { element: unknown; options: ProviderOptions; id: string }[] = [];
  const removals: string[] = [];
  let creates = 0, appends = 0, providerReads = 0;
  const provider = {
    render(target: unknown, parameters: ProviderOptions) {
      if (options.renderThrows) throw Error("Synthetic render refusal");
      const id = `synthetic-widget-${renders.length + 1}`;
      renders.push({ element: target, options: parameters, id });
      element.children.push(id);
      options.onRender?.(parameters);
      return id;
    },
    remove(id: string) {
      removals.push(id);
      if (options.removeThrows) throw Error("Synthetic removal refusal");
      element.children = element.children.filter(value => value !== id);
    },
  };
  const document = Object.assign(documentEvents, {
    createElement(name: string) {
      creates++;
      assert.equal(name, "script");
      if (options.createThrows) throw Error("Synthetic script creation refusal");
      return script;
    },
    head: { appendChild(value: unknown) {
      appends++;
      assert.equal(value, script);
      if (options.appendThrows) throw Error("Synthetic CSP append refusal");
      return value;
    } },
  });
  const window = { get turnstile() { providerReads++; return Object.hasOwn(options, "provider") ? options.provider : provider; } };
  const exports = {};
  const forbidden = new Proxy({}, { get() { assert.fail("No storage or logging is allowed in adapter tests"); } });
  new Script(compiled.outputText, { filename: file }).runInNewContext({
    exports, Error, DOMException, document, window, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    console: forbidden, localStorage: forbidden, sessionStorage: forbidden,
    fetch() { assert.fail("No network is allowed in adapter tests"); },
    require(name: string) { assert.fail(`Unexpected adapter dependency: ${name}`); },
  });
  const adapter = exports as Adapter;
  const controller = new AbortController();
  const signalListeners = new Set<AbortListener>();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(name: string, callback: AbortListener, value?: { once?: boolean }) {
      assert.equal(name, "abort"); signalListeners.add(callback); controller.signal.addEventListener(name, callback, value);
    },
    removeEventListener(name: string, callback: AbortListener) {
      signalListeners.delete(callback); controller.signal.removeEventListener(name, callback);
    },
  } as AbortSignal;
  let settlements = 0;
  const start = () => adapter.challengePartnerEntry("synthetic-site-key", element, signal).then<Outcome, Outcome>(
    value => { settlements++; return { value }; }, error => { settlements++; return { error }; },
  );
  const cleaned = () => {
    assert.equal(signalListeners.size, 0, "Abort listener must be removed");
    assert.equal(documentEvents.listeners.size, 0, "CSP listener must be removed");
    assert.equal(script.listeners.size, 0, "Load/error listeners must be removed");
    assert.equal(clock.pending.size, 0, "Timers must be cleared");
    assert.deepEqual(element.children, [], "Widget container must be cleared");
    assert.ok(element.clears > 0);
    if (creates && !options.createThrows) assert.ok(script.removed > 0, "Owned script must be removed");
  };
  return { adapter, start, controller, signal, signalListeners, documentEvents, script, element, renders, removals,
    clock, cleaned, counts: () => ({ creates, appends, providerReads, settlements }) };
}

async function rejected(f: ReturnType<typeof fixture>, pending: Promise<Outcome>, reason: ChallengeError["reason"] | "abort") {
  const result = await pending;
  assert.ok("error" in result, "The actual adapter must reject");
  if (reason === "abort") {
    assert.ok(result.error instanceof DOMException);
    assert.equal(result.error.name, "AbortError");
  } else {
    assert.ok(result.error instanceof f.adapter.PartnerEntryChallengeError);
    assert.equal(result.error.reason, reason);
  }
  assert.equal(f.counts().settlements, 1);
  f.cleaned();
}

test("module evaluation is inert and a pre-aborted signal never creates or appends a script", async () => {
  const f = fixture();
  assert.deepEqual(f.counts(), { creates: 0, appends: 0, providerReads: 0, settlements: 0 });
  f.controller.abort();
  await rejected(f, f.start(), "abort");
  assert.equal(f.counts().creates, 0);
  assert.equal(f.counts().appends, 0);
  assert.equal(f.clock.scheduled.length, 0);
});

test("actual adapter owns the exact explicit-loader URL and suppresses the referrer", async () => {
  const f = fixture();
  const pending = f.start();
  assert.equal(f.adapter.PARTNER_ENTRY_TURNSTILE_URL, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  assert.equal(f.script.src, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  assert.equal(f.script.referrerPolicy, "no-referrer");
  assert.equal(f.script.async, true);
  assert.equal(f.counts().appends, 1);
  assert.equal(f.counts().providerReads, 0, "An untrusted preexisting global must not bypass the fixed loader");
  assert.equal(f.renders.length, 0);
  f.controller.abort();
  await rejected(f, pending, "abort");
});

test("blocked script rejects and releases every loader listener and timer", async () => {
  const f = fixture(); const pending = f.start();
  f.script.fire("error");
  await rejected(f, pending, "blocked");
  f.script.fire("load");
  assert.equal(f.renders.length, 0);
});

for (const blockedURI of ["https://challenges.cloudflare.com", "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/frame"]) {
  test(`enforced provider CSP rejection cleans up: ${blockedURI}`, async () => {
    const f = fixture(); const pending = f.start();
    f.documentEvents.fire("securitypolicyviolation", { disposition: "enforce", blockedURI });
    await rejected(f, pending, "blocked");
    assert.equal(f.renders.length, 0);
  });
}

test("report-only CSP and unrelated blocked origins do not reject an owned verification", async () => {
  const f = fixture(); const pending = f.start();
  for (const event of [
    { disposition: "report", blockedURI: "https://challenges.cloudflare.com/turnstile/v0/api.js" },
    { disposition: "enforce", blockedURI: "https://unrelated.fixture.invalid/script.js" },
    { disposition: "enforce", blockedURI: "https://challenges.cloudflare.com.attacker.invalid/script.js" },
  ]) f.documentEvents.fire("securitypolicyviolation", event);
  await Promise.resolve();
  assert.equal(f.counts().settlements, 0);
  assert.equal(f.script.removed, 0);
  f.script.fire("load");
  f.renders[0].options.callback("synthetic-token");
  assert.deepEqual(await pending, { value: "synthetic-token" });
  f.cleaned();
});

test("abort after widget creation removes the widget and rejects retained callbacks", async () => {
  const f = fixture(); const pending = f.start(); f.script.fire("load");
  const options = f.renders[0].options;
  f.controller.abort();
  await rejected(f, pending, "abort");
  assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  const clears = f.element.clears;
  options.callback("late-synthetic-token"); options["error-callback"](); options["expired-callback"]();
  await Promise.resolve();
  assert.equal(f.counts().settlements, 1);
  assert.equal(f.element.clears, clears);
  f.cleaned();
});

test("enforced CSP after widget creation also removes the live widget", async () => {
  const f = fixture(); const pending = f.start(); f.script.fire("load");
  f.documentEvents.fire("securitypolicyviolation", { disposition: "enforce", blockedURI: "https://challenges.cloudflare.com" });
  await rejected(f, pending, "blocked");
  assert.deepEqual(f.removals, ["synthetic-widget-1"]);
});

test("successful callback returns only its token and removes hidden-field, widget and listener lifetimes", async () => {
  const f = fixture(); const pending = f.start(); f.script.fire("load");
  assert.equal(f.renders[0].element, f.element);
  const options = f.renders[0].options;
  const { callback, "error-callback": errorCallback, "expired-callback": expiredCallback, "timeout-callback": timeoutCallback,
    ...configuration } = options;
  assert.deepEqual(JSON.parse(JSON.stringify(configuration)), {
    sitekey: "synthetic-site-key", action: "partner_entry", theme: "light", size: "flexible", language: "ru",
    "response-field": false, "refresh-expired": "never",
  });
  assert.equal(typeof errorCallback, "function"); assert.equal(typeof expiredCallback, "function"); assert.equal(typeof timeoutCallback, "function");
  callback("synthetic-token");
  assert.deepEqual(await pending, { value: "synthetic-token" });
  assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  f.cleaned();
  const clears = f.element.clears;
  callback("late-token"); errorCallback(); expiredCallback(); timeoutCallback(); f.controller.abort();
  for (const timer of f.clock.scheduled) timer.callback();
  await Promise.resolve();
  assert.equal(f.element.clears, clears);
  assert.equal(f.counts().settlements, 1);
});

for (const mode of ["success", "error", "expired", "timeout"] as const) {
  test(`synchronous provider ${mode} callback cannot leak the returned widget ID`, async () => {
    const f = fixture({ onRender(options) {
      if (mode === "success") options.callback("synthetic-sync-token");
      else options[mode === "error" ? "error-callback" : mode === "expired" ? "expired-callback" : "timeout-callback"]();
    } });
    const pending = f.start(); f.script.fire("load");
    if (mode === "success") { assert.deepEqual(await pending, { value: "synthetic-sync-token" }); f.cleaned(); }
    else await rejected(f, pending, mode === "error" ? "unavailable" : "expired");
    assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  });
}

test("synthetic loader timer rejects a never-loaded script without wall-clock waiting", async () => {
  const f = fixture(); const pending = f.start();
  assert.deepEqual([...f.clock.pending.values()].map(task => task.delay), [20000]);
  f.clock.fire(20000);
  await rejected(f, pending, "blocked");
  f.script.fire("load"); assert.equal(f.renders.length, 0);
});

test("widget expiration replaces the loader timer and removes the original widget", async () => {
  const f = fixture(); const pending = f.start(); f.script.fire("load");
  assert.deepEqual([...f.clock.pending.values()].map(task => task.delay), [120000]);
  f.clock.fire(120000);
  await rejected(f, pending, "expired");
  assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  f.renders[0].options.callback("late-expired-token"); await Promise.resolve();
  assert.equal(f.counts().settlements, 1);
});

for (const [callback, reason] of [["error-callback", "unavailable"], ["expired-callback", "expired"], ["timeout-callback", "expired"]] as const) {
  test(`provider ${callback} rejects with ${reason} and cleans the widget`, async () => {
    const f = fixture(); const pending = f.start(); f.script.fire("load");
    f.renders[0].options[callback]();
    await rejected(f, pending, reason);
    assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  });
}

for (const [index, token] of [undefined, null, false, true, 0, 1, [], {}, "", "x".repeat(2049)].entries()) {
  test(`wrong token ${index} cannot resolve verification`, async () => {
    const f = fixture(); const pending = f.start(); f.script.fire("load");
    f.renders[0].options.callback(token);
    await rejected(f, pending, "unavailable");
    assert.deepEqual(f.removals, ["synthetic-widget-1"]);
  });
}

test("the documented maximum token length is returned unchanged", async () => {
  const f = fixture(); const pending = f.start(); f.script.fire("load");
  const token = "x".repeat(2048); f.renders[0].options.callback(token);
  assert.deepEqual(await pending, { value: token }); f.cleaned();
});

for (const provider of [undefined, {}, { render: true, remove() {} }, { render() {}, remove: null }]) {
  test(`a loaded script without a callable provider pair is unavailable: ${JSON.stringify(provider)}`, async () => {
    const f = fixture({ provider }); const pending = f.start(); f.script.fire("load");
    await rejected(f, pending, "unavailable");
    assert.equal(f.renders.length, 0);
  });
}

for (const fault of ["createThrows", "appendThrows"] as const) {
  test(`synchronous DOM failure ${fault} cleans all partial loader setup`, async () => {
    const f = fixture({ [fault]: true }); await rejected(f, f.start(), "blocked");
    assert.equal(f.renders.length, 0);
  });
}

test("a throwing provider render rejects and clears the expiration timer", async () => {
  const f = fixture({ renderThrows: true }); const pending = f.start(); f.script.fire("load");
  await rejected(f, pending, "unavailable");
});

test("a throwing provider remove cannot prevent container or listener cleanup", async () => {
  const f = fixture({ removeThrows: true }); const pending = f.start(); f.script.fire("load");
  f.controller.abort(); await rejected(f, pending, "abort");
  assert.deepEqual(f.removals, ["synthetic-widget-1"]);
});

test("only a previously trusted loaded API is reused, with a fresh widget lifetime", async () => {
  const f = fixture(); const first = f.start(); f.script.fire("load");
  f.renders[0].options.callback("first-synthetic-token");
  assert.deepEqual(await first, { value: "first-synthetic-token" }); f.cleaned();
  const second = f.start();
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().appends, 1);
  assert.equal(f.renders.length, 2);
  assert.deepEqual([...f.clock.pending.values()].map(task => task.delay), [120000]);
  f.renders[1].options.callback("second-synthetic-token");
  assert.deepEqual(await second, { value: "second-synthetic-token" });
  assert.deepEqual(f.removals, ["synthetic-widget-1", "synthetic-widget-2"]); f.cleaned();
});

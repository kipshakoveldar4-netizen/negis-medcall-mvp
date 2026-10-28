import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { eagerControlLazy, controlFixtureType, controlFixtureSuspense, ControlFixtureComponent } from "./control-lazy-test-fixture";

// Whole actual App, Onboarding, controlFetch, and staff-login helpers. React
// scheduling and the auth SDK are doubles: no real SDK/JWT decoding is claimed.
// HTTP uses synthetic native Responses and the real Response.json decoder.
// Clipboard, timers, and every session/credential below are synthetic. Password
// generation, browser storage, external imports, and real HTTP are forbidden.
// Current: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-control-onboarding-actor.test.ts
// Baseline: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-control-onboarding-actor.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");
const sourceFiles = {
  app: "artifacts/medina-control/src/App.tsx",
  screen: "artifacts/medina-control/src/screens/Onboarding.tsx",
  api: "artifacts/medina-control/src/lib/api.ts",
  logins: "lib/auth/staff-logins.ts",
};
const sources = new Map<string, Script>();
const fingerprints: Record<string, string> = {};
for (const file of Object.values(sourceFiles)) {
  const source = baseline
    ? execFileSync("git", ["show", `b301f1f:${file}`], { cwd: root, encoding: "utf8" })
    : readFileSync(path.join(root, file), "utf8");
  fingerprints[file] = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.equal(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0, file);
  sources.set(file, new Script(compiled.outputText, { filename: file }));
}

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const workspace = "00000000-0000-4000-8000-000000000011";
const ownerEmail = "synthetic-owner@example.invalid";
const ownerLogin = "synthetic.owner";
const password = "synthetic-password-42";
const credentialsRoute = "/api/crm/platform-onboarding-credentials";
const inviteRoute = "/api/crm/platform-onboarding";
const reissueRoute = "/api/crm/platform-invitation-reissue";
const origin = "https://onboarding.fixture.invalid";

type Props = Record<string, any> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set: (value: unknown) => void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies }
  | { kind: "effect"; create: Effect; deps: Dependencies; pending: boolean; cleanup?: () => void };
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type: controlFixtureType(type), props, key });
function nodes(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(nodes);
  if (child === null || typeof child !== "object") return [];
  return [child, ...nodes(child.props.children)];
}
function content(child: Child): string {
  if (Array.isArray(child)) return child.map(content).join("");
  if (child !== null && typeof child === "object") return content(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function sameDeps(left: Dependencies, right: Dependencies) {
  return !!left && !!right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
}
function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0, dirty = true, mounted = true, rendering = false, writes = 0, lateWrites = 0;
  let hookCount: number | undefined;
  let tree: Child;
  let component: () => Child;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Actual hooks must run during rendering");
    const index = cursor++;
    slots[index] ??= create();
    assert.equal(slots[index].kind, kind, "Stable hook order");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", () => {
        const current: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            writes++;
            if (!mounted) { lateWrites++; return; }
            const next = typeof update === "function" ? (update as (previous: unknown) => unknown)(current.value) : update;
            if (!Object.is(next, current.value)) { current.value = next; dirty = true; }
          },
        };
        return current;
      });
      return [state.value as T, state.set] as const;
    },
    useRef<T>(initial: T) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo<T>(create: () => T, deps?: readonly unknown[]) {
      const memo = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDeps(memo.deps, deps)) { memo.value = create(); memo.deps = deps; }
      return memo.value as T;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps?: readonly unknown[]) {
      const effect = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!sameDeps(effect.deps, deps)) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
  };
  return {
    hooks,
    mount(value: () => Child) { component = value; },
    commit() {
      if (!mounted || !dirty) return;
      dirty = false; cursor = 0; rendering = true;
      try { tree = component(); } finally { rendering = false; }
      hookCount ??= cursor;
      assert.equal(cursor, hookCount);
      const pending = slots.filter((s): s is Extract<Slot, { kind: "effect" }> => s.kind === "effect" && s.pending);
      for (const effect of pending) effect.cleanup?.();
      for (const effect of pending) { effect.pending = false; effect.cleanup = effect.create() || undefined; }
    },
    nodes: () => nodes(tree), text: () => content(tree), writes: () => writes, lateWrites: () => lateWrites,
    dispose() { if (!mounted) return; mounted = false; for (const item of slots) if (item.kind === "effect") item.cleanup?.(); },
  };
}
type Driver = ReturnType<typeof hookDriver>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Session = { user: { id: string; email: string }; access_token: string };
type SessionResult = { data: { session: Session | null }; error: unknown };
type HttpCall = {
  actor: string; url: URL; method: string; authorization: string | null; body: Record<string, unknown>;
  settled: boolean; claimed: boolean;
  reply(body: unknown, status?: number): void;
  holdJson(body: unknown, status?: number): { release(): void; locked(): boolean };
  lose(): void;
};
type ClipboardCall = { value: string; resolve(): void; reject(): void };
type Timer = { callback: () => void; active: boolean };

async function fixture(t: TestContext) {
  const app = hookDriver();
  const screens: Driver[] = [];
  let screen: Driver | undefined;
  let active = app;
  let actor = A;
  let tokenRevision = 0;
  let sdkAuthEvents = 0;
  let disposed = false;
  let mountedKey: unknown = Symbol("no screen");
  const listeners = new Set<(event: string, session: Session) => void>();
  const sessionHolds: Array<ReturnType<typeof deferred<SessionResult>>> = [];
  const sessionQueue: Array<ReturnType<typeof deferred<SessionResult>>> = [];
  const requests: HttpCall[] = [], clipboard: ClipboardCall[] = [];
  const timers: Timer[] = [];
  const bodyReleases: Array<() => void> = [];
  const session = (id = actor): Session => ({ user: { id, email: `synthetic-actor-${id}@example.invalid` },
    access_token: `synthetic-token-${id}${tokenRevision ? `-refresh-${tokenRevision}` : ""}` });
  const sessionResult = (id = actor): SessionResult => ({ data: { session: session(id) }, error: null });
  const forbidden = (name: string): never => assert.fail(`Forbidden onboarding harness dependency: ${name}`);
  const auth = {
    getSession() { return sessionQueue.shift()?.promise ?? Promise.resolve(sessionResult()); },
    onAuthStateChange(callback: (event: string, value: Session) => void) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
    },
  };
  const exportsByFile = new Map<string, any>();
  const react = new Proxy({}, { get(_target, name) {
    if (name === "lazy") return eagerControlLazy;
    if (name === "Suspense") return controlFixtureSuspense;
    if (name === "Component") return ControlFixtureComponent;
    return (...args: unknown[]) => {
      const hook = Reflect.get(active.hooks, name === "useLayoutEffect" ? "useEffect" : name);
      assert.equal(typeof hook, "function", `Unsupported hook ${String(name)}`);
      return hook(...args);
    };
  } });
  function evaluate(file: string): any {
    if (exportsByFile.has(file)) return exportsByFile.get(file);
    const exports = {};
    exportsByFile.set(file, exports);
    const program = sources.get(file);
    assert.ok(program, `Only whole declared source modules may execute: ${file}`);
    program.runInNewContext({
      exports, Error, TypeError, SyntaxError, Date, URL, URLSearchParams, Headers, Response,
      AbortController, AbortSignal, ReadableStream, TextEncoder, queueMicrotask,
      crypto: { getRandomValues: () => forbidden("password generation") },
      navigator: { clipboard: { writeText(value: string) {
        const pending = deferred<void>();
        clipboard.push({ value, resolve: () => pending.resolve(), reject: () => pending.reject(new Error("Synthetic clipboard denial")) });
        return pending.promise;
      } } },
      window: {
        setTimeout(callback: () => void) { timers.push({ callback, active: true }); return timers.length; },
        clearTimeout(id: number) { if (timers[id - 1]) timers[id - 1].active = false; },
      },
      fetch(input: string, init: RequestInit = {}) {
        const url = new URL(input);
        assert.equal(url.origin, origin, "No real HTTP is available");
        assert.ok([credentialsRoute, inviteRoute, reissueRoute].includes(url.pathname));
        const pending = deferred<Response>();
        function deliver(response: Response) { assert.equal(call.settled, false); call.settled = true; pending.resolve(response); }
        const call: HttpCall = {
          actor, url, method: init.method ?? "GET", authorization: new Headers(init.headers).get("Authorization"),
          body: JSON.parse(String(init.body)), settled: false, claimed: false,
          reply(body, status = 200) { deliver(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })); },
          holdJson(body, status = 200) {
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            let released = false;
            const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
            const release = () => { if (released) return; released = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); };
            bodyReleases.push(release);
            deliver(new Response(stream, { status, headers: { "content-type": "application/json" } }));
            return { release, locked: () => stream.locked };
          },
          lose() { assert.equal(call.settled, false); call.settled = true; pending.reject(new TypeError("Synthetic lost HTTP response")); },
        };
        requests.push(call);
        // Aborts intentionally do not suppress delivery: stale handlers need guards.
        return pending.promise;
      },
      require(name: string) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("Fragment") };
        if (file === sourceFiles.api && name === "./supabase" || file === sourceFiles.app && name === "./lib/supabase") {
          return { supabase: { auth }, controlConfig: { ready: true, apiOrigin: origin } };
        }
        if (file === sourceFiles.screen && name === "../lib/api"
          || file === sourceFiles.app && name === "./lib/api") return evaluate(sourceFiles.api);
        if (name === "../../../../lib/auth/staff-logins") return evaluate(sourceFiles.logins);
        if (name === "./screens/Onboarding") return evaluate(sourceFiles.screen);
        for (const nameOfScreen of ["Login", "Overview", "ClinicCard", "Operators", "Contributors", "PartnerCompanies"]) {
          if (name === `./screens/${nameOfScreen}`) return { [nameOfScreen]: Symbol(nameOfScreen) };
        }
        return forbidden(`${file}: ${name}`);
      },
    });
    return exports;
  }
  const { Onboarding } = evaluate(sourceFiles.screen);
  const { default: App } = evaluate(sourceFiles.app);
  app.mount(() => { active = app; return App(); });
  async function flush() {
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let pass = 0; pass < 48; pass++) {
        if (!disposed) {
          active = app; app.commit();
          const main = app.nodes().find((node) => node.type === "main");
          const child = main && nodes(main).find((node) => node.type === Onboarding);
          if (!child) { screen?.dispose(); screen = undefined; }
          else {
            if (!screen || !Object.is(mountedKey, main.key)) {
              screen?.dispose(); screen = hookDriver(); screens.push(screen); mountedKey = main.key;
              const mounted = screen;
              mounted.mount(() => { active = mounted; return Onboarding(child.props); });
            }
            active = screen; screen.commit();
          }
        }
        await Promise.resolve();
      }
      // Native Response.json reads Web Streams, beyond a pure microtask queue.
      await setImmediate();
    }
  }
  function findButton(elements: Element[], label: RegExp) {
    const button = elements.find((node) => node.type === "button" && label.test(content(node)));
    assert.ok(button, `Missing button ${label}`);
    return button;
  }
  function field(id: string) {
    const input = screen?.nodes().find((node) => node.props.id === id);
    assert.ok(input, `Missing real Onboarding input ${id}`);
    return input;
  }
  function invoke(node: Element, event: string, argument?: unknown) {
    assert.notEqual(node.props.disabled, true);
    assert.equal(typeof node.props[event], "function");
    return node.props[event](argument);
  }
  async function navigate(label: RegExp) { active = app; invoke(findButton(app.nodes(), label), "onClick"); await flush(); }
  await flush();
  await navigate(/^Подключить клинику$/u);
  const dispose = () => { if (disposed) return; disposed = true; screen?.dispose(); app.dispose(); };
  t.after(async () => {
    dispose();
    for (const held of sessionHolds) held.resolve(sessionResult());
    for (const request of requests) if (!request.settled) request.reply({ success: false }, 503);
    for (const release of bodyReleases) release();
    for (const item of clipboard) item.resolve();
    await flush();
  });
  return {
    requests, clipboard, timers, flush, navigate, dispose, field,
    nodes: () => screen?.nodes() ?? [], text: () => screen?.text() ?? "",
    appNodes: () => app.nodes(), appText: () => app.text(),
    mainKey: () => app.nodes().find((node) => node.type === "main")?.key,
    hasOnboarding: () => app.nodes().some((node) => node.type === Onboarding),
    screenMounts: () => screens.length, sdkAuthEvents: () => sdkAuthEvents,
    writes: () => screens.reduce((sum, driver) => sum + driver.writes(), 0),
    lateWrites: () => screens.reduce((sum, driver) => sum + driver.lateWrites(), 0),
    button: (label: RegExp) => findButton(screen?.nodes() ?? [], label),
    form() { const form = screen?.nodes().find((node) => node.type === "form"); assert.ok(form, "Real Onboarding form"); return form; },
    async click(label: RegExp) { invoke(findButton(screen?.nodes() ?? [], label), "onClick"); await flush(); },
    async change(id: string, value: string) { invoke(field(id), "onChange", { target: { value } }); await flush(); },
    async changeActor(id: string, reopen = true) {
      actor = id;
      sdkAuthEvents++;
      for (const listener of [...listeners]) listener("SIGNED_IN", session());
      await flush();
      if (reopen) await navigate(/^Подключить клинику$/u);
    },
    replaceSdkSession(id: string) { actor = id; },
    refreshSdkToken() { tokenRevision++; return session().access_token; },
    holdNextSession() {
      const held = deferred<SessionResult>(); sessionHolds.push(held); sessionQueue.push(held);
      return {
        release(id = A) { held.resolve(sessionResult(id)); },
        releaseResult(result: SessionResult) { held.resolve(result); },
        reject() { held.reject(new Error("Synthetic SDK lookup failure")); },
      };
    },
    take(route: string) {
      const request = requests.find((item) => !item.claimed && item.url.pathname === route);
      assert.ok(request, `Expected synthetic HTTP ${route}; saw ${requests.map((item) => `${item.actor} ${item.url.pathname}`).join(", ")}`);
      request.claimed = true; return request;
    },
  };
}
type UI = Awaited<ReturnType<typeof fixture>>;
type Mode = "email" | "login" | "invite";
async function fill(ui: UI, mode: Mode = "email") {
  if (mode === "invite") await ui.click(/^Ссылка-приглашение$/u);
  else if (mode === "login") await ui.click(/^Логин$/u);
  await ui.change("ob-name", "Synthetic onboarding clinic");
  await ui.change("ob-vertical", "beauty");
  await ui.change(mode === "login" ? "ob-login" : "ob-email", mode === "login" ? "Synthetic-Owner" : ownerEmail);
  await ui.change("ob-owner", "Synthetic owner");
  if (mode !== "invite") await ui.change("ob-password", password);
}
const submitEvent = () => ({ preventDefault() {} });
async function submit(ui: UI) { ui.form().props.onSubmit(submitEvent()); await ui.flush(); }
function success(mode: Mode = "email", reissued = false) {
  return { success: true, data: {
    workspaceId: workspace, name: "Synthetic onboarding clinic", vertical: reissued ? null : "beauty",
    purpose: "clinic_services", ownerEmail: mode === "login" ? "synthetic.owner@staff.negis.online" : ownerEmail,
    ownerLogin: mode === "login" ? ownerLogin : ownerEmail, ownerLoginOnly: mode === "login",
    timeZone: "Asia/Almaty", loginUrl: `${origin}/login`, acceptUrl: `${origin}/join/synthetic-invitation`, emailSent: false,
  } };
}
async function reissueReady(t: TestContext) {
  const ui = await fixture(t); await fill(ui, "invite"); await submit(ui);
  ui.take(inviteRoute).reply({ success: false, code: "invitation_already_pending", error: "Synthetic invitation conflict", data: { existingWorkspaceId: workspace } }, 409);
  await ui.flush(); return ui;
}
async function completed(t: TestContext, mode: Mode = "email") {
  const ui = await fixture(t); await fill(ui, mode); await submit(ui);
  ui.take(mode === "invite" ? inviteRoute : credentialsRoute).reply(success(mode));
  await ui.flush(); return ui;
}
async function leave(ui: UI, boundary: "B" | "A/B/A" | "unmount") {
  if (boundary === "unmount") await ui.navigate(/^Обзор$/u);
  else { await ui.changeActor(B); if (boundary === "A/B/A") await ui.changeActor(A); }
}

test("source provenance", (t) => { t.diagnostic(`${baseline ? "b301f1f baseline" : "current working tree"}: ${JSON.stringify(fingerprints)}`); });

for (const mode of ["email", "login", "invite"] as const) {
  test(`authorized ${mode} onboarding uses the actual API and renders its synthetic result`, async (t) => {
    const ui = await fixture(t); await fill(ui, mode); await submit(ui);
    const request = ui.take(mode === "invite" ? inviteRoute : credentialsRoute);
    assert.equal(request.actor, A); assert.equal(request.authorization, `Bearer synthetic-token-${A}`);
    assert.equal(request.method, "POST"); assert.equal(request.body.name, "Synthetic onboarding clinic");
    if (mode === "login") { assert.equal(request.body.ownerLogin, "synthetic.owner"); assert.equal(request.body.ownerEmail, undefined); }
    else assert.equal(request.body.ownerEmail, ownerEmail);
    assert.equal(request.body.password, mode === "invite" ? undefined : password);
    request.reply(success(mode)); await ui.flush();
    assert.match(ui.text(), /Synthetic onboarding clinic/u);
    assert.equal(ui.nodes().some((node) => node.type === "form"), false);
    if (mode !== "invite") assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
    assert.equal(ui.lateWrites(), 0);
  });
}

test("a fresh B onboarding lifetime can create its authorized login owner", async (t) => {
  const ui = await fixture(t); await ui.changeActor(B); await fill(ui, "login"); await submit(ui);
  const request = ui.take(credentialsRoute);
  assert.equal(request.actor, B); assert.equal(request.authorization, `Bearer synthetic-token-${B}`);
  assert.equal(request.body.ownerLogin, "synthetic.owner");
  request.reply(success("login")); await ui.flush();
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
});

test("authorized invitation reissue posts only the existing workspace and renders a new link", async (t) => {
  const ui = await reissueReady(t); await ui.click(/^Перевыпустить приглашение$/u);
  const request = ui.take(reissueRoute);
  assert.equal(request.actor, A); assert.deepEqual(request.body, { workspaceId: workspace });
  request.reply(success("invite", true)); await ui.flush();
  assert.match(ui.text(), /Приглашение перевыпущено/u);
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === `${origin}/join/synthetic-invitation`));
});

test("authorized password copy awaits synthetic clipboard and its timer resets the confirmation", async (t) => {
  const ui = await completed(t);
  await ui.click(/^Скопировать$/u);
  assert.equal(ui.clipboard.length, 1); assert.equal(ui.clipboard[0].value, password);
  assert.doesNotMatch(ui.text(), /Скопировано/u);
  ui.clipboard[0].resolve(); await ui.flush(); assert.match(ui.text(), /Скопировано/u);
  const timer = ui.timers.find((item) => item.active); assert.ok(timer);
  timer.active = false; timer.callback(); await ui.flush(); assert.doesNotMatch(ui.text(), /Скопировано/u);
});

for (const mode of ["email", "login", "invite"] as const) {
  for (const boundary of ["B", "A/B/A", "unmount"] as const) {
    test(`captured ${mode} submit cannot create an owner or invitation after ${boundary}`, async (t) => {
      const ui = await fixture(t); await fill(ui, mode);
      const oldSubmit = ui.form().props.onSubmit;
      await leave(ui, boundary);
      const writes = ui.writes(), count = ui.requests.length, before = ui.text();
      oldSubmit(submitEvent()); await ui.flush();
      assert.equal(ui.requests.length, count, `Old form must not let controlFetch capture the new actor/lifetime; dispatched actors: ${ui.requests.slice(count).map((request) => request.actor).join(", ")}`);
      assert.equal(ui.writes(), writes, "Old submit must not set busy, error, password, owner, or result state");
      assert.equal(ui.text(), before);
    });
  }
}

for (const boundary of ["B", "A/B/A", "unmount"] as const) {
  test(`captured invitation reissue cannot dispatch after ${boundary}`, async (t) => {
    const ui = await reissueReady(t); const reissue = ui.button(/^Перевыпустить приглашение$/u).props.onClick;
    await leave(ui, boundary);
    const count = ui.requests.length, writes = ui.writes();
    reissue(); await ui.flush();
    assert.equal(ui.requests.length, count, "An old conflict cannot create an invitation in a new actor lifetime");
    assert.equal(ui.writes(), writes);
  });

  test(`captured owner/password input closures cannot mutate state after ${boundary}`, async (t) => {
    const ui = await fixture(t); await fill(ui);
    const owner = ui.field("ob-email").props.onChange, secret = ui.field("ob-password").props.onChange;
    await leave(ui, boundary);
    const writes = ui.writes(), before = ui.text();
    owner({ target: { value: "other-synthetic-owner@example.invalid" } });
    secret({ target: { value: "other-synthetic-password" } }); await ui.flush();
    assert.equal(ui.writes(), writes, "Even input handlers need the originating render lifetime");
    assert.equal(ui.text(), before);
  });

  test(`captured password copy cannot write clipboard after ${boundary}`, async (t) => {
    const ui = await completed(t); const copy = ui.button(/^Скопировать$/u).props.onClick;
    await leave(ui, boundary);
    const writes = ui.writes(); copy(); await ui.flush();
    assert.equal(ui.clipboard.length, 0, "Do not copy a previous owner's password from a stale callback");
    assert.equal(ui.writes(), writes);
  });
}

for (const change of ["mode", "identity", "owner field", "reset"] as const) {
  test(`a captured submit is obsolete after ${change} within the same actor`, async (t) => {
    const ui = await fixture(t); await fill(ui); const old = ui.form().props.onSubmit;
    if (change === "mode") await ui.click(/^Ссылка-приглашение$/u);
    else if (change === "identity") await ui.click(/^Логин$/u);
    else if (change === "owner field") await ui.change("ob-email", "next-synthetic-owner@example.invalid");
    else { await submit(ui); ui.take(credentialsRoute).reply(success()); await ui.flush(); await ui.click(/^Подключить ещё одну$/u); }
    const count = ui.requests.length, writes = ui.writes();
    old(submitEvent()); await ui.flush();
    assert.equal(ui.requests.length, count); assert.equal(ui.writes(), writes);
  });
}

test("captured owner/password inputs cannot mutate a later identity form in the same actor lifetime", async (t) => {
  const ui = await fixture(t); await fill(ui);
  const owner = ui.field("ob-email").props.onChange, secret = ui.field("ob-password").props.onChange;
  await ui.click(/^Логин$/u); const writes = ui.writes();
  owner({ target: { value: "obsolete-synthetic-owner@example.invalid" } });
  secret({ target: { value: "obsolete-synthetic-password" } }); await ui.flush();
  assert.equal(ui.writes(), writes);
  assert.equal(ui.field("ob-password").props.value, "");
});

test("same-actor success/reset permits fresh typing and another authorized save while retiring old form inputs", async (t) => {
  const ui = await fixture(t); await fill(ui);
  const oldOwner = ui.field("ob-email").props.onChange, oldPassword = ui.field("ob-password").props.onChange;
  await submit(ui); ui.take(credentialsRoute).reply(success()); await ui.flush();
  const resultWrites = ui.writes(), resultText = ui.text();
  oldOwner({ target: { value: "obsolete-synthetic-owner@example.invalid" } });
  oldPassword({ target: { value: "obsolete-synthetic-password" } }); await ui.flush();
  assert.equal(ui.writes(), resultWrites, "Authorized success must retire the old input callbacks");
  assert.equal(ui.text(), resultText);

  await ui.click(/^Подключить ещё одну$/u);
  assert.equal(ui.field("ob-email").props.value, "");
  assert.equal(ui.field("ob-password").props.value, "");
  const nextOwner = "next-synthetic-owner@example.invalid", nextPassword = "synthetic-next-password-42";
  await ui.change("ob-name", "Synthetic second clinic");
  await ui.change("ob-vertical", "dental");
  await ui.change("ob-email", nextOwner);
  await ui.change("ob-owner", "Synthetic next owner");
  await ui.change("ob-tz", "Asia/Qyzylorda");
  await ui.change("ob-password", nextPassword);
  const draftWrites = ui.writes();
  oldOwner({ target: { value: ownerEmail } });
  oldPassword({ target: { value: password } }); await ui.flush();
  assert.equal(ui.writes(), draftWrites, "The old form cannot overwrite a freshly typed same-actor draft");
  assert.equal(ui.field("ob-email").props.value, nextOwner);
  assert.equal(ui.field("ob-password").props.value, nextPassword);

  await submit(ui); const request = ui.take(credentialsRoute);
  assert.equal(request.actor, A); assert.equal(request.authorization, `Bearer synthetic-token-${A}`);
  assert.deepEqual(request.body, {
    name: "Synthetic second clinic", vertical: "dental", ownerEmail: nextOwner,
    ownerName: "Synthetic next owner", timeZone: "Asia/Qyzylorda", purpose: "clinic_services", password: nextPassword,
  });
  const response = success();
  Object.assign(response.data, { name: "Synthetic second clinic", vertical: "dental", ownerEmail: nextOwner, ownerLogin: nextOwner, timeZone: "Asia/Qyzylorda" });
  request.reply(response); await ui.flush();
  assert.match(ui.text(), /Synthetic second clinic/u);
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === nextPassword));
  assert.ok(!ui.nodes().some((node) => node.type === "code" && content(node) === password));
  assert.equal(ui.requests.length, 2); assert.equal(ui.lateWrites(), 0);
});

test("two synchronous calls to the current submit handler create only one request", async (t) => {
  const ui = await fixture(t); await fill(ui); const handler = ui.form().props.onSubmit;
  handler(submitEvent()); handler(submitEvent()); await ui.flush();
  assert.equal(ui.requests.length, 1, "A synchronous mutex must precede the first await/render");
});

test("an actor change while the API checks the original session blocks HTTP and all late setters", async (t) => {
  const ui = await fixture(t); await fill(ui); const held = ui.holdNextSession();
  ui.form().props.onSubmit(submitEvent()); await ui.flush(); assert.equal(ui.requests.length, 0);
  await ui.changeActor(B); const writes = ui.writes();
  held.release(A); await ui.flush();
  assert.equal(ui.requests.length, 0); assert.equal(ui.writes(), writes, "A transport rejection is not permission for the old screen's catch/finally to run");
});

for (const mode of ["email", "invite", "reissue"] as const) {
  test(`a late ${mode} JSON body cannot publish result or catch/finally state after A/B/A`, async (t) => {
    const ui = mode === "reissue" ? await reissueReady(t) : await fixture(t);
    if (mode === "reissue") await ui.click(/^Перевыпустить приглашение$/u);
    else { await fill(ui, mode); await submit(ui); }
    const request = ui.take(mode === "reissue" ? reissueRoute : mode === "invite" ? inviteRoute : credentialsRoute);
    const body = request.holdJson(success(mode === "email" ? "email" : "invite", mode === "reissue"));
    await ui.flush(); assert.equal(body.locked(), true, "The actual native JSON reader must already be awaiting body bytes");
    await leave(ui, "A/B/A"); const writes = ui.writes(), count = ui.requests.length, before = ui.text();
    body.release(); await ui.flush();
    assert.equal(ui.writes(), writes, "No late result, shown password, error, or finally setter");
    assert.equal(ui.requests.length, count); assert.equal(ui.text(), before);
  });
}

test("a lost response after navigation cannot set an old onboarding error/finally state", async (t) => {
  const ui = await fixture(t); await fill(ui); await submit(ui); const request = ui.take(credentialsRoute);
  await leave(ui, "unmount"); const writes = ui.writes(); request.lose(); await ui.flush();
  assert.equal(ui.writes(), writes);
});

test("copy session verification must finish under the original lifetime before writing clipboard", async (t) => {
  const ui = await completed(t); const held = ui.holdNextSession();
  ui.button(/^Скопировать$/u).props.onClick(); await ui.flush();
  await leave(ui, "A/B/A"); held.release(A); await ui.flush();
  assert.equal(ui.clipboard.length, 0, "Clipboard is an external side effect and needs its own pre-write actor verification");
});

test("clipboard settlement after unmount cannot set copied state or schedule a new timer", async (t) => {
  const ui = await completed(t); await ui.click(/^Скопировать$/u); assert.equal(ui.clipboard.length, 1);
  await leave(ui, "unmount"); const writes = ui.writes(), timers = ui.timers.length;
  ui.clipboard[0].resolve(); await ui.flush();
  assert.equal(ui.writes(), writes); assert.equal(ui.timers.length, timers);
});

test("copy timer is cancelled on unmount and an already queued timer callback stays silent", async (t) => {
  const ui = await completed(t); await ui.click(/^Скопировать$/u); ui.clipboard[0].resolve(); await ui.flush();
  const timer = ui.timers.find((item) => item.active); assert.ok(timer);
  await leave(ui, "unmount"); const writes = ui.writes();
  assert.equal(timer.active, false, "Unmount must cancel the copy-feedback timeout");
  timer.callback(); await ui.flush(); assert.equal(ui.writes(), writes);
});

test("authorized explicit duplicate confirmation preserves the invitation intent", async (t) => {
  const ui = await fixture(t); await fill(ui, "invite"); await submit(ui);
  ui.take(inviteRoute).reply({ success: false, code: "owner_already_has_workspace", error: "Synthetic existing owner workspace" }, 409);
  await ui.flush(); await ui.click(/^Да, создать вторую клинику этой почте$/u);
  const request = ui.take(inviteRoute);
  assert.equal(request.actor, A); assert.equal(request.body.confirmAdditionalWorkspace, true);
  assert.equal(request.body.ownerEmail, ownerEmail); assert.equal(request.body.password, undefined);
  request.reply(success("invite")); await ui.flush(); assert.match(ui.text(), /Synthetic onboarding clinic/u);
});

test("an old explicit duplicate confirmation cannot create another owner's workspace after A/B/A", async (t) => {
  const ui = await fixture(t); await fill(ui, "invite"); await submit(ui);
  ui.take(inviteRoute).reply({ success: false, code: "owner_already_has_workspace", error: "Synthetic existing owner workspace" }, 409);
  await ui.flush(); const confirm = ui.button(/^Да, создать вторую клинику этой почте$/u).props.onClick;
  await leave(ui, "A/B/A"); const count = ui.requests.length, writes = ui.writes();
  confirm(); await ui.flush(); assert.equal(ui.requests.length, count); assert.equal(ui.writes(), writes);
});

test("authorized invitation copy uses the synthetic link, but a captured copy is obsolete after reset", async (t) => {
  const ui = await completed(t, "invite"); const copy = ui.button(/^Скопировать$/u).props.onClick;
  copy(); await ui.flush(); assert.equal(ui.clipboard.length, 1);
  assert.equal(ui.clipboard[0].value, `${origin}/join/synthetic-invitation`);
  ui.clipboard[0].resolve(); await ui.flush(); await ui.click(/^Подключить ещё одну$/u);
  const writes = ui.writes(); copy(); await ui.flush();
  assert.equal(ui.clipboard.length, 1, "Reset retires the old invitation link callback");
  assert.equal(ui.writes(), writes);
});

test("clipboard verification detects a changed SDK session without relying on an auth event", async (t) => {
  const ui = await completed(t); ui.replaceSdkSession(B);
  await ui.click(/^Скопировать$/u);
  assert.equal(ui.clipboard.length, 0, "The fake SDK returns B; the real API must verify before any clipboard side effect");
});

function assertRetiredByApp(ui: UI, previousKey: unknown, nextActor: string | null) {
  assert.equal(ui.sdkAuthEvents(), 0, "No fake SDK auth notification may drive this reset");
  assert.equal(ui.hasOnboarding(), false, "The actual App must deselect Onboarding, not merely disable its callbacks");
  assert.equal(ui.nodes().length, 0, "The old credentials/form must be unmounted");
  assert.equal(ui.text(), "");
  assert.doesNotMatch(ui.appText(), /Synthetic onboarding clinic|synthetic-owner@example\.invalid|synthetic-password-42/u);
  if (nextActor === null) {
    assert.ok(!ui.appNodes().some((node) => node.type === "main"), "An unusable SDK session must leave App's authenticated shell");
  } else {
    assert.ok(ui.appNodes().some((node) => node.type === "main"));
    assert.notEqual(ui.mainKey(), previousKey, "The actual App actor-epoch key must advance");
    assert.ok(ui.appText().includes(`synthetic-actor-${nextActor}@example.invalid`), "App must receive the SDK identity through the real central API subscriber");
  }
  assert.equal(ui.lateWrites(), 0);
}

test("silent SDK mismatch during clipboard verification removes A credentials and gives B a fresh actual App screen", async (t) => {
  const ui = await completed(t);
  const oldCopy = ui.button(/^Скопировать$/u).props.onClick, previousKey = ui.mainKey();
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
  ui.replaceSdkSession(B);
  oldCopy(); await ui.flush();
  assert.equal(ui.clipboard.length, 0); assertRetiredByApp(ui, previousKey, B);

  await ui.navigate(/^Подключить клинику$/u);
  assert.equal(ui.field("ob-email").props.value, "");
  assert.equal(ui.field("ob-password").props.value, "");
  const writes = ui.writes(), count = ui.requests.length;
  oldCopy(); await ui.flush();
  assert.equal(ui.clipboard.length, 0); assert.equal(ui.writes(), writes); assert.equal(ui.requests.length, count);
  await fill(ui, "login");
  const nextPassword = "synthetic-b-password-43";
  await ui.change("ob-password", nextPassword); await submit(ui);
  const request = ui.take(credentialsRoute);
  assert.equal(request.actor, B); assert.equal(request.authorization, `Bearer synthetic-token-${B}`);
  assert.equal(request.body.password, nextPassword);
  request.reply(success("login")); await ui.flush();
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === nextPassword));
  assert.ok(!ui.nodes().some((node) => node.type === "code" && content(node) === password));
  assert.equal(ui.sdkAuthEvents(), 0);
});

test("silent SDK mismatch during reissue removes the original recovery form and retires its workspace callback", async (t) => {
  const ui = await reissueReady(t), previousKey = ui.mainKey();
  const oldReissue = ui.button(/^Перевыпустить приглашение$/u).props.onClick;
  assert.equal(ui.field("ob-email").props.value, ownerEmail);
  ui.replaceSdkSession(B);
  oldReissue(); await ui.flush();
  assert.equal(ui.requests.filter((request) => request.url.pathname === reissueRoute).length, 0);
  assertRetiredByApp(ui, previousKey, B);
  await ui.navigate(/^Подключить клинику$/u);
  assert.equal(ui.field("ob-email").props.value, ""); assert.equal(ui.field("ob-password").props.value, "");
  const count = ui.requests.length, writes = ui.writes();
  oldReissue(); await ui.flush();
  assert.equal(ui.requests.length, count); assert.equal(ui.writes(), writes);
  assert.ok(!ui.nodes().some((node) => node.type === "button" && /Перевыпустить приглашение/u.test(content(node))));
});

for (const delivery of ["headers", "body"] as const) {
  test(`silent SDK mismatch at pending create ${delivery} unmounts A's form instead of publishing its late result`, async (t) => {
    const ui = await fixture(t); await fill(ui);
    const oldSubmit = ui.form().props.onSubmit, previousKey = ui.mainKey();
    await submit(ui); const request = ui.take(credentialsRoute);
    const held = delivery === "body" ? request.holdJson(success()) : null;
    await ui.flush();
    if (held) assert.equal(held.locked(), true, "The real Response.json decoder must be awaiting the held bytes");
    const writes = ui.writes();
    ui.replaceSdkSession(B);
    if (held) held.release(); else request.reply(success());
    await ui.flush();
    assertRetiredByApp(ui, previousKey, B);
    assert.equal(ui.writes(), writes, "The retired request must not publish password, result, error or finally state");
    assert.equal(ui.requests.length, 1); assert.equal(ui.clipboard.length, 0);
    await ui.navigate(/^Подключить клинику$/u);
    assert.equal(ui.field("ob-email").props.value, ""); assert.equal(ui.field("ob-password").props.value, "");
    oldSubmit(submitEvent()); await ui.flush();
    assert.equal(ui.requests.length, 1, "The old A form must stay retired inside B's remounted view");
  });
}

test("silent SDK A/B/A discoveries remount App twice and cannot reactivate A's original credential copy", async (t) => {
  const ui = await completed(t), firstKey = ui.mainKey();
  const oldCopy = ui.button(/^Скопировать$/u).props.onClick;
  ui.replaceSdkSession(B); oldCopy(); await ui.flush();
  assertRetiredByApp(ui, firstKey, B);
  await ui.navigate(/^Подключить клинику$/u); await fill(ui);
  const secondKey = ui.mainKey(), requests = ui.requests.length;
  ui.replaceSdkSession(A); await submit(ui);
  assertRetiredByApp(ui, secondKey, A);
  assert.notEqual(ui.mainKey(), firstKey, "Returning to A must not reuse the original App epoch");
  oldCopy(); await ui.flush();
  assert.equal(ui.clipboard.length, 0); assert.equal(ui.requests.length, requests);
  await ui.navigate(/^Подключить клинику$/u);
  assert.equal(ui.field("ob-email").props.value, ""); assert.equal(ui.field("ob-password").props.value, "");
});

for (const failure of ["SDK error result", "SDK rejection", "missing token", "null session"] as const) {
  test(`${failure} discovered during clipboard verification removes old credentials from actual App without an auth event`, async (t) => {
    const ui = await completed(t), previousKey = ui.mainKey();
    const oldCopy = ui.button(/^Скопировать$/u).props.onClick, held = ui.holdNextSession();
    oldCopy(); await ui.flush();
    assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
    if (failure === "SDK rejection") held.reject();
    else held.releaseResult({
      data: { session: failure === "null session" ? null : {
        user: { id: A, email: `synthetic-actor-${A}@example.invalid` },
        access_token: failure === "missing token" ? "" : `synthetic-token-${A}`,
      } },
      error: failure === "SDK error result" ? new Error("Synthetic SDK reported failure") : null,
    });
    await ui.flush(); assertRetiredByApp(ui, previousKey, null);
    const writes = ui.writes(); oldCopy(); await ui.flush();
    assert.equal(ui.writes(), writes); assert.equal(ui.clipboard.length, 0); assert.equal(ui.requests.length, 1);
  });
}

test("same-actor SDK token refresh without an auth event preserves the result screen and allows verified clipboard copy", async (t) => {
  const ui = await completed(t), previousKey = ui.mainKey(), mounts = ui.screenMounts();
  const copy = ui.button(/^Скопировать$/u).props.onClick;
  ui.refreshSdkToken(); copy(); await ui.flush();
  assert.equal(ui.clipboard.length, 1); assert.equal(ui.clipboard[0].value, password);
  assert.equal(ui.hasOnboarding(), true); assert.equal(ui.mainKey(), previousKey); assert.equal(ui.screenMounts(), mounts);
  ui.clipboard[0].resolve(); await ui.flush();
  assert.match(ui.text(), /Скопировано/u);
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
  assert.equal(ui.sdkAuthEvents(), 0); assert.equal(ui.lateWrites(), 0);
});

test("same-actor SDK token refresh keeps the current draft callback valid and authorizes its save with the new token", async (t) => {
  const ui = await fixture(t); await fill(ui);
  const submitCurrent = ui.form().props.onSubmit, previousKey = ui.mainKey(), mounts = ui.screenMounts();
  const refreshedToken = ui.refreshSdkToken(); submitCurrent(submitEvent()); await ui.flush();
  const request = ui.take(credentialsRoute);
  assert.equal(request.authorization, `Bearer ${refreshedToken}`); assert.equal(request.body.password, password);
  const held = request.holdJson(success()); await ui.flush(); assert.equal(held.locked(), true);
  ui.refreshSdkToken(); held.release(); await ui.flush();
  assert.equal(ui.mainKey(), previousKey); assert.equal(ui.screenMounts(), mounts); assert.equal(ui.hasOnboarding(), true);
  assert.ok(ui.nodes().some((node) => node.type === "code" && content(node) === password));
  assert.equal(ui.sdkAuthEvents(), 0); assert.equal(ui.lateWrites(), 0);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} headers immediately hide owner/password form without awaiting the body`, async (t) => {
    const ui = await fixture(t); await fill(ui); await submit(ui);
    const body = ui.take(credentialsRoute).holdJson({ success: false, error: "Synthetic access denial" }, status);
    await ui.flush();
    assert.equal(ui.nodes().some((node) => node.type === "form"), false, "Denied credentials must disappear before a body can be parsed");
    assert.equal(ui.nodes().some((node) => node.props.id === "ob-password" || node.props.id === "ob-email"), false);
    assert.doesNotMatch(ui.text(), /Synthetic onboarding clinic|synthetic-password-42/u);
    assert.equal(body.locked(), false, "Do not wait for an untrusted authorization-refusal body");
  });

  test(`reissue HTTP ${status} headers hide owner form immediately without reading the body`, async (t) => {
    const ui = await reissueReady(t); await ui.click(/^Перевыпустить приглашение$/u);
    const body = ui.take(reissueRoute).holdJson({ success: false, error: "Synthetic reissue access denial" }, status);
    await ui.flush();
    assert.equal(ui.nodes().some((node) => node.type === "form"), false);
    assert.equal(ui.nodes().some((node) => node.props.id === "ob-email"), false);
    assert.equal(body.locked(), false);
  });
}

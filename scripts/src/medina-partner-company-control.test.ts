import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the actual screen and portable parsers. Only hook scheduling, Control
// access/HTTP, and browser storage/events are doubled; no DOM or network is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screenPath = path.join(root, "artifacts/medina-control/src/screens/PartnerCompanies.tsx");
const contractsPath = path.join(root, "lib/crm/partner-company-contracts.ts");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const endpoint = "/api/crm/platform-partner-companies";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actorA = uuid(1), actorB = uuid(2);
const storageKey = (actor = actorA) => `medina-control:partner-company-review:v1:${encodeURIComponent(actor)}`;
type Command = { requestId: string; applicationId: string; revision: string; action: "approve" | "reject" };
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Effect = () => void | (() => void);
type Dependencies = readonly unknown[] | undefined;
type Slot = { kind: "state"; value: unknown; set(value: unknown): void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "effect"; create: Effect; deps: Dependencies; pending: boolean; cleanup?: () => void };
type Access = { actorId: string; isCurrent(): boolean };
type RequestInitDouble = { method?: string; body?: string; signal?: { aborted: boolean } };
type ResponseDouble = { status: number; ok: boolean; json(): Promise<unknown> };
type Request = {
  kind: "list" | "read" | "review" | "close";
  url: URL; init: RequestInitDouble; scope: Access; body: Record<string, unknown> | undefined;
  storageAtDispatch: [string, string][]; claimed: boolean; settled: boolean;
  reply(data: unknown, status?: number): void;
  jsonLater(body: Promise<unknown>): void;
  badJson(): void;
  lose(): void;
};
const jsx = (type: unknown, props: Props): Element => ({ type, props });
function elements(child: Child): Element[] {
  return Array.isArray(child) ? child.flatMap(elements)
    : child !== null && typeof child === "object" ? [child, ...elements(child.props.children)] : [];
}
function content(child: Child): string {
  return Array.isArray(child) ? child.map(content).join("")
    : child !== null && typeof child === "object" ? content(child.props.children)
      : typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0, dirty = true, mounted = true, lateWrites = 0;
  let tree: Child, component: () => Child, hookCount: number | undefined;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    const index = cursor++;
    slots[index] ??= create();
    assert.equal(slots[index].kind, kind, "The real screen must keep hook order stable");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", () => {
        const current: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
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
    useEffect(create: Effect, deps?: Dependencies) {
      const effect = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!deps || !effect.deps || deps.length !== effect.deps.length || deps.some((value, i) => !Object.is(value, effect.deps![i]))) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
  };
  return {
    hooks,
    mount(value: () => Child) { component = value; },
    async flush() {
      for (let i = 0; i < 100; i++) {
        if (mounted && dirty) {
          dirty = false; cursor = 0; tree = component();
          hookCount ??= cursor; assert.equal(cursor, hookCount, "No conditional hooks");
          const pending = slots.filter((s): s is Extract<Slot, { kind: "effect" }> => s.kind === "effect" && s.pending);
          for (const effect of pending) effect.cleanup?.();
          for (const effect of pending) { effect.pending = false; effect.cleanup = effect.create() || undefined; }
        }
        await Promise.resolve();
      }
      if (mounted) assert.equal(dirty, false, "Screen must quiesce without timers");
    },
    nodes: () => elements(tree), text: () => content(tree), lateWrites: () => lateWrites,
    dispose() { if (mounted) { mounted = false; for (const s of slots) if (s.kind === "effect") s.cleanup?.(); } },
  };
}
function memoryStorage() {
  const values = new Map<string, string>(), reads: string[] = [], writes: [string, string][] = [], removals: string[] = [];
  const fail = { get: false, set: false, remove: false };
  return {
    values, reads, writes, removals, fail,
    getItem(key: string) { reads.push(key); if (fail.get) throw Error("Synthetic storage read failure"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (fail.set) throw Error("Synthetic storage write failure"); writes.push([key, value]); values.set(key, value); },
    removeItem(key: string) { if (fail.remove) throw Error("Synthetic storage remove failure"); removals.push(key); values.delete(key); },
    snapshot: () => [...values.entries()],
  };
}
function application(n = 22, name = "Synthetic Company Alpha") {
  return { id: uuid(n), revision: uuid(n + 100), state: "pending",
    company: { name, purpose: "marketing", vertical: null, timeZone: "Asia/Qyzylorda", ownerName: "Synthetic Private Owner" },
    workspaceId: null, sourceState: "captured", expiresAt: "2026-12-01T12:00:00Z", submittedAt: "2026-10-01T12:00:00Z", reviewedAt: null };
}
const applications = [application(), application(21, "Synthetic Company Beta")];
const fullPage = () => Array.from({ length: 20 }, (_, i) => application(80 - i, `Synthetic Company ${80 - i}`));
const original: Command = { requestId: uuid(700), applicationId: applications[0].id, revision: applications[0].revision, action: "approve" };
function receipt(command: Command, state: "unconfirmed" | "abandoned" | "committed") {
  return state === "committed" ? { ...command, state, application: {
    ...applications[0], id: command.applicationId, revision: uuid(501), state: command.action === "approve" ? "approved" : "rejected",
    workspaceId: command.action === "approve" ? uuid(601) : null,
    sourceState: command.action === "approve" ? "pending_payment" : "captured", reviewedAt: "2026-10-28T12:00:00Z",
  } } : { ...command, state };
}
const compiled = new Map<string, string>();
function compile(filename: string) {
  let output = compiled.get(filename);
  if (output === undefined) {
    const result = ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    output = result.outputText; compiled.set(filename, output);
  }
  return output;
}
function fixture(t: TestContext, storage = memoryStorage()) {
  const driver = hookDriver(), requests: Request[] = [], listeners = new Set<() => void>();
  const events = new Map<string, Set<() => void>>();
  let actorId = actorA, sessionEpoch = 1, captures = 0;
  const api = {
    captureControlAccess() { captures++; const actor = actorId, epoch = sessionEpoch; return { actorId: actor, isCurrent: () => actorId === actor && sessionEpoch === epoch }; },
    subscribeControlActor(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    controlFetch(input: string, init: RequestInitDouble = {}, scope: Access) {
      assert.equal(scope.isCurrent(), true, "Dispatch requires the real screen's current scope");
      assert.equal(scope.actorId, actorId, "Dispatch cannot borrow the new account");
      const url = new URL(input, "https://synthetic-control.invalid");
      assert.equal(url.origin, "https://synthetic-control.invalid"); assert.equal(url.pathname, endpoint);
      assert.ok(["GET", "POST"].includes(init.method ?? "GET"));
      const pending = deferred<ResponseDouble>(), body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
      const deliver = (json: () => Promise<unknown>, status = 200) => {
        assert.equal(request.settled, false); request.settled = true;
        pending.resolve({ status, ok: status >= 200 && status < 300, json });
      };
      const request: Request = {
        kind: init.method === "POST" ? body?.operation === "close" ? "close" : "review" : url.searchParams.has("requestId") ? "read" : "list",
        url, init, scope, body, storageAtDispatch: storage.snapshot(), claimed: false, settled: false,
        reply(data, status = 200) { deliver(async () => ({ success: true, data }), status); },
        jsonLater(body) { deliver(() => body); },
        badJson() { deliver(async () => { throw new SyntaxError("Synthetic invalid JSON"); }); },
        lose() { assert.equal(request.settled, false); request.settled = true; pending.reject(Error("Synthetic lost response")); },
      };
      requests.push(request);
      // Deliberately ignore abort and session changes here, including in json().
      // Late-result rejection must come from the actual component, not the double.
      return pending.promise;
    },
  };
  const browserEvents = {
    addEventListener(name: string, listener: () => void) { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(listener); },
    removeEventListener(name: string, listener: () => void) { events.get(name)?.delete(listener); },
  };
  const cache = new Map<string, Record<string, unknown>>();
  function load(filename: string): Record<string, unknown> {
    assert.ok([screenPath, contractsPath].includes(filename), `Only actual screen/contracts may load: ${filename}`);
    if (cache.has(filename)) return cache.get(filename)!;
    const exports: Record<string, unknown> = {}; cache.set(filename, exports);
    new Script(compile(filename), { filename }).runInNewContext({ exports, module: { exports }, URLSearchParams, AbortController,
      crypto: { randomUUID }, window: { ...browserEvents, sessionStorage: storage }, document: { ...browserEvents, visibilityState: "visible" },
      require(name: string) {
        if (name === "react") return driver.hooks;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "../lib/api") return api;
        if (name === "./partner-companies.css") return {};
        if (name === "../../../../lib/crm/partner-company-contracts") return load(contractsPath);
        return assert.fail(`Unexpected dependency: ${name}`);
      },
    });
    return exports;
  }
  driver.mount(load(screenPath).PartnerCompanies as () => Child);
  t.after(async () => {
    driver.dispose();
    for (const request of requests) if (!request.settled) request.lose();
    await driver.flush();
    assert.equal(driver.lateWrites(), 0, "No state updates after unmount");
    assert.equal(listeners.size, 0); assert.equal([...events.values()].every(set => set.size === 0), true);
  });
  function take(kind: Request["kind"]) {
    const request = requests.find(r => r.kind === kind && !r.claimed);
    assert.ok(request, `Expected ${kind} request`); request.claimed = true; return request;
  }
  function button(label: string, source = driver.nodes()) {
    const found = source.find(n => n.type === "button" && (n.props["aria-label"] === label || content(n) === label));
    assert.ok(found, `Expected button ${label}; actual screen: ${driver.text()}`); return found;
  }
  function callback(node: Element, event = "onClick") {
    const fn = node.props[event]; assert.equal(typeof fn, "function", `Expected actual ${event} callback`);
    return fn as (event?: unknown) => void;
  }
  function click(label: string) { const node = button(label); assert.notEqual(node.props.disabled, true, `Button ${label} must be enabled`); callback(node)(); }
  function section(label: string) {
    const found = driver.nodes().find(n => n.type === "section" && n.props["aria-label"] === label);
    assert.ok(found, `Expected section ${label}`); return found;
  }
  function checkbox(source: Element, checked = true) {
    const found = elements(source).find(n => n.type === "input" && n.props.type === "checkbox");
    assert.ok(found); assert.notEqual(found.props.disabled, true); callback(found, "onChange")({ target: { checked } });
  }
  function row(index = 0) {
    const rows = driver.nodes().filter(n => n.type === "button" && String(n.props.className).split(" ").includes("pc-row"));
    assert.ok(rows[index], `Expected row ${index}`); return rows[index];
  }
  async function filter(value: string) {
    const select = driver.nodes().find(n => n.type === "select"); assert.ok(select);
    callback(select, "onChange")({ target: { value } }); await driver.flush();
  }
  function replyList(request: Request, items = applications, hasMore = false) {
    request.reply({ items, hasMore, offset: Number(request.url.searchParams.get("offset")), state: request.url.searchParams.get("state") });
  }
  async function ready(items = applications, hasMore = false) { await driver.flush(); replyList(take("list"), items, hasMore); await driver.flush(); }
  async function decide(action: Command["action"] = "approve", index = 0) {
    callback(row(index))(); await driver.flush(); click(action === "approve" ? "Одобрить" : "Отклонить"); await driver.flush();
    const dialog = driver.nodes().find(n => n.type === "dialog"); assert.ok(dialog); checkbox(dialog); await driver.flush();
    click(action === "approve" ? "Создать новое пространство" : "Отклонить заявку"); await driver.flush();
    const request = take("review"); assert.equal(request.body?.action, action);
    return { request, command: request.body as Command };
  }
  async function read(command: Command, state: "unconfirmed" | "abandoned" | "committed" = "unconfirmed") {
    click("Проверить результат"); await driver.flush(); const request = take("read");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), command, "Read must contain every original metadata field, and nothing else");
    assert.equal(request.init.body, undefined); request.reply(receipt(command, state)); await driver.flush(); return request;
  }
  return { ...driver, requests, storage, take, button, callback, click, section, checkbox, row, filter, replyList, ready, decide, read,
    writes: () => requests.filter(r => r.kind === "review" || r.kind === "close"), captures: () => captures,
    event(name: string) { for (const listener of [...events.get(name) ?? []]) listener(); },
    switchActor(next: string) { actorId = next; sessionEpoch++; for (const listener of [...listeners]) listener(); },
  };
}

test("Control company list uses pending/approved/rejected, omits all state, and pages in twenties", async t => {
  const h = fixture(t); await h.flush();
  const initial = h.take("list"); assert.deepEqual(Object.fromEntries(initial.url.searchParams), { offset: "0", state: "pending" });
  h.replyList(initial); await h.flush();
  for (const state of ["approved", "rejected", "all"]) {
    await h.filter(state); const request = h.take("list");
    assert.deepEqual(Object.fromEntries(request.url.searchParams), state === "all" ? { offset: "0" } : { offset: "0", state });
    h.replyList(request, state === "all" ? fullPage() : [], state === "all"); await h.flush();
  }
  h.click("Следующая страница"); await h.flush(); const next = h.take("list");
  assert.deepEqual(Object.fromEntries(next.url.searchParams), { offset: "20" }); h.replyList(next, []); await h.flush();
  h.click("Предыдущая страница"); await h.flush(); const previous = h.take("list");
  assert.deepEqual(Object.fromEntries(previous.url.searchParams), { offset: "0" }); h.replyList(previous, fullPage(), true); await h.flush();
  h.click("Следующая страница"); await h.flush(); h.replyList(h.take("list"), []); await h.flush();
  await h.filter("pending"); assert.deepEqual(Object.fromEntries(h.take("list").url.searchParams), { offset: "0", state: "pending" });
});

test("late list JSON and retired row callbacks cannot restore a previous page", async t => {
  const h = fixture(t); await h.flush(); const old = h.take("list"), body = deferred<unknown>();
  old.jsonLater(body.promise); await h.flush(); await h.filter("all");
  h.replyList(h.take("list"), [application(30, "Synthetic Current Company")]); await h.flush(); const oldRow = h.callback(h.row());
  body.resolve({ success: true, data: { items: applications, offset: 0, state: "pending", hasMore: false } }); await h.flush();
  assert.equal(old.scope.isCurrent(), false); assert.equal(h.text().includes(applications[0].company.name), false);
  await h.filter("pending"); h.replyList(h.take("list")); await h.flush(); oldRow(); await h.flush();
  assert.equal(h.nodes().some(n => n.props["aria-label"] === "Выбранная заявка"), false); assert.equal(h.writes().length, 0);
});

test("confirmation requires acceptance and row A/B/A cannot revive old decision callbacks", async t => {
  const h = fixture(t); await h.ready(); h.callback(h.row())(); await h.flush(); const oldOpen = h.callback(h.button("Одобрить"));
  oldOpen(); await h.flush(); const oldConfirm = h.callback(h.button("Создать новое пространство"));
  assert.equal(h.button("Создать новое пространство").props.disabled, true); oldConfirm(); await h.flush(); assert.equal(h.writes().length, 0);
  const oldDialog = h.nodes().find(n => n.type === "dialog")!; h.checkbox(oldDialog); await h.flush(); h.click("Отмена"); await h.flush();
  h.callback(h.row(1))(); await h.flush(); oldOpen(); oldConfirm(); await h.flush(); assert.equal(h.writes().length, 0);
  h.callback(h.row())(); await h.flush(); h.click("Одобрить"); await h.flush();
  h.checkbox(h.nodes().find(n => n.type === "dialog")!); await h.flush(); oldConfirm(); await h.flush();
  assert.equal(h.writes().length, 0, "Same row ID does not revive its retired selection");
  h.click("Создать новое пространство"); await h.flush(); assert.equal(h.take("review").body?.applicationId, applications[0].id);
});

for (const change of ["refresh", "filter ABA", "next page"] as const) {
  test(`accepted confirmation is retired by ${change}, including a changed application revision`, async t => {
    const h = fixture(t); await h.ready(fullPage(), true); h.callback(h.row())(); await h.flush(); h.click("Одобрить"); await h.flush();
    h.checkbox(h.nodes().find(n => n.type === "dialog")!); await h.flush(); const stale = h.callback(h.button("Создать новое пространство"));
    if (change === "refresh") h.event("focus");
    else if (change === "next page") h.click("Следующая страница");
    else { await h.filter("all"); h.replyList(h.take("list"), []); await h.flush(); await h.filter("pending"); }
    await h.flush(); stale(); await h.flush(); assert.equal(h.writes().length, 0);
    const changed = { ...application(80), revision: uuid(888) };
    h.replyList(h.take("list"), [changed]); await h.flush(); stale(); await h.flush(); assert.equal(h.writes().length, 0);
    const fresh = await h.decide(); assert.equal(fresh.command.revision, changed.revision);
  });
}

test("unknown review persists original metadata only before dispatch and blocks another decision", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide();
  assert.equal(command.applicationId, applications[0].id); assert.equal(command.revision, applications[0].revision);
  const marker = h.storage.values.get(storageKey())!;
  assert.deepEqual(JSON.parse(marker), command); assert.deepEqual(Object.keys(JSON.parse(marker)).sort(), ["action", "applicationId", "requestId", "revision"]);
  assert.deepEqual(request.storageAtDispatch, [[storageKey(), marker]], "Recovery key must be durable before dispatch");
  request.lose(); await h.flush(); h.callback(h.row(1))(); await h.flush();
  assert.equal(h.button("Одобрить").props.disabled, true); assert.equal(h.button("Отклонить").props.disabled, true);
  h.callback(h.button("Одобрить"))(); await h.flush(); assert.equal(h.writes().length, 1);
  for (const [key, value] of h.storage.writes) {
    assert.equal(key, storageKey()); assert.deepEqual(JSON.parse(value), command);
    for (const pii of [applications[0].company.name, applications[0].company.ownerName, applications[0].company.timeZone, "owner@example.invalid"])
      assert.equal(value.includes(pii), false, "No company or owner details belong in recovery storage");
  }
});

test("rejection targets the selected second row and its revision, not the first application", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide("reject", 1);
  assert.equal(command.applicationId, applications[1].id); assert.equal(command.revision, applications[1].revision);
  assert.equal(command.action, "reject"); assert.equal(command.applicationId === applications[0].id, false);
  request.reply(receipt(command, "committed")); await h.flush();
  assert.equal(h.storage.values.has(storageKey()), false); assert.equal(h.requests.filter(r => r.kind === "list").length, 2);
});

test("retry requires an original unconfirmed GET, reuses exact bytes, and cannot survive row ABA", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); request.lose(); await h.flush();
  const premature = h.callback(h.button("Повторить исходную отправку")); premature(); await h.flush(); assert.equal(h.writes().length, 1);
  await h.read(command); const staleRetry = h.callback(h.button("Повторить исходную отправку"));
  staleRetry(); staleRetry(); await h.flush(); const retry = h.take("review");
  assert.equal(h.writes().length, 2, "Synchronous double click must not dispatch twice"); assert.equal(retry.init.body, request.init.body);
  retry.lose(); await h.flush(); await h.read(command);
  h.callback(h.row(1))(); await h.flush(); h.callback(h.row())(); await h.flush(); staleRetry(); await h.flush();
  assert.equal(h.writes().length, 2); assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Повторить исходную отправку"), false);
  await h.read(command); assert.equal(h.storage.values.get(storageKey()), JSON.stringify(command));
});

test("returning to the same page and application cannot revive a retry after its revision changes", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); request.lose(); await h.flush();
  await h.read(command); const staleRetry = h.callback(h.button("Повторить исходную отправку"));
  await h.filter("all"); h.replyList(h.take("list"), []); await h.flush();
  await h.filter("pending"); const changed = { ...applications[0], revision: uuid(888) };
  h.replyList(h.take("list"), [changed]); await h.flush(); h.callback(h.row())(); await h.flush();
  await h.read(command); staleRetry(); await h.flush(); assert.equal(h.writes().length, 1);
  assert.equal(h.button("Одобрить").props.disabled, true); assert.equal(h.storage.values.get(storageKey()), JSON.stringify(command));
  h.checkbox(h.section("Восстановление исходного решения")); await h.flush(); h.click("Закрыть отправку"); await h.flush();
  assert.deepEqual(h.take("close").body, { operation: "close", ...command }, "Close must not adopt the freshly listed revision");
});

test("restored metadata permits only read/close, never reconstructed write payloads", async t => {
  const storage = memoryStorage(); storage.values.set(storageKey(), JSON.stringify(original));
  const h = fixture(t, storage); await h.flush(); assert.equal(storage.reads.length, 0, "Do not read owner recovery storage before an authorized list");
  h.replyList(h.take("list")); await h.flush();
  assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Повторить исходную отправку"), false);
  await h.read(original); assert.equal(h.writes().length, 0);
  h.checkbox(h.section("Восстановление исходного решения")); await h.flush(); h.click("Закрыть отправку"); await h.flush();
  assert.deepEqual(h.take("close").body, { operation: "close", ...original });
});

for (const field of ["requestId", "applicationId", "revision", "action"] as const) {
  test(`read receipt cannot replace original ${field} in any outcome`, async t => {
    const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); request.lose(); await h.flush();
    const marker = h.storage.values.get(storageKey());
    for (const state of ["unconfirmed", "abandoned", "committed"] as const) {
      h.click("Проверить результат"); await h.flush(); const read = h.take("read");
      assert.deepEqual(Object.fromEntries(read.url.searchParams), command);
      read.reply({ ...receipt(command, state), [field]: field === "action" ? "reject" : uuid(999) }); await h.flush();
      assert.equal(h.storage.values.get(storageKey()), marker); assert.equal(h.storage.removals.length, 0);
      assert.equal(h.button("Повторить исходную отправку").props.disabled, true);
      assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Закрыть отправку"), false);
    }
    await h.read(command, "committed"); assert.equal(h.storage.values.has(storageKey()), false);
    assert.equal(h.requests.filter(r => r.kind === "list").length, 2, "Terminal receipt refreshes, not patches, the list");
  });
}

test("committed receipt must preserve original command revision and contain a new terminal application revision", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); request.lose(); await h.flush();
  const committed = receipt(command, "committed"); assert.ok("application" in committed);
  for (const invalid of [
    { ...committed, revision: committed.application.revision },
    { ...committed, application: { ...committed.application, revision: command.revision } },
    { ...committed, application: { ...committed.application, id: uuid(999) } },
    { ...committed, extra: "Synthetic private receipt detail" },
  ]) {
    h.click("Проверить результат"); await h.flush(); h.take("read").reply(invalid); await h.flush();
    assert.equal(h.storage.values.has(storageKey()), true); assert.equal(h.storage.removals.length, 0);
  }
  await h.read(command, "committed"); assert.equal(h.storage.values.has(storageKey()), false);
});

for (const terminal of ["abandoned", "committed"] as const) {
  test(`unknown close requires fresh read/acceptance, keeps original metadata, and handles ${terminal}`, async t => {
    const h = fixture(t); await h.ready(); const { request, command } = await h.decide();
    request.reply(receipt(command, "unconfirmed")); await h.flush();
    assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Закрыть отправку"), false, "POST unconfirmed is not an unconfirmed GET proof");
    await h.read(command); const staleClose = h.callback(h.button("Закрыть отправку")); staleClose(); await h.flush();
    assert.equal(h.writes().length, 1, "Close requires its own explicit acceptance");
    h.checkbox(h.section("Восстановление исходного решения")); await h.flush(); staleClose(); staleClose(); await h.flush();
    const lostClose = h.take("close"); assert.deepEqual(lostClose.body, { operation: "close", ...command }); assert.equal(h.writes().length, 2);
    lostClose.lose(); await h.flush(); staleClose(); await h.flush(); assert.equal(h.writes().length, 2, "A failed close retires the read proof and acceptance");
    h.callback(h.row(1))(); await h.flush(); h.click("Обновить список"); await h.flush(); h.replyList(h.take("list")); await h.flush();
    assert.equal(h.storage.values.has(storageKey()), true); await h.read(command);
    h.checkbox(h.section("Восстановление исходного решения")); await h.flush(); h.click("Закрыть отправку"); await h.flush();
    const close = h.take("close"); assert.deepEqual(close.body, lostClose.body); close.reply(receipt(command, terminal)); await h.flush();
    assert.equal(h.storage.values.has(storageKey()), false); assert.equal(h.storage.removals.length, 1);
    assert.equal(h.nodes().some(n => n.props["aria-label"] === "Восстановление исходного решения"), false);
  });
}

for (const outcome of ["lost close", "delayed unconfirmed close"] as const) {
  test(`${outcome} followed by an unconfirmed read cannot revive a retained write retry`, async t => {
    const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); request.lose(); await h.flush();
    await h.read(command); const retainedRetry = h.callback(h.button("Повторить исходную отправку"));
    h.checkbox(h.section("Восстановление исходного решения")); await h.flush(); h.click("Закрыть отправку"); await h.flush();
    const close = h.take("close"), body = deferred<unknown>();
    assert.deepEqual(close.body, { operation: "close", ...command });
    if (outcome === "lost close") close.lose();
    else {
      close.jsonLater(body.promise); await h.flush(); retainedRetry(); await h.flush();
      assert.equal(h.writes().length, 2, "The pending close owns the mutation lock");
      body.resolve({ success: true, data: receipt(command, "unconfirmed") });
    }
    await h.flush(); await h.read(command); retainedRetry(); await h.flush();
    assert.equal(h.requests.filter(r => r.kind === "review").length, 1, "A close permanently retires the original write capability");
    assert.equal(h.writes().length, 2); assert.equal(h.storage.values.get(storageKey()), JSON.stringify(command));
    assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Повторить исходную отправку"), false);
    assert.equal(h.button("Одобрить").props.disabled, true);
  });
}

for (const phase of ["response", "JSON body"] as const) {
  test(`original session cannot revive after account A/B/A with a late ${phase}`, async t => {
    const h = fixture(t); await h.ready(); const { request, command } = await h.decide();
    const body = deferred<unknown>();
    if (phase === "JSON body") { request.jsonLater(body.promise); await h.flush(); }
    const staleRead = h.callback(h.button("Проверить результат")), marker = h.storage.values.get(storageKey());
    h.storage.values.set(storageKey(actorB), "Synthetic B marker must remain untouched");
    h.switchActor(actorB); await h.flush(); h.switchActor(actorA); await h.flush(); staleRead(); await h.flush();
    assert.equal(request.scope.isCurrent(), false); assert.equal(request.init.signal?.aborted, true);
    if (phase === "response") request.reply(receipt(command, "committed"));
    else body.resolve({ success: true, data: receipt(command, "committed") });
    await h.flush(); assert.equal(h.captures(), 1); assert.equal(h.requests.length, 2);
    assert.equal(h.text().includes(applications[0].company.name), false); assert.equal(h.text().includes(applications[0].company.ownerName), false);
    assert.equal(h.storage.values.get(storageKey()), marker); assert.equal(h.storage.removals.length, 0);
    assert.equal(h.storage.values.get(storageKey(actorB)), "Synthetic B marker must remain untouched");
  });
}

test("unmount rejects late review JSON and retained callbacks without losing recovery metadata", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); const body = deferred<unknown>();
  request.jsonLater(body.promise); await h.flush(); const staleRead = h.callback(h.button("Проверить результат"));
  h.dispose(); body.resolve({ success: true, data: receipt(command, "committed") }); staleRead(); await h.flush();
  assert.equal(h.lateWrites(), 0); assert.equal(h.requests.length, 2); assert.equal(h.storage.values.has(storageKey()), true);
});

for (const status of [401, 403, 404]) {
  test(`list refusal ${status} never opens private recovery storage`, async t => {
    const h = fixture(t); await h.flush(); h.take("list").reply(null, status); await h.flush();
    assert.equal(h.storage.reads.length, 0); assert.equal(h.storage.writes.length, 0); assert.equal(h.writes().length, 0);
    assert.equal(h.nodes().some(n => n.type === "select"), false);
  });
}

for (const failure of ["read", "write", "invalid marker"] as const) {
  test(`recovery storage ${failure} failure blocks a fresh review`, async t => {
    const storage = memoryStorage();
    if (failure === "read") storage.fail.get = true;
    if (failure === "invalid marker") storage.values.set(storageKey(), JSON.stringify({ ...original, ownerName: "Synthetic private owner" }));
    const h = fixture(t, storage); await h.ready();
    if (failure === "write") {
      storage.fail.set = true; h.callback(h.row())(); await h.flush(); h.click("Одобрить"); await h.flush();
      h.checkbox(h.nodes().find(n => n.type === "dialog")!); await h.flush(); h.click("Создать новое пространство"); await h.flush();
    } else { h.callback(h.row())(); await h.flush(); }
    assert.equal(h.writes().length, 0); assert.equal(h.button("Одобрить").props.disabled, true);
    assert.equal(h.text().includes("Новые решения заблокированы"), true); assert.equal(storage.removals.length, 0);
  });
}

test("terminal receipt with failed marker cleanup discards retry capability until read recovery", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide(); h.storage.fail.remove = true;
  request.reply(receipt(command, "committed")); await h.flush();
  assert.equal(h.storage.values.has(storageKey()), true);
  assert.equal(h.nodes().some(n => n.type === "button" && content(n) === "Повторить исходную отправку"), false);
  assert.equal(h.button("Одобрить").props.disabled, true); h.storage.fail.remove = false;
  await h.read(command, "committed"); assert.equal(h.storage.values.has(storageKey()), false); assert.equal(h.writes().length, 1);
});

test("another stored operation is neither overwritten nor deleted by an original terminal receipt", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide();
  const foreign = JSON.stringify({ ...command, requestId: uuid(999) }); h.storage.values.set(storageKey(), foreign);
  request.reply(receipt(command, "committed")); await h.flush();
  assert.equal(h.storage.values.get(storageKey()), foreign); assert.equal(h.storage.removals.length, 0);
  assert.equal(h.button("Одобрить").props.disabled, true); assert.equal(h.writes().length, 1);
});

test("malformed or failed review responses keep the recovery marker and decision lock", async t => {
  const h = fixture(t); await h.ready(); const { request, command } = await h.decide("reject"); request.badJson(); await h.flush();
  h.click("Проверить результат"); await h.flush(); h.take("read").reply(receipt(command, "committed"), 500); await h.flush();
  assert.equal(h.storage.values.has(storageKey()), true); assert.equal(h.storage.removals.length, 0);
  assert.equal(h.button("Отклонить").props.disabled, true); await h.read(command, "committed");
  assert.equal(h.storage.values.has(storageKey()), false);
});

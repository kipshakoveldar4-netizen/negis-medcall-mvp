import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Whole actual component with deterministic hook scheduling, not a DOM renderer.
// HTTP and access lifetimes are synthetic; Response.json is the real decoder.
// Positive payloads pass the actual server normalizer, not a copied business rule.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const componentFile = "artifacts/negis/src/components/crm/lead-team-analytics.tsx";
const baseline = process.argv.includes("--baseline");
const componentSource = baseline
  ? execFileSync("git", ["show", `HEAD:${componentFile}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, componentFile), "utf8");
type Json = Record<string, any>;
type Element = { type: unknown; props: Json };
const forbidden = (operation: string): never => assert.fail(`Forbidden analytics fixture operation: ${operation}`);
function evaluate(file: string, source: string, imports: Json = {}) {
  const output = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.deepEqual(output.diagnostics ?? [], [], `actual ${file} must transpile`);
  const exports: Json = {};
  new Script(output.outputText, { filename: file }).runInNewContext({
    exports, Date, Response, URL, AbortController,
    fetch: () => forbidden("network"),
    require(name: string) {
      if (Object.hasOwn(imports, name)) return imports[name];
      return forbidden(`import ${name}`);
    },
  }, { timeout: 1000 });
  return exports;
}
const permissions = evaluate("permissions.ts", await readFile(path.join(root, "artifacts/negis/src/lib/permissions.ts"), "utf8"));
const authFile = "lib/auth/server.ts";
const authSource = await readFile(path.join(root, authFile), "utf8");
const authAst = ts.createSourceFile(authFile, authSource, ts.ScriptTarget.Latest, true);
const uuidDeclarations = authAst.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "isUuidValue"
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((value) => value.name.getText(authAst) === "UUID_PATTERN"));
assert.equal(uuidDeclarations.length, 2);
const uuid = evaluate(authFile, uuidDeclarations.map((node) => node.getText(authAst)).join("\n"));
const reportFile = "lib/crm/lead-team-analytics.ts";
const server = evaluate(reportFile, await readFile(path.join(root, reportFile), "utf8")
  + "\nexports.fixtureNormalize = normalizeAnalytics;", {
  "../auth/server": uuid,
  "../supabase/server": { getSupabaseServerClient: () => forbidden("database") },
  "./server": { readWorkspaceContext: () => forbidden("request authentication") },
});
const WORKSPACE = "00000000-0000-4000-8000-000000000011";
const GENERATED_AT = "2026-10-25T10:00:00.000Z";
function rawReport(days = 30, name = "Current fixture") {
  return {
    workspaceId: WORKSPACE, timeZone: "Asia/Almaty", generatedAt: GENERATED_AT,
    period: { days, from: new Date(Date.parse(GENERATED_AT) - days * 86_400_000).toISOString(), to: GENERATED_AT },
    totalLeads: 20, unassignedLeads: 5, otherAssigneeLeads: 4, activityStatus: "available",
    members: [
      { staffId: "00000000-0000-4000-8000-000000000021", name, role: "lead_manager", status: "active",
        assigned: { total: 9, new: 1, inProgress: 1, booked: 3, postponed: 1, lost: 1, other: 2 },
        activity: { createdEvents: 7, updatedEvents: 13, touchedLeads: 6, lastRecordedAt: "2026-10-25T09:00:00.000Z" } },
      { staffId: "00000000-0000-4000-8000-000000000022", name: "Zero fixture", role: "admin", status: "inactive",
        assigned: { total: 2, new: 0, inProgress: 0, booked: 0, postponed: 1, lost: 1, other: 0 },
        activity: { createdEvents: 0, updatedEvents: 0, touchedLeads: 0, lastRecordedAt: null } },
      { staffId: "00000000-0000-4000-8000-000000000023", name: "No denominator fixture", role: "owner", status: "active",
        assigned: { total: 0, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 0 },
        activity: { createdEvents: 0, updatedEvents: 0, touchedLeads: 0, lastRecordedAt: null } },
    ],
  };
}
function envelope(raw = rawReport()) {
  return { success: true, mode: "supabase", data: { analytics: server.fixtureNormalize(raw, WORKSPACE, raw.period.days) } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === "object" && "props" in value ? [value, ...nodes(value.props.children)] : [];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function hookDriver() {
  const slots: Json[] = [];
  let cursor = 0, mounted = true, rendering = false, dirty = true, writes = 0, lateWrites = 0;
  let count: number | undefined, tree: any, render: () => any;
  const sameDeps = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  function slot(kind: string, create: () => Json) {
    assert.ok(rendering, "hooks run only during the actual component render");
    const index = cursor++;
    slots[index] ??= { kind, ...create() };
    assert.equal(slots[index].kind, kind, "stable hook order");
    return slots[index];
  }
  const hooks = {
    useState(initial: any) {
      const current = slot("state", () => ({ value: typeof initial === "function" ? initial() : initial }));
      current.set ??= (update: any) => {
        writes++;
        if (!mounted) { lateWrites++; return; }
        const next = typeof update === "function" ? update(current.value) : update;
        if (!Object.is(next, current.value)) { current.value = next; dirty = true; }
      };
      return [current.value, current.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ value: { current: initial } })).value; },
    useEffect(create: () => unknown, deps?: unknown[]) {
      const effect = slot("effect", () => ({ deps, pending: true }));
      if (!sameDeps(effect.deps, deps)) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
  };
  function commit() {
    if (!mounted || !dirty) return;
    dirty = false; cursor = 0; rendering = true;
    try { tree = render(); } finally { rendering = false; }
    count ??= cursor; assert.equal(cursor, count, "all renders use the same hooks");
    const effects = slots.filter((value) => value.kind === "effect" && value.pending);
    for (const effect of effects) effect.cleanup?.();
    for (const effect of effects) { effect.pending = false; effect.cleanup = effect.create(); }
  }
  return {
    hooks, mount(value: () => any) { render = value; }, invalidate() { dirty = true; },
    async flush() { for (let i = 0; i < 8; i++) { commit(); await setImmediate(); } assert.equal(dirty, false); },
    tree: () => tree, nodes: () => nodes(tree), text: () => text(tree), writes: () => writes, lateWrites: () => lateWrites,
    replayEffects() {
      const effects = slots.filter((value) => value.kind === "effect");
      for (const effect of effects) effect.cleanup?.();
      for (const effect of effects) effect.cleanup = effect.create();
    },
    dispose() { mounted = false; tree = null; for (const effect of slots) if (effect.kind === "effect") effect.cleanup?.(); },
  };
}
type Access = { isCurrent(): boolean; loadTeamAnalytics(days: number): Promise<Response> };
function fixture(initiallyExpanded = true) {
  const driver = hookDriver();
  const requests: Array<{ days: number; response: ReturnType<typeof deferred<Response>> }> = [];
  const original = { actor: "actor-A", workspace: WORKSPACE, role: "owner", token: "synthetic-token-1" };
  let live = { ...original };
  const access: Access = {
    isCurrent: () => live.actor === original.actor && live.workspace === original.workspace && live.role === original.role,
    loadTeamAnalytics(days) { const response = deferred<Response>(); requests.push({ days, response }); return response.promise; },
  };
  let propAccess = access;
  const jsx = (type: unknown, props: Json) => ({ type, props });
  const component = evaluate(componentFile, componentSource, {
    react: driver.hooks, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "lucide-react": { Loader2: "Loader2", RefreshCw: "RefreshCw" }, "@/lib/permissions": permissions,
  });
  driver.mount(() => component.LeadTeamAnalytics({ access: propAccess, initiallyExpanded }));
  function control(type: string) {
    const element = driver.nodes().find((node) => node.type === type);
    assert.ok(element, `missing ${type}`); return element;
  }
  const f = {
    driver, requests, access, control,
    setScope(patch: Partial<typeof original>) { live = { ...live, ...patch }; driver.invalidate(); },
    restore() { live = { ...original }; driver.invalidate(); },
    replaceAccess(next: Access) { propAccess = next; driver.invalidate(); },
    async period(days: number) { control("select").props.onChange({ target: { value: String(days) } }); await driver.flush(); },
    async toggle(open: boolean) { control("details").props.onToggle({ currentTarget: { open } }); await driver.flush(); },
    async refresh() { control("button").props.onClick(); await driver.flush(); },
    async reply(index: number, payload = envelope(rawReport(requests[index].days)), status = 200) {
      requests[index].response.resolve(Response.json(payload, { status })); await driver.flush();
    },
    async holdBody(index: number, payload = envelope(rawReport(requests[index].days))) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      requests[index].response.resolve(new Response(stream, { headers: { "content-type": "application/json" } }));
      await driver.flush();
      assert.equal(stream.locked, true, "the actual component has entered native Response.json");
      return async () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); await driver.flush(); };
    },
  };
  return f;
}
function assertHidden(f: ReturnType<typeof fixture>) {
  assert.doesNotMatch(f.driver.text(), /fixture|27,3%|33,3%/);
  assert.equal(f.driver.nodes().some((node) => node.type === "table" || node.type === "meter"), false);
}
function assertReady(f: ReturnType<typeof fixture>, name = "Current fixture") {
  assert.ok(f.driver.text().includes(name));
  assert.equal(f.driver.nodes().some((node) => node.props.role === "alert"), false);
  assert.equal(f.driver.nodes().find((node) => node.props["aria-busy"] !== undefined)?.props["aria-busy"], false);
}

test("authorized component uses the server-defined assigned cohort and lazy positive controls", async () => {
  const f = fixture(false); await f.driver.flush();
  assert.equal(f.requests.length, 0); assertHidden(f);
  await f.toggle(true); assert.equal(f.requests[0].days, 30);
  await f.reply(0); assertReady(f);
  assert.match(f.driver.text(), /27,3%/); // 3 / (9 + 2), not 3 / all 20 leads or an average.
  assert.deepEqual(f.driver.nodes().filter((node) => node.type === "meter").map((node) => node.props.value), [33.3, 0]);
  await f.period(7); assertHidden(f); assert.equal(f.requests[1].days, 7);
  await f.reply(1); assertReady(f); assert.match(f.driver.text(), /27,3%/);
  await f.toggle(false); assertHidden(f);
  await f.toggle(true); assertHidden(f); assert.equal(f.requests[2].days, 7);
  await f.reply(2); assertReady(f); f.driver.dispose();
});

for (const [at, zone, localDay, localTime] of [
  ["2026-01-01T20:10:00.000Z", "Asia/Almaty", "02.01.2026", "01:10"],
  ["2026-01-01T20:10:00.000Z", "Pacific/Chatham", "02.01.2026", "09:55"],
  ["2026-03-08T06:30:00.000Z", "America/New_York", "08.03.2026", "01:30"],
  ["2026-03-08T07:30:00.000Z", "America/New_York", "08.03.2026", "03:30"],
  ["2026-01-01T20:10:00.000Z", "UTC", "01.01.2026", "20:10"],
]) test(`team snapshot, period and last-activity labels use report zone ${zone} at ${at}`, async t => {
  const raw = rawReport(); raw.timeZone = zone; raw.generatedAt = raw.period.to = at;
  raw.period.from = new Date(Date.parse(at) - 30 * 86400000).toISOString(); raw.members[0].activity.lastRecordedAt = at;
  const f = fixture(); t.after(() => f.driver.dispose());
  await f.driver.flush(); await f.reply(0, envelope(raw)); assertReady(f);
  const expected = new Date(at).toLocaleString("ru-RU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  assert.ok(expected.includes(localDay) && expected.includes(localTime));
  assert.ok(f.driver.text().split(expected).length >= 4, "Snapshot, period.to and activity timestamp must all use the supplied zone");
  const from = new Date(raw.period.from).toLocaleString("ru-RU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  assert.ok(f.driver.text().includes(from));
});

test("team UI refuses missing/invalid zones and mismatched microsecond cutoffs even after a successful load", async t => {
  for (const edit of [
    (data: Json) => { delete data.timeZone; }, (data: Json) => { data.timeZone = "Invalid/Zone"; },
    (data: Json) => { data.generatedAt = data.generatedAt.replace(".000Z", ".000001Z"); },
    (data: Json) => { data.generatedAt = data.period.to = data.period.to.replace(".000Z", ".000001Z"); },
    (data: Json) => { data.period.from = "2026-02-30T10:00:00Z"; },
  ]) {
    const f = fixture(); t.after(() => f.driver.dispose());
    await f.driver.flush(); await f.reply(0); assertReady(f); await f.refresh();
    const malformed = envelope(); edit(malformed.data.analytics); await f.reply(1, malformed);
    assertHidden(f); assert.equal(f.driver.nodes().some(node => node.props.role === "alert"), true);
  }
});

test("same actor token refresh and replacement wrapper retain the original authorized bound loader", async () => {
  const f = fixture(); await f.driver.flush(); await f.reply(0);
  f.setScope({ token: "synthetic-token-2" });
  f.replaceAccess({ isCurrent: () => true, loadTeamAnalytics: () => forbidden("rebound loader") });
  await f.driver.flush(); assertReady(f);
  await f.refresh(); assertHidden(f); await f.reply(1); assertReady(f);
  assert.deepEqual(f.requests.map((request) => request.days), [30, 30]); f.driver.dispose();
});

test("7/90/30 filter ABA ignores late HTTP and already-decoding JSON from obsolete periods", async () => {
  const f = fixture(); await f.driver.flush(); await f.reply(0);
  await f.period(7);
  const release = await f.holdBody(1, envelope(rawReport(7, "Stale body fixture")));
  await f.period(90); await f.period(30); assertHidden(f);
  await f.reply(3); assertReady(f);
  const writes = f.driver.writes();
  await release(); await f.reply(2, envelope(rawReport(90, "Stale HTTP fixture")));
  assertReady(f); assert.doesNotMatch(f.driver.text(), /Stale/); assert.equal(f.driver.writes(), writes);
  await f.period(14); assert.equal(f.requests.length, 4); f.driver.dispose();
});

for (const [scope, patch] of [
  ["account", { actor: "actor-B" }], ["workspace", { workspace: "workspace-B" }], ["role", { role: "lead_manager" }],
] as const) {
  test(`${scope} ABA cannot revive a response or ready snapshot from the invalidated component lifetime`, async () => {
    const f = fixture(); await f.driver.flush(); await f.reply(0);
    const oldRefresh = f.control("button").props.onClick;
    await f.refresh(); const release = await f.holdBody(1, envelope(rawReport(30, "Stale scope fixture")));
    f.setScope(patch); await f.driver.flush(); assert.equal(f.driver.tree(), null);
    f.restore(); await f.driver.flush();
    const writes = f.driver.writes();
    await release(); oldRefresh(); await f.driver.flush();
    assert.equal(f.driver.tree() === null, true, "an observed expired pinned access requires a fresh component lifetime");
    assert.equal(f.requests.length, 2); assert.equal(f.driver.writes(), writes); f.driver.dispose();
  });
}

test("a ready snapshot stays hidden after an observed role loss and restoration without a new mount", async () => {
  const f = fixture(); await f.driver.flush(); await f.reply(0); assertReady(f);
  f.setScope({ role: "lead_manager" }); await f.driver.flush(); assert.equal(f.driver.tree(), null);
  f.restore(); await f.driver.flush(); assertHidden(f);
  assert.equal(f.driver.tree() === null, true); assert.equal(f.requests.length, 1); f.driver.dispose();
});

test("a fresh authorized mount resets the period without reviving the disposed report's controls", async () => {
  const old = fixture(); await old.driver.flush(); await old.reply(0); await old.period(7); await old.reply(1);
  const refresh = old.control("button").props.onClick;
  old.setScope({ actor: "actor-B" }); await old.driver.flush(); old.driver.dispose(); old.restore();
  const fresh = fixture(); await fresh.driver.flush();
  assert.equal(fresh.requests[0].days, 30); await fresh.reply(0); assertReady(fresh);
  refresh(); await fresh.driver.flush();
  assert.equal(old.driver.lateWrites(), 0); assert.equal(old.requests.length, 2);
  assert.equal(fresh.requests.length, 1); assertReady(fresh); fresh.driver.dispose();
});

test("unmounted controls and late native JSON cannot attempt setters even when external access stays current", async () => {
  const f = fixture(); await f.driver.flush(); await f.reply(0);
  const period = f.control("select").props.onChange, refresh = f.control("button").props.onClick, toggle = f.control("details").props.onToggle;
  await f.refresh(); const release = await f.holdBody(1);
  f.driver.dispose();
  period({ target: { value: "7" } }); refresh(); toggle({ currentTarget: { open: false } });
  await release();
  assert.equal(f.driver.lateWrites(), 0); assert.equal(f.requests.length, 2);
});

test("effect cleanup/setup replay cancels the first request without disabling authorized controls", async () => {
  const f = fixture(); await f.driver.flush(); f.driver.replayEffects(); await f.driver.flush();
  assert.equal(f.requests.length, 2);
  await f.reply(1); const writes = f.driver.writes();
  await f.reply(0, envelope(rawReport(30, "Stale replay fixture")));
  assertReady(f); assert.equal(f.driver.writes(), writes);
  await f.period(90); await f.reply(2); assertReady(f); f.driver.dispose();
});

for (const status of [403, 502]) {
  test(`HTTP ${status} clears prior results without parsing a body, then authorized refresh recovers`, async () => {
    const f = fixture(); await f.driver.flush(); await f.reply(0); await f.refresh(); assertHidden(f);
    f.requests[1].response.resolve({ ok: false, status, json: () => forbidden("failed HTTP body") } as unknown as Response);
    await f.driver.flush(); assertHidden(f);
    assert.equal(f.driver.nodes().some((node) => node.props.role === "alert"), true);
    assert.equal(f.control("button").props.disabled, false);
    await f.refresh(); await f.reply(2); assertReady(f); f.driver.dispose();
  });
}

for (const failure of ["transport", "invalid JSON"] as const) {
  test(`${failure} clears old data and busy state, with an authorized recovery path`, async () => {
    const f = fixture(); await f.driver.flush(); await f.reply(0); await f.refresh(); assertHidden(f);
    if (failure === "transport") f.requests[1].response.reject(new TypeError("Synthetic lost response"));
    else f.requests[1].response.resolve(new Response("{", { status: 200, headers: { "content-type": "application/json" } }));
    await f.driver.flush(); assertHidden(f);
    assert.equal(f.driver.nodes().some((node) => node.props.role === "alert"), true);
    assert.equal(f.control("button").props.disabled, false);
    await f.refresh(); await f.reply(2); assertReady(f); f.driver.dispose();
  });
}

for (const defect of ["short period", "older period end"] as const) {
  test(`${defect} is refused by the existing server contract and cannot be presented as a truthful UI period`, async () => {
    const raw = rawReport();
    if (defect === "short period") raw.period.from = "2026-10-24T10:00:00.000Z";
    else { raw.period.from = "2026-09-24T10:00:00.000Z"; raw.period.to = "2026-10-24T10:00:00.000Z"; }
    assert.throws(() => envelope(raw), /analytics_incomplete/);
    const malformed = envelope(); malformed.data.analytics.period = raw.period;
    const f = fixture(); await f.driver.flush(); await f.reply(0); await f.refresh();
    await f.reply(1, malformed); assertHidden(f);
    assert.equal(f.driver.nodes().some((node) => node.props.role === "alert"), true);
    await f.refresh(); await f.reply(2); assertReady(f); f.driver.dispose();
  });
}

test("unavailable activity and a missing denominator are not fabricated zero conversions", async () => {
  const raw = rawReport(); raw.activityStatus = "unavailable";
  for (const member of raw.members) member.activity = null as any;
  const f = fixture(); await f.driver.flush(); await f.reply(0, envelope(raw));
  assertReady(f); assert.match(f.driver.text(), /27,3%/);
  const row = f.driver.nodes().find((node) => node.type === "tr" && text(node).includes("Current fixture")); assert.ok(row);
  assert.deepEqual(nodes(row).filter((node) => node.type === "td").slice(7).map(text), ["-", "-", "-", "-"]);
  const empty = rawReport(); empty.members = []; empty.otherAssigneeLeads = 15;
  await f.refresh(); await f.reply(1, envelope(empty));
  assert.equal(f.driver.nodes().some((node) => node.type === "meter"), false);
  assert.doesNotMatch(f.driver.text(), /27,3%|0%/); f.driver.dispose();
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { randomUUID } from "node:crypto";

// Local source execution only: no app bootstrap, browser, environment, auth or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, "artifacts/negis/src", file), "utf8");
const source = await read("lib/mortgage-workspace.tsx");
const calendarSource = await read("pages/MortgageCalendar.tsx");
const taskSource = await read("pages/MortgageTasks.tsx");
const dialogSource = await read("components/mortgage/ActivityDialog.tsx");
const contactFormSource = await read("components/mortgage/MortgageContactForm.tsx");
const clientsSource = await read("pages/MortgageClients.tsx");
const contactDetailSource = await read("components/mortgage/MortgageContactDetail.tsx");
type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });
function evaluate(input: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Script(code).runInNewContext({ exports, AbortController, AbortSignal, DOMException, Response, Headers, URLSearchParams, Intl, Date, Error,
    crypto: { randomUUID }, window: { setTimeout: () => 1, clearTimeout: () => undefined }, ...bindings,
    require(name: string) {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name.startsWith("@/components/")) return new Proxy({}, { get: (_target, key) => String(key) });
      throw new Error(`Unmocked import: ${name}`);
    },
  });
  return exports;
}
const clinicDay = evaluate(await read("lib/clinicDay.ts"));
const capacity = evaluate(await readFile(path.join(root, "lib/crm/appointment-capacity.ts"), "utf8"));
const dayGrid = evaluate(await read("lib/dayGrid.ts"), { "../../../../lib/crm/appointment-capacity": capacity });
const clinicDateTime = evaluate(await read("lib/clinicDateTime.ts"), { "./clinicDay": clinicDay, "./dayGrid": dayGrid });
const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
function driver() {
  const slots: any[] = [];
  const writes: any[] = [];
  let cursor = 0, dirty = true;
  let output: any;
  let render = () => output;
  let context: any;
  const memo = (create: () => unknown, deps?: unknown[]) => {
    const index = cursor++;
    if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: create(), deps };
    return slots[index].value;
  };
  function effect(create: () => any, deps?: unknown[]) {
    const index = cursor++, previous = slots[index];
    slots[index] = { create, deps, cleanup: previous?.cleanup, pending: !previous || !sameDeps(previous.deps, deps) };
  }
  const hooks = {
    createContext: () => ({ Provider: "MortgageProvider" }), useContext: () => context,
    useState(initial: any) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update: any) => {
        const next = typeof update === "function" ? update(slots[index].value) : update;
        writes.push(next);
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useId: () => "fixture-form", useMemo: memo, useCallback: (callback: any, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
  const paint = () => { dirty = false; cursor = 0; output = render(); return output; };
  return {
    hooks, writes, setContext(value: any) { context = value; },
    mount(callback: () => any) { render = callback; dirty = true; }, paint,
    async flush() {
      for (let pass = 0; pass < 30; pass++) {
        if (dirty) paint();
        const pending = slots.filter((slot) => slot?.pending);
        for (const slot of pending) { slot.pending = false; slot.cleanup?.(); slot.cleanup = slot.create(); }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!dirty && !slots.some((slot) => slot?.pending)) return output;
      }
      throw new Error("Fixture did not settle");
    },
    async replay() {
      for (const slot of slots) if (slot?.create) { slot.cleanup?.(); slot.cleanup = slot.create(); }
      return this.flush();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const defer = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const scope = { actorId: "local-actor", workspaceId: "local-workspace", role: "owner", purpose: "mortgage_leads" };
const formAuth = { useAuth: () => ({ clinicId: scope.workspaceId, userRole: scope.role }) };
const selfStaffId = "22222222-2222-4222-8222-222222222222";
const selfAuthId = "11111111-1111-4111-8111-111111111111";
const otherStaffId = "33333333-3333-4333-8333-333333333333";
const contact = { id: "local-client", name: "Local Client", phone: "000", notes: "", status: "new", source: "manual", createdAt: "2026-10-14T10:00:00Z", updatedAt: "2026-10-14T10:00:00.123456Z", responsibleUserId: "local-manager", responsibleName: "Local Manager" };
const snapshot = () => ({ timeZone: "Asia/Qyzylorda", contacts: [contact], contactsTotal: 1, activities: [], members: [{ id: "local-manager", name: "Local Manager", role: "lead_manager", status: "active" }], events: [],
  metrics: { totalLeads: 1, unassignedLeads: 0, inProgressLeads: 0, meetingsToday: 0, overdueTasks: 0, activeManagers: 1 },
  memberMetrics: [{ id: "local-manager", name: "Local Manager", role: "lead_manager", assignedLeads: 1, openTasks: 0, overdueTasks: 0, doneTasks: 0, plannedMeetings: 0, doneMeetings: 0, missedMeetings: 0 }],
  periodDays: 90, page: 0, pageSize: 100, activitiesTruncated: false });
const response = (data: unknown = snapshot()) => new Response(JSON.stringify({ success: true, mode: "supabase", data }), { status: 200 });
function moduleFixture(d = driver(), fetcher: (path: string, init: any) => Promise<Response> = async () => response()) {
  const listeners = new Set<(event: string, session: any) => void>();
  const auth = { user: { id: scope.actorId }, userRole: scope.role, clinicId: scope.workspaceId, workspacePurpose: scope.purpose, isLoading: false, isSigningOut: false, isDemoMode: false, isImpersonation: false };
  const module = evaluate(source + "\nexports.fixture = { MortgageSession, snapshotFrom };", {
    react: d.hooks, "@/contexts/AuthContext": { useAuth: () => auth }, "@/lib/api": { crmFetch: fetcher },
    "@/lib/demoStorage": { readWorkspaceId: () => "selected-workspace" },
    "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { onAuthStateChange(callback: any) {
      listeners.add(callback); return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    } } } }, "@/lib/clinicDay": clinicDay, "@/lib/dayGrid": dayGrid, "@/lib/clinicDateTime": clinicDateTime,
  });
  return { module, d, auth, listeners };
}
const pure = moduleFixture().module;
const calendar = evaluate(calendarSource, { react: {}, wouter: {}, "@/lib/clinicDay": clinicDay, "@/lib/dayGrid": dayGrid, "@/lib/mortgage-workspace": pure });
const tasks = evaluate(taskSource, { react: {}, wouter: {}, "@/lib/clinicDay": clinicDay, "@/lib/mortgage-workspace": pure });

test("wall times use the snapshot zone, including Kazakhstan's current UTC+5 and overnight dates", () => {
  assert.equal(pure.mortgageDateTimeToIso("2026-10-15T00:10", "Asia/Qyzylorda"), "2026-10-14T19:10:00.000Z");
  assert.equal(pure.mortgageLocalDateTime("2026-10-14T19:10:00Z", "Asia/Qyzylorda"), "2026-10-15T00:10");
  assert.equal(pure.mortgageDateTimeToIso("2026-10-15T23:59", "Pacific/Chatham"), "2026-10-15T10:14:00.000Z");
  assert.throws(() => pure.mortgageDateTimeToIso("2026-02-30T12:00", "Asia/Qyzylorda"), /дату/);
  assert.throws(() => pure.mortgageDateTimeToIso("2026-10-15T12:00", ""), /пояс/);
  assert.throws(() => pure.mortgageLocalDateTime("2026-10-15T12:00Z", "not-a-zone"), /пояс/);
});

test("DST gaps and repeated wall times fail explicitly; unchanged repeated instants retain their offset", () => {
  assert.throws(() => pure.mortgageDateTimeToIso("2026-03-08T02:30", "America/New_York"), /отсутствует/);
  assert.throws(() => pure.mortgageDateTimeToIso("2026-11-01T01:30", "America/New_York"), /повторяется/);
  assert.equal(pure.mortgageDateTimeToIso("2026-11-01T01:30", "America/New_York", "2026-11-01T06:30:00Z"), "2026-11-01T06:30:00Z");
  assert.equal(pure.mortgageDateTimeToIso("2026-03-08T03:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
});

test("calendar dates navigate independently of the device zone, including month-end and six-row months", () => {
  assert.equal(pure.mortgageMonthStep("2026-01-31", 1), "2026-02-28");
  assert.equal(pure.mortgageMonthStep("2028-01-31", 1), "2028-02-29");
  assert.equal(pure.mortgageWeekStart("2026-10-18"), "2026-10-12");
  const days = calendar.mortgageCalendarDays("2026-03-31", "month");
  assert.equal(days.length, 42); assert.equal(days[0], "2026-02-23"); assert.equal(days[41], "2026-04-05");
});

function activity(overrides: Record<string, unknown> = {}) {
  return { id: "activity-1", kind: "meeting", leadId: contact.id, title: "Local activity", notes: "", priority: "normal", status: "open",
    startsAt: "2026-10-15T05:00:00Z", endsAt: "2026-10-15T06:00:00Z", dueAt: null, createdAt: "2026-10-14T10:00:00Z", updatedAt: "2026-10-14T10:00:00.123456Z", contactName: contact.name, responsibleUserId: contact.responsibleUserId, responsibleName: contact.responsibleName, ...overrides };
}
test("calendar places overlaps in lanes, clips overnight meetings and excludes an exclusive end day", () => {
  const meetings = [activity(), activity({ id: "overlap", startsAt: "2026-10-15T05:30:00Z", endsAt: "2026-10-15T06:30:00Z" })];
  const column = calendar.mortgageMeetingColumn(meetings, "2026-10-15", "Asia/Qyzylorda");
  assert.equal(column.length, 2); assert.equal(column[0].lanes, 2); assert.notEqual(column[0].lane, column[1].lane);
  const overnight = activity({ startsAt: "2026-10-15T18:30:00Z", endsAt: "2026-10-15T20:30:00Z" });
  assert.equal(calendar.mortgageMeetingColumn([overnight], "2026-10-15", "Asia/Qyzylorda")[0].endMinute, 1440);
  assert.equal(calendar.mortgageMeetingColumn([overnight], "2026-10-16", "Asia/Qyzylorda")[0].startMinute, 0);
  assert.equal(calendar.mortgageMeetingOnDay(activity({ endsAt: "2026-10-15T19:00:00Z" }), "2026-10-16", "Asia/Qyzylorda"), false);
});

test("task filters use zoned due dates and do not mark done/cancelled work overdue", () => {
  const now = Date.parse("2026-10-15T19:30:00Z");
  const due = activity({ kind: "task", startsAt: null, endsAt: null, dueAt: "2026-10-15T19:15:00Z", priority: "high", title: "Documents" });
  const filters = { search: "documents", status: "active", priority: "high", managerId: "all", due: "today", from: "", to: "" };
  assert.equal(tasks.mortgageFilterTasks([due], filters, "Asia/Qyzylorda", now).length, 1);
  assert.equal(tasks.mortgageTaskOverdue(due, now), true);
  assert.equal(tasks.mortgageTaskOverdue({ ...due, status: "done" }, now), false);
  assert.equal(tasks.mortgageTaskOverdue({ ...due, status: "cancelled" }, now), false);
  assert.equal(tasks.mortgageFilterTasks([due], { ...filters, due: "range", from: "2026-10-17" }, "Asia/Qyzylorda", now).length, 0);
  assert.equal(tasks.mortgageFilterTasks([{ ...due, dueAt: null }], { ...filters, due: "none" }, "Asia/Qyzylorda", now).length, 1);
});

test("session requests are no-store, expected-actor-bound and aborted immediately on auth change", async () => {
  const pending = defer<Response>();
  const calls: any[] = [];
  const f = moduleFixture(driver(), async (path, init) => { calls.push({ path, init }); return pending.promise; });
  const live = { current: { ...scope } };
  f.d.mount(() => f.module.fixture.MortgageSession({ scope, live, children: "sensitive" }));
  const tree = await f.d.flush();
  const access = tree.props.value;
  const request = access.request("/api/crm/mortgage-workspace");
  assert.equal(calls[0].init.cache, "no-store"); assert.equal(calls[0].init.expectedUserId, scope.actorId);
  for (const listener of f.listeners) listener("SIGNED_OUT", null);
  assert.equal(calls[0].init.signal.aborted, true); assert.equal(access.isCurrent(), false);
  pending.resolve(response());
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(await f.d.flush(), null);
  await assert.rejects(access.request("/api/crm/leads", { method: "POST" }), { name: "AbortError" });
  assert.equal(calls.length, 1);
  f.d.unmount();
});

test("StrictMode replay creates a fresh live controller, never reactivating old access", async () => {
  const calls: any[] = [];
  const f = moduleFixture(driver(), async (_path, init) => { calls.push(init); return response(); });
  const live = { current: { ...scope } };
  f.d.mount(() => f.module.fixture.MortgageSession({ scope, live, children: "sensitive" }));
  const oldAccess = (await f.d.flush()).props.value;
  await oldAccess.request("/api/crm/mortgage-workspace");
  const newAccess = (await f.d.replay()).props.value;
  assert.equal(oldAccess.isCurrent(), false); assert.equal(newAccess.isCurrent(), true);
  await newAccess.request("/api/crm/mortgage-workspace");
  assert.notEqual(calls[0].signal, calls[1].signal); assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  f.d.unmount(); assert.equal(calls[1].signal.aborted, true);
});

test("401/403/404 reads and mutations revoke the entire scope, hide loaded data/dialogs and show a non-sensitive alert", async () => {
  const dialog = evaluate(dialogSource, { react: {}, "@/lib/mortgage-workspace": pure, "@/contexts/AuthContext": formAuth });
  for (const status of [401, 403, 404]) for (const method of ["GET", "PATCH", "POST"]) {
    const calls: any[] = [];
    let refuse = false;
    const f = moduleFixture(driver(), async (url, init) => {
      calls.push({ url, init });
      return refuse ? new Response(JSON.stringify({ error: "Local membership/assignment revoked", code: "workspace_access_denied" }), { status }) : response();
    });
    const live = { current: { ...scope } };
    f.d.mount(() => f.module.fixture.MortgageSession({ scope, live, children: "sensitive content" }));
    const access = (await f.d.flush()).props.value;
    const hookDriver = driver(); const hook = moduleFixture(hookDriver);
    hookDriver.setContext(access); hookDriver.mount(() => hook.module.useMortgageWorkspace());
    const loaded = await hookDriver.flush();
    assert.equal(loaded.data.contacts[0].name, "Local Client");
    assert.notEqual(dialog.ActivityDialog({ open: true, workspace: loaded, kind: "task", onOpenChange() {} }), null);
    refuse = true;
    const refused = method === "PATCH" ? loaded.saveActivity({ kind: "task", leadId: contact.id, title: "Local task" }, activity({ kind: "task" }))
      : method === "POST" ? loaded.createContact({ name: "Local", phone: "000" }) : loaded.searchContacts("Local");
    await assert.rejects(refused, { name: "AbortError" });
    assert.equal(access.isCurrent(), false, `${status} ${method}`);
    assert.equal(calls.at(-1).init.signal.aborted, true);
    assert.equal(hookDriver.paint().data, null);
    assert.equal(dialog.ActivityDialog({ open: true, workspace: loaded, kind: "task", onOpenChange() {} }), null);
    const denied = await f.d.flush();
    assert.equal(denied.props.role, "alert");
    assert.match(denied.props.children.props.children, status === 401 ? /Сеанс.*завершён/ : status === 403 ? /Доступ.*отозван/ : /недоступны/);
    assert.doesNotMatch(JSON.stringify(denied), /Local Client|sensitive content|local-client/);
    assert.equal((await f.d.replay()).props.role, "alert");
    assert.equal(access.isCurrent(), false);
    const count = calls.length;
    await assert.rejects(access.request("/api/crm/leads", { method: "POST" }), { name: "AbortError" });
    assert.equal(calls.length, count);
    hookDriver.unmount(); f.d.unmount();
  }
});

test("each actor/workspace/role/purpose change invalidates old access synchronously", async () => {
  for (const [key, value] of [["actorId", "other"], ["workspaceId", "other"], ["role", "admin"], ["purpose", "clinic_services"]]) {
    const f = moduleFixture(); const live = { current: { ...scope } };
    f.d.mount(() => f.module.fixture.MortgageSession({ scope, live, children: "sensitive" }));
    const access = (await f.d.flush()).props.value;
    assert.equal(access.isCurrent(), true);
    live.current = { ...scope, [key]: value };
    assert.equal(access.isCurrent(), false, key);
    await assert.rejects(access.request("/api/crm/mortgage-workspace"), { name: "AbortError" });
    f.d.unmount();
  }
});

test("scope keys cover actor/workspace/role/purpose and demo sessions never render children", () => {
  const f = moduleFixture();
  f.d.mount(() => f.module.MortgageScope({ children: "sensitive" }));
  const first = f.d.paint();
  for (const [key, value] of [["clinicId", "other-workspace"], ["userRole", "admin"]] as const) {
    const old = f.auth[key]; f.auth[key] = value;
    assert.notEqual(f.d.paint().key, first.key); f.auth[key] = old;
  }
  f.auth.user = { id: "other-actor" }; assert.notEqual(f.d.paint().key, first.key);
  f.auth.isDemoMode = true; const denied = f.d.paint(); assert.equal(denied.props.role, "alert");
  assert.notEqual(denied.props.children, "sensitive");
});

test("an SDK actor change cannot remount the previous actor while AuthContext catches up", async () => {
  const f = moduleFixture();
  f.d.mount(() => f.module.MortgageScope({ children: "sensitive" }));
  const first = await f.d.flush();
  for (const listener of f.listeners) listener("SIGNED_IN", { user: { id: "other-actor" } });
  assert.equal(await f.d.flush(), null);
  f.auth.user = { id: "other-actor" };
  const next = f.d.paint();
  assert.notEqual(next.key, first.key); assert.equal(next.props.scope.actorId, "other-actor");
  f.auth.isSigningOut = true;
  assert.equal(f.d.paint(), null);
  f.d.unmount();
});

function hookFixture(fetcher: (path: string, init?: RequestInit) => Promise<Response>) {
  const f = moduleFixture();
  let current = true;
  const access = { workspaceId: scope.workspaceId, isCurrent: () => current, request: fetcher };
  f.d.setContext(access);
  let query: any = {};
  f.d.mount(() => f.module.useMortgageWorkspace(query));
  return { ...f, access, revoke: () => { current = false; }, setQuery(value: any) { query = value; }, };
}

test("snapshot query, zero-based contact search and immediate query data hiding use the shared contract", async () => {
  const calls: any[] = [];
  const f = hookFixture(async (url) => { calls.push(url); return response(); });
  const result = await f.d.flush(); assert.equal(result.data.contacts[0].id, contact.id);
  f.setQuery({ q: "Local name", page: 2, leadId: "lead", from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", days: 30 });
  assert.equal(f.d.paint().data, null);
  const next = await f.d.flush();
  const url = new URL(calls.at(-1), "http://fixture.invalid");
  assert.equal(url.searchParams.get("workspaceId"), scope.workspaceId); assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("q"), "Local name"); assert.equal(url.searchParams.get("days"), "30");
  assert.equal(url.searchParams.get("from"), "2026-01-01T00:00:00Z"); assert.equal(url.searchParams.get("leadId"), "lead");
  assert.equal(url.searchParams.get("to"), "2026-02-01T00:00:00Z");
  await next.searchContacts("Search");
  assert.equal(new URL(calls.at(-1), "http://fixture.invalid").searchParams.get("page"), "0");
  f.revoke(); assert.equal(f.d.paint().data, null); f.d.unmount();
});

test("stale body parsing and out-of-order reads cannot commit data or errors", async () => {
  const body = defer<unknown>();
  const f = hookFixture(async () => ({ ok: true, status: 200, json: () => body.promise } as Response));
  await f.d.flush(); const writes = f.d.writes.length;
  f.revoke(); body.resolve({ success: true, mode: "supabase", data: snapshot() });
  await f.d.flush(); assert.equal(f.d.writes.length, writes); assert.equal(f.d.paint().data, null); f.d.unmount();
  const older = defer<Response>();
  let count = 0;
  const g = hookFixture(async () => ++count === 1 ? older.promise : response({ ...snapshot(), contacts: [] }));
  await g.d.flush(); g.setQuery({ page: 1 }); await g.d.flush();
  older.resolve(response()); const latest = await g.d.flush(); assert.equal(latest.data.contacts.length, 0); g.d.unmount();
});

test("schema errors are real errors, with no demo data or fallback writes", async () => {
  const f = hookFixture(async () => new Response(JSON.stringify({ error: "Новые разделы ещё не подключены к этой базе", code: "schema_not_ready" }), { status: 503 }));
  const result = await f.d.flush();
  assert.equal(result.data, null); assert.match(result.error, /ещё не подключены/); assert.equal(result.loading, false);
  assert.doesNotMatch(source + dialogSource, /localStorage|sessionStorage|leadsSeed|useDemoCollection/);
  f.d.unmount();
});

test("successful snapshots validate every required collection, metric, count, paging field and nested row", async () => {
  const valid: Record<string, any> = { ...snapshot(), activities: [activity()], events: [{ id: "event", activityId: "activity-1", action: "created", title: "Local activity", actorName: "Local actor", createdAt: "2026-10-14T10:00:00Z" }] };
  assert.equal(pure.fixture.snapshotFrom({ data: valid }).contacts[0].updatedAt, "2026-10-14T10:00:00.123456Z");
  for (const key of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[key];
    assert.throws(() => pure.fixture.snapshotFrom({ data: missing }), `missing ${key}`);
  }
  for (const [key, value] of [["metrics", {}], ["metrics", { ...valid.metrics, activeManagers: "1" }], ["contactsTotal", -1], ["contactsTotal", "1"], ["page", -1], ["pageSize", 0], ["periodDays", 0], ["activitiesTruncated", "false"], ["events", {}], ["memberMetrics", [{}]], ["contacts", [{ ...contact, phone: [] }]], ["activities", [activity({ priority: ["normal"] })]], ["activities", [activity({ status: ["open"] })]], ["members", [{ id: "manager", name: 4, role: "lead_manager", status: "active" }]], ["events", [{ ...valid.events[0], createdAt: "invalid" }]]]) {
    assert.throws(() => pure.fixture.snapshotFrom({ data: { ...valid, [key as string]: value } }), `invalid ${key}`);
  }
  const malformed = hookFixture(async () => response({ ...valid, metrics: {} }));
  const result = await malformed.d.flush();
  assert.equal(result.data, null); assert.equal(result.loading, false); assert.match(result.error, /данные рабочего пространства/);
  malformed.d.unmount();
});

test("activity retries retain requestId; PATCH carries the expected version and no assignee/clinical fields", async () => {
  const calls: any[] = [];
  let fail = true;
  const f = hookFixture(async (url, init) => {
    calls.push({ url, init });
    if (init?.method && fail) { fail = false; throw new Error("Temporary local failure"); }
    return response();
  });
  const result = await f.d.flush();
  const draft = { kind: "task", leadId: contact.id, title: "Documents", requestId: randomUUID(), responsibleUserId: "forged", price: 100 };
  await assert.rejects(result.saveActivity(draft), /Temporary/);
  await result.saveActivity(draft);
  const writes = calls.filter((call) => call.init?.method);
  assert.equal(JSON.parse(writes[0].init.body).requestId, JSON.parse(writes[1].init.body).requestId);
  await result.saveActivity({ ...draft, status: "done" }, activity({ kind: "task" }));
  const patch = JSON.parse(calls.at(-1).init.body);
  assert.equal(calls.at(-1).init.method, "PATCH"); assert.equal(patch.expectedUpdatedAt, "2026-10-14T10:00:00.123456Z");
  assert.equal(patch.id, "activity-1"); assert.equal(patch.requestId, undefined);
  assert.equal(patch.responsibleUserId, undefined); assert.equal(patch.price, undefined);
  assert.equal(patch.dueAt, null);
  await assert.rejects(result.saveActivity({ ...draft, requestId: undefined }), /Откройте/);
  f.d.unmount();
});

test("contact writes use existing leads endpoints, surface server errors, and check after JSON parsing", async () => {
  const calls: any[] = [];
  let body: any = { success: true, mode: "supabase", data: snapshot() };
  const f = hookFixture(async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body)); });
  const result = await f.d.flush();
  await result.createContact({ name: "Local", phone: "000" });
  let payload = JSON.parse(calls.at(-1).init.body);
  assert.match(calls.at(-1).url, /\/api\/crm\/leads\?workspaceId=/);
  assert.equal(payload.responsibleUserId, ""); assert.equal(payload.source, "manual"); assert.equal(payload.status, "new");
  await result.updateContact(contact.id, { notes: "Updated", status: "in_progress", responsibleUserId: "forged" });
  payload = JSON.parse(calls.at(-1).init.body);
  assert.equal(payload.id, contact.id); assert.equal(payload.updates.notes, "Updated"); assert.equal(payload.updates.responsibleUserId, undefined);
  body = { success: false, error: "Access denied", code: "workspace_access_denied" };
  await assert.rejects(result.updateContact(contact.id, { notes: "Updated" }), /Access denied/);
  f.d.unmount();
});

test("a contact mutation that loses its session during body parsing cannot refresh or report success", async () => {
  const body = defer<unknown>();
  const f = hookFixture(async (_url, init) => init?.method ? { ok: true, status: 200, json: () => body.promise } as Response : response());
  const result = await f.d.flush();
  const mutation = result.createContact({ name: "Local", phone: "000" });
  await f.d.flush(); const writes = f.d.writes.length;
  f.revoke(); body.resolve({ success: true, mode: "supabase", data: {} });
  await assert.rejects(mutation, { name: "AbortError" });
  assert.equal(f.d.writes.length, writes); f.d.unmount();
});

test("the real activity form retains a UUID across failed retries and converts meetings in the snapshot zone", async () => {
  const d = driver();
  let captured: any;
  const drafts: any[] = [];
  let fail = true;
  let closed = false;
  const workspace = { data: snapshot(), isCurrent: () => true, searchContacts: async () => [], saveActivity: async (draft: any) => {
    drafts.push(draft); if (fail) { fail = false; throw new Error("Local retry"); }
  } };
  const observed = dialogSource.replace("return <DialogContent", "__capture({ submit, loaded, setTitle, setStartsAt, setEndsAt, setDueAt, error }); return <DialogContent") + "\nexports.fixture = { ActivityForm };";
  const form = evaluate(observed, { react: d.hooks, "@/lib/mortgage-workspace": pure, "@/contexts/AuthContext": formAuth }, { __capture: (value: any) => { captured = value; } });
  d.mount(() => form.fixture.ActivityForm({ workspace, kind: "meeting", leadId: contact.id, timeZone: snapshot().timeZone, onOpenChange: () => { closed = true; } }));
  await d.flush(); captured.loaded(contact, ""); captured.setTitle("Local meeting"); captured.setStartsAt("2026-10-15T23:30"); captured.setEndsAt("2026-10-16T00:30"); await d.flush();
  await captured.submit({ preventDefault() {} }); await d.flush();
  assert.equal(closed, false); assert.equal(captured.error, "Local retry");
  await captured.submit({ preventDefault() {} }); await d.flush();
  assert.equal(closed, true); assert.equal(drafts.length, 2); assert.equal(drafts[0].requestId, drafts[1].requestId);
  assert.equal(drafts[0].startsAt, "2026-10-15T18:30:00.000Z"); assert.equal(drafts[0].endsAt, "2026-10-15T19:30:00.000Z");
  assert.equal(drafts[0].responsibleUserId, undefined); d.unmount();
});

function formNodes(value: any): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(formNodes);
  return "type" in value ? [value, ...formNodes(value.props?.children)] : [];
}

function contactFormFixture(fetcher: (path: string, init: any) => Promise<Response>, editing = false, bound?: { request: (path: string, init: any) => Promise<Response>; isCurrent: () => boolean }) {
  const d = driver(), requests: any[] = [], submitted: any[] = [];
  let current = true, closed = false;
  const isCurrent = () => current && (!bound || bound.isCurrent());
  const request = async (path: string, init: any) => { requests.push({ path, init }); return bound ? bound.request(path, init) : fetcher(path, init); };
  const form = evaluate(contactFormSource, {
    react: d.hooks, "@/contexts/AuthContext": { useAuth: () => ({ clinicId: scope.workspaceId, userRole: "admin" }) },
    "@/lib/phone": { phoneDigits: (value: string) => value.replace(/\D/g, "") },
    "./MortgagePrimitives": { mortgageContactStatus: (value: string) => value, mortgageErrorMessage: (error: Error) => error.message },
  });
  const props = { contact: editing ? contact : undefined,
    request, isCurrent, onSubmit: async (fields: any) => { submitted.push(fields); }, onClose: () => { closed = true; } };
  d.mount(() => form.MortgageContactForm(props));
  let output: any;
  const flush = async () => { output = await d.flush(); return formNodes(output); };
  const nodes = () => formNodes(output);
  const field = (suffix: string) => nodes().find((node) => node.props.id === `fixture-form-${suffix}`)!;
  const submit = async () => { await nodes().find((node) => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); };
  return { d, requests, submitted, flush, nodes, field, submit, isClosed: () => closed, revoke: () => { current = false; } };
}

test("create and edit parents forward their existing bound request and session guard to the contact form", async () => {
  for (const editing of [false, true]) {
    const d = driver(), queries: any[] = [];
    const workspace = { data: snapshot(), loading: false, error: "", isCurrent: () => true,
      request: async () => response(), refresh() {} };
    const primitives = { MortgageIconButton: "MortgageIconButton", MortgagePageHeader: "MortgagePageHeader", MortgageState: "MortgageState",
      mortgageContactStatus: (value: string) => value, mortgageDate: () => "Synthetic date" };
    const page = evaluate((editing ? contactDetailSource : clientsSource) + (editing ? "" : "\nexports.Body = MortgageClientsBody;"), {
      react: d.hooks, wouter: { Link: "Link", useSearchParams: () => [new URLSearchParams(), () => undefined] },
      "@/contexts/AuthContext": { useAuth: () => ({ clinicId: scope.workspaceId, userRole: "admin" }) },
      "@/lib/mortgage-workspace": { useMortgageWorkspace: (query: any) => { queries.push(query); return workspace; } },
      "@/lib/phone": { formatPhone: (value: string) => value, toTelHref: (value: string) => `tel:${value}` },
      "@/components/mortgage/MortgagePrimitives": primitives, "./MortgagePrimitives": primitives,
      "@/components/mortgage/MortgageContactForm": { MortgageContactForm: "MortgageContactForm" },
      "./MortgageContactForm": { MortgageContactForm: "MortgageContactForm" },
    });
    d.mount(() => editing ? page.MortgageContactDetail({ leadId: contact.id, canEdit: true, onClose() {}, onChanged() {} }) : page.Body());
    let nodes = formNodes(await d.flush());
    const open = nodes.find((node) => editing ? node.type === "MortgageIconButton" && node.props.label === "Изменить контакт"
      : node.type === "button" && JSON.stringify(node.props.children).includes("Новый контакт"));
    assert.ok(open);open.props.onClick();nodes = formNodes(await d.flush());
    const forms = nodes.filter((node) => node.type === "MortgageContactForm");
    assert.equal(forms.length, 1);
    assert.equal(forms[0].props.request, workspace.request);
    assert.equal(forms[0].props.isCurrent, workspace.isCurrent);
    assert.equal("members" in forms[0].props, false);
    assert.equal(forms[0].props.contact, editing ? contact : undefined);
    assert.ok(queries.every((query) => editing ? query.leadId === contact.id : query.q === "" && query.page === 0));
    forms[0].props.onClose();nodes = formNodes(await d.flush());
    assert.equal(nodes.some((node) => node.type === "MortgageContactForm"), false);d.unmount();
  }
});

test("new-contact picker uses bound lead-assignees only, defaults unassigned and explicitly submits admin self", async () => {
  assert.doesNotMatch(contactFormSource, /useMortgageWorkspace/);
  assert.doesNotMatch(contactFormSource, /\bmembers\b/);
  const allowed = [{ id: selfStaffId, name: "Synthetic current admin" }, { id: otherStaffId, name: "Synthetic lead manager" }];
  const f = contactFormFixture(async () => response({ assignees: allowed }));
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, `/api/crm/lead-assignees?workspaceId=${scope.workspaceId}`);
  assert.ok(f.requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.field("responsible").props.value, "");
  assert.deepEqual(f.nodes().filter((node) => node.type === "option").map((node) => node.props.value), ["", selfStaffId, otherStaffId]);
  f.field("name").props.onChange({ target: { value: "Synthetic new contact" } });
  f.field("phone").props.onChange({ target: { value: "+77000000000" } });
  f.field("responsible").props.onChange({ target: { value: selfStaffId } });
  await f.flush(); await f.submit();
  assert.equal(f.submitted[0].responsibleUserId, selfStaffId);
  assert.equal(f.isClosed(), true);
  f.d.unmount();
});

test("contact picker reuses the parent's actual bound transport without a snapshot read", async () => {
  const requests: any[] = [], session = moduleFixture(driver(), async (path, init) => {
    requests.push({ path, init });
    return response({ assignees: [{ id: selfStaffId, name: "Synthetic admin" }] });
  });
  const adminScope = { ...scope, role: "admin" }, live = { current: adminScope };
  session.d.mount(() => session.module.fixture.MortgageSession({ scope: adminScope, live, children: "Synthetic form" }));
  const provider = await session.d.flush(), access = provider.props.value;
  const f = contactFormFixture(async () => { throw new Error("Only the parent's transport is permitted"); }, false, access);
  await f.flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/api/crm/lead-assignees?workspaceId=${scope.workspaceId}`);
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.expectedUserId, scope.actorId);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.nodes().filter((node) => node.type === "option").length, 2);
  const listener = [...session.listeners][0];
  listener("SIGNED_OUT", null);
  assert.equal(access.isCurrent(), false); assert.equal(requests[0].init.signal.aborted, true);
  f.d.unmount(); session.d.unmount();
});

test("contact picker never falls back to members after failed, malformed or stale responses", async () => {
  for (const fetcher of [
    async () => new Response("{}", { status: 403 }),
    async () => { throw new Error("Local outage"); },
    async () => response({ assignees: [{ id: selfAuthId }] }),
    async () => response({ assignees: [{ id: selfStaffId, name: "One" }, { id: selfStaffId, name: "Duplicate" }] }),
  ]) {
    const f = contactFormFixture(fetcher); await f.flush();
    assert.equal(f.field("responsible").props.disabled, true);
    assert.deepEqual(f.nodes().filter((node) => node.type === "option").map((node) => node.props.value), [""]);
    f.field("name").props.onChange({ target: { value: "Synthetic contact" } });
    f.field("phone").props.onChange({ target: { value: "+77000000000" } });
    f.field("responsible").props.onChange({ target: { value: otherStaffId } });
    await f.flush(); await f.submit(); assert.equal(f.submitted.length, 0); f.d.unmount();
  }
  const pending = defer<Response>(), stale = contactFormFixture(() => pending.promise);
  await stale.flush(); stale.revoke(); const writes = stale.d.writes.length;
  pending.resolve(response({ assignees: [{ id: selfStaffId, name: "Stale" }] }));
  await stale.flush(); assert.equal(stale.d.writes.length, writes); assert.equal(stale.submitted.length, 0); stale.d.unmount();
  const editing = contactFormFixture(async () => { throw new Error("Editing must not list assignees"); }, true);
  await editing.flush(); assert.equal(editing.requests.length, 0); editing.d.unmount();
});

function adminMeetingFixture({ role = "admin", memberRole = "admin", memberStatus = "active", context = {},
  fetcher }: { role?: string; memberRole?: string; memberStatus?: string; context?: Record<string, unknown>; fetcher?: () => Promise<Response> } = {}) {
  const d = driver(), drafts: any[] = [], requests: any[] = [];
  let captured: any, current = true;
  const workspace = { data: { ...snapshot(), members: [{ id: selfStaffId, name: "Synthetic self", role: memberRole, status: memberStatus }] },
    isCurrent: () => current, searchContacts: async () => [], saveActivity: async (draft: any) => { drafts.push(draft); },
    request: async (path: string, init: any) => {
      requests.push({ path, init });
      return fetcher ? fetcher() : response({ workspaceId: scope.workspaceId, purpose: "mortgage_leads", role: "admin", staffUserId: selfStaffId, ...context });
    } };
  const observed = dialogSource.replace("return <DialogContent", "__capture({ submit, loaded, setTitle, error, manager }); return <DialogContent") + "\nexports.fixture = { ActivityForm };";
  const form = evaluate(observed, { react: d.hooks, "@/lib/mortgage-workspace": pure,
    "@/contexts/AuthContext": { useAuth: () => ({ clinicId: scope.workspaceId, userRole: role, user: { id: selfAuthId } }) } },
  { __capture: (value: any) => { captured = value; } });
  d.mount(() => form.fixture.ActivityForm({ workspace, kind: "meeting", leadId: contact.id, timeZone: snapshot().timeZone, onOpenChange() {} }));
  const ready = async () => { await d.flush(); captured.loaded({ ...contact, responsibleUserId: selfStaffId }, ""); captured.setTitle("Synthetic self meeting"); await d.flush(); };
  return { d, drafts, requests, ready, captured: () => captured, revoke: () => { current = false; } };
}

test("admin self meetings use the selected verified STAFF id, not the authentication id", async () => {
  const f = adminMeetingFixture(); await f.ready();
  assert.notEqual(selfStaffId, selfAuthId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, `/api/crm/auth-context?workspaceId=${scope.workspaceId}`);
  assert.ok(f.requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.captured().manager.id, selfStaffId);
  await f.captured().submit({ preventDefault() {} });
  assert.equal(f.drafts.length, 1); assert.equal(f.drafts[0].responsibleUserId, undefined); f.d.unmount();
});

test("meeting admin exception rejects other admins, owner, inactive, foreign, missing and forged identity responses", async () => {
  for (const options of [
    { context: { staffUserId: otherStaffId } }, { context: { staffUserId: selfAuthId } },
    { context: { staffUserId: null } }, { context: { staffUserId: "invalid" } },
    { context: { workspaceId: "foreign-workspace" } }, { context: { role: "owner" } },
    { context: { purpose: "clinic_services" } }, { role: "owner" }, { role: "lead_manager" },
    { memberRole: "owner" }, { memberStatus: "inactive" },
    { fetcher: async () => new Response("{}", { status: 403 }) },
    { fetcher: async () => { throw new Error("Local context outage"); } },
  ]) {
    const f = adminMeetingFixture(options); await f.ready();
    assert.equal(f.captured().manager, undefined, JSON.stringify(options));
    await f.captured().submit({ preventDefault() {} });
    assert.equal(f.drafts.length, 0); f.d.unmount();
  }
  const pending = defer<Response>(), f = adminMeetingFixture({ fetcher: () => pending.promise });
  await f.ready(); assert.equal(f.captured().manager, undefined);
  f.revoke(); const writes = f.d.writes.length;
  pending.resolve(response({ workspaceId: scope.workspaceId, role: "admin", purpose: "mortgage_leads", staffUserId: selfStaffId }));
  await f.d.flush(); assert.equal(f.d.writes.length, writes);
  await f.captured().submit({ preventDefault() {} }); assert.equal(f.drafts.length, 0); f.d.unmount();
});

test("active lead-manager meetings remain valid for owner, admin and lead-manager actors", async () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    const f = adminMeetingFixture({ role, memberRole: "lead_manager", fetcher: async () => { throw new Error("Local context unavailable"); } });
    await f.ready(); assert.equal(f.captured().manager.id, selfStaffId);
    await f.captured().submit({ preventDefault() {} }); assert.equal(f.drafts.length, 1); f.d.unmount();
  }
});

test("the form blocks inactive/unassigned meeting managers, permits tasks without due dates, and blocks double submit", async () => {
  for (const kind of ["meeting", "task"]) {
    const d = driver(); let captured: any; const pending = defer<void>(); const drafts: any[] = [];
    const workspace = { data: { ...snapshot(), members: [] }, isCurrent: () => true, searchContacts: async () => [], saveActivity: async (draft: any) => { drafts.push(draft); return pending.promise; } };
    const observed = dialogSource.replace("return <DialogContent", "__capture({ submit, loaded, setTitle, error }); return <DialogContent") + "\nexports.fixture = { ActivityForm };";
    const form = evaluate(observed, { react: d.hooks, "@/lib/mortgage-workspace": pure, "@/contexts/AuthContext": formAuth }, { __capture: (value: any) => { captured = value; } });
    d.mount(() => form.fixture.ActivityForm({ workspace, kind, leadId: contact.id, timeZone: snapshot().timeZone, onOpenChange() {} }));
    await d.flush(); captured.loaded(contact, ""); captured.setTitle("Local task"); await d.flush();
    const first = captured.submit({ preventDefault() {} });
    await captured.submit({ preventDefault() {} });
    if (kind === "meeting") { await first; await d.flush(); assert.equal(drafts.length, 0); assert.match(captured.error, /активный менеджер/); }
    else { assert.equal(drafts.length, 1); assert.equal(drafts[0].dueAt, null); assert.equal(drafts[0].startsAt, null); pending.resolve(); await first; }
    d.unmount();
  }
});

function creationPage(kind: "meeting" | "task", initialSearch: string) {
  const d = driver();
  let search = initialSearch;
  const pathname = kind === "meeting" ? "/appointments" : "/tasks";
  const calls: Array<{ url: string; replace: boolean }> = [];
  const workspace: any = { data: null, loading: false, error: "", refresh() {} };
  let captured: any;
  let page: Record<string, any>;
  const mount = () => d.mount(() => page.Body());
  const navigate = (url: string, options: { replace?: boolean }) => {
    calls.push({ url, replace: Boolean(options.replace) });
    search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    mount();
  };
  const input = kind === "meeting" ? calendarSource : taskSource;
  const body = kind === "meeting" ? "MortgageCalendarBody" : "MortgageTasksBody";
  page = evaluate(input.replace("return <PageLayout>", "__capture({ editor, setEditor }); return <PageLayout>") + `\nexports.Body = ${body};`, {
    react: d.hooks, wouter: { useSearch: () => search, useLocation: () => [pathname, navigate], Link: "Link" },
    "@/lib/clinicDay": clinicDay, "@/lib/dayGrid": dayGrid,
    "@/lib/mortgage-workspace": { ...pure, useMortgageWorkspace: () => workspace },
  }, { __capture: (value: any) => { captured = value; }, window: { setInterval: () => 1, clearInterval() {} } });
  mount();
  return { d, calls, workspace, mount, editor: () => captured.editor,
    close() { captured.setEditor(null); }, search: () => search,
    setSearch(value: string) { search = value; mount(); } };
}

function readFilterSnapshot(kind: "meeting" | "task") {
  const data = snapshot(), day = clinicDay.dayKeyInZone(Date.now(), data.timeZone);
  return { ...data, members: [
    ...data.members,
    { id: selfStaffId, name: "Synthetic current admin", role: "admin", status: "active" },
    { id: otherStaffId, name: "Synthetic peer admin", role: "admin", status: "active" },
    { id: "inactive-admin", name: "Synthetic inactive admin", role: "admin", status: "inactive" },
    { id: "inactive-manager", name: "Synthetic former manager", role: "lead_manager", status: "inactive" },
    { id: "owner", name: "Synthetic owner", role: "owner", status: "active" },
  ], activities: [selfStaffId, otherStaffId, "local-manager"].map((id) => activity({
    id: `${kind}-${id}`, kind, title: `Synthetic work for ${id}`, responsibleUserId: id,
    startsAt: kind === "meeting" ? `${day}T10:00:00+05:00` : null,
    endsAt: kind === "meeting" ? `${day}T11:00:00+05:00` : null,
  })) };
}

const responsibleSelect = (tree: unknown) => formNodes(tree).find((node) => node.type === "select" && node.props["aria-label"] === "Ответственный")!;
const listedActivityIds = (tree: unknown) => formNodes(tree).filter((node) => node.type === "li").map((node) => node.key);

for (const kind of ["meeting", "task"] as const) {
  test(`${kind} read filter includes active admins, retains managers and only narrows already-scoped work`, async () => {
    const f = creationPage(kind, ""), data = readFilterSnapshot(kind), original = JSON.stringify(data);
    let writes = 0;
    f.workspace.data = data;
    f.workspace.saveActivity = async () => { writes += 1; throw new Error("A read filter must not write"); };
    let tree = await f.d.flush();
    const options = formNodes(responsibleSelect(tree)).filter((node) => node.type === "option");
    assert.deepEqual(options.map((node) => node.props.value), ["all", "local-manager", selfStaffId, otherStaffId, "inactive-manager"]);
    assert.match(JSON.stringify(options.find((node) => node.props.value === "inactive-manager")), /неактивен/);
    assert.equal(listedActivityIds(tree).length, 3);
    for (const id of [selfStaffId, otherStaffId, "local-manager"]) {
      responsibleSelect(tree).props.onChange({ target: { value: id } });
      tree = await f.d.flush();
      assert.deepEqual(listedActivityIds(tree), [`${kind}-${id}`]);
    }
    responsibleSelect(tree).props.onChange({ target: { value: "all" } });
    tree = await f.d.flush();assert.equal(listedActivityIds(tree).length, 3);
    assert.equal(writes, 0);assert.equal(f.calls.length, 0);
    assert.equal(data.metrics.activeManagers, 1);assert.equal(JSON.stringify(data), original);
    f.d.unmount();

    const own = creationPage(kind, "");
    own.workspace.data = { ...data, members: [data.members[0]], activities: data.activities.filter((item) => item.responsibleUserId === "local-manager") };
    const ownTree = await own.d.flush();
    assert.deepEqual(formNodes(responsibleSelect(ownTree)).filter((node) => node.type === "option").map((node) => node.props.value), ["all", "local-manager"]);
    assert.deepEqual(listedActivityIds(ownTree), [`${kind}-local-manager`]);own.d.unmount();
  });

  test(`${kind} individual filters reuse the authorized HTTP snapshot without broader reads or writes`, async () => {
    const data = readFilterSnapshot(kind), requests: any[] = [];
    const session = moduleFixture(driver(), async (path, init) => { requests.push({ path, init }); return response(data); });
    const boundScope = { ...scope, role: "admin" }, live = { current: boundScope };
    session.d.mount(() => session.module.fixture.MortgageSession({ scope: boundScope, live, children: "Synthetic read filters" }));
    const access = (await session.d.flush()).props.value;
    const page = moduleFixture();page.d.setContext(access);
    const body = kind === "meeting" ? "MortgageCalendarBody" : "MortgageTasksBody";
    const input = kind === "meeting" ? calendarSource : taskSource;
    const rendered = evaluate(input + `\nexports.Body = ${body};`, {
      react: page.d.hooks, wouter: { useSearch: () => "", useLocation: () => [kind === "meeting" ? "/appointments" : "/tasks", () => { throw new Error("No navigation expected"); }], Link: "Link" },
      "@/lib/clinicDay": clinicDay, "@/lib/dayGrid": dayGrid, "@/lib/mortgage-workspace": page.module,
    }, { window: { setInterval: () => 1, clearInterval() {} } });
    page.d.mount(() => rendered.Body());
    let tree = await page.d.flush();
    const initialReads = requests.length;assert.ok(initialReads > 0);
    assert.ok(requests.every(({ path, init }) => path.startsWith("/api/crm/mortgage-workspace?")
      && new URL(path, "http://fixture.invalid").searchParams.get("workspaceId") === scope.workspaceId
      && (init.method ?? "GET") === "GET" && init.cache === "no-store" && init.expectedUserId === scope.actorId));
    responsibleSelect(tree).props.onChange({ target: { value: selfStaffId } });
    tree = await page.d.flush();assert.deepEqual(listedActivityIds(tree), [`${kind}-${selfStaffId}`]);
    responsibleSelect(tree).props.onChange({ target: { value: otherStaffId } });
    tree = await page.d.flush();assert.deepEqual(listedActivityIds(tree), [`${kind}-${otherStaffId}`]);
    assert.equal(requests.length, initialReads, 'filtering must not request additional workspace or assignee data');
    [...session.listeners][0]("SIGNED_OUT", null);
    tree = page.d.paint();assert.deepEqual(listedActivityIds(tree), []);
    assert.deepEqual(formNodes(responsibleSelect(tree)).filter((node) => node.type === "option").map((node) => node.props.value), ["all"]);
    page.d.unmount();session.d.unmount();
  });

  test(`${kind} creation consumes only the one-shot URL intent after data is ready`, async () => {
    const f = creationPage(kind, "leadId=local-client&new=1&keep=two%20words");
    await f.d.flush(); assert.equal(f.editor(), null); assert.equal(f.calls.length, 0);
    f.workspace.data = snapshot(); f.mount(); await f.d.flush();
    assert.ok(f.editor()); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].replace, true);
    const params = new URLSearchParams(f.search());
    assert.equal(params.get("new"), null); assert.equal(params.get("leadId"), "local-client");
    assert.equal(params.get("keep"), "two words");
    await f.d.replay(); assert.equal(f.calls.length, 1);
    f.close(); await f.d.flush(); assert.equal(f.editor(), null);
    f.setSearch("leadId=local-client&new=1&keep=two%20words"); await f.d.flush();
    assert.ok(f.editor()); assert.equal(f.calls.length, 2);
    const cleaned = f.search(); f.d.unmount();
    const reloaded = creationPage(kind, cleaned);
    reloaded.workspace.data = snapshot(); await reloaded.d.flush();
    assert.equal(reloaded.editor(), null); assert.equal(reloaded.calls.length, 0); reloaded.d.unmount();
  });

  test(`${kind} ordinary navigation and non-create flags do not open a dialog`, async () => {
    for (const search of ["", "leadId=local-client", "leadId=local-client&new=0"]) {
      const f = creationPage(kind, search);
      f.workspace.data = snapshot(); await f.d.flush();
      assert.equal(f.editor(), null); assert.equal(f.calls.length, 0); f.d.unmount();
    }
  });
}

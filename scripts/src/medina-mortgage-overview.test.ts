import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute local TSX and its presentation helpers only; never bootstrap auth, HTTP or the app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, "artifacts/negis/src", file), "utf8");
const overviewSource = await read("pages/MortgageOverview.tsx");
const primitiveSource = await read("components/mortgage/MortgagePrimitives.tsx");
const daySource = await read("lib/clinicDay.ts");
const phoneSource = await read("lib/phone.ts");

type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });
const iconImports = new Proxy({}, { get: (_target, name) => `icon-${String(name)}` });
const tooltipImports = new Proxy({}, { get: () => ({ children }: Node["props"]) => children });
const router = { Link: (props: Node["props"]) => jsx("a", props) };

function evaluate(input: string, imports: Record<string, unknown>, bindings: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Script(code).runInNewContext({ exports, ...bindings, require(name: string) {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "lucide-react") return iconImports;
    throw new Error(`Overview fixture forbids unmocked import: ${name}`);
  } });
  return exports;
}

function render(value: any): any {
  if (Array.isArray(value)) return value.map(render);
  if (!value || typeof value !== "object") return value;
  if (typeof value.type === "function") return render(value.type(value.props));
  return { ...value, props: { ...value.props, children: render(value.props.children) } };
}

function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !value.props) return [];
  return [value, ...nodes(value.props.children)];
}

function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join(" ").replace(/\s+/g, " ").trim();
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.props ? text(value.props.children) : "";
}

const compact = (value: string) => value.replace(/\s/g, "");
const countText = (value: number) => compact(value.toLocaleString("ru-RU"));
const find = (tree: any, predicate: (node: Node) => boolean) => {
  const node = nodes(tree).find(predicate);
  assert.ok(node, "Expected a rendered overview element");
  return node;
};
const section = (tree: any, id: string) => find(tree, (node) => node.type === "section" && node.props["aria-labelledby"] === id);
const button = (tree: any, label: string) => find(tree, (node) => node.type === "button" && (node.props["aria-label"] === label || text(node) === label));
const links = (tree: any, href: string) => nodes(tree).filter((node) => node.type === "a" && node.props.href === href);
const rows = (tree: any) => nodes(tree).filter((node) => node.type === "li");
const frozenNow = Date.parse("2026-10-15T19:30:00Z");

const contact = (overrides: Record<string, any> = {}) => ({
  id: "synthetic-assigned", name: "Synthetic assigned client", phone: "+77000001111", notes: "",
  status: "new", source: "manual", createdAt: "2026-10-15T19:10:00Z", updatedAt: "2026-10-15T19:10:00Z",
  responsibleUserId: "synthetic-manager", responsibleName: "Synthetic assigned manager", ...overrides,
});
const unassignedContact = () => contact({
  id: "synthetic-unassigned", name: "Synthetic unassigned client", phone: "+77000002222",
  responsibleUserId: null, responsibleName: null,
});
const activity = (overrides: Record<string, any> = {}) => ({
  id: "synthetic-meeting", kind: "meeting", leadId: "synthetic-assigned", title: "Synthetic upcoming meeting",
  contactName: "Synthetic activity client", notes: "", priority: "normal", status: "open",
  startsAt: "2026-10-16T00:10:00Z", endsAt: "2026-10-16T01:10:00Z", dueAt: null,
  createdAt: "2026-10-15T10:00:00Z", updatedAt: "2026-10-15T10:00:00Z",
  responsibleUserId: "synthetic-manager", responsibleName: "Synthetic activity manager", ...overrides,
});
const task = (overrides: Record<string, any> = {}) => activity({
  id: "synthetic-task", kind: "task", title: "Synthetic overdue task", priority: "high",
  startsAt: null, endsAt: null, dueAt: "2026-10-15T18:50:00Z", ...overrides,
});
const snapshot = (overrides: Record<string, any> = {}) => ({
  timeZone: "Asia/Qyzylorda", contacts: [unassignedContact(), contact()], contactsTotal: 18731,
  activities: [activity(), task()], activitiesTruncated: false,
  members: [{ id: "synthetic-manager", name: "Synthetic team manager", role: "lead_manager", status: "active" }],
  events: [], metrics: {
    totalLeads: 11231, inProgressLeads: 21331, meetingsToday: 31431, overdueTasks: 41531,
    unassignedLeads: 51631, activeManagers: 61731,
  },
  memberMetrics: [
    { id: "synthetic-team-a", name: "Synthetic team alpha", role: "lead_manager", assignedLeads: 71831,
      openTasks: 81931, overdueTasks: 92031, doneTasks: 12131, plannedMeetings: 22231, doneMeetings: 32331, missedMeetings: 0 },
    { id: "synthetic-team-b", name: "Synthetic team beta", role: "admin", assignedLeads: 42431,
      openTasks: 52531, overdueTasks: 0, doneTasks: 62631, plannedMeetings: 72731, doneMeetings: 82831, missedMeetings: 0 },
  ],
  periodDays: 37, page: 0, pageSize: 100, ...overrides,
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(role = "owner", initialData: any = snapshot()) {
  let now = frozenNow, cursor = 0, dirty = false, current = true, refreshes = 0, intervalId = 0;
  const slots: any[] = [], pending: Array<() => void> = [], writes: string[] = [];
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  class FixtureDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? now : value instanceof Date ? value.getTime() : value); }
    static now() { return now; }
    getDate() { return this.getUTCDate(); }
    getMonth() { return this.getUTCMonth(); }
    getFullYear() { return this.getUTCFullYear(); }
    getDay() { return this.getUTCDay(); }
    getHours() { return this.getUTCHours(); }
    getMinutes() { return this.getUTCMinutes(); }
    getTimezoneOffset() { return 0; }
  }
  // The fixture device is UTC, deliberately different from the workspace timezone.
  class FixtureDateTimeFormat extends Intl.DateTimeFormat {
    constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      super(locales, { timeZone: "UTC", ...options });
    }
  }
  const bindings = { Date: FixtureDate, Intl: new Proxy(Intl, {
    get(target, key) { return key === "DateTimeFormat" ? FixtureDateTimeFormat : Reflect.get(target, key); },
  }), window: {
    setInterval(callback: () => void, delay: number) { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id: number) { intervals.delete(id); },
  } };
  const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update: any) => {
        const next = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useEffect(create: () => any, deps?: unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = create(); });
      slots[index] = { deps, cleanup: previous?.cleanup };
    },
  };
  const auth = { clinicId: "synthetic-workspace", userRole: role,
    availableWorkspaces: [{ id: "synthetic-workspace", name: "Synthetic Baspana" }] };
  const mutation = (name: string) => () => { writes.push(name); throw new Error(`Overview attempted ${name}`); };
  const workspace = {
    data: freeze(initialData), loading: false, error: "", isCurrent: () => current,
    refresh: async () => { refreshes += 1; },
    saveActivity: mutation("saveActivity"), createContact: mutation("createContact"), updateContact: mutation("updateContact"),
    request: mutation("request"), searchContacts: mutation("searchContacts"),
  };
  const primitives = evaluate(primitiveSource, { wouter: router, "@/components/ui/tooltip": tooltipImports }, bindings);
  const day = evaluate(daySource, {}, bindings);
  const phone = evaluate(phoneSource, {}, bindings);
  const module = evaluate(`${overviewSource}\nexports.fixture = { MortgageOverviewBody, OverviewActivity };`, {
    react: hooks, wouter: router, "@/components/layout/PageLayout": { PageLayout: "FixturePageLayout" },
    "@/contexts/AuthContext": { useAuth: () => auth }, "@/lib/phone": phone, "@/lib/clinicDay": day,
    "@/lib/mortgage-workspace": { MortgageScope: "FixtureMortgageScope", useMortgageWorkspace: () => workspace },
    "@/components/mortgage/MortgagePrimitives": primitives,
  }, bindings);
  const paint = () => {
    let output: any;
    for (let pass = 0; pass < 20; pass++) {
      dirty = false; cursor = 0;
      output = render(module.fixture.MortgageOverviewBody());
      for (const effect of pending.splice(0)) effect();
      if (!dirty) return output;
    }
    throw new Error("Overview fixture did not settle");
  };
  return { auth, workspace, module, paint, writes, intervals, refreshes: () => refreshes,
    revoke() { current = false; },
    tick(instant: number) { now = instant; for (const { callback } of intervals.values()) callback(); return paint(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("overview retains the page and mortgage-scope wrapper without bootstrapping the app", () => {
  const f = fixture(), tree = f.module.default();
  assert.equal(tree.type, "FixturePageLayout");
  assert.equal(tree.props.children.type, "FixtureMortgageScope");
  assert.equal(tree.props.children.props.children.type, f.module.fixture.MortgageOverviewBody);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

for (const role of ["owner", "admin"]) test(`${role} sees actual team loads, unassigned contacts and analytics links`, () => {
  const data = snapshot(), f = fixture(role, data), tree = f.paint();
  const team = section(tree, "mortgage-team-load"), contacts = section(tree, "mortgage-overview-contacts");
  assert.match(text(team), /Нагрузка команды/);
  assert.match(text(team), /Назначенные заявки.*сейчас/);
  assert.ok(links(team, "/analytics").length);
  for (const member of data.memberMetrics) {
    const row = rows(team).find((node) => text(node).includes(member.name));
    assert.ok(row, "Render every returned member metric, including admin rows");
    assert.ok(compact(text(row)).includes(countText(member.assignedLeads)));
    assert.match(text(row), /Задач:.*Плановых встреч:/);
  }
  assert.match(text(team), /Отметки сотрудников.*37 дней/);
  assert.ok(compact(text(team)).includes(countText(data.memberMetrics.reduce((sum, member) => sum + member.doneTasks, 0))));
  assert.ok(compact(text(team)).includes(countText(data.memberMetrics.reduce((sum, member) => sum + member.doneMeetings, 0))));
  assert.match(text(contacts), /Заявки без ответственного/);
  assert.match(text(contacts), /Synthetic unassigned client/);
  assert.doesNotMatch(text(contacts), /Synthetic assigned client/);
  assert.ok(links(contacts, "tel:+77000002222").length);
  assert.ok(compact(text(tree)).includes(countText(data.metrics.unassignedLeads)));
  assert.match(text(tree), new RegExp(`Активные менеджеры: ${data.metrics.activeManagers}`));
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("lead_manager hides all team metrics, unassigned rows and analytics even in a broad snapshot", () => {
  const data = snapshot(), f = fixture("lead_manager", data), tree = f.paint();
  assert.match(text(tree), /Мой рабочий день/);
  assert.match(text(tree), /Мои заявки/);
  assert.match(text(tree), /Моя работа/);
  assert.match(text(section(tree, "mortgage-overview-contacts")), /Synthetic assigned client/);
  assert.equal(links(tree, "/analytics").length, 0);
  assert.doesNotMatch(text(tree), /команд|без ответственного|Активные менеджеры|Отметки сотрудников|Завершили задач|Завершили встреч/i);
  const serialized = compact(JSON.stringify(tree));
  for (const forbidden of ["Synthetic team alpha", "Synthetic team beta", unassignedContact().name, unassignedContact().phone]) {
    assert.ok(!serialized.includes(compact(forbidden)), `Manager must not render ${forbidden}`);
  }
  for (const value of [data.metrics.unassignedLeads, data.metrics.activeManagers, ...data.memberMetrics.flatMap((member) =>
    [member.assignedLeads, member.openTasks, member.overdueTasks, member.doneTasks, member.plannedMeetings, member.doneMeetings]).filter(Boolean)]) {
    assert.ok(!serialized.includes(countText(value)), `Manager must not render team-only count ${value}`);
  }
  button(tree, "Задачи").props.onClick();
  assert.doesNotMatch(text(f.paint()), /команд|без ответственного|Отметки сотрудников/i);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

for (const state of ["loading", "error", "stale", "missing-workspace", "missing-data"] as const) {
  test(`${state} hides previously loaded names, phones, activities and all snapshot counts`, () => {
    const data = snapshot(), f = fixture("owner", data);
    assert.match(text(f.paint()), /Synthetic unassigned client/);
    if (state === "loading") f.workspace.loading = true;
    if (state === "error") f.workspace.error = "Synthetic local read failure";
    if (state === "stale") f.revoke();
    if (state === "missing-workspace") f.auth.clinicId = "";
    if (state === "missing-data") f.workspace.data = null;
    const tree = f.paint(), serialized = compact(JSON.stringify(tree));
    for (const forbidden of [contact().name, contact().phone, unassignedContact().name, unassignedContact().phone,
      activity().title, activity().contactName, activity().responsibleName, "Synthetic team alpha", "Synthetic team beta"]) {
      assert.ok(!serialized.includes(compact(forbidden)), `${state} leaked ${forbidden}`);
    }
    for (const value of [...Object.values(data.metrics), data.contactsTotal, ...data.memberMetrics.flatMap((member) =>
      [member.assignedLeads, member.openTasks, member.overdueTasks, member.doneTasks, member.plannedMeetings, member.doneMeetings]).filter(Boolean)]) {
      assert.ok(!serialized.includes(countText(value)), `${state} leaked count ${value}`);
    }
    assert.equal(nodes(tree).filter((node) => node.type === "dl").length, 0);
    assert.equal(rows(tree).length, 0);
    assert.ok(nodes(tree).some((node) => ["status", "alert"].includes(node.props.role)));
    if (state === "loading" || state === "stale") assert.equal(button(tree, "Обновить обзор").props.disabled, true);
    assert.deepEqual(f.writes, []);
    f.dispose();
  });
}

test("refresh and retry call the workspace refresh while revoked handlers and agenda controls never mutate", async () => {
  const f = fixture(), original = JSON.stringify(f.workspace.data);
  let tree = f.paint();
  assert.equal(button(tree, "Обновить обзор").props.disabled, false);
  button(tree, "Обновить обзор").props.onClick();
  await Promise.resolve(); assert.equal(f.refreshes(), 1);
  f.workspace.error = "Synthetic refresh failure";
  tree = f.paint();
  button(tree, "Повторить").props.onClick();
  await Promise.resolve(); assert.equal(f.refreshes(), 2);
  f.workspace.error = ""; tree = f.paint();
  const oldRefresh = button(tree, "Обновить обзор"), oldTasks = button(tree, "Задачи");
  f.revoke(); oldRefresh.props.onClick(); oldTasks.props.onClick();
  await Promise.resolve(); assert.equal(f.refreshes(), 2);
  assert.equal(rows(f.paint()).length, 0);
  assert.equal(JSON.stringify(f.workspace.data), original);
  assert.deepEqual(f.writes, []);
  f.dispose(); assert.equal(f.intervals.size, 0);
});

test("agenda tabs render the real activity helpers, sort and cap samples, and only navigate", () => {
  const meetings = Array.from({ length: 7 }, (_, i) => activity({ id: `meeting-${i}`, title: `Upcoming ${i}`,
    startsAt: `2026-10-16T0${i}:10:00Z`, endsAt: `2026-10-16T0${i}:50:00Z` })).reverse();
  const tasks = Array.from({ length: 7 }, (_, i) => task({ id: `task-${i}`, title: `Task ${i}`, dueAt: `2026-10-15T0${i}:10:00Z` })).reverse();
  const data = snapshot({ activities: [activity({ id: "ended", title: "Excluded ended meeting", startsAt: "2026-10-15T17:00:00Z", endsAt: "2026-10-15T18:00:00Z" }),
    activity({ id: "cancelled", title: "Excluded cancelled meeting", status: "cancelled" }),
    task({ id: "done", title: "Excluded done task", status: "done" }), ...meetings, ...tasks] });
  const f = fixture("owner", data), original = JSON.stringify(data);
  let tree = f.paint(), agenda = section(tree, "mortgage-agenda");
  assert.equal(button(agenda, "Встречи").props["aria-pressed"], true);
  assert.equal(button(agenda, "Задачи").props["aria-pressed"], false);
  assert.deepEqual(rows(agenda).map((row) => text(row).match(/Upcoming \d/)?.[0]), ["Upcoming 0", "Upcoming 1", "Upcoming 2", "Upcoming 3", "Upcoming 4"]);
  assert.equal(links(agenda, "/appointments").length, 1);
  assert.ok(links(agenda, "/appointments?leadId=synthetic-assigned").length);
  assert.ok(links(agenda, "/clients?leadId=synthetic-assigned").length);
  assert.doesNotMatch(text(agenda), /Excluded|Task \d|Upcoming [56]/);
  button(agenda, "Задачи").props.onClick(); tree = f.paint(); agenda = section(tree, "mortgage-agenda");
  assert.equal(button(agenda, "Задачи").props["aria-pressed"], true);
  assert.equal(button(agenda, "Встречи").props["aria-pressed"], false);
  assert.deepEqual(rows(agenda).map((row) => text(row).match(/Task \d/)?.[0]), ["Task 0", "Task 1", "Task 2", "Task 3", "Task 4"]);
  assert.equal(links(agenda, "/tasks").length, 1);
  assert.match(text(agenda), /Просрочено.*Высокий приоритет/);
  assert.doesNotMatch(text(agenda), /Excluded|Upcoming|Task [56]/);
  button(agenda, "Встречи").props.onClick();
  assert.match(text(section(f.paint(), "mortgage-agenda")), /Upcoming 0/);
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(f.writes, []);
  assert.equal(f.refreshes(), 0);
  f.dispose();
});

test("empty activity samples retain server totals and never claim that all work is absent", () => {
  const data = snapshot({ activities: [], activitiesTruncated: true, contacts: [], memberMetrics: [] });
  const f = fixture("owner", data);
  let tree = f.paint();
  assert.match(text(tree), /Встречи и задачи: неполная выборка.*Счётчики полные/);
  assert.match(text(section(tree, "mortgage-agenda")), /В выборке нет ближайших встреч/);
  for (const [label, value] of [["Всего заявок", data.metrics.totalLeads], ["В работе", data.metrics.inProgressLeads],
    ["Встречи сегодня", data.metrics.meetingsToday], ["Просроченные задачи", data.metrics.overdueTasks]] as const) {
    const metric = find(tree, (node) => node.type === "a" && compact(node.props["aria-label"] || "") === compact(`${label}: ${value.toLocaleString("ru-RU")}`));
    assert.equal(compact(text(metric)), countText(value), "Counts come from full server metrics, not the returned rows");
  }
  assert.match(text(section(tree, "mortgage-overview-contacts")), /вне текущей страницы контактов/);
  assert.match(text(section(tree, "mortgage-team-load")), /Нет данных по сотрудникам/);
  assert.doesNotMatch(text(tree), /Все заявки назначены|Просроченных задач нет|Ближайших встреч нет/);
  button(tree, "Задачи").props.onClick(); tree = f.paint();
  assert.match(text(section(tree, "mortgage-agenda")), /В выборке нет открытых задач/);
  assert.ok(compact(text(tree)).includes(countText(data.metrics.overdueTasks)));
  f.dispose();
});

test("contact previews label their displayed sample, retain full totals, and do not invent missing people", () => {
  const contacts = Array.from({ length: 8 }, (_, i) => ({ ...unassignedContact(), id: `unassigned-${i}`, name: `Synthetic preview ${i}` }));
  const data = snapshot({ contacts }), f = fixture("owner", data), tree = f.paint();
  const preview = section(tree, "mortgage-overview-contacts");
  assert.equal(rows(preview).length, 5);
  assert.match(text(preview), /Показано:?\s*5/);
  assert.doesNotMatch(text(preview), /В текущей странице:\s*5|Synthetic preview [567]/);
  assert.ok(compact(text(preview)).includes(countText(data.metrics.unassignedLeads)));
  assert.equal(rows(preview).filter((row) => text(row).includes("Без телефона")).length, 0);
  f.dispose();

  const empty = fixture("owner", snapshot({ contacts: [], activities: [], memberMetrics: [], metrics: {
    totalLeads: 0, inProgressLeads: 0, meetingsToday: 0, overdueTasks: 0, unassignedLeads: 0, activeManagers: 0,
  } }));
  const emptyTree = empty.paint();
  assert.match(text(section(emptyTree, "mortgage-overview-contacts")), /Все заявки назначены/);
  assert.equal(rows(emptyTree).length, 0);
  assert.doesNotMatch(text(emptyTree), /Synthetic (?:client|team|preview)|неполная выборка/);
  empty.dispose();
});

test("header, activity day labels, clock updates and contact dates use the clinic zone, not the UTC device", () => {
  const f = fixture(), data = f.workspace.data;
  let tree = f.paint();
  const header = find(tree, (node) => node.type === "header");
  const expectedDate = new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(frozenNow);
  assert.ok(text(header).includes(expectedDate));
  let row = rows(section(tree, "mortgage-agenda"))[0];
  assert.match(text(row), /05:10 Сегодня/);
  assert.match(text(row), /до 06:10/);
  button(tree, "Задачи").props.onClick(); tree = f.paint();
  row = rows(section(tree, "mortgage-agenda"))[0];
  assert.match(text(row), /23:50/);
  assert.doesNotMatch(text(row), /Сегодня/);
  const contactTime = find(section(tree, "mortgage-overview-contacts"), (node) => node.type === "time");
  const expectedContactDate = new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(unassignedContact().createdAt));
  assert.equal(text(contactTime), expectedContactDate);
  assert.equal(f.intervals.size, 1);
  assert.equal([...f.intervals.values()][0].delay, 60_000);
  button(tree, "Встречи").props.onClick();
  tree = f.tick(Date.parse("2026-10-16T19:30:00Z"));
  assert.match(text(section(tree, "mortgage-agenda")), /В выборке нет ближайших встреч/);
  const nextDate = new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(Date.parse("2026-10-16T19:30:00Z"));
  assert.ok(text(find(tree, (node) => node.type === "header")).includes(nextDate));
  f.dispose(); assert.equal(f.intervals.size, 0);
});

test("the actual activity helper handles negative and fractional zones and undated tasks", () => {
  const f = fixture();
  for (const [timeZone, now, startsAt, endsAt, expectedTime, sameDay] of [
    ["America/Los_Angeles", "2026-10-16T00:30:00Z", "2026-10-15T23:30:00Z", "2026-10-16T00:00:00Z", "16:30", true],
    ["Pacific/Chatham", "2026-10-15T10:30:00Z", "2026-10-15T09:30:00Z", "2026-10-15T10:00:00Z", "23:15", false],
  ] as const) {
    const row = render(f.module.fixture.OverviewActivity({ activity: activity({ startsAt, endsAt }), timeZone, now: Date.parse(now) }));
    assert.ok(text(row).includes(expectedTime));
    assert.equal(text(row).includes("Сегодня"), sameDay, timeZone);
  }
  const noDue = render(f.module.fixture.OverviewActivity({ activity: task({ dueAt: null }), timeZone: "Asia/Qyzylorda", now: frozenNow }));
  assert.match(text(noDue), /Без срока/);
  assert.doesNotMatch(text(noDue), /Просрочено|Сегодня/);
  assert.equal(find(noDue, (node) => node.type === "time").props.dateTime, undefined);
  f.dispose();
});

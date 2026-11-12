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
  if (typeof value.type === "function") {
    const output = value.type(value.props);
    return render(output?.props && value.key !== undefined ? { ...output, key: value.key } : output);
  }
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
const button = (tree: any, label: string) => find(tree, (node) => node.type === "button" && (node.props["aria-label"] === label
  || text(node) === label || [node.props.children].flat().some((child) => typeof child === "string" && child.trim() === label)));
const links = (tree: any, href: string) => nodes(tree).filter((node) => node.type === "a" && node.props.href === href);
const rows = (tree: any) => nodes(tree).filter((node) => node.type === "li");
const expectClasses = (node: Node, ...expected: string[]) => {
  const classes = String(node.props.className || "").split(/\s+/);
  for (const name of expected) assert.ok(classes.includes(name), `Expected ${node.type} to use ${name}`);
};
const expectAgenda = (tree: any, selected: "meetings" | "tasks") => {
  const agenda = section(tree, "mortgage-agenda");
  assert.equal(text(find(agenda, (node) => node.type === "h2")), "Ближайшие дела");
  assert.equal(button(agenda, "Встречи").props["aria-pressed"], selected === "meetings");
  assert.equal(button(agenda, "Задачи").props["aria-pressed"], selected === "tasks");
  assert.ok(links(agenda, selected === "meetings" ? "/appointments" : "/tasks").length);
  return agenda;
};
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
  generatedAt: "2026-10-20T12:00:00.123456Z", period: { days: 90, from: "2026-07-22T12:00:00.123456Z", to: "2026-10-20T12:00:00.123456Z" },
  periodDays: 90, page: 0, pageSize: 100, ...overrides,
});

function expectedMetrics(data: ReturnType<typeof snapshot>, role = "owner") {
  const teamAccess = role !== "lead_manager";
  return [
    [teamAccess ? "Всего заявок" : "Мои заявки", data.metrics.totalLeads, "/leads"],
    ["В работе", data.metrics.inProgressLeads, "/leads"],
    ...(teamAccess ? [["Без ответственного", data.metrics.unassignedLeads, "/leads"] as const] : []),
    ["Встречи сегодня", data.metrics.meetingsToday, "/appointments"],
    ["Просроченные задачи", data.metrics.overdueTasks, "/tasks"],
    ...(teamAccess ? [["Активные менеджеры", data.metrics.activeManagers, "/analytics"] as const] : []),
  ] as const;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fixture(role = "owner", initialData: any = snapshot(), initialReducedMotion: boolean | null = false, server = false) {
  let now = frozenNow, cursor = 0, dirty = false, current = true, refreshes = 0, intervalId = 0;
  let reducedMotion = initialReducedMotion;
  const slots: any[] = [], pending: Array<() => void> = [], writes: string[] = [];
  const motionQuery = "(prefers-reduced-motion: reduce)";
  type MediaListener = (event: { type: "change"; matches: boolean; media: string }) => void;
  type MediaRegistration = { target: unknown; listener: MediaListener };
  const media = { listeners: new Set<MediaListener>(), added: [] as MediaRegistration[], removed: [] as MediaRegistration[], queries: [] as string[] };
  const motionNodes: Node[] = [];
  const motionProps = new Set(["initial", "animate", "exit", "whileHover", "whileTap", "transition", "layout", "layoutId"]);
  // Capture TSX motion inputs separately from host output; this does not simulate animation or exit retention.
  const motion = Object.fromEntries(["div", "ul", "span"].map((type) => [type, (props: Node["props"]) => {
    motionNodes.push({ type, props });
    return jsx(type, Object.fromEntries(Object.entries(props).filter(([name]) => !motionProps.has(name))));
  }]));
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
  const fixtureWindow = {
    setInterval(callback: () => void, delay: number) { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id: number) { intervals.delete(id); },
    matchMedia(query: string) {
      assert.equal(query, motionQuery);
      media.queries.push(query);
      return {
        media: query,
        get matches() { return reducedMotion === true; },
        addEventListener(type: string, listener: MediaListener) {
          assert.equal(type, "change");
          media.added.push({ target: this, listener });
          media.listeners.add(listener);
        },
        removeEventListener(type: string, listener: MediaListener) {
          assert.equal(type, "change");
          media.removed.push({ target: this, listener });
          media.listeners.delete(listener);
        },
      };
    },
  };
  const bindings = { Date: FixtureDate, Intl: new Proxy(Intl, {
    get(target, key) { return key === "DateTimeFormat" ? FixtureDateTimeFormat : Reflect.get(target, key); },
  }), ...(server ? {} : { window: fixtureWindow }) };
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
      if (server) return;
      if (!previous || !sameDeps(previous.deps, deps)) pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = create(); });
      slots[index] = { deps, cleanup: previous?.cleanup };
    },
    // Model snapshots and subscription lifetime, not React concurrency or hydration.
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown, getServerSnapshot: () => unknown) {
      const index = cursor++;
      if (server) return getServerSnapshot();
      const slot = slots[index] ??= {};
      slot.getSnapshot = getSnapshot;
      slot.value = getSnapshot();
      if (slot.subscribe !== subscribe) {
        slot.subscribe = subscribe;
        pending.push(() => {
          slot.cleanup?.();
          const notify = () => {
            const next = slot.getSnapshot();
            if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
          };
          slot.cleanup = subscribe(notify);
          notify();
        });
      }
      return slot.value;
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
    react: hooks, wouter: router, "framer-motion": { motion },
    "@/components/layout/PageLayout": { PageLayout: "FixturePageLayout" },
    "@/contexts/AuthContext": { useAuth: () => auth }, "@/lib/phone": phone, "@/lib/clinicDay": day,
    "@/lib/mortgage-workspace": { MortgageScope: "FixtureMortgageScope", useMortgageWorkspace: () => workspace },
    "@/components/mortgage/MortgagePrimitives": primitives,
  }, bindings);
  const paint = () => {
    let output: any;
    for (let pass = 0; pass < 20; pass++) {
      dirty = false; cursor = 0; motionNodes.length = 0;
      output = render(module.fixture.MortgageOverviewBody());
      for (const effect of pending.splice(0)) effect();
      if (!dirty) return output;
    }
    throw new Error("Overview fixture did not settle");
  };
  return { auth, workspace, module, paint, writes, intervals, motionNodes, media, refreshes: () => refreshes, needsPaint: () => dirty,
    setReducedMotion(value: boolean | null) {
      const previous = reducedMotion === true;
      reducedMotion = value;
      if (previous !== (value === true)) {
        for (const listener of [...media.listeners]) listener({ type: "change", matches: value === true, media: motionQuery });
      }
    },
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

test("overview uses shared page buttons and inherited colors for every supported role", () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    const f = fixture(role), tree = f.paint(), header = find(tree, (node) => node.type === "header");
    assert.equal(text(find(header, (node) => node.type === "h1")), role === "lead_manager" ? "Мой рабочий день" : "Обзор команды");
    assert.ok(nodes(header).some((node) => node.type === "p" && text(node) === "Synthetic Baspana"));
    for (const node of nodes(tree)) {
      assert.deepEqual(Object.keys(node.props.style || {}).filter((name) => name.startsWith("--negis-")), [],
        "The overview must inherit shared color tokens instead of redefining them locally");
    }
    const refresh = button(header, "Обновить обзор");
    expectClasses(refresh, "neu-icon-btn", "!h-11", "!w-11");
    assert.equal(refresh.props.title, "Обновить обзор");
    assert.equal(refresh.props["aria-label"], "Обновить обзор");
    assert.equal(refresh.props.type, "button");
    assert.equal(text(refresh), "");
    assert.ok(nodes(refresh).some((node) => node.type === "icon-RefreshCw"));
    assert.equal(links(header, "/leads").length, 1);
    expectClasses(links(header, "/leads")[0], "neu-btn-primary");
    const agenda = section(tree, "mortgage-agenda");
    expectClasses(links(agenda, "/tasks")[0], "neu-btn");
    expectClasses(find(agenda, (node) => node.type === "a" && node.props["aria-label"] === `Открыть: ${task().title}`), "neu-icon-btn");
    const contacts = section(tree, "mortgage-overview-contacts"), teamAccess = role !== "lead_manager";
    const action = find(contacts, (node) => node.type === "a" && node.props["aria-label"] === (teamAccess ? "Открыть распределение заявок" : "Все клиенты"));
    expectClasses(action, "neu-btn", "max-sm:!h-11", "max-sm:!w-11");
    assert.equal(action.props.href, teamAccess ? "/leads" : "/clients");
    assert.equal(action.props.title, action.props["aria-label"]);
    expectClasses(find(action, (node) => node.type === "span"), "hidden", "sm:inline");
    assert.ok(nodes(action).some((node) => node.type === "icon-ArrowUpRight" && node.props["aria-hidden"] === "true"));
    expectClasses(links(contacts, teamAccess ? "tel:+77000002222" : "tel:+77000001111")[0], "min-h-11", "sm:min-h-6");
    if (teamAccess) expectClasses(links(section(tree, "mortgage-team-load"), "/analytics")[0], "neu-btn");
    assert.deepEqual(f.writes, []);
    f.dispose();
  }
});

test("only the first overview metric receives the shared mint accent while values and destinations stay intact", () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    const data = snapshot(), f = fixture(role, data), tree = f.paint();
    const metrics = find(tree, (node) => node.type === "dl" && node.props["aria-label"] === "Показатели рабочего пространства");
    const cards = nodes(metrics).filter((node) => node.type === "div" && nodes(node).some((child) => child.type === "dt"));
    const expected = expectedMetrics(data, role);
    assert.equal(cards.length, role === "lead_manager" ? 4 : 6);
    assert.deepEqual(cards.map((node) => node.props.style?.background === "var(--negis-mint)"), expected.map((_, index) => index === 0));
    assert.equal(f.motionNodes.length, expected.length + 2 + (role === "lead_manager" ? 0 : data.memberMetrics.length),
      "Only role-visible metrics, one agenda list/fill and permitted team bars use motion");
    for (const [index, card] of cards.entries()) {
      expectClasses(card, "neu-sm");
      assert.equal(text(find(card, (node) => node.type === "dt")), expected[index][0]);
      assert.equal(compact(text(find(card, (node) => node.type === "dd"))), countText(expected[index][1]));
      assert.equal(find(card, (node) => node.type === "a").props.href, expected[index][2]);
      if (index > 0) assert.equal(card.props.style, undefined, "Non-accent metrics keep the shared neutral surface");
    }
    assert.equal(cards[0].props.style.boxShadow, "none");
    expectClasses(find(cards[0], (node) => node.type === "dt"), "text-[var(--negis-mint-deep)]");
    expectClasses(find(cards[0], (node) => node.type === "dd"), "text-[var(--negis-mint-ink)]");
    expectClasses(find(cards[expected.findIndex(([label]) => label === "Просроченные задачи")], (node) => node.type === "dd"), "text-[var(--negis-danger)]");
    assert.deepEqual(f.writes, []);
    f.dispose();
  }
});

test("agenda segments, team loads and contact badges use the common palette with motion enabled or reduced", () => {
  const contacts = [unassignedContact(), { ...unassignedContact(), id: "synthetic-followup", name: "Synthetic followup", status: "in_progress" }];
  const data = snapshot({ contacts }), f = fixture("owner", data);
  let tree = f.paint(), layoutId: unknown;
  for (const reducedMotion of [false, true]) {
    f.setReducedMotion(reducedMotion);
    for (const selected of ["meetings", "tasks"] as const) {
      button(tree, selected === "meetings" ? "Встречи" : "Задачи").props.onClick();
      tree = f.paint();
      const agenda = expectAgenda(tree, selected);
      const active = button(agenda, selected === "meetings" ? "Встречи" : "Задачи");
      const inactive = button(agenda, selected === "meetings" ? "Задачи" : "Встречи");
      expectClasses(active, "isolate", "rounded-md", "text-[var(--negis-mint-ink)]");
      expectClasses(inactive, "rounded-md", "bg-white", "text-[var(--negis-ink-2)]", "hover:bg-[var(--negis-plate)]");
      assert.ok(!String(inactive.props.className).split(/\s+/).includes("text-[var(--negis-mint-ink)]"));
      const fills = f.motionNodes.filter((node) => node.type === "span" && node.props.layoutId);
      assert.equal(fills.length, 1);
      expectClasses(fills[0], "absolute", "inset-0", "-z-10", "rounded-md", "bg-[var(--negis-mint)]");
      layoutId ??= fills[0].props.layoutId;
      assert.equal(fills[0].props.layoutId, layoutId);
      assert.equal(fills[0].props.transition.duration, reducedMotion ? 0 : 0.18);
      assert.equal(nodes(active).filter((node) => node.type === "span" && node.props.className === fills[0].props.className).length, 1);
      const overdueBadge = find(agenda, (node) => node.props["aria-label"] === `Просрочено: ${data.metrics.overdueTasks}`);
      expectClasses(overdueBadge, "badge", "badge-error", "!tracking-normal");
      expectClasses(links(agenda, selected === "meetings" ? "/appointments" : "/tasks")[0], "neu-btn");
    }
  }
  const team = section(tree, "mortgage-team-load");
  assert.equal(rows(team).length, data.memberMetrics.length);
  for (const row of rows(team)) {
    expectClasses(find(row, (node) => node.type === "span" && node.props["aria-hidden"] === "true"),
      "bg-[var(--negis-primary-soft)]", "text-[var(--negis-primary)]");
  }
  const bars = f.motionNodes.filter((node) => node.props.animate?.scaleX !== undefined);
  assert.equal(bars.length, data.memberMetrics.length);
  for (const bar of bars) expectClasses(bar, "bg-[var(--negis-primary)]");
  const preview = section(tree, "mortgage-overview-contacts");
  assert.equal(rows(preview).length, 2);
  for (const [index, row] of rows(preview).entries()) {
    const cardLink = find(row, (node) => node.type === "a" && node.props["aria-label"] === `Карточка: ${contacts[index].name}`);
    expectClasses(find(cardLink, (node) => node.type === "span"), "badge", index === 0 ? "badge-blue" : "badge-muted", "!tracking-normal");
  }
  assert.deepEqual(f.writes, []);
  f.dispose();
});

for (const role of ["owner", "admin", "lead_manager"]) for (const reducedMotion of [false, true]) test(`${role} motion props respect reduced-motion=${reducedMotion} without delaying counts or agenda rows`, () => {
  const data = snapshot(), f = fixture(role, data, reducedMotion), teamAccess = role !== "lead_manager";
  let tree = f.paint();
  const metrics = find(tree, (node) => node.type === "dl" && node.props["aria-label"] === "Показатели рабочего пространства");
  assert.deepEqual(nodes(metrics).filter((node) => node.type === "dd").map((node) => compact(text(node))),
    expectedMetrics(data, role).map(([, value]) => countText(value)));
  assert.equal(rows(section(tree, "mortgage-overview-contacts")).length, 1);
  const team = teamAccess ? section(tree, "mortgage-team-load") : null;
  assert.equal(rows(team).length, teamAccess ? data.memberMetrics.length : 0);
  for (const member of teamAccess ? data.memberMetrics : []) {
    const row = find(team, (node) => node.type === "li" && text(node).includes(member.name));
    assert.equal(compact(text(find(row, (node) => node.type === "strong"))), countText(member.assignedLeads));
  }
  const metricMotion = f.motionNodes.filter((node) => nodes(node).some((child) => child.type === "dt"));
  assert.equal(metricMotion.length, teamAccess ? 6 : 4);
  for (const node of metricMotion) {
    assert.equal(node.type, "div");
    assert.equal(node.props.initial, false);
    assert.equal(node.props.animate, undefined);
    assert.equal(node.props.transition.duration, reducedMotion ? 0 : 0.16);
    if (reducedMotion) {
      assert.equal(node.props.whileHover, undefined);
      assert.equal(node.props.whileTap, undefined);
    } else {
      assert.deepEqual({ ...node.props.whileHover }, { y: -2 });
      assert.deepEqual({ ...node.props.whileTap }, { scale: 0.99 });
    }
  }
  const bars = f.motionNodes.filter((node) => node.props.animate?.scaleX !== undefined);
  assert.equal(bars.length, teamAccess ? data.memberMetrics.length : 0);
  const maxLoad = Math.max(1, ...data.memberMetrics.map((member) => member.assignedLeads));
  for (const [index, bar] of bars.entries()) {
    assert.equal(bar.type, "div");
    assert.equal(text(bar), "");
    assert.ok(bar.props.style?.transformOrigin === "left" || String(bar.props.className).split(/\s+/).includes("origin-left"),
      "Scale decorative loads from the left edge");
    assert.deepEqual({ ...bar.props.animate }, { scaleX: data.memberMetrics[index].assignedLeads / maxLoad });
    if (reducedMotion) assert.equal(bar.props.initial, false);
    else assert.deepEqual({ ...bar.props.initial }, { scaleX: 0 });
    assert.equal(bar.props.transition.duration, reducedMotion ? 0 : 0.24);
    assert.ok(nodes(team).some((node) => node.props["aria-hidden"] === "true" && nodes(node).some((child) =>
      child.type === "div" && child.props.className === bar.props.className && text(child) === "")),
      "Load bars remain decorative; visible counts are ordinary text");
  }
  let layoutId: unknown;
  for (const selected of ["tasks", "meetings", "tasks"] as const) {
    button(tree, selected === "meetings" ? "Встречи" : "Задачи").props.onClick();
    tree = f.paint();
    const agenda = expectAgenda(tree, selected);
    const list = find(agenda, (node) => node.type === "ul");
    assert.equal(list.key, selected);
    assert.equal(rows(list).length, 1);
    assert.match(text(list), new RegExp(selected === "meetings" ? activity().title : task().title));
    assert.doesNotMatch(text(agenda), new RegExp(selected === "meetings" ? task().title : activity().title));
    const lists = f.motionNodes.filter((node) => node.type === "ul");
    assert.equal(lists.length, 1);
    if (reducedMotion) assert.equal(lists[0].props.initial, false);
    else assert.deepEqual({ ...lists[0].props.initial }, { opacity: 0, y: 4 });
    assert.deepEqual({ ...lists[0].props.animate }, { opacity: 1, y: 0 });
    assert.equal(lists[0].props.transition.duration, reducedMotion ? 0 : 0.18);
    const underlines = f.motionNodes.filter((node) => node.type === "span" && node.props.layoutId);
    assert.equal(underlines.length, 1);
    const underline = underlines[0];
    assert.equal(typeof underline.props.layoutId, "string");
    layoutId ??= underline.props.layoutId;
    assert.equal(underline.props.layoutId, layoutId);
    assert.equal(underline.props["aria-hidden"], "true");
    assert.equal(text(underline), "");
    assert.equal(underline.props.transition.duration, reducedMotion ? 0 : 0.18);
    assert.equal(nodes(button(agenda, selected === "meetings" ? "Встречи" : "Задачи")).filter((node) =>
      node.type === "span" && node.props["aria-hidden"] === "true" && text(node) === "").length, 1);
    assert.equal(f.motionNodes.length, (teamAccess ? 6 : 4) + 2 + (teamAccess ? data.memberMetrics.length : 0),
      "Only role-visible metric hosts, one agenda list/fill and permitted decorative bars use motion");
    for (const node of f.motionNodes) assert.equal(node.props.exit, undefined);
    for (const node of nodes(tree)) {
      for (const prop of ["initial", "animate", "exit", "whileHover", "whileTap", "transition", "layout", "layoutId"]) {
        assert.ok(!Object.hasOwn(node.props, prop), `Do not leak motion prop ${prop} into the host fixture`);
      }
    }
  }
  assert.doesNotMatch(overviewSource, /\bAnimatePresence\b/, "The VM cannot model retained exits; overview must not introduce a presence wrapper");
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("the same mounted overview follows motion preference changes and treats a null preference as normal motion", () => {
  const f = fixture();
  let tree = f.paint();
  button(tree, "Встречи").props.onClick();
  tree = f.paint();
  const originalText = text(tree);
  for (const preference of [true, false, null] as const) {
    f.setReducedMotion(preference);
    assert.equal(f.needsPaint(), preference !== null, "A changed media match requests a render through the real subscription");
    tree = f.paint();
    assert.equal(text(tree), originalText);
    expectAgenda(tree, "meetings");
    assert.equal(rows(section(tree, "mortgage-agenda")).length, 1);
    assert.equal(f.motionNodes.length, 10);
    for (const node of f.motionNodes) {
      assert.equal(node.props.transition.duration === 0, preference === true);
      if (preference === true) {
        assert.equal(node.props.whileHover, undefined);
        assert.equal(node.props.whileTap, undefined);
        if (node.type !== "span") assert.equal(node.props.initial, false);
      }
    }
  }
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("reduced-motion subscriptions reuse one listener across renders and remove that exact listener on disposal", () => {
  const f = fixture();
  f.paint();
  assert.equal(f.media.added.length, 1);
  assert.equal(f.media.listeners.size, 1);
  const registration = f.media.added[0];
  for (const preference of [true, false, true]) {
    f.setReducedMotion(preference);
    assert.equal(f.needsPaint(), true);
    const tree = f.paint();
    button(tree, preference ? "Встречи" : "Задачи").props.onClick();
    f.paint();
    f.tick(frozenNow + 60_000);
    assert.equal(f.media.added.length, 1, "Stable subscribe identity must not resubscribe on preference, agenda or clock renders");
    assert.equal(f.media.removed.length, 0);
    assert.deepEqual([...f.media.listeners], [registration.listener]);
  }
  f.setReducedMotion(true);
  assert.equal(f.needsPaint(), false, "An unchanged media match must not schedule a render");
  f.workspace.loading = true;
  f.paint();
  assert.equal(f.media.listeners.size, 1, "The page subscription outlives temporarily hidden snapshot content");
  f.dispose();
  assert.equal(f.media.listeners.size, 0);
  assert.equal(f.media.removed.length, 1);
  assert.equal(f.media.removed[0].listener, registration.listener);
  assert.equal(f.media.removed[0].target, registration.target);
  assert.equal(f.intervals.size, 0);
  f.setReducedMotion(false);
  assert.equal(f.needsPaint(), false, "A disposed page must not receive media-query changes");
  assert.deepEqual(f.writes, []);
});

test("the server snapshot disables motion without reading window or subscribing to media changes", () => {
  const data = snapshot(), f = fixture("owner", data, false, true), tree = f.paint();
  assert.equal(rows(expectAgenda(tree, "tasks")).length, 1);
  assert.equal(rows(section(tree, "mortgage-team-load")).length, data.memberMetrics.length);
  const metrics = find(tree, (node) => node.type === "dl" && node.props["aria-label"] === "Показатели рабочего пространства");
  assert.deepEqual(nodes(metrics).filter((node) => node.type === "dd").map((node) => compact(text(node))),
    expectedMetrics(data).map(([, value]) => countText(value)));
  assert.equal(f.motionNodes.length, 10);
  for (const node of f.motionNodes) {
    assert.equal(node.props.initial, false);
    assert.equal(node.props.transition.duration, 0);
    assert.equal(node.props.whileHover, undefined);
    assert.equal(node.props.whileTap, undefined);
  }
  assert.deepEqual(f.media.queries, []);
  assert.deepEqual(f.media.added, []);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("actual manualChunks isolates motion packages across module layouts without changing other vendor groups", async () => {
  const source = await readFile(path.join(root, "artifacts/negis/vite.config.ts"), "utf8");
  const ast = ts.createSourceFile("vite.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: import("typescript").MethodDeclaration[] = [];
  const visit = (node: import("typescript").Node) => {
    if (ts.isMethodDeclaration(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "manualChunks") methods.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(methods.length, 1, "Locate the unique actual manualChunks method, never execute the Vite config");
  const code = ts.transpileModule(`({ ${methods[0].getText(ast)} }).manualChunks;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const manualChunks = new Script(code).runInNewContext({}, { timeout: 1000 }) as (id: string) => string | undefined;
  const cases = [
    ["framer-motion", "vendor-motion"], ["motion-dom", "vendor-motion"], ["motion-utils", "vendor-motion"],
    ["react", "vendor-react"], ["react-dom", "vendor-react"], ["scheduler", "vendor-react"],
    ["@supabase/supabase-js", "vendor-supabase"], ["@supabase/auth-js", "vendor-supabase"],
    ["react-hook-form", "vendor-forms"], ["@hookform/resolvers", "vendor-forms"], ["zod", "vendor-forms"],
    ["recharts", "vendor-charts"], ["d3-scale", "vendor-charts"], ["lucide-react", "vendor"], ["wouter", "vendor"],
    ["react-is", "vendor"], ["framer-motion-extra", "vendor"], ["motion-dom-extra", "vendor"], ["motion-utils-extra", "vendor"],
    ["my-framer-motion", "vendor"], ["@fixture/framer-motion", "vendor"], ["fixture/motion-dom", "vendor"],
  ] as const;
  for (const separator of ["/", "\\"]) {
    for (const layout of ["normal", "pnpm"]) {
      for (const [name, expected] of cases) {
        const nested = layout === "pnpm" ? `.pnpm/${name.replaceAll("/", "+")}@0.0.0/node_modules/` : "";
        const id = `${separator === "\\" ? "C:" : ""}/fixture/node_modules/${nested}${name}/dist/index.js`.replaceAll("/", separator);
        assert.equal(manualChunks(id), expected, `${layout}: ${id}`);
      }
    }
    for (const app of ["src/pages/MortgageOverview.tsx", "src/framer-motion/index.ts", "src/motion-utils/index.ts"]) {
      assert.equal(manualChunks(`/fixture/${app}`.replaceAll("/", separator)), undefined);
    }
    assert.equal(manualChunks("/fixture/not_node_modules/framer-motion/index.js".replaceAll("/", separator)), "vendor");
  }
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
  assert.match(text(team), /Отметки сотрудников.*90 дней/);
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
    assert.equal(f.motionNodes.length, 10, "Begin with the actual motion-enabled overview mounted");
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
    assert.equal(f.motionNodes.length, 0, `${state} must synchronously remove every snapshot motion host`);
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
  assert.equal(f.motionNodes.length, 0, "Revocation must not retain motion hosts after invoking old handlers");
  assert.equal(JSON.stringify(f.workspace.data), original);
  assert.deepEqual(f.writes, []);
  f.dispose(); assert.equal(f.intervals.size, 0);
});

for (const role of ["owner", "admin", "lead_manager"]) {
  for (const overdueTasks of [0, 41531]) test(`${role} defaults the agenda from server overdue totals, not sampled activities (${overdueTasks})`, () => {
    const data = snapshot({ activities: overdueTasks ? [activity()] : [task()], activitiesTruncated: true });
    data.metrics.overdueTasks = overdueTasks;
    const f = fixture(role, data), tree = f.paint();
    const agenda = expectAgenda(tree, overdueTasks ? "tasks" : "meetings");
    assert.equal(rows(agenda).length, 0, "A server count must not invent activities missing from the sample");
    assert.match(text(agenda), overdueTasks ? /В выборке нет открытых задач/ : /В выборке нет ближайших встреч/);
    assert.match(text(tree), /Встречи и задачи: неполная выборка.*Счётчики полные/);
    assert.deepEqual(f.writes, []);
    f.dispose();
  });
}

test("an untouched agenda follows server overdue totals after loading and later snapshots", () => {
  const f = fixture("owner", null);
  f.workspace.loading = true;
  assert.equal(rows(f.paint()).length, 0);
  f.workspace.data = freeze(snapshot());
  f.workspace.loading = false;
  expectAgenda(f.paint(), "tasks");
  const withoutOverdue = snapshot();
  withoutOverdue.metrics.overdueTasks = 0;
  f.workspace.data = freeze(withoutOverdue);
  expectAgenda(f.paint(), "meetings");
  f.workspace.data = freeze(snapshot());
  expectAgenda(f.paint(), "tasks");
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

for (const selected of ["meetings", "tasks"] as const) test(`explicit ${selected} selection survives rerenders, refreshed totals and clock updates`, () => {
  const initial = snapshot();
  initial.metrics.overdueTasks = selected === "meetings" ? 41531 : 0;
  const f = fixture("owner", initial);
  let tree = f.paint();
  expectAgenda(tree, selected === "meetings" ? "tasks" : "meetings");
  button(tree, selected === "meetings" ? "Встречи" : "Задачи").props.onClick();
  expectAgenda(f.paint(), selected);
  expectAgenda(f.paint(), selected);
  for (const overdueTasks of [0, 41531]) {
    const next = snapshot();
    next.metrics.overdueTasks = overdueTasks;
    f.workspace.data = freeze(next);
    expectAgenda(f.paint(), selected);
  }
  f.workspace.loading = true;
  assert.equal(rows(f.paint()).length, 0);
  f.workspace.loading = false;
  expectAgenda(f.paint(), selected);
  tree = f.tick(frozenNow + 60_000);
  expectAgenda(tree, selected);
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("agenda tabs render the real activity helpers, sort and cap samples, and only navigate", () => {
  const meetings = Array.from({ length: 7 }, (_, i) => activity({ id: `meeting-${i}`, title: `Upcoming ${i}`,
    startsAt: `2026-10-16T0${i}:10:00Z`, endsAt: `2026-10-16T0${i}:50:00Z` })).reverse();
  const tasks = Array.from({ length: 7 }, (_, i) => task({ id: `task-${i}`, title: `Task ${i}`, dueAt: `2026-10-15T0${i}:10:00Z` })).reverse();
  const data = snapshot({ activities: [activity({ id: "ended", title: "Excluded ended meeting", startsAt: "2026-10-15T17:00:00Z", endsAt: "2026-10-15T18:00:00Z" }),
    activity({ id: "cancelled", title: "Excluded cancelled meeting", status: "cancelled" }),
    task({ id: "done", title: "Excluded done task", status: "done" }), ...meetings, ...tasks] });
  const f = fixture("owner", data), original = JSON.stringify(data);
  let tree = f.paint();
  button(tree, "Встречи").props.onClick();
  tree = f.paint();
  let agenda = section(tree, "mortgage-agenda");
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
  assert.match(text(expectAgenda(tree, "tasks")), /В выборке нет открытых задач/);
  const metrics = find(tree, (node) => node.type === "dl" && node.props["aria-label"] === "Показатели рабочего пространства");
  for (const [label, value, href] of expectedMetrics(data)) {
    const metric = find(tree, (node) => node.type === "a" && compact(node.props["aria-label"] || "") === compact(`${label}: ${value.toLocaleString("ru-RU")}`));
    assert.equal(metric.props.href, href);
    assert.ok(compact(text(metric)).includes(countText(value)), "Counts come from full server metrics, not the returned rows");
    assert.ok(nodes(metrics).some((node) => node.type === "dt" && text(node) === label));
    assert.ok(nodes(metrics).some((node) => node.type === "dd" && compact(text(node)) === countText(value)));
  }
  assert.match(text(section(tree, "mortgage-overview-contacts")), /вне текущей страницы контактов/);
  assert.match(text(section(tree, "mortgage-team-load")), /Нет данных по сотрудникам/);
  assert.doesNotMatch(text(tree), /Все заявки назначены|Просроченных задач нет|Ближайших встреч нет/);
  button(tree, "Встречи").props.onClick(); tree = f.paint();
  assert.match(text(expectAgenda(tree, "meetings")), /В выборке нет ближайших встреч/);
  assert.ok(compact(text(tree)).includes(countText(data.metrics.overdueTasks)));
  f.dispose();
});

test("contact previews label their displayed sample, retain full totals, and do not invent missing people", () => {
  const contacts = Array.from({ length: 8 }, (_, i) => ({ ...unassignedContact(), id: `unassigned-${i}`, name: `Synthetic preview ${i}` }));
  const data = snapshot({ contacts }), f = fixture("owner", data), tree = f.paint();
  const preview = section(tree, "mortgage-overview-contacts");
  assert.equal(rows(preview).length, 3);
  assert.match(text(preview), /Показано:?\s*3/);
  assert.doesNotMatch(text(preview), /В текущей странице:\s*3|Synthetic preview [34567]/);
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

for (const role of ["owner", "admin", "lead_manager"]) test(`${role} sees three correctly scoped contacts in server order with role-appropriate sections`, () => {
  const assigned = Array.from({ length: 8 }, (_, i) => contact({
    id: `assigned-${i}`, name: `Synthetic assigned preview ${i}`, phone: `+7700000100${i}`,
  })).reverse();
  const unassigned = Array.from({ length: 8 }, (_, i) => ({ ...unassignedContact(),
    id: `unassigned-${i}`, name: `Synthetic unassigned preview ${i}`, phone: `+7700000200${i}`,
  })).reverse();
  const data = snapshot({ contacts: assigned.flatMap((item, i) => [item, unassigned[i]]), page: 4, pageSize: 100 });
  const original = JSON.stringify(data), f = fixture(role, data), tree = f.paint();
  const preview = section(tree, "mortgage-overview-contacts"), teamAccess = role !== "lead_manager";
  const expected = (teamAccess ? unassigned : assigned).slice(0, 3);
  assert.equal(text(find(preview, (node) => node.type === "h2")), teamAccess ? "Заявки без ответственного" : "Последние заявки");
  assert.deepEqual(rows(preview).map((row) => text(find(row, (node) => node.type === "a" && !node.props["aria-label"]))),
    expected.map((item) => item.name), "Filter the returned page by responsibility before taking the first three rows");
  assert.match(text(preview), /Показано:?\s*3/);
  assert.ok(links(preview, teamAccess ? "/leads" : "/clients").length);
  assert.ok(compact(text(preview)).includes(countText(teamAccess ? data.metrics.unassignedLeads : data.contactsTotal)));
  for (const item of expected) {
    assert.ok(links(preview, `/clients?leadId=${encodeURIComponent(item.id)}`).length);
    assert.ok(links(preview, `tel:${item.phone}`).length);
  }
  const serialized = JSON.stringify(preview);
  for (const item of data.contacts.filter((item) => !expected.some((visible) => visible.id === item.id))) {
    assert.ok(!serialized.includes(item.name), `Do not render out-of-sample or out-of-scope contact ${item.id}`);
    assert.ok(!serialized.includes(item.phone), `Do not render out-of-sample or out-of-scope phone ${item.id}`);
  }
  const sections = nodes(tree).filter((node) => node.type === "section").map((node) => node.props["aria-labelledby"]);
  if (teamAccess) {
    assert.ok(sections.indexOf("mortgage-overview-contacts") < sections.indexOf("mortgage-agenda"));
    assert.ok(sections.indexOf("mortgage-agenda") < sections.indexOf("mortgage-team-load"));
    assert.equal(text(find(section(tree, "mortgage-team-load"), (node) => node.type === "h2")), "Нагрузка команды");
  } else {
    assert.ok(!sections.includes("mortgage-team-load"));
    assert.equal(links(tree, "/analytics").length, 0);
    for (const item of unassigned) {
      assert.ok(!JSON.stringify(tree).includes(item.name));
      assert.ok(!JSON.stringify(tree).includes(item.phone));
    }
    const work = section(tree, "mortgage-own-work");
    for (const href of ["/clients", "/appointments", "/tasks"]) assert.ok(links(work, href).length);
  }
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(f.writes, []);
  f.dispose();
});

test("header, activity day labels, clock updates and contact dates use the clinic zone, not the UTC device", () => {
  const f = fixture(), data = f.workspace.data;
  let tree = f.paint();
  const header = find(tree, (node) => node.type === "header");
  const formattedDate = new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(frozenNow);
  const expectedDate = formattedDate.charAt(0).toLocaleUpperCase("ru-RU") + formattedDate.slice(1);
  const dateLabel = find(header, (node) => node.type === "p" && text(node) === expectedDate);
  assert.ok(!nodes(header).some((node) => String(node.props.className || "").split(/\s+/).some((token) => /(?:^|:)capitalize$/.test(token))), "Capitalize only the first date letter in text, not every word through CSS");
  assert.equal(text(dateLabel), expectedDate);
  button(tree, "Встречи").props.onClick(); tree = f.paint();
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
  assert.ok(text(find(tree, (node) => node.type === "header")).includes(nextDate.charAt(0).toLocaleUpperCase("ru-RU") + nextDate.slice(1)));
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

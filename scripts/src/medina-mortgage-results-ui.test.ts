import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute local declarations/TSX with synthetic hooks and deferred Responses only.
// This suite makes no browser-layout, SQL, environment or network claim.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const filename = "artifacts/negis/src/components/mortgage/MortgageResults.tsx";
const source = await readFile(path.join(root, filename), "utf8");
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function select(names: string[]): string {
  const selected = new Set<import("typescript").Statement>();
  for (const name of names) {
    const matches = ast.statements.filter((node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === name)));
    assert.equal(matches.length, 1, `select exactly one actual declaration: ${name}`);
    selected.add(matches[0]!);
  }
  for (const name of ["parseMortgageResults", "mortgageResultsRatio"]) {
    const declaration = [...selected].find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration && ts.canHaveModifiers(declaration)
      && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword), `${name} remains exported`);
  }
  return ast.statements.filter((node) => selected.has(node)).map((node) => node.getText(ast)).join("\n");
}

type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });
function evaluate(input: string, imports: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const result = ts.transpileModule(input, { fileName: filename, reportDiagnostics: true, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  new Script(result.outputText, { filename }).runInNewContext({ exports, Error, Date, Intl, AbortController, URLSearchParams,
    fetch: () => assert.fail("No network is permitted in mortgage results UI tests"),
    require(name: string) {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}
const pure = evaluate(select([
  "PERIODS", "COUNT_FIELDS", "isRecord", "isCount", "isInstant", "isTimeZone", "compareInstants", "safeSum",
  "parseMortgageResults", "mortgageResultsRatio",
]));
const parse = pure.parseMortgageResults as (body: unknown, days: number) => ReturnType<typeof envelope>["data"];
const ratio = pure.mortgageResultsRatio as (numerator: unknown, denominator: unknown) => number | null;
const MAX = Number.MAX_SAFE_INTEGER;
const countFields = ["assignedLeads", "heldLeads", "signedLeads", "heldSignedLeads", "signedInPeriod"] as const;
const id = (n: number) => `abcdefab-cdef-4abc-8def-${String(n).padStart(12, "0")}`;
function member(overrides: Record<string, any> = {}) {
  return { staffId: id(1), name: "Synthetic active manager", role: "lead_manager", status: "active",
    assignedLeads: 10, heldLeads: 5, signedLeads: 4, heldSignedLeads: 2, signedInPeriod: 20, ...overrides };
}
function envelope(days = 30, members = [member()]) {
  const to = "2026-10-20T12:00:00.123456Z";
  const from = new Date(Date.parse(to) - days * 86_400_000).toISOString().replace(/Z$/, "456Z");
  return { success: true, mode: "supabase", data: {
    timeZone: "Asia/Almaty", generatedAt: to, period: { days, from, to }, unassignedLeads: 3, otherAssigneeLeads: 2, members,
  } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const days of [7, 30, 90]) test(`parser accepts the actual ${days}-day envelope without mutating it`, () => {
  const body = freeze(envelope(days, [
    member({ role: "owner" }), member({ staffId: id(2), role: "admin", status: "inactive" }),
    member({ staffId: id(3), status: "invited", name: "" }),
  ]));
  const before = JSON.stringify(body);
  assert.equal(parse(body, days), body.data);
  assert.equal(JSON.stringify(body), before);
  assert.equal(parse(body, days).members[1]!.status, "inactive");
});

test("empty and zero portfolios are valid, and historical signing credit can exceed current assignments", () => {
  assert.equal(parse(envelope(30, []), 30).members.length, 0);
  const body = envelope(30, [member({ assignedLeads: 0, heldLeads: 0, signedLeads: 0, heldSignedLeads: 0, signedInPeriod: MAX, status: "inactive" })]);
  assert.equal(parse(body, 30).members[0]!.signedInPeriod, MAX);
  assert.equal(parse(envelope(30, [member({ assignedLeads: 10, heldLeads: 10, signedLeads: 10, heldSignedLeads: 0 })]), 30).members[0]!.heldSignedLeads, 0,
    "contracts preceding meetings need not count toward contracts after a meeting");
});

test("results require a report-owned valid timezone, without a browser-zone fallback", () => {
  for (const timeZone of [undefined, null, 5, {}, [], "", " UTC ", "Invalid/Zone"]) {
    const body: any = envelope(); body.data.timeZone = timeZone;
    assert.throws(() => parse(body, 30));
  }
  for (const timeZone of ["UTC", "Asia/Almaty", "America/New_York", "Pacific/Chatham"]) {
    const body = envelope(); body.data.timeZone = timeZone;
    assert.equal(parse(body, 30).timeZone, timeZone);
  }
});

test("safe integer boundaries are accepted for every count independently of period credit", () => {
  const body = envelope(30, [member(Object.fromEntries(countFields.map((field) => [field, MAX])))]);
  body.data.unassignedLeads = 0;
  body.data.otherAssigneeLeads = 0;
  assert.equal(parse(body, 30).members[0]!.heldSignedLeads, MAX);
  for (const field of ["unassignedLeads", "otherAssigneeLeads"] as const) {
    const excluded = envelope(30, []);
    excluded.data.unassignedLeads = 0;
    excluded.data.otherAssigneeLeads = 0;
    excluded.data[field] = MAX;
    assert.equal(parse(excluded, 30)[field], MAX);
  }
});

const invalidCounts: unknown[] = [-1, 0.5, NaN, Infinity, -Infinity, MAX + 1, "0", null, undefined, true, {}, [], 1n];
for (const field of [...countFields, "unassignedLeads", "otherAssigneeLeads"]) {
  test(`parser rejects all invalid count types and unsafe values: ${field}`, () => {
    for (const value of invalidCounts) {
      const body = envelope();
      const target: Record<string, any> = countFields.includes(field as typeof countFields[number]) ? body.data.members[0]! : body.data;
      target[field] = value;
      assert.throws(() => parse(body, 30), `${field}: ${String(value)}`);
    }
    const body = envelope();
    const target: Record<string, any> = countFields.includes(field as typeof countFields[number]) ? body.data.members[0]! : body.data;
    delete target[field];
    assert.throws(() => parse(body, 30), `missing ${field}`);
  });
}

test("parser rejects impossible portfolio subsets without tying historical signing credit to them", () => {
  for (const counts of [
    { assignedLeads: 2, heldLeads: 3, signedLeads: 1, heldSignedLeads: 0 },
    { assignedLeads: 2, heldLeads: 1, signedLeads: 3, heldSignedLeads: 0 },
    { assignedLeads: 4, heldLeads: 2, signedLeads: 3, heldSignedLeads: 3 },
    { assignedLeads: 4, heldLeads: 3, signedLeads: 2, heldSignedLeads: 3 },
    { assignedLeads: 0, heldLeads: 0, signedLeads: 0, heldSignedLeads: 1 },
  ]) assert.throws(() => parse(envelope(30, [member(counts)]), 30), JSON.stringify(counts));
});

test("all member aggregates and combined excluded-client totals reject overflow, not wrap or round", () => {
  for (const field of countFields) {
    const full = Object.fromEntries(countFields.map((key) => [key, key === "signedInPeriod" ? 0 : MAX]));
    const extra = Object.fromEntries(countFields.map((key) => [key, key === "signedInPeriod" ? 0 : 1]));
    if (field === "signedInPeriod") {
      countFields.forEach((key) => { full[key] = 0; extra[key] = 0; });
      full.signedInPeriod = MAX;
      extra.signedInPeriod = 1;
    }
    const body = envelope(30, [member(full), member({ ...extra, staffId: id(2) })]);
    body.data.unassignedLeads = 0;
    body.data.otherAssigneeLeads = 0;
    assert.throws(() => parse(body, 30), `overflow in ${field} aggregate`);
  }
  const body = envelope(30, [member({ assignedLeads: MAX - 5 })]);
  assert.equal(parse(body, 30).members[0]!.assignedLeads, MAX - 5);
  body.data.otherAssigneeLeads += 1;
  assert.throws(() => parse(body, 30), "assigned + unassigned + other exceeds MAX");
  const excluded = envelope(30, []);
  excluded.data.unassignedLeads = MAX;
  excluded.data.otherAssigneeLeads = 1;
  assert.throws(() => parse(excluded, 30), "excluded categories alone overflow");
});

test("staff UUIDs are unique case-insensitively and member metadata has the contracted types", () => {
  for (const duplicate of [id(1), id(1).toUpperCase()]) {
    assert.throws(() => parse(envelope(30, [member(), member({ staffId: duplicate })]), 30));
  }
  for (const overrides of [
    { staffId: "" }, { staffId: "not-a-uuid" }, { staffId: `${id(1)} ` }, { staffId: id(1).slice(1) },
    { staffId: null }, { staffId: 1 }, { name: null }, { name: [] }, { status: null }, { status: 1 },
    { role: "manager" }, { role: "OWNER" }, { role: null }, { role: ["owner"] }, { role: {} },
  ]) assert.throws(() => parse(envelope(30, [member(overrides)]), 30), JSON.stringify(overrides));
  assert.equal(parse(envelope(30, [member({ staffId: id(1).toUpperCase() }), member({ staffId: id(2) })]), 30).members.length, 2);
  for (const malformed of [null, [], "member", 1]) {
    const body: any = envelope();
    body.data.members = [malformed];
    assert.throws(() => parse(body, 30));
  }
});

test("malformed, failed and non-Supabase envelopes never become a ready zero report", () => {
  for (const body of [null, undefined, [], {}, true, "report", envelope().data,
    { ...envelope(), success: false }, { ...envelope(), success: "true" },
    { ...envelope(), mode: "demo" }, { ...envelope(), mode: undefined },
    { ...envelope(), data: null }, { ...envelope(), data: [] },
  ]) assert.throws(() => parse(body, 30));
  for (const field of ["generatedAt", "period", "unassignedLeads", "otherAssigneeLeads", "members"]) {
    const body: any = envelope();
    delete body.data[field];
    assert.throws(() => parse(body, 30), `missing ${field}`);
  }
  for (const value of [null, {}, "members", 1]) {
    const body: any = envelope();
    body.data.members = value;
    assert.throws(() => parse(body, 30));
  }
});

test("only requested 7/30/90-day periods are accepted, without coercion", () => {
  for (const days of [0, 1, 14, 365, NaN, Infinity, "30", null, undefined]) assert.throws(() => parse(envelope(), days as number));
  for (const period of [null, [], {}, { ...envelope().data.period, days: "30" },
    { ...envelope().data.period, days: 7 }, { ...envelope().data.period, from: undefined },
    { ...envelope().data.period, to: undefined }]) {
    const body: any = envelope();
    body.data.period = period;
    assert.throws(() => parse(body, 30));
  }
});

const invalidDates: unknown[] = [null, undefined, 0, {}, "", "not-a-date", "2026-10-20", "2026-10-20T12:00:00",
  "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-13-01T12:00:00Z",
  "2026-00-01T12:00:00Z", "2026-10-00T12:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20T12:60:00Z",
  "2026-10-20T12:00:60Z", "2026-10-20T12:00:00+24:00", "2026-10-20T12:00:00+05:60",
  "2026-10-20T12:00:00.1234567Z", " 2026-10-20T12:00:00Z", "2026-10-20T12:00:00Zsuffix"];
for (const field of ["generatedAt", "from", "to"] as const) test(`strict ISO calendar, time and offset validation: ${field}`, () => {
  for (const value of invalidDates) {
    const body: any = envelope();
    if (field === "generatedAt") body.data.generatedAt = value;
    else body.data.period[field] = value;
    assert.throws(() => parse(body, 30), `${field}: ${String(value)}`);
  }
});

test("exact elapsed periods retain PostgreSQL microseconds and offset equivalence", () => {
  const accepts = [
    ["2026-09-20T12:00:00.123456Z", "2026-10-20T12:00:00.123456Z", "2026-10-20T17:00:00.123456+05:00"],
    ["2026-09-20T12:00:00.124Z", "2026-10-20T12:00:00.124000Z", "2026-10-20T12:00:00.124Z"],
    ["2026-09-20T07:00:00-05:00", "2026-10-20T12:00:00Z", "2026-10-20T12:00:00.000000Z"],
    ["2028-02-29T12:00:00Z", "2028-03-30T12:00:00Z", "2028-03-30T12:00:00Z"],
    ["2026-03-01T09:00:00-05:00", "2026-03-31T10:00:00-04:00", "2026-03-31T14:00:00Z"],
  ];
  const rejects = [
    ["2026-10-20T12:00:00.123455Z", "2026-10-20T12:00:00.123456Z", "2026-10-20T17:00:00.123456+05:00"],
    ["2026-09-20T12:00:00.123455Z", "2026-10-20T12:00:00.123456Z", "2026-10-20T12:00:00.123456Z"],
    ["2026-09-20T12:00:00.123457Z", "2026-10-20T12:00:00.123456Z", "2026-10-20T12:00:00.123456Z"],
    ["2026-09-20T12:00:00Z", "2026-10-20T12:00:00Z", "2026-10-20T12:00:00.000001Z"],
    ["2026-03-01T09:00:00-05:00", "2026-03-31T09:00:00-04:00", "2026-03-31T13:00:00Z"],
    ["2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z"],
    ["2026-10-21T12:00:00Z", "2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z"],
    ["2026-10-19T12:00:00Z", "2026-10-20T12:00:01Z", "2026-10-20T12:00:00Z"],
    ["2026-10-20T12:00:00.123457Z", "2026-10-20T12:00:00.123456Z", "2026-10-20T12:00:00.123456Z"],
    ["2026-10-19T12:00:00Z", "2026-10-20T12:00:00.123457Z", "2026-10-20T12:00:00.123456Z"],
    ["2026-10-19T12:00:00Z", "2026-10-20T17:00:00.000001+05:00", "2026-10-20T12:00:00Z"],
    ["2026-10-20T17:00:00.1+05:00", "2026-10-20T12:00:00.100000Z", "2026-10-20T12:00:01Z"],
  ];
  for (const [from, to, generatedAt] of accepts) {
    const body = envelope();
    Object.assign(body.data.period, { from, to });
    Object.assign(body.data, { generatedAt });
    assert.doesNotThrow(() => parse(body, 30), `${from} < ${to} <= ${generatedAt}`);
  }
  for (const [from, to, generatedAt] of rejects) {
    const body = envelope();
    Object.assign(body.data.period, { from, to });
    Object.assign(body.data, { generatedAt });
    assert.throws(() => parse(body, 30), `${from} < ${to} <= ${generatedAt}`);
  }
});

test("actual ratio handles zero denominators, invalid counts and safe one-decimal percentages", () => {
  assert.equal(ratio(0, 0), null);
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(0, 10), 0);
  assert.equal(ratio(1, 3), 33.3);
  assert.equal(ratio(2, 3), 66.7);
  assert.equal(ratio(1, 16), 6.3);
  assert.equal(ratio(MAX, MAX), 100);
  assert.equal(ratio(MAX - 1, MAX), 100);
  assert.equal(ratio(1, MAX), 0);
  assert.equal(ratio(3, 2), null);
  for (const invalid of invalidCounts) {
    assert.equal(ratio(invalid, 10), null, `numerator ${String(invalid)}`);
    assert.equal(ratio(0, invalid), null, `denominator ${String(invalid)}`);
  }
});

const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));
function materialize(value: any): any {
  if (Array.isArray(value)) return Array.from(value, materialize);
  if (!value || typeof value !== "object" || !("props" in value)) return value;
  if (typeof value.type === "function") return materialize(value.type(value.props));
  return { ...value, props: { ...value.props, children: materialize(value.props.children) } };
}
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return Array.from(value).flatMap(nodes);
  return value && typeof value === "object" && "props" in value ? [value, ...nodes(value.props.children)] : [];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

// Same bounded hook/effect scheduling pattern as the existing mortgage UI suites.
class ReactHookDriver {
  slots: any[] = [];
  writes: any[] = [];
  cursor = 0;
  dirty = true;
  mounted = true;
  tree: any;
  render = () => this.tree;
  hooks = {
    useState: (initial: any) => {
      const index = this.cursor++;
      this.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [this.slots[index].value, (update: any) => {
        const value = typeof update === "function" ? update(this.slots[index].value) : update;
        this.writes.push(value);
        if (this.mounted && !Object.is(value, this.slots[index].value)) { this.slots[index].value = value; this.dirty = true; }
      }];
    },
    useRef: (initial: any) => { const index = this.cursor++; return this.slots[index] ??= { current: initial }; },
    useId: () => { const index = this.cursor++; return `synthetic-results-${index}`; },
    useMemo: (create: () => any, deps?: unknown[]) => {
      const index = this.cursor++;
      if (!this.slots[index] || !sameDeps(this.slots[index].deps, deps)) this.slots[index] = { value: create(), deps };
      return this.slots[index].value;
    },
    useEffect: (create: () => any, deps?: unknown[]) => {
      const index = this.cursor++, old = this.slots[index];
      this.slots[index] = { create, deps, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
    },
  };
  paint() {
    this.cursor = 0;
    this.dirty = false;
    this.tree = materialize(this.render());
    return this.tree;
  }
  async flush() {
    for (let pass = 0; pass < 30; pass++) {
      if (this.mounted && this.dirty) this.paint();
      const pending = this.slots.filter((slot) => slot?.pending);
      pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); slot.cleanup = slot.create(); });
      await tick();
      if (!this.dirty && !this.slots.some((slot) => slot?.pending)) return this.tree;
    }
    assert.fail("Mortgage results hook driver did not settle");
  }
  unmount() {
    this.mounted = false;
    this.slots.forEach((slot) => slot?.cleanup?.());
  }
  replayEffects() {
    for (const slot of this.slots) if (slot?.create) { slot.cleanup?.(); slot.cleanup = slot.create(); }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function componentFixture() {
  const driver = new ReactHookDriver();
  const calls: Array<{ path: string; init: RequestInit; deferred: ReturnType<typeof deferred<Response>> }> = [];
  let current = true;
  const props = {
    workspaceId: "synthetic-workspace & local",
    isCurrent: () => current,
    request: (path: string, init: RequestInit = {}) => {
      const pending = deferred<Response>();
      calls.push({ path, init, deferred: pending });
      return pending.promise;
    },
  };
  const module = evaluate(source, {
    react: driver.hooks, "lucide-react": { RefreshCw: "refresh-icon" },
    "@/lib/permissions": { roleLabels: { owner: "Owner", admin: "Admin", lead_manager: "Manager" } },
    "@/components/mortgage/MortgagePrimitives": {
      MortgageIconButton: (values: Node["props"]) => jsx("button", { ...values, "aria-label": values.label }),
      MortgageState: (values: Node["props"]) => jsx("state", values),
      mortgageSegmentClass: "synthetic-segment", mortgageTableClass: "synthetic-table",
    },
  });
  driver.render = () => module.MortgageResults(props);
  const find = (predicate: (node: Node) => boolean) => {
    const found = nodes(driver.tree).find(predicate);
    assert.ok(found, "expected a rendered control/node");
    return found;
  };
  return { driver, calls, props, find,
    setCurrent(value: boolean) { current = value; driver.dirty = true; },
    period(days: number) { find((node) => node.type === "button" && text(node) === `${days} дней`).props.onClick(); },
    refresh() { find((node) => node.type === "button" && node.props.label === "Обновить встречи и договоры").props.onClick(); },
  };
}
const response = (body: unknown = envelope(), status = 200) => new Response(JSON.stringify(body), { status });
const delayedBody = () => {
  const body = deferred<unknown>();
  let reads = 0;
  return { body, get reads() { return reads; }, response: {
    ok: true, status: 200, json: () => { reads += 1; return body.promise; },
  } as Response };
};
function cells(row: Node): string[] {
  return nodes(row.props.children).filter((node) => node.type === "th" || node.type === "td").map(text);
}
function renderedTables(fixture: ReturnType<typeof componentFixture>): Node[] {
  return nodes(fixture.driver.tree).filter((node) => node.type === "table");
}

test("actual table totals are weighted, include inactive staff, and use after-meeting clients rather than all signed clients", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  const body = envelope(30, [
    member({ assignedLeads: 2, heldLeads: 2, signedLeads: 2, heldSignedLeads: 2, signedInPeriod: 9 }),
    member({ staffId: id(2), name: "Synthetic inactive manager", status: "inactive", assignedLeads: 18, heldLeads: 6, signedLeads: 3, heldSignedLeads: 1, signedInPeriod: 100 }),
  ]);
  body.data.unassignedLeads = 100;
  body.data.otherAssigneeLeads = 200;
  f.calls[0]!.deferred.resolve(response(body));
  await f.driver.flush();
  const tables = renderedTables(f);
  assert.equal(tables.length, 2);
  const footers = tables.map((table) => nodes(table).find((node) => node.type === "tfoot")!);
  const totalRow = nodes(footers[0]).find((node) => node.type === "tr")!;
  assert.deepEqual(cells(totalRow).slice(1), ["20", "8", "5", "3", "40,0%", "25,0%", "37,5%"]);
  const rows = nodes(tables[0]).filter((node) => node.type === "tbody").flatMap((node) => nodes(node).filter((entry) => entry.type === "tr"));
  assert.equal(rows.length, 2);
  assert.match(text(rows[1]), /Synthetic inactive manager/);
  assert.match(text(rows[1]), /Неактивен/);
  assert.deepEqual(cells(rows[1]!).slice(-3), ["33,3%", "16,7%", "16,7%"]);
  assert.equal(cells(nodes(footers[1]).find((node) => node.type === "tr")!).at(-1), "109");
  assert.notEqual(40, (ratio(2, 2)! + ratio(6, 18)!) / 2);
  assert.notEqual(37.5, ratio(5, 8), "all signed clients / held clients is not the after-meeting conversion");
  assert.match(text(tables[0]), /Договор после встречи/);
});

for (const [at, zone, localDay, localTime] of [
  ["2026-01-01T20:10:00.000Z", "Asia/Almaty", "02.01.2026", "01:10"],
  ["2026-01-01T20:10:00.000Z", "Pacific/Chatham", "02.01.2026", "09:55"],
  ["2026-03-08T06:30:00.000Z", "America/New_York", "08.03.2026", "01:30"],
  ["2026-03-08T07:30:00.000Z", "America/New_York", "08.03.2026", "03:30"],
  ["2026-01-01T20:10:00.000Z", "UTC", "01.01.2026", "20:10"],
]) test(`results snapshot and period labels use report zone ${zone} at ${at}`, async t => {
  const f = componentFixture(); t.after(() => f.driver.unmount()); await f.driver.flush();
  const body = envelope(); body.data.timeZone = zone; body.data.generatedAt = body.data.period.to = at;
  body.data.period.from = new Date(Date.parse(at) - 30 * 86400000).toISOString();
  f.calls[0]!.deferred.resolve(response(body)); await f.driver.flush();
  assert.equal(renderedTables(f).length, 2);
  const expected = new Date(at).toLocaleString("ru-RU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  assert.ok(expected.includes(localDay) && expected.includes(localTime));
  assert.ok(text(f.driver.tree).split(expected).length >= 3, "Snapshot and period.to must both use the supplied zone");
  const from = new Date(body.data.period.from).toLocaleString("ru-RU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  assert.ok(text(f.driver.tree).includes(from));
});

test("actual zero-denominator cells display dashes, not 0% or infinity", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  f.calls[0]!.deferred.resolve(response(envelope(30, [member({ assignedLeads: 0, heldLeads: 0, signedLeads: 0, heldSignedLeads: 0, signedInPeriod: 5 })])));
  await f.driver.flush();
  const table = renderedTables(f)[0]!;
  const rows = nodes(table).filter((node) => node.type === "tr").slice(1);
  assert.equal(rows.length, 2);
  rows.forEach((row) => assert.deepEqual(cells(row).slice(-3), ["—", "—", "—"]));
});

for (const late of ["request", "body"] as const) test(`period change discards a stale ${late} after the new report is ready`, async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  assert.equal(f.calls[0]!.init.method, "GET");
  assert.equal(f.calls[0]!.init.cache, "no-store");
  assert.equal(f.calls[0]!.path, `/api/crm/mortgage-results?${new URLSearchParams({ workspaceId: f.props.workspaceId, days: "30" })}`);
  const old = delayedBody();
  if (late === "body") {
    f.calls[0]!.deferred.resolve(old.response);
    await f.driver.flush();
    assert.equal(old.reads, 1);
  }
  f.period(7);
  assert.equal(f.calls[0]!.init.signal!.aborted, true, "period click invalidates before effect cleanup");
  await f.driver.flush();
  assert.equal(renderedTables(f).length, 0);
  assert.match(f.calls[1]!.path, /days=7$/);
  f.calls[1]!.deferred.resolve(response(envelope(7, [member({ name: "Fresh 7-day result" })])));
  await f.driver.flush();
  const writes = f.driver.writes.length;
  if (late === "request") f.calls[0]!.deferred.resolve(response(envelope(30, [member({ name: "Stale result" })])));
  else old.body.resolve(envelope(30, [member({ name: "Stale result" })]));
  await f.driver.flush();
  assert.equal(f.driver.writes.length, writes, "obsolete completion must not write state");
  assert.match(text(f.driver.tree), /Fresh 7-day result/);
  assert.doesNotMatch(text(f.driver.tree), /Stale result/);
});

test("refresh clears old tables immediately and overlapping same-period responses cannot replace the latest body", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  f.calls[0]!.deferred.resolve(response(envelope(30, [member({ name: "Initial report" })])));
  await f.driver.flush();
  const refresh = f.find((node) => node.props.label === "Обновить встречи и договоры").props.onClick;
  refresh();
  await f.driver.flush();
  assert.equal(renderedTables(f).length, 0);
  const old = delayedBody();
  f.calls[1]!.deferred.resolve(old.response);
  await f.driver.flush();
  assert.equal(old.reads, 1);
  // A retained handler exercises the revision guard even if a UI click was queued before disabling.
  refresh();
  await f.driver.flush();
  assert.equal(f.calls[1]!.init.signal!.aborted, true);
  f.calls[2]!.deferred.resolve(response(envelope(30, [member({ name: "Latest refresh" })])));
  await f.driver.flush();
  const writes = f.driver.writes.length;
  old.body.resolve(envelope(30, [member({ name: "Outdated refresh" })]));
  await f.driver.flush();
  assert.equal(f.driver.writes.length, writes);
  assert.match(text(f.driver.tree), /Latest refresh/);
  assert.doesNotMatch(text(f.driver.tree), /Initial report|Outdated refresh/);
});

for (const late of ["request", "body", "rejection"] as const) test(`unmount aborts and prevents late ${late} state writes`, async () => {
  const f = componentFixture();
  await f.driver.flush();
  const old = delayedBody();
  if (late === "body") { f.calls[0]!.deferred.resolve(old.response); await f.driver.flush(); }
  f.driver.unmount();
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
  const writes = f.driver.writes.length;
  if (late === "body") old.body.resolve(envelope());
  else if (late === "rejection") f.calls[0]!.deferred.reject(new Error("late local rejection"));
  else f.calls[0]!.deferred.resolve(response());
  await tick();
  await tick();
  assert.equal(f.driver.writes.length, writes);
});

test("isCurrent guards pending body completion, rendering and retained actions", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  const old = delayedBody();
  f.calls[0]!.deferred.resolve(old.response);
  await f.driver.flush();
  const refresh = f.find((node) => node.props.label === "Обновить встречи и договоры").props.onClick;
  const period = f.find((node) => node.type === "button" && text(node) === "7 дней").props.onClick;
  const writes = f.driver.writes.length;
  f.setCurrent(false);
  refresh();
  period();
  old.body.resolve(envelope());
  await f.driver.flush();
  assert.equal(f.driver.tree, null);
  assert.equal(f.driver.writes.length, writes);
  assert.equal(f.calls.length, 1);
});

test("workspace prop change hides ready data before effects, and stale bodies cannot cross workspaces", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  f.calls[0]!.deferred.resolve(response(envelope(30, [member({ name: "Old workspace" })])));
  await f.driver.flush();
  f.refresh();
  await f.driver.flush();
  const old = delayedBody();
  f.calls[1]!.deferred.resolve(old.response);
  await f.driver.flush();
  f.props.workspaceId = "new-synthetic-workspace";
  f.driver.paint();
  assert.equal(renderedTables(f).length, 0);
  const writes = f.driver.writes.length;
  old.body.resolve(envelope(30, [member({ name: "Old workspace body" })]));
  await tick();
  assert.equal(f.driver.writes.length, writes, "latest render guard precedes old-effect cleanup");
  await f.driver.flush();
  assert.match(f.calls[2]!.path, /workspaceId=new-synthetic-workspace/);
  f.calls[2]!.deferred.resolve(response(envelope(30, [member({ name: "New workspace" })])));
  await f.driver.flush();
  assert.match(text(f.driver.tree), /New workspace/);
  assert.doesNotMatch(text(f.driver.tree), /Old workspace/);
});

test("StrictMode-style effect replay aborts the first request and accepts only its fresh replacement", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  f.driver.replayEffects();
  await f.driver.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
  assert.equal(f.calls[1]!.init.signal!.aborted, false);
  f.calls[1]!.deferred.resolve(response(envelope(30, [member({ name: "Replay fresh" })])));
  await f.driver.flush();
  const writes = f.driver.writes.length;
  f.calls[0]!.deferred.resolve(response(envelope(30, [member({ name: "Replay stale" })])));
  await f.driver.flush();
  assert.equal(f.driver.writes.length, writes);
  assert.match(text(f.driver.tree), /Replay fresh/);
  assert.doesNotMatch(text(f.driver.tree), /Replay stale/);
});

for (const failure of ["schema503", "storage503", "forbidden", "network", "json", "invalid", "wrongPeriod"] as const) {
  test(`${failure} clears previous data and renders an honest retryable error`, async (t) => {
    const f = componentFixture();
    t.after(() => f.driver.unmount());
    await f.driver.flush();
    f.calls[0]!.deferred.resolve(response(envelope(30, [member({ name: "Previously ready" })])));
    await f.driver.flush();
    assert.equal(renderedTables(f).length, 2);
    f.refresh();
    await f.driver.flush();
    assert.equal(renderedTables(f).length, 0);
    const pending = f.calls[1]!.deferred;
    if (failure === "network") pending.reject(new Error("local synthetic failure"));
    else if (failure === "json") pending.resolve(new Response("not json", { status: 200 }));
    else if (failure === "schema503") pending.resolve(response({ success: false, code: "schema_not_ready" }, 503));
    else if (failure === "storage503") pending.resolve(response({ success: false, code: "storage_not_configured" }, 503));
    else if (failure === "forbidden") pending.resolve(response({ success: false }, 403));
    else if (failure === "wrongPeriod") pending.resolve(response(envelope(7)));
    else pending.resolve(response({ success: true, mode: "supabase", data: {} }));
    await f.driver.flush();
    const error = f.find((node) => node.type === "state");
    assert.equal(error.props.kind, failure === "forbidden" ? "denied" : "error");
    assert.equal(renderedTables(f).length, 0);
    assert.doesNotMatch(text(f.driver.tree), /Previously ready/);
    assert.equal(typeof error.props.onRetry, "function");
    if (failure === "schema503") assert.match(text(error), /ещё не подключён/);
    else assert.doesNotMatch(text(error), /ещё не подключён/);
    error.props.onRetry();
    await f.driver.flush();
    assert.equal(f.calls.length, 3);
    f.calls[2]!.deferred.resolve(response());
    await f.driver.flush();
    assert.equal(renderedTables(f).length, 2);
  });
}

test("successful empty results remain empty states, not errors or invented table rows", async (t) => {
  const f = componentFixture();
  t.after(() => f.driver.unmount());
  await f.driver.flush();
  f.calls[0]!.deferred.resolve(response(envelope(30, [])));
  await f.driver.flush();
  assert.equal(renderedTables(f).length, 0);
  const states = nodes(f.driver.tree).filter((node) => node.type === "state");
  assert.equal(states.length, 2);
  states.forEach((node) => assert.equal(node.props.kind, "empty"));
  assert.match(text(f.driver.tree), /Без ответственного: 3/);
  assert.match(text(f.driver.tree), /Другие ответственные: 2/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual local parser and panel execution only. Hook scheduling, presentation and
// imported date helpers are synthetic; no app, providers, environment or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const filename = "artifacts/negis/src/components/mortgage/MortgageContractPanel.tsx";
const source = await readFile(path.join(root, filename), "utf8");
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const id = (n: number) => `abcdefab-cdef-4abc-8def-${String(n).padStart(12, "0")}`;
const leadId = id(1), workspaceId = id(2), contractId = id(3);
const fixedNow = "2026-10-20T12:00:00.000Z";
class FixedDate extends Date {
  constructor(value?: string | number) { super(value === undefined ? fixedNow : value); }
  static now() { return Date.parse(fixedNow); }
}

type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });
function evaluate(input: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const result = ts.transpileModule(input, { fileName: filename, reportDiagnostics: true, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  new Script(result.outputText, { filename }).runInNewContext({ exports, Date: FixedDate, Error, DOMException, AbortController, URLSearchParams,
    fetch: () => assert.fail("Unexpected network call in a local contract UI test"), ...bindings,
    require(name: string) {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}
function select(names: string[]) {
  const statements = names.map((name) => {
    const matches = ast.statements.filter((node) => (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name);
    assert.equal(matches.length, 1, `select the actual ${name} declaration`);
    if (name.startsWith("parseMortgage")) {
      const node = matches[0]!;
      assert.ok(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword), `${name} is exported`);
    }
    return matches[0]!.getText(ast);
  });
  return statements.join("\n");
}
const pure = evaluate(select(["ContractError", "isObject", "isInstant", "isUuid", "isContract", "parseMortgageContractSnapshot", "parseMortgageContractReceipt"]));
const parseSnapshot = pure.parseMortgageContractSnapshot as (value: unknown, leadId: string) => { records: ReturnType<typeof record>[]; truncated: boolean };
const parseReceipt = pure.parseMortgageContractReceipt as (value: unknown) => { id: string; replayed: boolean };
function record(overrides: Record<string, any> = {}) {
  return { id: contractId, leadId, reference: "Local-001", signedAt: "2026-10-18T12:00:00.123456Z",
    responsibleStaffId: id(4), responsibleName: "Synthetic assignee", recordedByName: "Synthetic actor",
    voidedAt: null, voidReason: "", ...overrides };
}
const snapshot = (records = [] as ReturnType<typeof record>[], truncated = false) => ({ records, truncated });
const voided = (overrides: Record<string, any> = {}) => record({ voidedAt: "2026-10-19T12:00:00+00:00", voidReason: "Local correction reason", ...overrides });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("actual snapshot export accepts empty, active and corrected records without mutating input", () => {
  for (const value of [snapshot(), snapshot([], true), snapshot([record()]), snapshot([voided(), record({ id: id(5) })], true)]) {
    const before = JSON.stringify(value);
    freeze(value);
    const parsed = parseSnapshot(value, leadId);
    assert.equal(parsed.records, value.records);
    assert.equal(parsed.truncated, value.truncated);
    assert.equal(JSON.stringify(value), before);
  }
  const parsed = parseSnapshot(snapshot([voided({ voidReason: "Reason\nkept verbatim", reference: "", responsibleName: "", recordedByName: "" })]), leadId);
  assert.equal(parsed.records[0]!.voidReason, "Reason\nkept verbatim");
});

test("snapshot UUID uniqueness is case-insensitive, and at most one nonvoid record is allowed", () => {
  for (const duplicate of [contractId, contractId.toUpperCase()]) {
    assert.throws(() => parseSnapshot(snapshot([voided(), voided({ id: duplicate })]), leadId));
  }
  assert.throws(() => parseSnapshot(snapshot([record(), record({ id: id(5) })]), leadId));
  assert.equal(parseSnapshot(snapshot([voided({ id: contractId.toUpperCase() }), record({ id: id(5) })]), leadId).records.length, 2);
});

test("snapshot enforces record, reference and correction-reason caps at their exact boundaries", () => {
  const hundred = Array.from({ length: 100 }, (_, index) => voided({ id: id(index + 100), reference: "r".repeat(100), voidReason: "v".repeat(500) }));
  assert.equal(parseSnapshot(snapshot(hundred, true), leadId).records.length, 100);
  assert.throws(() => parseSnapshot(snapshot([...hundred, voided({ id: id(999) })], true), leadId));
  assert.throws(() => parseSnapshot(snapshot([record({ reference: "r".repeat(101) })]), leadId));
  assert.throws(() => parseSnapshot(snapshot([voided({ voidReason: "v".repeat(501) })]), leadId));
});

test("snapshot rejects missing/null/non-UUID identity fields and any foreign lead", () => {
  for (const field of ["id", "responsibleStaffId", "leadId"]) {
    for (const invalid of [null, undefined, "", "not-a-uuid", 1, [], `${id(1)} `]) {
      assert.throws(() => parseSnapshot(snapshot([record({ [field]: invalid })]), leadId), `${field}: ${String(invalid)}`);
    }
    const missing: any = record();
    delete missing[field];
    assert.throws(() => parseSnapshot(snapshot([missing]), leadId), `missing ${field}`);
  }
  assert.throws(() => parseSnapshot(snapshot([record({ leadId: id(999) })]), leadId));
});

test("snapshot rejects malformed collections, missing metadata and invalid dates", () => {
  for (const value of [null, undefined, [], true, {}, { records: null, truncated: false },
    { records: {}, truncated: false }, { records: [], truncated: null }, { records: [] }, { records: [], truncated: "false" },
    { records: [null], truncated: false }, { records: [[]], truncated: false }]) assert.throws(() => parseSnapshot(value, leadId));
  for (const field of ["reference", "responsibleName", "recordedByName", "voidReason"]) {
    for (const invalid of [null, undefined, 1, []]) assert.throws(() => parseSnapshot(snapshot([record({ [field]: invalid })]), leadId));
    const missing: any = record();
    delete missing[field];
    assert.throws(() => parseSnapshot(snapshot([missing]), leadId));
  }
  for (const invalid of [null, undefined, "", "not-a-date", "2026-10-18", "2026-10-18T12:00:00", "2026-13-01T12:00:00Z", 0]) {
    assert.throws(() => parseSnapshot(snapshot([record({ signedAt: invalid })]), leadId));
  }
});

test("voidedAt and voidReason must consistently represent either an active or corrected record", () => {
  for (const overrides of [
    { voidedAt: null, voidReason: "Should not be attached to active record" },
    { voidedAt: null, voidReason: " " }, { voidedAt: undefined },
    { voidedAt: "bad date", voidReason: "reason" }, { voidedAt: false, voidReason: "reason" },
    { voidedAt: "2026-10-19T12:00:00Z", voidReason: "" },
    { voidedAt: "2026-10-19T12:00:00Z", voidReason: " \n\t " },
    { voidedAt: "2026-10-19T12:00:00Z", voidReason: null },
  ]) assert.throws(() => parseSnapshot(snapshot([record(overrides)]), leadId), JSON.stringify(overrides));
  const missing: any = record();
  delete missing.voidedAt;
  assert.throws(() => parseSnapshot(snapshot([missing]), leadId));
});

test("receipt export requires both a UUID id and an explicit boolean replayed value", () => {
  for (const replayed of [false, true]) {
    const receipt = freeze({ id: contractId.toUpperCase(), replayed });
    const parsed = parseReceipt(receipt);
    assert.equal(parsed.id, receipt.id);
    assert.equal(parsed.replayed, replayed);
  }
  for (const value of [null, undefined, [], {}, { id: contractId }, { replayed: false },
    { id: contractId, replayed: null }, { id: contractId, replayed: 0 }, { id: contractId, replayed: "false" }]) assert.throws(() => parseReceipt(value));
  for (const invalid of [null, undefined, "", "not-a-uuid", 1, [], `${contractId} `]) assert.throws(() => parseReceipt({ id: invalid, replayed: false }));
});

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
  if (Array.isArray(value)) return Array.from(value, text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}
const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));

// Locally adapted from medina-mortgage-results-ui.test.ts. The wrapper has no
// hooks and its one child owns these slots; keyed-remount/parent auth is not simulated.
class ReactHookDriver {
  slots: any[] = [];
  writes: any[] = [];
  cursor = 0;
  dirty = true;
  mounted = true;
  tree: any;
  render = () => this.tree;
  memo = (create: () => any, deps?: unknown[]) => {
    const index = this.cursor++;
    if (!this.slots[index] || !sameDeps(this.slots[index].deps, deps)) this.slots[index] = { value: create(), deps };
    return this.slots[index].value;
  };
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
    useId: () => `synthetic-contract-${this.cursor++}`,
    useCallback: (callback: any, deps?: unknown[]) => this.memo(() => callback, deps),
    useEffect: (create: () => any, deps?: unknown[]) => {
      const index = this.cursor++, old = this.slots[index];
      this.slots[index] = { create, deps, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
    },
  };
  paint() {
    this.cursor = 0; this.dirty = false;
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
    assert.fail("Contract panel hook driver did not settle");
  }
  unmount() { this.mounted = false; this.slots.forEach((slot) => slot?.cleanup?.()); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (data: unknown = snapshot(), status = 200) => new Response(JSON.stringify({ success: true, mode: "supabase", data }), { status });
const schema503 = () => new Response(JSON.stringify({ success: false, code: "schema_not_ready" }), { status: 503 });
function delayedBody() {
  const body = deferred<unknown>();
  let reads = 0;
  return { body, get reads() { return reads; }, response: { ok: true, status: 200, json: () => { reads += 1; return body.promise; } } as Response };
}
type Call = { path: string; init: RequestInit; method: string; pending: ReturnType<typeof deferred<Response>> };
function fixture() {
  const driver = new ReactHookDriver();
  const calls: Call[] = [], generated: string[] = [];
  let current = true;
  const props = { leadId, workspaceId, timeZone: "UTC", canEdit: true, canVoid: true, isCurrent: () => current,
    request: (path: string, init: RequestInit = {}) => {
      const pending = deferred<Response>();
      calls.push({ path, init, method: init.method ?? "GET", pending });
      return pending.promise;
    },
  };
  const module = evaluate(source, {
    react: driver.hooks,
    "lucide-react": Object.fromEntries(["FileCheck", "Loader2", "RefreshCw", "Undo2", "X"].map((name) => [name, name])),
    "@/lib/mortgage-workspace": {
      mortgageLocalDateTime: (value: string) => new Date(value).toISOString().slice(0, 16),
      mortgageDateTimeToIso: (value: string) => new Date(`${value}Z`).toISOString(),
    },
    "./MortgagePrimitives": {
      MortgageIconButton: (values: Node["props"]) => jsx("button", { ...values, "aria-label": values.label }),
      MortgageState: (values: Node["props"]) => jsx("state", values),
      mortgageDate: (value: string) => value,
      mortgageErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
      mortgageButtonClass: "synthetic-button", mortgageInputClass: "synthetic-input", mortgagePrimaryClass: "synthetic-primary",
    },
  }, { crypto: { randomUUID: () => { const value = id(1000 + generated.length); generated.push(value); return value; } } });
  driver.render = () => module.MortgageContractPanel(props);
  const find = (predicate: (node: Node) => boolean) => {
    const found = nodes(driver.tree).find(predicate);
    assert.ok(found, "expected a rendered panel control");
    return found;
  };
  const event = () => ({ preventDefault() {} });
  return { driver, calls, generated, props, find,
    setCurrent(value: boolean) { current = value; driver.dirty = true; },
    writes() { return calls.filter((call) => call.method !== "GET"); },
    gets() { return calls.filter((call) => call.method === "GET"); },
    body(call: Call) { return JSON.parse(String(call.init.body)); },
    refresh() { find((node) => node.props.label === "Обновить историю договоров").props.onClick(); },
    submit() { find((node) => node.type === "form").props.onSubmit(event()); },
    confirm(checked = true) { find((node) => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked } }); },
    reference(value: string) { find((node) => node.type === "input" && node.props.type === "text").props.onChange({ target: { value } }); },
    reason(value: string) { find((node) => node.type === "textarea").props.onChange({ target: { value } }); },
    correct() { find((node) => node.type === "button" && text(node) === "Исправить ошибочную запись").props.onClick(); },
  };
}
async function ready(f: ReturnType<typeof fixture>, data = snapshot()) {
  await f.driver.flush();
  assert.equal(f.gets().length, 1);
  assert.equal(f.gets()[0]!.path, `/api/crm/mortgage-contracts?${new URLSearchParams({ leadId, workspaceId })}`);
  f.gets()[0]!.pending.resolve(response(data));
  await f.driver.flush();
}
async function prepareWrite(f: ReturnType<typeof fixture>, method: "POST" | "PATCH") {
  await ready(f, method === "POST" ? snapshot() : snapshot([record()]));
  if (method === "POST") { f.reference("  Local retry  "); f.confirm(); }
  else { f.correct(); await f.driver.flush(); f.reason("  Local wrong-record reason  "); }
  await f.driver.flush();
}

test("missing confirmation blocks the actual POST callback without generating a UUID", async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await ready(f);
  f.reference("Local unconfirmed"); await f.driver.flush();
  f.submit(); await f.driver.flush();
  assert.equal(f.writes().length, 0);
  assert.equal(f.generated.length, 0);
  assert.equal(f.find((node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
});

for (const method of ["POST", "PATCH"] as const) test(`${method} double submissions are blocked synchronously before a rerender`, async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, method);
  const submit = f.find((node) => node.type === "form").props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} });
  assert.equal(f.writes().length, 1);
  assert.equal(f.generated.length, 1);
  assert.equal(f.writes()[0]!.method, method);
  assert.equal(new Headers(f.writes()[0]!.init.headers).get("Content-Type"), "application/json");
  const payload = f.body(f.writes()[0]!);
  assert.equal(payload.leadId, leadId);
  assert.equal(payload.requestId, f.generated[0]);
  if (method === "POST") { assert.equal(payload.reference, "Local retry"); assert.equal(payload.signedAt, fixedNow); }
  else { assert.equal(payload.id, contractId); assert.equal(payload.reason, "Local wrong-record reason"); }
  f.writes()[0]!.pending.reject(new Error("local double-click cleanup"));
  await f.driver.flush();
});

for (const method of ["POST", "PATCH"] as const) for (const failure of ["network", "successBody", "bodyRead"] as const) {
  test(`${method} preserves one UUID and identical payload after ambiguous ${failure} failure`, async (t) => {
    const f = fixture(); t.after(() => f.driver.unmount());
    await prepareWrite(f, method);
    f.submit();
    const first = f.writes()[0]!;
    const payload = f.body(first);
    if (failure === "network") first.pending.reject(new Error("ambiguous local network failure"));
    else if (failure === "successBody") first.pending.resolve(response({ id: contractId }));
    else first.pending.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("ambiguous local body read")) } as Response);
    await f.driver.flush();
    assert.ok(nodes(f.driver.tree).some((node) => node.props.role === "alert"));
    assert.doesNotMatch(text(f.driver.tree), /Договор учтён\.|Ошибочная запись исправлена\./);
    assert.equal(f.gets().length, 1);
    f.submit();
    const second = f.writes()[1]!;
    assert.deepEqual(f.body(second), payload);
    assert.equal(f.generated.length, 1);
    second.pending.resolve(response({ id: contractId, replayed: true }));
    await f.driver.flush();
    assert.equal(f.gets().length, 2);
    f.gets()[1]!.pending.resolve(response(method === "POST" ? snapshot([record()]) : snapshot([voided()])));
    await f.driver.flush();
    assert.match(text(f.driver.tree), method === "POST" ? /Договор учтён\./ : /Ошибочная запись исправлена\./);
    assert.match(text(f.driver.tree), /Повторный запрос подтверждён/);
    assert.equal(nodes(f.driver.tree).filter((node) => node.props.role === "alert").length, 0);
  });
}

for (const method of ["POST", "PATCH"] as const) test(`${method} generates a new UUID for a changed payload after a failed attempt`, async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, method);
  f.submit();
  const first = f.writes()[0]!;
  first.pending.reject(new Error("local ambiguous failure"));
  await f.driver.flush();
  if (method === "POST") f.reference("Changed local reference");
  else f.reason("Changed local correction reason");
  await f.driver.flush();
  f.submit();
  const second = f.writes()[1]!;
  assert.equal(f.generated.length, 2);
  assert.notEqual(f.body(first).requestId, f.body(second).requestId);
  assert.equal(method === "POST" ? f.body(second).reference : f.body(second).reason,
    method === "POST" ? "Changed local reference" : "Changed local correction reason");
  second.pending.reject(new Error("local cleanup")); await f.driver.flush();
});

test("a confirmed write followed by a history read error retries only GET, without repeating POST", async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, "POST");
  f.submit();
  f.writes()[0]!.pending.resolve(response({ id: contractId, replayed: false }));
  await f.driver.flush();
  f.gets()[1]!.pending.reject(new Error("local history read error"));
  await f.driver.flush();
  assert.match(text(f.driver.tree), /Договор учтён\./);
  assert.equal(nodes(f.driver.tree).filter((node) => node.type === "form").length, 0);
  const retry = f.find((node) => node.type === "state" && node.props.kind === "error").props.onRetry;
  retry(); await f.driver.flush();
  assert.equal(f.gets().length, 3);
  assert.equal(f.writes().length, 1);
  assert.equal(f.generated.length, 1);
  f.gets()[2]!.pending.resolve(response(snapshot([record()]))); await f.driver.flush();
  assert.match(text(f.driver.tree), /Local-001/);
  assert.equal(nodes(f.driver.tree).filter((node) => node.type === "input" && node.props.type === "checkbox").length, 0);
});

test("an ambiguous POST retains its UUID through a separate failed history refresh and an unchanged form retry", async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, "POST");
  f.submit();
  const originalPayload = f.body(f.writes()[0]!);
  f.writes()[0]!.pending.reject(new Error("ambiguous local save"));
  await f.driver.flush();
  f.refresh(); await f.driver.flush();
  f.gets()[1]!.pending.reject(new Error("local history read error"));
  await f.driver.flush();
  f.find((node) => node.type === "state" && node.props.kind === "error").props.onRetry();
  await f.driver.flush();
  f.gets()[2]!.pending.resolve(response(snapshot()));
  await f.driver.flush();
  assert.equal(f.find((node) => node.type === "input" && node.props.type === "checkbox").props.checked, true);
  f.submit();
  assert.deepEqual(f.body(f.writes()[1]!), originalPayload);
  assert.equal(f.generated.length, 1);
  f.writes()[1]!.pending.reject(new Error("local cleanup"));
  await f.driver.flush();
});

for (const stage of ["GET", "POST", "PATCH"] as const) test(`${stage} schema503 hides forms and reports unavailable storage, not an empty history`, async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  if (stage === "GET") { await f.driver.flush(); f.gets()[0]!.pending.resolve(schema503()); }
  else { await prepareWrite(f, stage); f.submit(); f.writes()[0]!.pending.resolve(schema503()); }
  await f.driver.flush();
  assert.match(text(f.driver.tree), /Учёт договоров ещё не подключён/);
  assert.doesNotMatch(text(f.driver.tree), /Учтённых договоров нет|Договор учтён\.|Ошибочная запись исправлена\./);
  assert.equal(nodes(f.driver.tree).filter((node) => node.type === "form").length, 0);
  assert.equal(nodes(f.driver.tree).filter((node) => node.type === "ol").length, 0);
});

for (const stale of ["GET", "body", "readError"] as const) test(`late ${stale} cannot replace a fresher read revision`, async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await f.driver.flush();
  const old = delayedBody();
  if (stale !== "GET") { f.gets()[0]!.pending.resolve(old.response); await f.driver.flush(); assert.equal(old.reads, 1); }
  f.refresh();
  assert.equal(f.gets()[0]!.init.signal!.aborted, true);
  await f.driver.flush();
  f.gets()[1]!.pending.resolve(response(snapshot([record({ reference: "Fresh local history" })])));
  await f.driver.flush();
  const writes = f.driver.writes.length;
  if (stale === "GET") f.gets()[0]!.pending.resolve(response(snapshot([record({ reference: "Stale history" })])));
  else if (stale === "body") old.body.resolve({ success: true, mode: "supabase", data: snapshot([record({ reference: "Stale history" })]) });
  else old.body.reject(new Error("stale local read failure"));
  await f.driver.flush();
  assert.equal(f.driver.writes.length, writes);
  assert.match(text(f.driver.tree), /Fresh local history/);
  assert.doesNotMatch(text(f.driver.tree), /Stale history|stale local read failure/);
});

for (const method of ["POST", "PATCH"] as const) for (const end of ["isCurrentFalse", "unmount"] as const) {
  for (const stage of ["request", "body"] as const) for (const outcome of ["success", "error"] as const) {
    test(`${method} late ${stage} ${outcome} after ${end} cannot set error/notice/busy or refresh history`, async (t) => {
      const f = fixture(); t.after(() => { if (f.driver.mounted) f.driver.unmount(); });
      await prepareWrite(f, method);
      f.submit();
      const call = f.writes()[0]!, old = delayedBody();
      if (stage === "body") { call.pending.resolve(old.response); await f.driver.flush(); assert.equal(old.reads, 1); }
      if (end === "unmount") f.driver.unmount();
      else { f.setCurrent(false); f.driver.paint(); assert.equal(f.driver.tree, null); }
      const writes = f.driver.writes.length, gets = f.gets().length;
      if (stage === "request") {
        if (outcome === "success") call.pending.resolve(response({ id: contractId, replayed: false }));
        else call.pending.reject(new Error("late local write failure"));
      } else if (outcome === "success") old.body.resolve({ success: true, mode: "supabase", data: { id: contractId, replayed: false } });
      else old.body.reject(new Error("late local write body failure"));
      await tick(); await tick();
      assert.equal(f.driver.writes.length, writes);
      assert.equal(f.gets().length, gets);
      assert.equal(f.writes().length, 1);
    });
  }
}

test("PATCH rejects a receipt for a different record and retries the same UUID/reason until the matching receipt", async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, "PATCH"); f.submit();
  f.writes()[0]!.pending.resolve(response({ id: id(999), replayed: false }));
  await f.driver.flush();
  assert.match(text(f.driver.tree), /не подтвердил исправление выбранной записи/);
  assert.doesNotMatch(text(f.driver.tree), /Ошибочная запись исправлена\./);
  assert.equal(f.gets().length, 1);
  assert.equal(f.find((node) => node.type === "textarea").props.value, "  Local wrong-record reason  ");
  f.submit();
  assert.deepEqual(f.body(f.writes()[1]!), f.body(f.writes()[0]!));
  assert.equal(f.generated.length, 1);
  f.writes()[1]!.pending.resolve(response({ id: contractId.toUpperCase(), replayed: true }));
  await f.driver.flush();
  f.gets()[1]!.pending.resolve(response(snapshot([voided({ voidReason: "Local wrong-record reason" })])));
  await f.driver.flush();
  assert.match(text(f.driver.tree), /Ошибочная запись исправлена\./);
  assert.match(text(f.driver.tree), /Local wrong-record reason/);
});

for (const method of ["POST", "PATCH"] as const) test(`${method} retained submit callback respects live permission and session props`, async (t) => {
  const f = fixture(); t.after(() => f.driver.unmount());
  await prepareWrite(f, method);
  const submit = f.find((node) => node.type === "form").props.onSubmit;
  if (method === "POST") f.props.canEdit = false;
  else f.props.canVoid = false;
  f.driver.paint();
  submit({ preventDefault() {} }); await f.driver.flush();
  assert.equal(f.writes().length, 0);
  assert.equal(f.generated.length, 0);
  f.setCurrent(false); f.driver.paint();
  const writes = f.driver.writes.length;
  submit({ preventDefault() {} }); await tick();
  assert.equal(f.driver.writes.length, writes);
});

test("active or truncated history never exposes the create form; corrected reasons remain visible", async (t) => {
  for (const data of [snapshot([record()]), snapshot([], true), snapshot([voided()], true)]) {
    const f = fixture(); t.after(() => f.driver.unmount());
    await ready(f, data);
    assert.equal(nodes(f.driver.tree).filter((node) => node.type === "input" && node.props.type === "checkbox").length, 0);
    if (data.records.some((item) => item.voidedAt)) assert.match(text(f.driver.tree), /Local correction reason/);
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";

// Execute unchanged page declarations/actions. Only storage, UI setters and the
// transport boundary are synthetic; no browser, network, database or auth SDK runs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pagePath = "artifacts/negis/src/pages/AppointmentsPage.tsx";
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${pagePath}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, pagePath), "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === "AppointmentsPage");
assert.ok(page?.body, "actual page function must exist");

function declarations(statements: readonly ts.Statement[], names: string[]) {
  return names.map((name) => {
    const matches = statements.filter((node) => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
      return ts.isVariableStatement(node) && node.declarationList.declarations.some((item) =>
        ts.isIdentifier(item.name) && item.name.text === name);
    });
    assert.equal(matches.length, 1, `exactly one actual declaration: ${name}`);
    return matches[0]!.getText(ast);
  }).join("\n");
}

const helpers = declarations(ast.statements, [
  "activeStatuses", "normalizeStatus", "pad", "toDateKey", "toTimeKey", "toLocalDate", "toStartsAt",
  "dateKeyFromStartsAt", "timeKeyFromStartsAt", "readString", "readNumber", "asRecord",
  "appointmentFromApi", "appointmentToApi", "safeJson", "defaultForm", "formFromAppointment",
  "formServiceItems", "appointmentFromForm", "appointmentInterval", "isUuidText",
  "SlotTakenError", "ServerRefusalError", "APPOINTMENT_ERROR_TEXTS", "refusalText", "conflictFromBody",
  "OutsideScheduleError", "scheduleRefusalFromBody", "describeSchedule", "describeConflict",
  "AppointmentAccessRefusalError", "AppointmentCreateRecoveryError", "appointmentAttemptStorage",
]);
const actions = declarations(page.body.statements, [
  "matchesMutationSdkActor", "isCurrentMutationScope", "unsavedFromBody", "warnAboutUnsaved",
  "patchAppointment", "createAppointment", "findConflict", "submitForm",
]);
const recovery = page.body.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === "useEffect"
  && node.getText(ast).includes("restoreAppointmentCreateAttempt(storage,"));
assert.equal(recovery.length, 1, "execute the actual recovery effect, including its hidden-form branch");
const recoveryCall = (recovery[0] as ts.ExpressionStatement).expression as ts.CallExpression;
const compiled = ts.transpileModule(`${helpers}\n${actions}
  exports.recover = ${recoveryCall.arguments[0]!.getText(ast)};
  exports.findConflict = findConflict;
  exports.submitForm = submitForm;
  exports.fromApi = appointmentFromApi;
  exports.fromForm = appointmentFromForm;
  exports.defaultForm = defaultForm;
  exports.formFromAppointment = formFromAppointment;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.deepEqual(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);

const helperFiles = new Set([
  "lib/crm/appointment-services.ts", "lib/crm/appointment-capacity.ts", "lib/vertical/terms.ts",
  "artifacts/negis/src/lib/clinicDateTime.ts", "artifacts/negis/src/lib/clinicDay.ts",
  "artifacts/negis/src/lib/dayGrid.ts", "artifacts/negis/src/lib/appointmentCreateAttempt.ts",
]);
const helperCache = new Map<string, Record<string, any>>();
const forbiddenHelperCapabilities: string[] = [];
function denyHelper(capability: string): never {
  forbiddenHelperCapabilities.push(capability);
  assert.fail(`Helper capability forbidden: ${capability}`);
}
afterEach(() => assert.deepEqual(forbiddenHelperCapabilities, [], "Even swallowed helper capability attempts must fail"));
function helper(file: string): Record<string, any> {
  if (!helperFiles.has(file)) return denyHelper("unknown module");
  const existing = helperCache.get(file);
  if (existing) return existing;
  const module = { exports: {} };
  helperCache.set(file, module.exports);
  const result = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  new Script(result.outputText, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Intl, Error, TypeError, RangeError, DOMException,
    crypto: { randomUUID },
    require(name: string) {
      if (!name.startsWith(".")) return denyHelper("native/application import");
      const resolved = path.resolve(path.dirname(path.join(root, file)), `${name}.ts`);
      return helper(path.relative(root, resolved).split(path.sep).join("/"));
    },
    fetch() { return denyHelper("fetch"); },
    process: new Proxy({}, { get() { return denyHelper("ambient process"); } }),
    WebSocket: class { constructor() { denyHelper("WebSocket"); } },
    XMLHttpRequest: class { constructor() { denyHelper("XMLHttpRequest"); } },
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  return module.exports;
}
const services = helper("lib/crm/appointment-services.ts");
const capacity = helper("lib/crm/appointment-capacity.ts");
const dates = helper("artifacts/negis/src/lib/clinicDateTime.ts");
const attempts = helper("artifacts/negis/src/lib/appointmentCreateAttempt.ts");
const { capitalize } = helper("lib/vertical/terms.ts");
const doctorId = "abcdef00-0000-4000-8000-000000000001";
const otherDoctorId = "abcdef00-0000-4000-8000-000000000002";
const savedId = "abcdef00-0000-4000-8000-000000000003";
const requestKey = "abcdef00-0000-4000-8000-000000000004";
const today = "2026-10-25";
const futureDay = "2026-11-19";
const futureStart = "2026-11-18T20:30:00.000Z"; // Next day in the clinic, not UTC.
type Visit = {
  id: string; doctorId: string; doctor: string; startsAt: string; durationMinutes: number; status: string;
  client: string; phone: string; service: string; serviceId: string; serviceItems: unknown[];
  clientId: string; whatsapp: string; priceMinor: number | null; notes: string; source: string;
};
function visit(id: string, overrides: Partial<Visit> = {}): Visit {
  return { id, doctorId, doctor: "Same Name", startsAt: futureStart, durationMinutes: 60,
    status: "scheduled", client: "Synthetic client", phone: "+77000000000", service: "Local service",
    serviceId: "", serviceItems: [], clientId: "", whatsapp: "+77000000000", priceMinor: null,
    notes: "", source: "Local fixture", ...overrides };
}
type Reply = { status: number; body: Record<string, unknown> } | "lost";
type Init = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };

function fixture(rows: Visit[] = [], places = 2) {
  const storage = new Map<string, string>();
  const memoryStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const sent: Array<{ url: string; init: Init; payload: Record<string, any> }> = [];
  const replies: Reply[] = [];
  const notices: string[] = [];
  const scope: Record<string, any> = {
    ...services, ...capacity, ...dates, ...attempts, capitalize, exports: {},
    crypto: { randomUUID }, Response, DOMException, console: { warn() {} },
    fetch() { throw new Error("Network is forbidden in this local test"); },
    window: { sessionStorage: memoryStorage }, todayKeyAtLoad: today,
    items: rows, directory: { items: [
      { id: doctorId, fullName: "Same Name", capacity: places },
      { id: otherDoctorId, fullName: "Same Name", capacity: places },
    ] },
    activeCatalog: [], activeDoctors: [], terms: { specialist: "specialist", specialistGenitive: "specialist" },
    userRole: "receptionist", clinicTimeZone: "Asia/Qyzylorda", clinicTimeZoneReady: true,
    hasSupabaseFrontendEnv: false, mutationScope: {
      active: true, workspaceId: "local-workspace", actorId: "local-actor", role: "receptionist", deniedIds: new Set(), deniedCreateKeys: new Set(),
    },
    isRealWorkspace: () => true, readCurrentWorkspaceId: () => "local-workspace",
    editingId: null, saving: false, submitLock: { current: false }, createAttempt: { current: null },
    prefillLeadRef: { current: "" }, restoredCreateScope: { current: "" }, createRecoveryRead: 0,
    createRecoveryError: "", unconfirmedCreate: false, modalOpen: false, selectedDate: today,
    conflictMessage: "", scheduleMessage: "",
    toast: Object.fromEntries(["error", "warning", "success"].map((kind) => [kind, (value: string) => notices.push(value)])),
    markLeadBooked() { throw new Error("Lead messaging/handoff is outside this test"); },
    discardRefusedAppointment() { throw new Error("No access refusal expected"); },
    addItem() { throw new Error("Must execute keyed creation, not demo creation"); },
    crmFetch: async (url: string, init: Init) => {
      assert.equal(init.expectedUserId, "local-actor");
      assert.equal(init.dispatchGuard?.(), true, "actual action must retain its dispatch guard");
      sent.push({ url, init, payload: JSON.parse(String(init.body)) });
      const reply = replies.shift();
      assert.ok(reply, "every local transport response must be explicitly supplied");
      if (reply === "lost") throw new Error("Synthetic lost response");
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
  };
  scope.currentMutationScope = { current: scope.mutationScope };
  for (const field of ["items", "form", "selectedDate", "modalOpen", "editingId", "saving", "conflictMessage",
    "scheduleMessage", "unconfirmedCreate", "createRecoveryError", "clientMatches", "remoteVisitHistory"]) {
    scope[`set${field[0]!.toUpperCase()}${field.slice(1)}`] = (value: any) => {
      scope[field] = typeof value === "function" ? value(scope[field]) : value;
    };
  }
  new Script(compiled.outputText, { filename: `${baseline ?? "working-tree"}:${pagePath}:actual-actions` }).runInNewContext(scope);
  const runtime = scope.exports as {
    findConflict(candidate: Visit): Visit | null; submitForm(allowConflict?: boolean, allowOutsideSchedule?: boolean): Promise<void>;
    recover(): void; fromApi(value: unknown): Visit; fromForm(value: unknown, id?: string, zone?: string): Visit;
    defaultForm(day: string): Record<string, any>; formFromAppointment(value: Visit, zone: string): Record<string, any>;
  };
  scope.form = runtime.defaultForm(today);
  return { scope, runtime, storage, memoryStorage, sent, replies, notices };
}
const success = (item: Visit, replayed = false): Reply => ({ status: 200,
  body: { success: true, mode: "supabase", data: { item, replayed } } });

test("actual findConflict keeps same-name distinct IDs separate at capacity two", () => {
  const own = visit("own"), other = visit("other", { doctorId: otherDoctorId });
  const { runtime } = fixture([own, other]);
  assert.equal(runtime.findConflict(visit("candidate", { doctorId: doctorId.toUpperCase() })), null);
  assert.equal(runtime.findConflict(visit("candidate", { doctorId: otherDoctorId.toUpperCase() })), null);
  const full = fixture([other, visit("other-second", { doctorId: otherDoctorId })]);
  assert.equal(full.runtime.findConflict(visit("candidate")), null, "another ID must never fall back to its matching name");
});

test("actual findConflict counts true same-ID overlaps despite changed or empty labels", () => {
  const first = visit("first", { doctor: "Old name" });
  const second = visit("second", { doctorId: doctorId.toUpperCase(), doctor: "" });
  const { runtime } = fixture([first, second]);
  assert.ok([first, second].includes(runtime.findConflict(visit("candidate"))!));
  assert.equal(fixture([first]).runtime.findConflict(visit("candidate")), null);
});

test("actual findConflict allows normalized legacy names only when an identity is missing", () => {
  const legacy = visit("legacy", { doctorId: "", doctor: " same NAME " });
  const linked = visit("linked");
  assert.ok(fixture([legacy, linked]).runtime.findConflict(visit("candidate")));
  assert.ok(fixture([linked, visit("second")]).runtime.findConflict(visit("candidate", { doctorId: "", doctor: " SAME name " })));
  assert.equal(fixture([legacy], 1).runtime.findConflict(visit("candidate", { doctor: "Different" })), null);
  assert.equal(fixture([visit("empty", { doctorId: "", doctor: "" })], 1)
    .runtime.findConflict(visit("candidate", { doctorId: "", doctor: "" })), null, "empty names are not legacy identity");
});

test("actual findConflict preserves retained/shrunk intervals but checks expansions and identity changes", () => {
  const original = visit(savedId), overbooked = visit("overbooked");
  const { runtime } = fixture([original, overbooked], 1);
  for (const status of ["scheduled", "confirmed", "arrived"]) {
    assert.equal(runtime.findConflict({ ...original, id: savedId.toUpperCase(), status }), null);
    assert.equal(runtime.findConflict({ ...original, startsAt: "2026-11-18T20:45:00.000Z", durationMinutes: 30, status }), null);
  }
  assert.equal(runtime.findConflict({ ...original, durationMinutes: 90 }), overbooked);
  assert.equal(runtime.findConflict({ ...original, startsAt: "2026-11-18T20:15:00.000Z" }), overbooked);
  const occupiedOther = visit("occupied-other", { doctorId: otherDoctorId });
  assert.equal(fixture([original, occupiedOther], 1).runtime.findConflict({ ...original, doctorId: otherDoctorId }), occupiedOther);
});

test("actual findConflict excludes inactive and adjacent intervals without weakening same-ID conflicts", () => {
  for (const status of ["cancelled", "no_show"]) {
    assert.equal(fixture([visit("inactive", { status })], 1).runtime.findConflict(visit("candidate")), null);
    assert.equal(fixture([visit("busy")], 1).runtime.findConflict(visit("candidate", { status })), null);
  }
  assert.equal(fixture([visit("adjacent", { startsAt: "2026-11-18T21:30:00.000Z" })], 1)
    .runtime.findConflict(visit("candidate")), null);
});

test("actual submit action permits distinct-ID capacity, blocks a full same-ID group and preserves server refusals", async () => {
  const f = fixture([visit("own"), visit("other", { doctorId: otherDoctorId })]);
  f.scope.form = f.runtime.formFromAppointment(visit("draft"), f.scope.clinicTimeZone);
  f.replies.push({ status: 409, body: { success: false, code: "appointment_conflict",
    conflict: { startsAt: futureStart, clientName: "Concurrent client", doctorName: "Same Name" } } });
  f.scope.modalOpen = true;
  await f.runtime.submitForm();
  assert.equal(f.sent.length, 1, "local false conflict must not prevent authoritative server validation");
  assert.equal(f.sent[0]!.payload.allowConflict, undefined);
  assert.equal(f.scope.modalOpen, true);
  assert.ok(f.scope.conflictMessage.includes("Concurrent client"));
  assert.equal(f.storage.size, 0, "definite refusal can release the original key");
  f.scope.items = [visit("first", { doctor: "Old name" }), visit("second")];
  await f.runtime.submitForm();
  assert.equal(f.sent.length, 1, "full same-ID capacity must block locally");
  f.replies.push({ status: 409, body: { success: false, code: "outside_doctor_schedule",
    schedule: { doctorName: "Same Name", localTime: "01:30", weekdayLabel: "Thursday", intervals: [] } } });
  await f.runtime.submitForm(true);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1]!.payload.allowConflict, true);
  assert.equal(f.sent[1]!.payload.allowOutsideSchedule, undefined);
  assert.ok(f.scope.scheduleMessage);
  assert.equal(f.scope.modalOpen, true);
});

for (const originRole of [undefined, "doctor"]) {
  test(`actual hidden-form future recovery/replay selects captured clinic date without duplicates (${originRole ?? "legacy"})`, async () => {
    const saved = visit(savedId);
    const f = fixture([saved, { ...saved }]); // A reload already fetched the committed row twice.
    const captured = attempts.newAppointmentCreateAttempt("local-workspace", "local-actor", saved,
      () => requestKey, { originRole });
    assert.equal(attempts.persistAppointmentCreateAttempt(f.memoryStorage, captured), true);
    f.runtime.recover();
    assert.equal(f.scope.form.date, today);
    assert.equal(f.scope.form.client, "", "role-hidden draft must stay cleared");
    assert.equal(f.scope.selectedDate, today);
    assert.equal(f.scope.unconfirmedCreate, true);
    assert.equal(f.scope.modalOpen, true);
    f.replies.push(success(saved, true));
    const pending = f.runtime.submitForm();
    await f.runtime.submitForm(); // Same-turn repeated click must not dispatch twice.
    await pending;
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.payload.requestKey, requestKey);
    assert.equal(f.sent[0]!.payload.startsAt, futureStart);
    assert.equal(f.sent[0]!.payload.client, saved.client);
    assert.equal(f.scope.items.length, 1, "actual merge must replace/deduplicate the committed UUID");
    assert.equal(f.scope.items[0].id, savedId);
    assert.equal(f.scope.items[0].startsAt, futureStart);
    assert.equal(f.scope.createAttempt.current, null);
    assert.equal(f.scope.unconfirmedCreate, false);
    assert.equal(f.storage.size, 0);
    assert.equal(f.scope.modalOpen, false);
    assert.equal(f.scope.saving, false);
    assert.equal(f.scope.selectedDate, futureDay, "success must select the captured appointment's clinic day, not cleared form.date");
  });
}

test("actual create action retains one key after a lost reply and replays the captured future date", async () => {
  const f = fixture();
  const saved = visit(savedId);
  f.scope.form = f.runtime.formFromAppointment(saved, f.scope.clinicTimeZone);
  f.scope.modalOpen = true;
  f.replies.push("lost");
  await f.runtime.submitForm();
  assert.equal(f.scope.unconfirmedCreate, true);
  assert.equal(f.storage.size, 1);
  f.scope.form = f.runtime.defaultForm(today);
  f.replies.push(success(saved, true));
  await f.runtime.submitForm();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1]!.payload, f.sent[0]!.payload, "retry must use the whole captured payload and original request key");
  assert.equal(f.scope.items.length, 1);
  assert.equal(f.storage.size, 0);
  assert.equal(f.scope.selectedDate, futureDay);
});

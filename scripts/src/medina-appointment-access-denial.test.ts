import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// G2-C11: execute actual scope/effects/actions and crmFetch with synthetic hooks/auth/network.
// These local UI acceptance tests make no server, SQL, browser or deployment claim.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pageSource = await readFile(path.join(root, "artifacts/negis/src/pages/AppointmentsPage.tsx"), "utf8");
const ast = ts.createSourceFile("AppointmentsPage.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = ast.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === "AppointmentsPage") as import("typescript").FunctionDeclaration | undefined;
assert.ok(page?.body, "the actual AppointmentsPage function must exist");
function compile(source: string, filename: string) {
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}
async function localModule(file: string, imports: Record<string, Record<string, any>> = {}) {
  const source = await readFile(path.join(root, file), "utf8");
  const exports: Record<string, any> = {};
  const forbidden = () => { throw new Error(`External call from pure local helper: ${file}`); };
  new Script(compile(source, file), { filename: file }).runInNewContext({ exports, Error, crypto: { randomUUID }, fetch: forbidden,
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `unexpected helper import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}
const services = await localModule("lib/crm/appointment-services.ts");
const capacity = await localModule("lib/crm/appointment-capacity.ts");
const clinicDay = await localModule("artifacts/negis/src/lib/clinicDay.ts");
const grid = await localModule("artifacts/negis/src/lib/dayGrid.ts", { "../../../../lib/crm/appointment-capacity": capacity });
const dates = await localModule("artifacts/negis/src/lib/clinicDateTime.ts", { "./clinicDay": clinicDay, "./dayGrid": grid });
const vertical = await localModule("lib/vertical/terms.ts");
const phone = await localModule("artifacts/negis/src/lib/phone.ts");
const clients = await localModule("artifacts/negis/src/lib/appointmentClient.ts", { "./phone": phone });
const attempts = await localModule("artifacts/negis/src/lib/appointmentCreateAttempt.ts");
const pipeline = await localModule("artifacts/negis/src/lib/leadPipeline.ts");
const apiCode = compile(await readFile(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8"), "api.ts");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function bindingNames(name: import("typescript").BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((entry) => ts.isBindingElement(entry) ? bindingNames(entry.name) : []);
}
function select(statements: import("typescript").NodeArray<import("typescript").Statement>, names: string[]) {
  const selected = new Set<import("typescript").Statement>();
  for (const name of names) {
    const matches = statements.filter((node) => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
      return ts.isVariableStatement(node)
        && node.declarationList.declarations.some((item) => bindingNames(item.name).includes(name));
    });
    assert.equal(matches.length, 1, `extract exactly one actual declaration: ${name}`);
    selected.add(matches[0]!);
  }
  return statements.filter((node) => selected.has(node)).map((node) => node.getText(ast)).join("\n");
}

const helpers = select(ast.statements, [
  "activeStatuses", "normalizeStatus", "getAppointmentStatusLabel", "pad", "toDateKey", "toTimeKey",
  "toLocalDate", "toStartsAt", "dateKeyFromStartsAt", "timeKeyFromStartsAt", "readString", "readNumber",
  "asRecord", "appointmentFromApi", "appointmentToApi", "safeJson", "defaultForm", "formFromAppointment",
  "formServiceItems", "appointmentFromForm", "SlotTakenError", "ServerRefusalError", "APPOINTMENT_ERROR_TEXTS",
  "refusalText", "conflictFromBody", "OutsideScheduleError", "scheduleRefusalFromBody", "describeSchedule",
  "describeConflict", "appointmentInterval", "AppointmentAccessRefusalError", "AppointmentCreateRecoveryError", "appointmentAttemptStorage", "isUuidText",
]);
const state = select(page.body.statements, [
  "userRole", "terms",
  "selectedDate", "modalOpen", "editingId", "form", "clientMatches", "clientSearchAttempted",
  "remoteVisitHistory", "conflictMessage", "saving", "submitLock", "createAttempt", "serviceSearch",
  "doctorSearch", "scheduleMessage",
  "prefillLeadRef", "restoredCreateScope", "unconfirmedCreate", "createRecoveryError", "createRecoveryRead",
]);
function effectReferencing(name: string) {
  const matches = page!.body!.statements.filter((node) => {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "useEffect") return false;
    if (name === "prefillLeadRef") {
      const deps = node.expression.arguments[1];
      if (!deps || !ts.isArrayLiteralExpression(deps) || deps.elements.length !== 1
        || !ts.isIdentifier(deps.elements[0]!) || deps.elements[0]!.text !== "modalOpen") return false;
    }
    const identifiers: string[] = [];
    const visit = (child: import("typescript").Node) => {
      if (ts.isIdentifier(child)) identifiers.push(child.text);
      ts.forEachChild(child, visit);
    };
    visit(node);
    return identifiers.includes(name) && !identifiers.includes("restoreAppointmentCreateAttempt");
  });
  assert.equal(matches.length, 1, `one actual existing effect for ${name}`);
  return matches[0]!.getText(ast);
}
// Preserve every statement in the actual bounded scope block, including conditionals,
// ref assignments and layout effects; no test implementation of the guard or SDK epoch.
const scopeStart = page.body.statements.findIndex((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => bindingNames(item.name).includes("mutationWorkspaceId")));
const scopeEnd = page.body.statements.findIndex((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => bindingNames(item.name).includes("discardRefusedAppointment")));
assert.ok(scopeStart >= 0 && scopeEnd > scopeStart, "actual mutation scope block must exist");
const scopeStatements = page.body.statements.slice(scopeStart, scopeEnd + 1);
assert.ok(scopeStatements.some((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => bindingNames(item.name).includes("deniedMutationIds"))),
"the actual shared denial ref must be part of the executed scope block");
assert.equal(scopeStatements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === "useLayoutEffect").length, 2);
const scope = scopeStatements.map((node) => node.getText(ast)).join("\n");
const actions = select(page.body.statements, [
  "openEdit", "unsavedFromBody", "warnAboutUnsaved", "patchAppointment", "updateAppointmentStatus",
  "findConflict", "submitForm", "visitHistory", "createAppointment",
]);
const leadAction = select(page.body.statements, ["markLeadBooked"]);
const disabledFields: import("typescript").Expression[] = [];
const findDisabledFieldset = (node: import("typescript").Node) => {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === "fieldset") {
    for (const attribute of node.attributes.properties) {
      if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "disabled"
        && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
        disabledFields.push(attribute.initializer.expression);
      }
    }
  }
  ts.forEachChild(node, findDisabledFieldset);
};
findDisabledFieldset(page);
assert.equal(disabledFields.length, 1, "observe the actual form fieldset's disabled expression");
function compileActions(actualLeadHandoff = false) {
  return compile(`${helpers}\nfunction renderActions() {
  const [appointmentItems, setItems] = useState(seedItems);
  ${state}
  ${effectReferencing("prefillLeadRef")}
  ${scope}
  ${actualLeadHandoff ? leadAction : ""}
  ${actions}
  return { items, appointmentItems, form, editingId, modalOpen, saving, submitLock, conflictMessage, scheduleMessage,
    clientMatches, clientSearchAttempted, remoteVisitHistory, visitHistory, doctorSearch, serviceSearch,
    setItems, setClientMatches, setClientSearchAttempted, setRemoteVisitHistory, setDoctorSearch, setServiceSearch,
    createAttempt, unconfirmedCreate, prefillLeadRef, setModalOpen, setEditingId, setUnconfirmedCreate,
    createRecoveryError, createRecoveryRead, setCreateRecoveryRead, recoveryFieldsDisabled: ${disabledFields[0]!.getText(ast)},
    blankForm: defaultForm(todayKeyAtLoad),
    mutationScope, isCurrentMutationScope, openEdit, setForm, patchAppointment, createAppointment, submitForm, updateAppointmentStatus, markLeadBooked };
}\nexports.renderActions = renderActions;
exports.AccessRefusal = AppointmentAccessRefusalError;`, "AppointmentsPage.extracted-actions.ts");
}
const compiled = compileActions(), compiledLead = compileActions(true);

const workspaceId = "00000000-0000-4000-8000-000000000001";
const own = {
  id: "00000000-0000-4000-8000-000000000002", clientId: "00000000-0000-4000-8000-000000000003",
  client: "Fictitious local client", phone: "+77000000001", whatsapp: "+77000000002",
  service: "Local consultation", serviceId: "00000000-0000-4000-8000-000000000004", serviceItems: [],
  doctor: "Fictitious local doctor", doctorId: "00000000-0000-4000-8000-000000000005",
  startsAt: "2026-10-19T09:00:00.000Z", durationMinutes: 60, priceMinor: 500000,
  status: "scheduled", arrivalSaleId: "", notes: "Previously visible local notes", source: "Local fixture",
};
const unrelated = { ...own, id: "00000000-0000-4000-8000-000000000006", client: "Other local client" };
const actorA = "00000000-0000-4000-8000-000000000090";
const actorB = "00000000-0000-4000-8000-000000000091";
const workspaceB = "00000000-0000-4000-8000-000000000092";
type Init = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
type Reply = { status: number; body: Record<string, unknown> | string } | "network";
type Action = "edit" | "status";
type Transition = "account" | "workspace" | "role" | "raw ABA";
type Snapshot = {
  items: typeof own[]; appointmentItems: typeof own[]; form: Record<string, any>;
  editingId: string | null; modalOpen: boolean; saving: boolean;
  submitLock: { current: boolean }; conflictMessage: string; scheduleMessage: string;
  createAttempt: { current: Record<string, any> | null }; unconfirmedCreate: boolean;
  createRecoveryError: string; createRecoveryRead: number; setCreateRecoveryRead(value: number): void; recoveryFieldsDisabled: boolean;
  blankForm: Record<string, any>;
  prefillLeadRef: { current: string }; setModalOpen(open: boolean): void;
  setEditingId(id: string | null): void; setUnconfirmedCreate(value: boolean): void;
  clientMatches: any[]; clientSearchAttempted: boolean; remoteVisitHistory: any[]; visitHistory: any[];
  doctorSearch: string; serviceSearch: string;
  mutationScope: { active: boolean; deniedIds: Set<string>; workspaceId: string; actorId: string; epoch: number };
  isCurrentMutationScope(): boolean;
  setItems(items: typeof own[]): void;
  setClientMatches(items: any[]): void; setClientSearchAttempted(value: boolean): void;
  setRemoteVisitHistory(items: any[]): void; setDoctorSearch(value: string): void; setServiceSearch(value: string): void;
  openEdit(appointment: typeof own): void;
  setForm(update: (current: Record<string, any>) => Record<string, any>): void;
  patchAppointment(appointment: typeof own): Promise<{ unsaved: string[]; saved: typeof own | null }>;
  createAppointment(appointment: typeof own, allowConflict: boolean, allowOutsideSchedule?: boolean): Promise<unknown>;
  submitForm(): Promise<void>;
  markLeadBooked(leadId: string): Promise<void>;
  updateAppointmentStatus(appointment: typeof own, status: string): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const invoke = (view: Snapshot, action: Action) => action === "edit"
  ? view.submitForm() : view.updateAppointmentStatus(clone(own), "confirmed");
function observable(view: Snapshot) {
  return clone(Object.fromEntries(["items", "appointmentItems", "form", "editingId", "modalOpen", "saving",
    "clientMatches", "clientSearchAttempted", "remoteVisitHistory", "visitHistory", "doctorSearch", "serviceSearch",
    "conflictMessage", "scheduleMessage", "createRecoveryError", "createRecoveryRead", "recoveryFieldsDisabled"].map((name) => [name, view[name as keyof Snapshot]])));
}
function fixture(options: { queueToken?: boolean; storedAttempt?: Record<string, any>; role?: string; actorTokens?: boolean;
  storage?: Map<string, string>; storageMode?: "denied" | "no-readback" | "no-remove"; mountOnly?: boolean;
  actualLeadHandoff?: boolean; storageFault?: "retained-readback-once" | "write-once" } = {}) {
  const slots: any[] = [], stateWrites: unknown[] = [];
  let cursor = 0, dirty = true, sdkActor = actorA, selectedWorkspace = workspaceId;
  const context = { user: { id: actorA }, userRole: options.role ?? "doctor", clinicId: workspaceId, vertical: "clinic",
    isLoading: false, isSigningOut: false, isDemoMode: false, isImpersonation: false };
  const writes: any[] = [];
  const errors: string[] = [], successes: string[] = [];
  const warnings: { message: string; id?: string }[] = [], stored = options.storage ?? new Map<string, string>();
  const handoffs: string[] = [];
  const storageWrites: { key: string; value: string }[] = [];
  let storageFaultUsed = false, failedReadbackKey = "";
  const sessionStorage = { getItem: (key: string) => {
      if (options.storageMode === "denied") throw new Error("Synthetic session storage denied");
      if (key === failedReadbackKey) { failedReadbackKey = ""; throw new Error("Synthetic one-time readback failure"); }
      return options.storageMode === "no-readback" ? null : stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      storageWrites.push({ key, value });
      if (options.storageMode === "denied") throw new Error("Synthetic session storage denied");
      if (!storageFaultUsed && options.storageFault === "write-once") { storageFaultUsed = true; throw new Error("Synthetic initial write failure"); }
      stored.set(key, value);
      if (!storageFaultUsed && options.storageFault === "retained-readback-once") { storageFaultUsed = true; failedReadbackKey = key; }
    },
    removeItem: (key: string) => { if (options.storageMode !== "no-remove") stored.delete(key); } };
  if (options.storedAttempt) assert.equal(attempts.persistAppointmentCreateAttempt(sessionStorage, options.storedAttempt), true);
  const requests: { url: string; init: Init; body: any; actorId: string; gate: ReturnType<typeof deferred<Response>> }[] = [];
  const tokens: { expected?: string; gate: ReturnType<typeof deferred<string>> }[] = [];
  const listeners = new Set<(event: string, session: { user: { id: string } } | null) => void>();
  const forbidden = () => { throw new Error("External calls and unrelated page actions are forbidden"); };
  const api: Record<string, any> = {};
  new Script(apiCode, { filename: "api.ts" }).runInNewContext({ exports: api, Error, DOMException, Headers, Response,
    require(name: string) {
      assert.equal(name, "@/lib/serverAuth");
      return { getSupabaseAccessToken: async (expected?: string) => {
        const gate = deferred<string>();
        tokens.push({ expected, gate });
        const token = options.queueToken ? await gate.promise : "fixture.appointment.token";
        return !expected || expected === sdkActor ? options.actorTokens ? `fixture.${sdkActor}.token` : token : "";
      } };
    },
    fetch(url: string, init: Init) {
      const at = (endpoint: string) => [workspaceId, workspaceB].some((id) => url === `/api/crm/${endpoint}?workspaceId=${id}`);
      const appointment = at("appointments"), stages = options.actualLeadHandoff && at("lead-stages"), leads = options.actualLeadHandoff && at("leads");
      assert.ok(appointment || stages || leads, "only explicitly enabled synthetic CRM routes are allowed");
      assert.ok(appointment ? init.method === "PATCH" || init.method === "POST"
        : stages ? !init.method || init.method === "GET" : init.method === "PATCH");
      assert.equal(new Headers(init.headers).get("Authorization"), options.actorTokens
        ? `Bearer fixture.${sdkActor}.token` : "Bearer fixture.appointment.token");
      assert.equal(init.expectedUserId, undefined, "actual crmFetch strips dispatch metadata before fetch");
      assert.equal(init.dispatchGuard, undefined);
      const gate = deferred<Response>();
      requests.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {}, actorId: sdkActor, gate });
      return gate.promise;
    },
  });
  const exports: { renderActions?: () => Snapshot; AccessRefusal?: new () => Error } = {};
  const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length
    && a.every((value, index) => Object.is(value, b[index])));
  const slot = (kind: string, create: () => any) => {
    const index = cursor++, value = slots[index] ??= { kind, ...create() };
    assert.equal(value.kind, kind, "extracted hook order must remain stable");
    return { index, value };
  };
  const sessionAuth = { onAuthStateChange(listener: Parameters<typeof listeners.add>[0]) {
    listeners.add(listener);
    return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } };
  new Script(options.actualLeadHandoff ? compiledLead : compiled, { filename: "AppointmentsPage.extracted-actions.cjs" }).runInNewContext({
    exports, Error, DOMException, Response, fetch: forbidden, require: forbidden,
    ...services, ...dates, ...capacity, ...vertical, ...clients, ...attempts,
    window: { sessionStorage },
    todayKeyAtLoad: "2026-10-19", clinicTimeZone: "UTC", clinicTimeZoneReady: true,
    seedItems: clone([own, unrelated]), useAuth: () => context, hasSupabaseFrontendEnv: true,
    isRealWorkspace: () => true,
    supabase: { auth: sessionAuth },
    sessionAuth,
    activeCatalog: [], activeDoctors: [], directory: { items: [] },
    readCurrentWorkspaceId: () => selectedWorkspace,
    addItem: forbidden, markLeadBooked: (leadId: string) => { handoffs.push(leadId); },
    leadStageDefinitionFromUnknown: pipeline.leadStageDefinitionFromUnknown,
    console: { warn() {} }, toast: { error: (message: string) => errors.push(message), success: (message: string) => successes.push(message),
      warning: (message: string, options?: { id?: string }) => warnings.push({ message, id: options?.id }) },
    useState(initial: any) {
      const { index, value: state } = slot("state", () => ({ value: typeof initial === "function" ? initial() : initial }));
      state.set ??= (update: any) => {
        const next = typeof update === "function" ? update(state.value) : update;
        stateWrites.push({ index, value: clone(next) });
        if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
        if (index === 0) writes.push(clone(next));
      };
      return [state.value, state.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ value: { current: initial } })).value.value; },
    useMemo(create: () => any, deps: unknown[]) {
      const memo = slot("memo", () => ({ value: create(), deps })).value;
      if (!sameDeps(memo.deps, deps)) { memo.value = create(); memo.deps = deps; }
      return memo.value;
    },
    useLayoutEffect(create: () => unknown, deps: unknown[]) {
      const effect = slot("layout", () => ({ pending: true, deps })).value;
      if (!sameDeps(effect.deps, deps)) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
    useEffect(create: () => unknown, deps: unknown[]) {
      const effect = slot("passive", () => ({ pending: true, deps })).value;
      if (!sameDeps(effect.deps, deps)) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
    crmFetch: api.crmFetch,
  });
  assert.ok(exports.renderActions);
  const render = () => {
    let view!: Snapshot;
    for (let pass = 0; pass < 20; pass++) {
      dirty = false; cursor = 0; view = exports.renderActions!();
      for (const kind of ["layout", "passive"]) {
        const pending = slots.filter((item) => item.kind === kind && item.pending);
        for (const item of pending) item.cleanup?.();
        for (const item of pending) { item.pending = false; item.cleanup = item.create(); }
      }
      if (!dirty) return view;
    }
    throw new Error("scope layout must settle");
  };
  const open = (appointment = own, notes = "Unsaved local edit") => {
    render().openEdit(clone(appointment));
    const view = render();
    view.setForm((current) => ({ ...current, notes }));
    view.setClientMatches([{ id: appointment.clientId, name: appointment.client, phone: appointment.phone }]);
    view.setClientSearchAttempted(true); view.setRemoteVisitHistory([clone(appointment)]);
    view.setDoctorSearch(appointment.doctor); view.setServiceSearch(appointment.service);
    return render();
  };
  if (!options.storedAttempt && !options.mountOnly) open();
  const before = render();
  writes.length = 0; stateWrites.length = 0;
  const emit = (actor: string, event = "SIGNED_IN") => {
    sdkActor = actor;
    for (const listener of listeners) listener(event, actor ? { user: { id: actor } } : null);
  };
  return {
    render, before, open, emit, requests, tokens, writes, stateWrites, errors, successes, warnings, stored, sessionStorage, storageWrites, handoffs,
    AccessRefusal: exports.AccessRefusal!,
    start: (action: Action) => invoke(render(), action),
    releaseToken(index = 0) { tokens[index]!.gate.resolve("fixture.appointment.token"); },
    transition(kind: Transition) {
      if (kind === "account") { context.user = { id: actorB }; emit(actorB); }
      if (kind === "workspace") { context.clinicId = selectedWorkspace = workspaceB; }
      if (kind === "role") context.userRole = "manager";
      if (kind === "raw ABA") { emit(actorB); emit(actorA); }
    },
    setWorkspaceSelector(id: string) { selectedWorkspace = id; },
    setActor(id: string) { context.user = { id }; emit(id); },
    setRole(role: string) { context.userRole = role; },
    setWorkspace(id: string) { context.clinicId = selectedWorkspace = id; },
    setStorageMode(mode?: "denied" | "no-readback" | "no-remove") { options.storageMode = mode; },
    createForm(appointment = own, notes = "Local create draft") {
      const view = open(appointment, notes);
      view.setItems([]); view.setEditingId(null);
      const ready = render();
      writes.length = 0; stateWrites.length = 0;
      return ready;
    },
    installNewView() {
      render().setItems([clone(unrelated)]);
      return open(unrelated, "New scope draft must survive");
    },
    reply(reply: Reply, index = 0) {
      const gate = requests[index]!.gate;
      if (reply === "network") gate.reject(new Error("Synthetic connection lost"));
      else gate.resolve(typeof reply.body === "string" ? new Response(reply.body, { status: reply.status })
        : Response.json(reply.body, { status: reply.status }));
    },
    dispose() { for (const item of slots) item.cleanup?.(); },
    listeners,
  };
}

function assertPending(f: ReturnType<typeof fixture>, action: Action) {
  assert.equal(f.requests.length, 1, "the actual action must reach patchAppointment and the mocked transport");
  assert.equal(f.requests[0]!.body.id, own.id);
  assert.equal(f.requests[0]!.body.workspaceId, workspaceId);
  assert.equal(f.tokens[0]!.expected, actorA, "actual PATCH binds token lookup to the captured actor");
  assert.deepEqual(clone(f.render().items[1]), unrelated);
  assert.equal(f.writes.length, 0, "no list change before server confirmation");
  assert.deepEqual(clone(f.render().items), [own, unrelated]);
  if (action === "edit") {
    assert.equal(f.render().items[0]!.notes, own.notes);
    for (const key of ["phone", "clientPhone", "whatsapp"]) {
      assert.equal(Object.hasOwn(f.requests[0]!.body.updates, key), false, `doctor edit omits readback ${key}`);
    }
    assert.equal(f.render().saving, true);
    assert.equal(f.render().submitLock.current, true);
  } else {
    assert.equal(f.render().items[0]!.status, "scheduled");
    assert.deepEqual(f.requests[0]!.body.updates, { status: "confirmed" });
  }
  assert.equal(f.successes.length, 0);
}
function assertDiscarded(f: ReturnType<typeof fixture>) {
  const current = f.render();
  assert.deepEqual(clone(current.items), [unrelated]);
  assert.deepEqual(clone(current.appointmentItems), [unrelated]);
  assert.ok(current.mutationScope.deniedIds.has(own.id.toLowerCase()));
  assert.equal(current.modalOpen, false);
  assert.equal(current.editingId, null);
  for (const field of ["clientId", "client", "phone", "whatsapp", "doctor", "doctorId", "notes"]) {
    assert.equal(current.form[field], "", `discard clears ${field}`);
  }
  assert.deepEqual(clone(current.clientMatches), []);
  assert.deepEqual(clone(current.remoteVisitHistory), []);
  assert.equal(current.clientSearchAttempted, false);
  assert.equal(current.doctorSearch, "");
  assert.equal(current.serviceSearch, "");
  assert.equal(current.saving, false);
  assert.equal(current.submitLock.current, false);
  assert.equal(f.successes.length, 0);
  assert.equal(f.writes.length, 1, "one removal, no optimistic update or rollback to refused contacts");
}
function assertRetained(f: ReturnType<typeof fixture>) {
  const current = f.render();
  assert.deepEqual(clone(current.items), [own, unrelated], "the last confirmed list row remains unchanged");
  assert.deepEqual(clone(current.form), clone(f.before.form), "the populated unsaved edit form remains");
  assert.equal(current.form.phone, own.phone);
  assert.equal(current.form.whatsapp, own.whatsapp);
  assert.equal(current.form.notes, "Unsaved local edit");
  assert.equal(current.editingId, own.id);
  assert.equal(current.modalOpen, true);
  assert.equal(current.saving, false);
  assert.equal(current.submitLock.current, false);
  assert.deepEqual(clone(current.clientMatches), clone(f.before.clientMatches));
  assert.deepEqual(clone(current.remoteVisitHistory), clone(f.before.remoteVisitHistory));
  assert.equal(current.mutationScope.deniedIds.size, 0);
  assert.equal(f.writes.length, 0, "ordinary errors never alter the last confirmed list");
  assert.equal(f.successes.length, 0);
}

for (const action of ["edit", "status"] as const) {
  for (const [status, code] of [[401, "authentication_required"], [403, "permission_denied"], [404, "not_found"]] as const) {
    for (const malformed of [false, true]) {
      test(`${action}: HTTP ${status} ${malformed ? "malformed HTML" : "JSON"} discards contacts before body parsing`, async () => {
        const f = fixture();
        const saving = f.start(action);
        await tick();
        assertPending(f, action);
        let reads = 0;
        const response = malformed ? new Response("<html>proxy access refusal", { status })
          : Response.json({ success: false, code, error: "Synthetic access refusal" }, { status });
        Object.defineProperty(response, "text", { value: async () => { reads++; throw new Error("denial body must not be parsed"); } });
        f.requests[0]!.gate.resolve(response);
        await saving;
        assert.equal(reads, 0);
        assertDiscarded(f);
        assert.equal(f.errors.length, 1);
        const after = observable(f.render()), writeCount = f.stateWrites.length;
        await invoke(f.before, action);
        await assert.rejects(f.before.patchAppointment(clone(own)), { name: "AbortError" });
        f.before.openEdit(clone(own));
        assert.deepEqual(observable(f.render()), after);
        assert.equal(f.stateWrites.length, writeCount, "captured refused handlers do not mutate state");
        assert.equal(f.tokens.length, 1);
        assert.equal(f.requests.length, 1);
      });
    }
  }

  for (const kind of ["validation", "conflict", "gateway", "network"] as const) {
    test(`${action}: ordinary ${kind} refusal retains the retryable form without any list write`, async () => {
      const f = fixture();
      const saving = f.start(action);
      await tick();
      assertPending(f, action);
      const replies: Record<Exclude<typeof kind, "network">, Reply> = {
        validation: { status: 400, body: { success: false, code: "validation_error", error: "Synthetic invalid field" } },
        conflict: { status: 409, body: { success: false, code: "appointment_conflict", error: "Synthetic occupied slot",
          conflict: { startsAt: own.startsAt, clientName: "Another local client", doctorName: own.doctor } } },
        gateway: { status: 502, body: { success: false, code: "unavailable", error: "Synthetic gateway failure" } },
      };
      f.reply(kind === "network" ? "network" : replies[kind]);
      await saving;
      assertRetained(f);
      if (kind === "conflict" && action === "edit") {
        assert.ok(f.render().conflictMessage.includes("Another local client"), "the actual SlotTakenError branch executes");
        assert.equal(f.errors.length, 0);
      } else assert.equal(f.errors.length, 1);
    });
  }

  test(`${action}: successful real patch maps and displays the returned server row with one list write`, async () => {
    const f = fixture();
    const saving = f.start(action);
    await tick();
    assertPending(f, action);
    const saved = { ...own, client: "Server-returned local client", phone: "+77000000003", whatsapp: "+77000000004",
      status: "confirmed", notes: "Server-saved notes" };
    f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: saved, unsaved: [] } } });
    await saving;
    assert.deepEqual(clone(f.render().items), [saved, unrelated]);
    assert.equal(f.errors.length, 0);
    assert.equal(f.successes.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.render().saving, false);
    assert.equal(f.render().submitLock.current, false);
    assert.equal(f.render().modalOpen, action === "status");
  });

  test(`${action}: denial purges appointment A from matching-client B history without clearing B form`, async () => {
    const f = fixture();
    const captured = f.render();
    const history = { ...unrelated, id: "00000000-0000-4000-8000-000000000007", notes: "Other visible matching-client history" };
    f.open(unrelated, "Newer matching-client B draft");
    f.render().setRemoteVisitHistory([clone(own), clone(unrelated), history]);
    const newer = observable(f.render());
    assert.ok(f.render().visitHistory.some((item) => item.id === own.id), "A genuinely appears in B's matching-client history before refusal");
    const saving = invoke(captured, action);
    await tick();
    f.reply({ status: 403, body: "<html>forbidden" });
    await saving;
    const current = f.render();
    assert.deepEqual(clone(current.items), [unrelated]);
    assert.deepEqual(clone(current.remoteVisitHistory), [unrelated, history], "A is removed even though B is the open form");
    assert.deepEqual(clone(current.visitHistory), [history]);
    for (const field of ["form", "editingId", "modalOpen", "clientMatches", "clientSearchAttempted",
      "doctorSearch", "serviceSearch"]) assert.deepEqual(observable(current)[field], newer[field], field);
    current.setRemoteVisitHistory([clone(own), clone(unrelated), history]);
    assert.ok(f.render().remoteVisitHistory.some((item) => item.id === own.id), "a late history read is present in raw state");
    assert.deepEqual(clone(f.render().visitHistory), [history], "the actual history merge hides A after a late read");
    assert.deepEqual(clone(f.render().form), newer.form);
    assert.equal(f.successes.length, 0);
  });

  test(`${action}: stale GET cannot reintroduce a denied row or enable its captured handlers`, async () => {
    const f = fixture();
    const saving = f.start(action);
    await tick();
    f.reply({ status: 404, body: "Not found" });
    await saving;
    const staleRow = { ...own, id: own.id.toUpperCase() };
    f.render().setItems([staleRow, clone(unrelated)]);
    assert.equal(f.render().appointmentItems.length, 2, "raw stale collection data is genuinely present");
    assert.deepEqual(clone(f.render().items), [unrelated], "the actual useMemo-derived items hide the denied row");
    const before = observable(f.render()), count = f.stateWrites.length;
    await invoke(f.before, action);
    f.render().openEdit(staleRow);
    assert.deepEqual(observable(f.render()), before);
    assert.equal(f.stateWrites.length, count);
    assert.equal(f.requests.length, 1);
    assert.equal(f.tokens.length, 1);
  });

  for (const kind of ["role", "raw ABA"] as const) {
    test(`${action}: denied IDs survive ${kind} reset and hide subsequent stale collection/history rows`, async () => {
      const f = fixture();
      const saving = f.start(action);
      await tick();
      f.reply({ status: 403, body: "<html>refused" });
      await saving;
      const oldScope = f.render().mutationScope;
      f.transition(kind);
      const current = f.render();
      assert.notEqual(current.mutationScope, oldScope);
      assert.equal(current.mutationScope.deniedIds, oldScope.deniedIds, "the actual ref is shared across mutation scopes");
      current.setItems([clone(own), clone(unrelated)]);
      f.open(unrelated, "Matching-client B after scope reset");
      f.render().setRemoteVisitHistory([clone(own), clone(unrelated)]);
      const view = f.render(), before = observable(view), count = f.stateWrites.length;
      assert.equal(view.appointmentItems.length, 2);
      assert.equal(view.remoteVisitHistory.length, 2);
      assert.deepEqual(clone(view.items), [unrelated]);
      assert.deepEqual(clone(view.visitHistory), []);
      view.openEdit(clone(own));
      await view.updateAppointmentStatus(clone(own), "confirmed");
      await assert.rejects(view.patchAppointment(clone(own)), { name: "AbortError" });
      assert.deepEqual(observable(f.render()), before);
      assert.equal(f.stateWrites.length, count);
      assert.equal(f.tokens.length, 1);
      assert.equal(f.requests.length, 1);
      assert.equal(f.successes.length, 0);
    });
  }

  for (const kind of ["account", "workspace", "role", "raw ABA"] as const) {
    test(`${action}: stale pre-dispatch handlers are inert after ${kind} transition`, async () => {
      const f = fixture();
      f.transition(kind);
      if (kind === "raw ABA") assert.equal(f.before.isCurrentMutationScope(), false, "SDK callback invalidates before React renders");
      f.render();
      const before = observable(f.installNewView()), count = f.stateWrites.length;
      assert.equal(f.before.isCurrentMutationScope(), false);
      await invoke(f.before, action);
      await assert.rejects(f.before.patchAppointment(clone(own)), { name: "AbortError" });
      f.before.openEdit(clone(own));
      assert.deepEqual(observable(f.render()), before);
      assert.equal(f.stateWrites.length, count);
      assert.equal(f.tokens.length, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.successes.length + f.errors.length, 0);
    });

    test(`${action}: ${kind} during queued token lookup blocks actual crmFetch dispatch`, async () => {
      const f = fixture({ queueToken: true });
      const saving = f.start(action);
      await tick();
      assert.equal(f.tokens.length, 1);
      assert.equal(f.tokens[0]!.expected, actorA);
      assert.equal(f.requests.length, 0);
      f.transition(kind);
      if (kind === "raw ABA") assert.equal(f.before.isCurrentMutationScope(), false, "raw ABA is not hidden by batched React updates");
      f.render();
      const before = observable(f.installNewView()), count = f.stateWrites.length;
      f.releaseToken();
      await saving;
      assert.equal(f.requests.length, 0, "real crmFetch checks the actual scope guard after the token await");
      assert.deepEqual(observable(f.render()), before);
      assert.equal(f.stateWrites.length, count);
      assert.equal(f.successes.length + f.errors.length, 0);
      assert.equal(f.render().isCurrentMutationScope(), true, "the new scope remains usable");
    });

    for (const late of ["success", "denial"] as const) {
      test(`${action}: late ${late} after ${kind} cannot change newer rows/form or reset its pending save`, async () => {
        const f = fixture();
        const saving = f.start(action);
        await tick();
        assertPending(f, action);
        f.transition(kind);
        if (kind === "raw ABA") assert.equal(f.before.isCurrentMutationScope(), false);
        f.render();
        const newer = f.installNewView().submitForm();
        await tick();
        assert.equal(f.requests.length, 2);
        assert.equal(f.render().saving, true);
        const before = observable(f.render()), count = f.stateWrites.length;
        f.reply(late === "denial" ? { status: 403, body: "<html>old forbidden reply" }
          : { status: 200, body: { success: true, mode: "supabase", data: { item: own } } }, 0);
        await saving;
        assert.deepEqual(observable(f.render()), before);
        assert.equal(f.stateWrites.length, count, "old catch/finally must not write to the new scope");
        assert.equal(f.render().submitLock.current, true);
        assert.equal(f.successes.length + f.errors.length, 0);
        const saved = { ...unrelated, notes: "Saved in the newer scope" };
        f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: saved } } }, 1);
        await newer;
        assert.deepEqual(clone(f.render().items), [saved]);
        assert.equal(f.successes.length, 1);
      });
    }
  }

  for (const queueToken of [false, true]) {
    test(`${action}: same-actor refresh preserves ${queueToken ? "queued token" : "in-flight"} save`, async () => {
      const f = fixture({ queueToken });
      const scope = f.render().mutationScope;
      const saving = f.start(action);
      await tick();
      f.emit(actorA, "TOKEN_REFRESHED");
      f.emit(actorA, "SIGNED_IN");
      assert.equal(f.before.isCurrentMutationScope(), true);
      assert.equal(f.render().mutationScope, scope);
      if (queueToken) { assert.equal(f.requests.length, 0); f.releaseToken(); await tick(); }
      assert.equal(f.requests.length, 1);
      const saved = { ...own, notes: "Saved after same-actor refresh", status: "confirmed" };
      f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: saved } } });
      await saving;
      assert.deepEqual(clone(f.render().items), [saved, unrelated]);
      assert.equal(f.successes.length, 1);
      assert.equal(f.errors.length, 0);
    });
  }

  test(`${action}: verified workspace disagrees with selector, so no token lookup or PATCH is dispatched`, async () => {
    const f = fixture();
    f.setWorkspaceSelector(workspaceB);
    assert.equal(f.render().mutationScope.workspaceId, workspaceId, "verified clinic context takes precedence");
    const before = observable(f.render()), count = f.stateWrites.length;
    await f.start(action);
    await assert.rejects(f.before.patchAppointment(clone(own)), { name: "AbortError" });
    assert.deepEqual(observable(f.render()), before);
    assert.equal(f.stateWrites.length, count);
    assert.equal(f.tokens.length + f.requests.length, 0);
  });

  test(`${action}: denial while another PATCH body is pending cannot restore the refused row`, async () => {
    const f = fixture();
    const saving = f.start(action);
    const other = f.before.updateAppointmentStatus(clone(own), "arrived");
    await tick();
    assert.equal(f.requests.length, 2);
    const body = deferred<string>();
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "text", { value: () => body.promise });
    f.requests[0]!.gate.resolve(response);
    await tick();
    f.reply({ status: 403, body: "<html>refused" }, 1);
    await other;
    assert.deepEqual(clone(f.render().items), [unrelated]);
    body.resolve(JSON.stringify({ success: true, mode: "supabase", data: { item: own } }));
    await saving;
    assert.deepEqual(clone(f.render().items), [unrelated]);
    assert.equal(f.render().modalOpen, false);
    assert.equal(f.render().form.phone, "");
    assert.equal(f.successes.length, 0);
  });

  test(`${action}: denied ID invalidates a second queued-token PATCH before physical dispatch`, async () => {
    const f = fixture({ queueToken: true });
    const saving = f.start(action);
    await tick();
    f.releaseToken();
    await tick();
    const other = f.before.updateAppointmentStatus(clone(own), "arrived");
    await tick();
    assert.equal(f.tokens.length, 2);
    assert.equal(f.requests.length, 1);
    f.reply({ status: 403, body: "<html>refused" });
    await saving;
    f.releaseToken(1);
    await other;
    assert.equal(f.requests.length, 1, "actual dispatchGuard includes the now-denied ID");
    assert.deepEqual(clone(f.render().items), [unrelated]);
    assert.equal(f.render().form.phone, "");
    assert.equal(f.successes.length, 0);
  });
}

test("admin edit preserves all contact keys while applying only the returned server row", async () => {
  const f = fixture({ role: "admin" });
  const saving = f.start("edit");
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.body.updates.phone, own.phone);
  assert.equal(f.requests[0]!.body.updates.clientPhone, own.phone);
  assert.equal(f.requests[0]!.body.updates.whatsapp, own.whatsapp);
  assert.equal(f.requests[0]!.body.updates.notes, "Unsaved local edit");
  assert.equal(f.writes.length, 0);
  const saved = { ...own, notes: "Confirmed admin edit" };
  f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: saved } } });
  await saving;
  assert.deepEqual(clone(f.render().items), [saved, unrelated]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.render().modalOpen, false);
  assert.equal(f.errors.length, 0);
  assert.equal(f.successes.length, 1);
});

test("actual patch throws the typed access refusal and marks denied ID without consuming the response body", async () => {
  const f = fixture();
  const saving = f.before.patchAppointment(clone(own));
  await tick();
  const rejected = assert.rejects(saving, (error) => error instanceof f.AccessRefusal);
  f.reply({ status: 403, body: "<html>unparseable denial" });
  await rejected;
  assert.ok(f.before.mutationScope.deniedIds.has(own.id));
  assert.equal(f.successes.length, 0);
});

test("actual layout cleanup invalidates captured actions and unsubscribes the raw SDK observer", async () => {
  const f = fixture();
  assert.equal(f.listeners.size, 1);
  const before = observable(f.render()), count = f.stateWrites.length;
  f.dispose();
  assert.equal(f.listeners.size, 0);
  f.emit(actorB);
  assert.equal(f.before.isCurrentMutationScope(), false);
  await invoke(f.before, "edit");
  await invoke(f.before, "status");
  await assert.rejects(f.before.patchAppointment(clone(own)), { name: "AbortError" });
  assert.deepEqual(observable(f.render()), before);
  assert.equal(f.stateWrites.length, count);
  assert.equal(f.tokens.length + f.requests.length, 0);
});

function assertPrivateFormBlank(view: Snapshot) {
  assert.deepEqual(clone(view.form), clone(view.blankForm), "no original payload fields are exposed in the recovery form");
  for (const key of ["clientId", "client", "phone", "whatsapp", "doctor", "doctorId", "notes"]) assert.equal(view.form[key], "", key);
  assert.deepEqual(clone(view.clientMatches), []);
  assert.deepEqual(clone(view.remoteVisitHistory), []);
  assert.equal(view.recoveryFieldsDisabled, true);
}

// Recovery state/effect controls; actual POST composition follows below.
for (const kind of ["role", "raw ABA"] as const) {
  test(`matching uncertain create survives ${kind}; only its exact origin role sees private recovery fields`, () => {
    const pending = attempts.newAppointmentCreateAttempt(workspaceId, actorA, clone(own),
      () => "00000000-0000-4000-8000-000000000008",
      { originRole: "doctor", leadId: "00000000-0000-4000-8000-000000000009" });
    pending.uncertain = true;
    const f = fixture({ storedAttempt: pending });
    const initial = f.render(), attempt = initial.createAttempt.current;
    assert.ok(attempt?.uncertain);
    assert.equal(initial.unconfirmedCreate, true);
    assert.equal(initial.modalOpen, true);
    assert.equal(initial.form.phone, own.phone);
    assert.equal(initial.prefillLeadRef.current, pending.leadId);
    const form = clone(initial.form), stored = [...f.stored];
    initial.setModalOpen(false);
    assert.equal(f.render().modalOpen, false);
    assert.equal(f.render().prefillLeadRef.current, pending.leadId, "the actual closed-modal effect preserves an uncertain lead prefill");
    f.transition(kind);
    if (kind === "raw ABA") assert.equal(initial.isCurrentMutationScope(), false);
    const restored = f.render();
    assert.equal(restored.isCurrentMutationScope(), true);
    assert.equal(restored.createAttempt.current!.requestKey, pending.requestKey);
    assert.deepEqual(clone(restored.createAttempt.current!.payload), clone(pending.payload));
    if (kind === "role") assertPrivateFormBlank(restored);
    else assert.deepEqual(clone(restored.form), form);
    assert.equal(restored.modalOpen, true);
    assert.equal(restored.editingId, null);
    assert.equal(restored.unconfirmedCreate, true);
    assert.equal(restored.prefillLeadRef.current, pending.leadId);
    assert.deepEqual([...f.stored], stored);
    assert.equal(f.writes.length + f.tokens.length + f.requests.length, 0);
    assert.equal(f.errors.length + f.successes.length, 0);
    assert.ok(f.warnings.length >= 2);
    assert.deepEqual([...new Set(f.warnings.map((warning) => warning.id))], ["appointment-create-recovery"],
      "repeat effect notifications use one stable toast ID; no claim about a rendered toast library");
  });

  test(`STATE PHASE: pending create becomes conservatively uncertain after ${kind} without changing key/payload`, () => {
    const f = fixture();
    const initial = f.render(), form = clone(initial.form);
    const pending = attempts.newAppointmentCreateAttempt(workspaceId, actorA,
      { ...clone(own), notes: form.notes }, () => "00000000-0000-4000-8000-000000000010",
      { originRole: "doctor", leadId: "00000000-0000-4000-8000-000000000011" });
    assert.equal(pending.uncertain, false);
    // Model only the existing create request/catch state phases, not a POST or router.
    initial.createAttempt.current = pending;
    initial.prefillLeadRef.current = pending.leadId;
    initial.setEditingId(null);
    initial.setUnconfirmedCreate(false);
    assert.equal(attempts.persistAppointmentCreateAttempt(f.sessionStorage, pending), true);
    f.render();
    const payload = clone(pending.payload), key = pending.requestKey;
    f.transition(kind);
    const reset = f.render();
    assert.notEqual(reset.mutationScope, initial.mutationScope);
    assert.equal(reset.isCurrentMutationScope(), true);
    assert.equal(reset.createAttempt.current!.uncertain, true);
    const restored = reset;
    assert.equal(restored.createAttempt.current!.requestKey, key);
    assert.deepEqual(clone(restored.createAttempt.current!.payload), payload);
    if (kind === "role") assertPrivateFormBlank(restored);
    else assert.deepEqual(clone(restored.form), form);
    assert.equal(restored.editingId, null);
    assert.equal(restored.modalOpen, true);
    assert.equal(restored.unconfirmedCreate, true);
    assert.equal(restored.prefillLeadRef.current, pending.leadId);
    const warningCount = f.warnings.length;
    f.render();
    assert.equal(f.warnings.length, warningCount, "settled recovery does not repeat the effect");
    assert.equal(f.writes.length + f.tokens.length + f.requests.length, 0);
    assert.equal(f.errors.length + f.successes.length, 0);
  });
}

// G2-C12 create acceptance uses synthetic transport replies, not a database or backend auth.
const createdReply = (item = own): Reply => ({ status: 201,
  body: { success: true, mode: "supabase", data: { item, replayed: false, clientCreated: false } } });

test("CREATE control: actual submitForm -> createAppointment -> crmFetch persists key and paints confirmed reply", async () => {
  const f = fixture({ actorTokens: true });
  const creating = f.createForm().submitForm();
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.init.method, "POST");
  assert.equal(f.tokens[0]!.expected, actorA, "create token lookup is bound to the captured actor");
  const attempt = f.render().createAttempt.current;
  assert.ok(attempt);
  assert.equal(f.requests[0]!.body.requestKey, attempt.requestKey);
  assert.equal(f.stored.size, 1);
  assert.deepEqual(clone(f.render().items), []);
  f.reply(createdReply());
  await creating;
  assert.deepEqual(clone(f.render().items), [own]);
  assert.equal(f.render().modalOpen, false);
  assert.equal(f.render().saving, false);
  assert.equal(f.stored.size, 0);
  assert.equal(f.successes.length, 1);
});

for (const kind of ["raw actor", "account", "workspace", "role", "raw ABA"] as const) {
  test(`CREATE: ${kind} change while token queued blocks physical POST and preserves the original intent`, async () => {
    const f = fixture({ queueToken: true, actorTokens: true });
    const creating = f.createForm().submitForm();
    await tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.tokens[0]!.expected, actorA);
    const original = clone(f.render().createAttempt.current!);
    if (kind === "raw actor") f.emit(actorB);
    else f.transition(kind);
    if (kind !== "raw actor" && kind !== "raw ABA") f.render();
    const raw = kind === "raw actor" || kind === "raw ABA";
    if (raw) assert.equal(f.before.isCurrentMutationScope(), false, "raw SDK event invalidates the scope before React commits");
    const state = raw ? null : observable(f.render());
    const writes = f.stateWrites.length, toasts = f.successes.length + f.errors.length + f.warnings.length;
    f.releaseToken();
    await creating;
    assert.equal(f.requests.length, 0, "actual crmFetch rejects the captured dispatchGuard after token await");
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.successes.length + f.errors.length + f.warnings.length, toasts);
    if (state) assert.deepEqual(observable(f.render()), state);
    const retained = attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorA);
    assert.equal(retained.requestKey, original.requestKey);
    assert.deepEqual(clone(retained.payload), original.payload);
    assert.equal(retained.uncertain, true);
  });
}

for (const kind of ["account", "workspace", "role", "raw ABA"] as const) {
  test(`CREATE: late reply after ${kind} cannot paint/toast/close/unlock the newer live operation`, async () => {
    const f = fixture({ actorTokens: true });
    const initial = f.createForm();
    initial.prefillLeadRef.current = "00000000-0000-4000-8000-000000000020";
    const creating = initial.submitForm();
    await tick();
    assert.equal(f.requests[0]!.init.method, "POST");
    const original = clone(f.render().createAttempt.current!);
    f.transition(kind);
    f.render();
    const retry = kind === "role" || kind === "raw ABA";
    const newer = retry ? f.render().submitForm() : f.installNewView().submitForm();
    await tick();
    assert.equal(f.requests[1]!.init.method, retry ? "POST" : "PATCH");
    if (retry) assert.deepEqual(f.requests[1]!.body, f.requests[0]!.body, "new scope reconciles the original key and payload");
    assert.equal(f.render().saving, true);
    assert.equal(f.render().submitLock.current, true);
    const state = observable(f.render()), count = f.stateWrites.length;
    const toasts = [f.successes.length, f.errors.length, f.warnings.length];
    f.reply(createdReply(), 0);
    await creating;
    assert.deepEqual(observable(f.render()), state);
    assert.equal(f.stateWrites.length, count);
    assert.equal(f.render().saving, true);
    assert.equal(f.render().submitLock.current, true);
    assert.deepEqual([f.successes.length, f.errors.length, f.warnings.length], toasts);
    assert.deepEqual(f.handoffs, [], "stale create must not initiate the captured lead handoff");
    const retained = attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorA);
    assert.equal(retained.requestKey, original.requestKey);
    assert.deepEqual(clone(retained.payload), original.payload);
    f.reply(retry ? { status: 200, body: { success: true, mode: "supabase", data: { item: own, replayed: true } } }
      : { status: 200, body: { success: true, mode: "supabase", data: { item: unrelated } } }, 1);
    await newer;
    assert.deepEqual(f.handoffs, retry ? [original.leadId] : []);
  });
}

test("CREATE: A and B keep independent scoped recovery; returning to A restores its exact original attempt", async () => {
  const f = fixture({ actorTokens: true });
  const creatingA = f.createForm().submitForm();
  await tick();
  const keyA = f.requests[0]!.body.requestKey;
  assert.equal(f.stored.size, 1);
  assert.equal(JSON.parse([...f.stored.values()][0]!).requestKey, keyA);
  f.setActor(actorB);
  f.render();
  assert.equal(f.stored.size, 1, "identity cleanup preserves A's persisted intent");
  assert.equal(f.render().createAttempt.current, null);
  const creatingB = f.createForm(unrelated, "Account B create draft").submitForm();
  await tick();
  const keyB = f.requests[1]!.body.requestKey;
  assert.notEqual(keyB, keyA);
  assert.equal(f.stored.size, 2);
  const savedB = attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorB);
  assert.equal(savedB.requestKey, keyB);
  assert.equal(savedB.actorId, actorB);
  assert.equal([...f.stored.values()].some((value) => value.includes(keyA)), true);
  f.reply("network", 0);
  await creatingA;
  f.reply("network", 1);
  await creatingB;
  assert.equal(f.render().createAttempt.current!.requestKey, keyB);
  assert.equal(f.render().createAttempt.current!.uncertain, true);
  f.setActor(actorA);
  f.render();
  assert.equal(f.stored.size, 2);
  assert.equal(f.render().createAttempt.current!.requestKey, keyA);
  assert.equal(f.render().createAttempt.current!.uncertain, true);
  assert.equal(attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorB).requestKey, keyB);
  const retryA = f.render().submitForm(); await tick();
  assert.deepEqual(f.requests[2]!.body, f.requests[0]!.body);
  f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: own, replayed: true } } }, 2);
  await retryA;
  assert.equal(f.stored.size, 1, "successful A reconciliation clears only A's addressed receipt");
  assert.equal(attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorB).requestKey, keyB);
});

for (const kind of ["raw actor", "account", "workspace", "role", "raw ABA"] as const) {
  test(`CREATE: captured handler after ${kind} cannot start token lookup or touch current state`, async () => {
    const f = fixture();
    const stale = f.createForm();
    if (kind === "raw actor") f.emit(actorB); else f.transition(kind);
    const raw = kind === "raw actor" || kind === "raw ABA";
    const state = raw ? null : observable(f.render());
    const writes = f.stateWrites.length;
    await stale.submitForm();
    await assert.rejects(stale.createAppointment(clone(own), false), { name: "AbortError" });
    assert.equal(f.stateWrites.length, writes);
    if (state) assert.deepEqual(observable(f.render()), state);
    assert.equal(f.tokens.length + f.requests.length + f.successes.length + f.errors.length + f.handoffs.length, 0);
    assert.equal(f.stored.size, 0);
  });
}

test("CREATE: network loss retains exact wire intent; live retry confirms the same key with replay acknowledgment", async () => {
  const f = fixture();
  const first = f.createForm().submitForm();
  await tick();
  const body = clone(f.requests[0]!.body);
  f.reply("network");
  await first;
  assert.equal(f.render().unconfirmedCreate, true);
  assert.equal(f.render().recoveryFieldsDisabled, true);
  assert.equal(f.render().modalOpen, true);
  assert.equal(f.render().saving, false);
  assert.equal(f.writes.length + f.successes.length, 0);
  const retry = f.render().submitForm();
  await tick();
  assert.deepEqual(f.requests[1]!.body, body);
  assert.equal(f.tokens[1]!.expected, actorA);
  f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: own, replayed: true } } }, 1);
  await retry;
  assert.deepEqual(clone(f.render().items), [own]);
  assert.equal(f.stored.size, 0);
  assert.equal(f.successes.length, 1);
  assert.equal(f.writes.length, 1);
});

for (const [status, code] of [[400, "validation_error"], [403, "permission_denied"],
  [409, "appointment_conflict"], [503, "appointment_create_unavailable"]] as const) {
  test(`CREATE: first definite ${status}/${code} releases only its addressed attempt and permits a new key`, async () => {
    const f = fixture();
    const first = f.createForm().submitForm();
    await tick();
    const body = clone(f.requests[0]!.body);
    f.reply({ status, body: { success: false, code, error: "Synthetic definite refusal" } });
    await first;
    assert.equal(f.stored.size, 0);
    assert.equal(f.render().createAttempt.current, null);
    assert.equal(f.render().modalOpen, true);
    assert.equal(f.render().form.phone, own.phone);
    assert.equal(f.writes.length, 0);
    const retry = f.render().submitForm();
    await tick();
    const next = f.requests[1]!.body;
    assert.notEqual(next.requestKey, body.requestKey);
    const { requestKey: _first, ...intent } = body, { requestKey: _next, ...nextIntent } = next;
    assert.deepEqual(nextIntent, intent);
    f.reply(createdReply(), 1);
    await retry;
  });
}

test("CREATE: a definite refusal after prior uncertainty cannot release or replace the original key", async () => {
  const f = fixture();
  const first = f.createForm().submitForm();
  await tick();
  const body = clone(f.requests[0]!.body);
  f.reply("network"); await first;
  const refused = f.render().submitForm();
  await tick();
  f.reply({ status: 403, body: { success: false, code: "permission_denied", error: "Synthetic later refusal" } }, 1);
  await refused;
  assert.equal(f.render().createAttempt.current!.requestKey, body.requestKey);
  assert.equal(f.render().createAttempt.current!.uncertain, true);
  assert.equal(f.stored.size, 1);
  const retry = f.render().submitForm();
  await tick();
  assert.deepEqual(f.requests[1]!.body, body);
  assert.deepEqual(f.requests[2]!.body, body);
  f.reply(createdReply(), 2); await retry;
});

for (const queueToken of [false, true]) {
  test(`CREATE: same-actor refresh permits the ${queueToken ? "queued" : "in-flight"} operation`, async () => {
    const f = fixture({ queueToken });
    const scope = f.render().mutationScope;
    const creating = f.createForm().submitForm();
    await tick();
    f.emit(actorA, "TOKEN_REFRESHED"); f.emit(actorA, "SIGNED_IN");
    assert.equal(f.render().mutationScope, scope);
    if (queueToken) { f.releaseToken(); await tick(); }
    assert.equal(f.requests.length, 1);
    assert.equal(f.tokens[0]!.expected, actorA);
    f.reply(createdReply()); await creating;
    assert.deepEqual(clone(f.render().items), [own]);
    assert.equal(f.successes.length, 1);
    assert.equal(f.errors.length, 0);
  });
}

for (const kind of ["account", "workspace", "role", "raw ABA"] as const) {
  test(`CREATE: ${kind} during body parsing cannot settle the newer ${kind === "role" || kind === "raw ABA" ? "same-key retry" : "edit"}`, async () => {
    const f = fixture();
    const creating = f.createForm().submitForm();
    await tick();
    const original = clone(f.requests[0]!.body), body = deferred<string>();
    let reads = 0;
    const response = new Response(null, { status: 201 });
    Object.defineProperty(response, "text", { value: () => { reads++; return body.promise; } });
    f.requests[0]!.gate.resolve(response);
    await tick();
    assert.equal(reads, 1);
    f.transition(kind); f.render();
    const retry = kind === "role" || kind === "raw ABA";
    const newer = retry ? f.render().submitForm() : f.installNewView().submitForm();
    await tick();
    assert.equal(f.requests[1]!.init.method, retry ? "POST" : "PATCH");
    if (retry) assert.deepEqual(f.requests[1]!.body, original);
    const state = observable(f.render()), writes = f.stateWrites.length;
    const toasts = [f.successes.length, f.errors.length, f.warnings.length];
    body.resolve(JSON.stringify({ success: true, mode: "supabase", data: { item: own, replayed: false } }));
    await creating;
    assert.equal(f.stateWrites.length, writes);
    assert.deepEqual(observable(f.render()), state);
    assert.equal(f.render().submitLock.current, true);
    assert.deepEqual([f.successes.length, f.errors.length, f.warnings.length], toasts);
    assert.equal(attempts.restoreAppointmentCreateAttempt(f.sessionStorage, workspaceId, actorA).requestKey, original.requestKey);
    f.reply(retry ? createdReply() : { status: 200, body: { success: true, mode: "supabase", data: { item: unrelated } } }, 1);
    await newer;
  });
}

for (const originRole of [undefined, "admin"]) {
  test(`CREATE: ${originRole ? "different" : "absent"} origin role hides private draft but allows bound same-key reconciliation`, async () => {
    const pending = attempts.newAppointmentCreateAttempt(workspaceId, actorA, clone(own),
      () => "00000000-0000-4000-8000-000000000030", { ...(originRole ? { originRole } : {}) });
    pending.uncertain = true;
    const f = fixture({ storedAttempt: pending });
    assertPrivateFormBlank(f.render());
    assert.equal(f.render().modalOpen, true);
    const retry = f.render().submitForm();
    await tick();
    assert.equal(f.tokens[0]!.expected, actorA);
    assert.deepEqual(f.requests[0]!.body, { ...clone(pending.payload), requestKey: pending.requestKey });
    f.reply(createdReply()); await retry;
    assert.equal(f.successes.length, 1);
    assert.equal(f.stored.size, 0);
  });
}

const legacySlot = "medina_appointment_create_attempt_v1";
function savedAttempt(key = "00000000-0000-4000-8000-000000000040", actor = actorA) {
  return attempts.newAppointmentCreateAttempt(workspaceId, actor, clone(own), () => key);
}
test("CREATE: matching legacy v1 migrates without a new key and reconciles from a blank role-unknown form", async () => {
  const pending = savedAttempt();
  const stored = new Map([[legacySlot, JSON.stringify({ version: 1, ...pending })]]);
  const f = fixture({ storage: stored, mountOnly: true });
  assert.equal(stored.has(legacySlot), false);
  assert.equal(stored.size, 1);
  assertPrivateFormBlank(f.render());
  const retry = f.render().submitForm(); await tick();
  assert.equal(f.requests[0]!.body.requestKey, pending.requestKey);
  f.reply(createdReply()); await retry;
  assert.equal(stored.size, 0);
});
test("CREATE: foreign legacy remains byte-identical through another actor's successful scoped create", async () => {
  const raw = JSON.stringify({ version: 1, ...savedAttempt(undefined, actorB) });
  const stored = new Map([[legacySlot, raw]]), f = fixture({ storage: stored });
  const creating = f.createForm().submitForm(); await tick();
  assert.equal(stored.size, 2);
  assert.equal(stored.get(legacySlot), raw);
  f.reply(createdReply()); await creating;
  assert.deepEqual([...stored], [[legacySlot, raw]]);
});

for (const bad of ["legacy corrupt", "scoped corrupt", "conflict"] as const) {
  test(`CREATE: ${bad} recovery blocks POST and preserves stored evidence`, async () => {
    const seed = fixture({ storedAttempt: savedAttempt() }), stored = seed.stored;
    seed.dispose();
    if (bad === "legacy corrupt") stored.set(legacySlot, "not-json");
    if (bad === "scoped corrupt") stored.set([...stored.keys()][0]!, "not-json");
    if (bad === "conflict") stored.set(legacySlot, JSON.stringify({ version: 1,
      ...savedAttempt("00000000-0000-4000-8000-000000000041") }));
    const before = [...stored], f = fixture({ storage: stored, mountOnly: true });
    assert.ok(f.render().createRecoveryError);
    await f.createForm().submitForm();
    assert.equal(f.tokens.length + f.requests.length + f.successes.length, 0);
    assert.deepEqual([...stored], before);
  });
}
for (const mode of ["denied", "no-readback"] as const) {
  test(`CREATE: ${mode} storage cannot dispatch an unprotected create`, async () => {
    const f = fixture({ storageMode: mode, mountOnly: true });
    await f.createForm().submitForm();
    assert.equal(f.tokens.length + f.requests.length + f.successes.length, 0);
  });
}
test("CREATE: confirmed ack with failed addressed cleanup retains the key; recovery retries that key", async () => {
  const f = fixture({ storageMode: "no-remove" });
  const creating = f.createForm().submitForm(); await tick();
  const body = clone(f.requests[0]!.body);
  f.reply(createdReply()); await creating;
  assert.equal(f.writes.length + f.successes.length, 0);
  assert.equal(f.render().unconfirmedCreate, true);
  assert.equal(f.render().createAttempt.current!.requestKey, body.requestKey);
  f.setStorageMode();
  const retry = f.render().submitForm(); await tick();
  assert.deepEqual(f.requests[1]!.body, body);
  f.reply(createdReply(), 1); await retry;
  assert.equal(f.stored.size, 0);
  assert.equal(f.successes.length, 1);
});
test("CREATE: live completion hands off the captured lead, not a later mutable prefill", async () => {
  const f = fixture(), view = f.createForm();
  const originalLead = "00000000-0000-4000-8000-000000000050";
  view.prefillLeadRef.current = originalLead;
  const creating = view.submitForm(); await tick();
  assert.equal(f.render().createAttempt.current!.leadId, originalLead);
  assert.equal(f.render().createAttempt.current!.originRole, "doctor");
  view.prefillLeadRef.current = "00000000-0000-4000-8000-000000000051";
  f.reply(createdReply()); await creating;
  assert.deepEqual(f.handoffs, [originalLead], "handoff initiation only; the lead API is outside this fixture");
});

for (const late of ["success", "network"] as const) {
  test(`CREATE: old ${late} after successful same-key ABA reconciliation cannot resurrect the cleared receipt`, async () => {
    const f = fixture(), old = f.createForm().submitForm();
    await tick();
    const original = clone(f.requests[0]!.body);
    f.transition("raw ABA"); f.render();
    const retry = f.render().submitForm(); await tick();
    assert.deepEqual(f.requests[1]!.body, original);
    f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: own, replayed: true } } }, 1);
    await retry;
    assert.equal(f.stored.size, 0);
    assert.equal(f.render().createAttempt.current, null);
    const state = observable(f.render()), writes = f.stateWrites.length, storageWrites = f.storageWrites.length;
    const toasts = [f.successes.length, f.errors.length, f.warnings.length];
    f.reply(late === "network" ? "network" : createdReply(), 0);
    await old;
    assert.equal(f.stored.size, 0);
    assert.equal(f.storageWrites.length, storageWrites, "stale catch never writes storage, including after a new reconciliation cleared it");
    assert.equal(f.stateWrites.length, writes);
    assert.deepEqual(observable(f.render()), state);
    assert.deepEqual([f.successes.length, f.errors.length, f.warnings.length], toasts);
  });
}

test("CREATE: retained write with one failed readback blocks POST, then explicit recovery sends its original key", async () => {
  const f = fixture({ storageFault: "retained-readback-once" });
  await f.createForm().submitForm();
  assert.equal(f.tokens.length + f.requests.length, 0);
  assert.equal(f.render().createAttempt.current, null, "failed persistence readback cannot install an in-memory attempt");
  assert.ok(f.render().createRecoveryError);
  assert.equal(f.stored.size, 1);
  const retained = JSON.parse([...f.stored.values()][0]!);
  const blocked = f.render(); await blocked.submitForm();
  assert.equal(f.requests.length, 0);
  blocked.setCreateRecoveryRead(blocked.createRecoveryRead + 1);
  const recovered = f.render();
  assert.equal(recovered.createRecoveryError, "");
  assert.equal(recovered.createAttempt.current!.requestKey, retained.requestKey);
  assert.deepEqual(clone(recovered.createAttempt.current!.payload), retained.payload);
  const retry = recovered.submitForm(); await tick();
  assert.deepEqual(f.requests[0]!.body, { ...retained.payload, requestKey: retained.requestKey });
  f.reply(createdReply()); await retry;
  assert.equal(f.stored.size, 0);
  assert.equal(f.successes.length, 1);
});

test("CREATE: initial unretained write failure permits a fresh key only after explicit empty recovery read", async () => {
  const f = fixture({ storageFault: "write-once" });
  await f.createForm().submitForm();
  const failedKey = JSON.parse(f.storageWrites[0]!.value).requestKey;
  assert.equal(f.stored.size + f.tokens.length + f.requests.length, 0);
  assert.ok(f.render().createRecoveryError);
  const blocked = f.render(); await blocked.submitForm();
  assert.equal(f.storageWrites.length, 1, "the error guard prevents blindly generating a new attempt");
  blocked.setCreateRecoveryRead(blocked.createRecoveryRead + 1);
  assert.equal(f.render().createRecoveryError, "");
  assert.equal(f.render().createAttempt.current, null);
  const retry = f.render().submitForm(); await tick();
  assert.notEqual(f.requests[0]!.body.requestKey, failedKey);
  f.reply(createdReply()); await retry;
});

test("CREATE: uncertainty plus unreadable durable recovery blocks further POSTs until addressed reread succeeds", async () => {
  const f = fixture(), first = f.createForm().submitForm(); await tick();
  const body = clone(f.requests[0]!.body);
  f.reply("network"); await first;
  f.setStorageMode("denied");
  await f.render().submitForm();
  assert.equal(f.requests.length, 1);
  assert.ok(f.render().createRecoveryError);
  const current = f.render(); current.setCreateRecoveryRead(current.createRecoveryRead + 1);
  assert.ok(f.render().createRecoveryError, "actual recovery effect reads durable storage even with a pending in-memory attempt");
  await f.render().submitForm();
  assert.equal(f.requests.length, 1);
  f.setStorageMode();
  const blocked = f.render(); blocked.setCreateRecoveryRead(blocked.createRecoveryRead + 1);
  assert.equal(f.render().createRecoveryError, "");
  const retry = f.render().submitForm(); await tick();
  assert.deepEqual(f.requests[1]!.body, body);
  f.reply(createdReply(), 1); await retry;
});

// Actual handoff closure, crmFetch and parser; empty-stage cases exercise the fallback.
const handoffLead = "00000000-0000-4000-8000-000000000060";
const stagesReply: Reply = { status: 200, body: { success: true, mode: "supabase", data: { stages: [] } } };
const leadReply: Reply = { status: 200, body: { success: true, mode: "supabase" } };
function assertLeadRoute(f: ReturnType<typeof fixture>, index: number, stages = false) {
  const request = f.requests[index]!;
  assert.equal(request.url, `/api/crm/${stages ? "lead-stages" : "leads"}?workspaceId=${workspaceId}`);
  assert.equal(request.init.method ?? "GET", stages ? "GET" : "PATCH");
  assert.equal(request.actorId, actorA);
  if (!stages) assert.deepEqual(request.body, { id: handoffLead, workspaceId, status: "booked" });
  assert.ok(f.tokens.every((token) => token.expected === actorA), "every real handoff request binds the original actor");
}
function heldJson() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
  return { response: new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } }),
    release(value: unknown) { writer.enqueue(new TextEncoder().encode(JSON.stringify(value))); writer.close(); } };
}
function changeHandoffScope(f: ReturnType<typeof fixture>, kind: Transition) {
  f.transition(kind);
  if (kind !== "raw ABA") f.render();
  assert.equal(f.before.isCurrentMutationScope(), false);
  return f.stateWrites.length;
}

test("HANDOFF: actual create caller performs bound GET then PATCH for the captured lead, not the mutable prefill", async () => {
  const f = fixture({ actualLeadHandoff: true, actorTokens: true }), view = f.createForm();
  view.prefillLeadRef.current = handoffLead;
  const creating = view.submitForm(); await tick();
  view.prefillLeadRef.current = "00000000-0000-4000-8000-000000000061";
  f.reply(createdReply()); await creating; await tick();
  assertLeadRoute(f, 1, true);
  f.reply(stagesReply, 1); await tick();
  assertLeadRoute(f, 2);
  f.reply(leadReply, 2); await tick(); await tick();
  assert.equal(f.requests.length, 3);
  assert.equal(f.successes.length, 2, "one appointment confirmation and one actual handoff confirmation");
  assert.equal(f.errors.length, 0);
});

for (const kind of ["account", "workspace", "role", "raw ABA"] as const) {
  test(`HANDOFF: captured handler after ${kind} performs no token lookup`, async () => {
    const f = fixture({ actualLeadHandoff: true }), captured = f.render().markLeadBooked;
    const writes = changeHandoffScope(f, kind);
    await captured(handoffLead);
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.tokens.length + f.requests.length + f.successes.length + f.errors.length, 0);
  });

  test(`HANDOFF: ${kind} while GET token queued blocks both GET and fallback PATCH`, async () => {
    const f = fixture({ actualLeadHandoff: true, queueToken: true });
    const handoff = f.render().markLeadBooked(handoffLead); await tick();
    assert.equal(f.tokens.length, 1);
    assert.equal(f.tokens[0]!.expected, actorA);
    const writes = changeHandoffScope(f, kind);
    f.releaseToken(); await handoff;
    assert.equal(f.requests.length, 0);
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.successes.length + f.errors.length, 0);
  });

  test(`HANDOFF: ${kind} during actual GET JSON body consumption cannot start PATCH`, async () => {
    const f = fixture({ actualLeadHandoff: true }), handoff = f.render().markLeadBooked(handoffLead);
    await tick(); assertLeadRoute(f, 0, true);
    const body = heldJson(); f.requests[0]!.gate.resolve(body.response); await tick();
    assert.equal(f.requests.length, 1);
    const writes = changeHandoffScope(f, kind);
    body.release({ success: true, data: { stages: [] } }); await handoff;
    assert.equal(f.requests.length, 1);
    assert.equal(f.tokens.length, 1, "no second token lookup or retargeted lead mutation");
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.successes.length + f.errors.length, 0);
  });

  test(`HANDOFF: ${kind} while PATCH token queued blocks physical lead mutation`, async () => {
    const f = fixture({ actualLeadHandoff: true, queueToken: true });
    const handoff = f.render().markLeadBooked(handoffLead); await tick();
    f.releaseToken(); await tick(); assertLeadRoute(f, 0, true);
    f.reply(stagesReply); await tick();
    assert.equal(f.tokens.length, 2);
    assert.equal(f.tokens[1]!.expected, actorA);
    assert.equal(f.requests.length, 1);
    const writes = changeHandoffScope(f, kind);
    f.releaseToken(1); await handoff;
    assert.equal(f.requests.length, 1);
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.successes.length + f.errors.length, 0);
  });

  for (const failed of [false, true]) {
    test(`HANDOFF: late PATCH ${failed ? "network failure" : "success"} after ${kind} produces no cross-scope toast`, async () => {
      const f = fixture({ actualLeadHandoff: true }), handoff = f.render().markLeadBooked(handoffLead);
      await tick(); f.reply(stagesReply); await tick(); assertLeadRoute(f, 1);
      const writes = changeHandoffScope(f, kind);
      f.reply(failed ? "network" : leadReply, 1); await handoff;
      assert.equal(f.requests.length, 2);
      assert.equal(f.stateWrites.length, writes);
      assert.equal(f.successes.length + f.errors.length, 0);
      assertLeadRoute(f, 1);
    });
  }
}

for (const phase of ["GET token", "PATCH token", "PATCH response"] as const) {
  test(`HANDOFF: same-actor refresh during ${phase} remains allowed`, async () => {
    const queued = phase !== "PATCH response";
    const f = fixture({ actualLeadHandoff: true, queueToken: queued });
    const scope = f.render().mutationScope, handoff = f.render().markLeadBooked(handoffLead);
    const refresh = () => { f.emit(actorA, "TOKEN_REFRESHED"); assert.equal(f.render().mutationScope, scope); };
    await tick();
    if (phase === "GET token") refresh();
    if (queued) { f.releaseToken(); await tick(); }
    assertLeadRoute(f, 0, true);
    f.reply(stagesReply); await tick();
    if (phase === "PATCH token") refresh();
    if (queued) { f.releaseToken(1); await tick(); }
    assertLeadRoute(f, 1);
    if (phase === "PATCH response") refresh();
    f.reply(leadReply, 1); await handoff;
    assert.equal(f.requests.length, 2);
    assert.equal(f.successes.length, 1);
    assert.equal(f.errors.length, 0);
  });
}

test("HANDOFF: real parser selects the earliest active configured booked stage and sends its UUID", async () => {
  const f = fixture({ actualLeadHandoff: true }), handoff = f.render().markLeadBooked(handoffLead);
  await tick(); assertLeadRoute(f, 0, true);
  const chosen = "00000000-0000-4000-8000-000000000070";
  f.reply({ status: 200, body: { success: true, data: { stages: [
    { id: "00000000-0000-4000-8000-000000000071", stage_key: "inactive_booked", name: "Inactive local stage", semantic_group: "booked", sort_order: 0, is_active: false },
    { id: "00000000-0000-4000-8000-000000000072", stage_key: "in_progress", name: "Other local group", semantic_group: "in_progress", sort_order: 1, is_active: true },
    { id: "00000000-0000-4000-8000-000000000073", stage_key: "later_booked", name: "Later local stage", semantic_group: "booked", sort_order: 30, is_active: true },
    { id: chosen, stage_key: " custom_booked ", name: "Chosen local stage", semantic_group: "booked", sort_order: "10", is_active: "true" },
    { id: "invalid-local-stage", name: "Missing stage key" },
  ] } } });
  await tick();
  assert.equal(f.requests[1]!.url, `/api/crm/leads?workspaceId=${workspaceId}`);
  assert.equal(f.requests[1]!.init.method, "PATCH");
  assert.deepEqual(f.requests[1]!.body, { id: handoffLead, workspaceId, status: "custom_booked", stageId: chosen });
  assert.ok(f.tokens.every((token) => token.expected === actorA));
  f.reply(leadReply, 1); await handoff;
  assert.equal(f.requests.length, 2);
  assert.equal(f.successes.length, 1);
  assert.equal(f.errors.length, 0);
});

test("HANDOFF: account change while PATCH JSON body is held suppresses the obsolete confirmation", async () => {
  const f = fixture({ actualLeadHandoff: true }), handoff = f.render().markLeadBooked(handoffLead);
  await tick(); f.reply(stagesReply); await tick(); assertLeadRoute(f, 1);
  const body = heldJson(); f.requests[1]!.gate.resolve(body.response); await tick();
  assert.equal(f.successes.length + f.errors.length, 0, "PATCH headers alone do not complete the handoff");
  const writes = changeHandoffScope(f, "account");
  body.release({ success: true, mode: "supabase" }); await handoff;
  assert.equal(f.stateWrites.length, writes);
  assert.equal(f.requests.length, 2);
  assert.equal(f.tokens.length, 2);
  assert.equal(f.successes.length + f.errors.length, 0);
  assertLeadRoute(f, 1);
});

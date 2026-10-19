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
  "describeConflict", "appointmentInterval", "AppointmentAccessRefusalError", "appointmentAttemptStorage", "isUuidText",
]);
const state = select(page.body.statements, [
  "userRole", "terms",
  "selectedDate", "modalOpen", "editingId", "form", "clientMatches", "clientSearchAttempted",
  "remoteVisitHistory", "conflictMessage", "saving", "submitLock", "createAttempt", "serviceSearch",
  "doctorSearch", "scheduleMessage",
  "prefillLeadRef", "restoredCreateScope", "unconfirmedCreate", "currentCreateScope",
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
const createScopeAssignments = page.body.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isBinaryExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.left)
  && ts.isIdentifier(node.expression.left.expression) && node.expression.left.expression.text === "currentCreateScope");
assert.equal(createScopeAssignments.length, 1);
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
const compiled = compile(`${helpers}\nfunction renderActions() {
  const [appointmentItems, setItems] = useState(seedItems);
  ${state}
  ${createScopeAssignments[0]!.getText(ast)}
  ${effectReferencing("prefillLeadRef")}
  ${effectReferencing("clearPersistedAppointmentCreateAttempt")}
  ${scope}
  ${actions}
  return { items, appointmentItems, form, editingId, modalOpen, saving, submitLock, conflictMessage, scheduleMessage,
    clientMatches, clientSearchAttempted, remoteVisitHistory, visitHistory, doctorSearch, serviceSearch,
    setItems, setClientMatches, setClientSearchAttempted, setRemoteVisitHistory, setDoctorSearch, setServiceSearch,
    createAttempt, unconfirmedCreate, prefillLeadRef, setModalOpen, setEditingId, setUnconfirmedCreate,
    mutationScope, isCurrentMutationScope, openEdit, setForm, patchAppointment, createAppointment, submitForm, updateAppointmentStatus };
}\nexports.renderActions = renderActions;
exports.AccessRefusal = AppointmentAccessRefusalError;`, "AppointmentsPage.extracted-actions.ts");

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
    "conflictMessage", "scheduleMessage"].map((name) => [name, view[name as keyof Snapshot]])));
}
function fixture(options: { queueToken?: boolean; storedAttempt?: Record<string, any>; role?: string; actorTokens?: boolean } = {}) {
  const slots: any[] = [], stateWrites: unknown[] = [];
  let cursor = 0, dirty = true, sdkActor = actorA, selectedWorkspace = workspaceId;
  const context = { user: { id: actorA }, userRole: options.role ?? "doctor", clinicId: workspaceId, vertical: "clinic",
    isLoading: false, isSigningOut: false, isDemoMode: false, isImpersonation: false };
  const writes: any[] = [];
  const errors: string[] = [], successes: string[] = [];
  const warnings: { message: string; id?: string }[] = [], stored = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); } };
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
      assert.ok([workspaceId, workspaceB].some((id) => url === `/api/crm/appointments?workspaceId=${id}`));
      assert.ok(init.method === "PATCH" || init.method === "POST", "only mocked appointment writes are allowed");
      assert.equal(new Headers(init.headers).get("Authorization"), options.actorTokens
        ? `Bearer fixture.${sdkActor}.token` : "Bearer fixture.appointment.token");
      assert.equal(init.expectedUserId, undefined, "actual crmFetch strips dispatch metadata before fetch");
      assert.equal(init.dispatchGuard, undefined);
      const gate = deferred<Response>();
      requests.push({ url, init, body: JSON.parse(String(init.body)), actorId: sdkActor, gate });
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
  new Script(compiled, { filename: "AppointmentsPage.extracted-actions.cjs" }).runInNewContext({
    exports, Error, DOMException, Response, fetch: forbidden, require: forbidden,
    ...services, ...dates, ...capacity, ...vertical, ...clients, ...attempts,
    window: { sessionStorage },
    todayKeyAtLoad: "2026-10-19", clinicTimeZone: "UTC", clinicTimeZoneReady: true,
    seedItems: clone([own, unrelated]), useAuth: () => context, hasSupabaseFrontendEnv: true,
    isRealWorkspace: () => true,
    supabase: { auth: { onAuthStateChange(listener: (event: string, session: any) => void) {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    } } },
    activeCatalog: [], activeDoctors: [], directory: { items: [] },
    readCurrentWorkspaceId: () => selectedWorkspace,
    addItem: forbidden, markLeadBooked: forbidden,
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
  if (!options.storedAttempt) open();
  const before = render();
  writes.length = 0; stateWrites.length = 0;
  const emit = (actor: string, event = "SIGNED_IN") => {
    sdkActor = actor;
    for (const listener of listeners) listener(event, actor ? { user: { id: actor } } : null);
  };
  return {
    render, before, open, emit, requests, tokens, writes, stateWrites, errors, successes, warnings, stored,
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
    createForm(appointment = own, notes = "Local create draft") {
      const view = open(appointment, notes);
      view.setItems([]); view.setEditingId(null);
      return render();
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
    const saving = f.start(action);
    await tick();
    const history = { ...unrelated, id: "00000000-0000-4000-8000-000000000007", notes: "Other visible matching-client history" };
    f.open(unrelated, "Newer matching-client B draft");
    f.render().setRemoteVisitHistory([clone(own), clone(unrelated), history]);
    const newer = observable(f.render());
    assert.ok(f.render().visitHistory.some((item) => item.id === own.id), "A genuinely appears in B's matching-client history before refusal");
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

// Only the existing recovery effects are in scope here, not create POST or its other reads.
for (const kind of ["role", "raw ABA"] as const) {
  test(`matching uncertain create rehydrates after ${kind} scope reset without losing payload/key/lead prefill`, () => {
    const pending = attempts.newAppointmentCreateAttempt(workspaceId, actorA, clone(own),
      () => "00000000-0000-4000-8000-000000000008");
    pending.uncertain = true;
    pending.leadId = "00000000-0000-4000-8000-000000000009";
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
    assert.equal(restored.createAttempt.current, attempt, "the existing uncertain attempt is retained");
    assert.equal(restored.createAttempt.current!.requestKey, pending.requestKey);
    assert.deepEqual(clone(restored.createAttempt.current!.payload), clone(pending.payload));
    assert.deepEqual(clone(restored.form), form);
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

  test(`STATE PHASE ONLY: late create uncertainty after ${kind} reset reopens the original payload/key/lead`, () => {
    const f = fixture();
    const initial = f.render(), form = clone(initial.form);
    const pending = attempts.newAppointmentCreateAttempt(workspaceId, actorA,
      { ...clone(own), notes: form.notes }, () => "00000000-0000-4000-8000-000000000010");
    pending.leadId = "00000000-0000-4000-8000-000000000011";
    assert.equal(pending.uncertain, false);
    // Model only the existing create request/catch state phases, not a POST or router.
    initial.createAttempt.current = pending;
    initial.prefillLeadRef.current = pending.leadId;
    initial.setEditingId(null);
    initial.setUnconfirmedCreate(false);
    f.render();
    const payload = clone(pending.payload), key = pending.requestKey;
    f.transition(kind);
    const reset = f.render();
    assert.notEqual(reset.mutationScope, initial.mutationScope);
    assert.equal(reset.isCurrentMutationScope(), true);
    assert.equal(reset.createAttempt.current, pending);
    assert.equal(reset.createAttempt.current!.uncertain, false);
    assert.equal(reset.unconfirmedCreate, false);
    assert.equal(reset.modalOpen, false);
    assert.equal(reset.form.client, "");
    assert.equal(reset.form.phone, "");
    assert.equal(f.warnings.length, 0);

    pending.uncertain = true;
    const stillReset = f.render();
    assert.equal(stillReset.modalOpen, false, "changing a ref alone cannot rerun the existing recovery effect");
    assert.equal(stillReset.form.phone, "");
    stillReset.setUnconfirmedCreate(true);
    const restored = f.render();
    assert.equal(restored.createAttempt.current, pending);
    assert.equal(restored.createAttempt.current!.requestKey, key);
    assert.deepEqual(clone(restored.createAttempt.current!.payload), payload);
    assert.deepEqual(clone(restored.form), form);
    assert.equal(restored.editingId, null);
    assert.equal(restored.modalOpen, true);
    assert.equal(restored.unconfirmedCreate, true);
    assert.equal(restored.prefillLeadRef.current, pending.leadId);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0]!.id, "appointment-create-recovery");
    f.render();
    assert.equal(f.warnings.length, 1, "the settled late-uncertainty phase does not repeat the effect");
    assert.equal(f.writes.length + f.tokens.length + f.requests.length, 0);
    assert.equal(f.errors.length + f.successes.length, 0);
  });
}

// Current create-path characterizations, NOT safe-retry/session acceptance. Replies
// below are synthetic transport data: no database insertion or authorization is asserted.
const createdReply = (item = own): Reply => ({ status: 201,
  body: { success: true, mode: "supabase", data: { item, replayed: false, clientCreated: false } } });

test("CREATE control: actual submitForm -> createAppointment -> crmFetch persists key and paints confirmed reply", async () => {
  const f = fixture({ actorTokens: true });
  const creating = f.createForm().submitForm();
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.init.method, "POST");
  assert.equal(f.tokens[0]!.expected, undefined, "current create token lookup is unbound");
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
  test(`CREATE BASELINE: ${kind} change while token queued still dispatches the original POST (not acceptance)`, async () => {
    const f = fixture({ queueToken: true, actorTokens: true });
    const creating = f.createForm().submitForm();
    await tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.tokens[0]!.expected, undefined);
    const original = clone(f.render().createAttempt.current!);
    if (kind === "raw actor") f.emit(actorB);
    else f.transition(kind);
    if (kind !== "raw actor" && kind !== "raw ABA") f.render();
    f.releaseToken();
    await tick();
    assert.equal(f.requests.length, 1, "current create has no dispatch guard after token await");
    const request = f.requests[0]!;
    assert.equal(request.init.method, "POST");
    assert.equal(request.url, `/api/crm/appointments?workspaceId=${workspaceId}`);
    assert.equal(request.body.requestKey, original.requestKey);
    assert.deepEqual(request.body, { ...original.payload, requestKey: original.requestKey });
    const actor = kind === "raw actor" || kind === "account" ? actorB : actorA;
    assert.equal(request.actorId, actor);
    assert.equal(new Headers(request.init.headers).get("Authorization"), `Bearer fixture.${actor}.token`);
    f.reply({ status: 403, body: { success: false, code: "permission_denied", error: "Synthetic refusal, no save claimed" } });
    await creating;
    assert.equal(f.successes.length, 0);
  });
}

for (const kind of ["account", "workspace", "role", "raw ABA"] as const) {
  test(`CREATE BASELINE: late reply after ${kind} affects a newer pending edit (not acceptance)`, async () => {
    const f = fixture({ actorTokens: true });
    const creating = f.createForm().submitForm();
    await tick();
    assert.equal(f.requests[0]!.init.method, "POST");
    f.transition(kind);
    f.render();
    const newer = f.installNewView().submitForm();
    await tick();
    assert.equal(f.requests[1]!.init.method, "PATCH");
    assert.equal(f.render().saving, true);
    assert.equal(f.render().submitLock.current, true);
    const form = clone(f.render().form), count = f.writes.length;
    f.reply(createdReply(), 0);
    await creating;
    const acceptsLate = kind === "role" || kind === "raw ABA";
    assert.deepEqual(clone(f.render().items), acceptsLate ? [own, unrelated] : [unrelated]);
    assert.equal(f.writes.length - count, acceptsLate ? 1 : 0);
    assert.deepEqual(clone(f.render().form), form, "newer draft values themselves were not replaced");
    assert.equal(f.render().modalOpen, !acceptsLate, "role/epoch-only change permits the old create to close the newer modal");
    assert.equal(f.render().saving, false, "old create finally resets the newer edit's pending indicator");
    assert.equal(f.render().submitLock.current, false, "old create finally releases the newer edit's submit lock");
    assert.equal(f.successes.length, acceptsLate ? 1 : 0);
    assert.equal(f.errors.length, acceptsLate ? 0 : 1);
    f.reply({ status: 200, body: { success: true, mode: "supabase", data: { item: unrelated } } }, 1);
    await newer;
  });
}

test("CREATE BASELINE: account switch deletes A's scalar v1 recovery slot, then B occupies the sole slot (not acceptance)", async () => {
  const f = fixture({ actorTokens: true });
  const creatingA = f.createForm().submitForm();
  await tick();
  const keyA = f.requests[0]!.body.requestKey;
  assert.equal(f.stored.size, 1);
  assert.equal(JSON.parse([...f.stored.values()][0]!).requestKey, keyA);
  f.setActor(actorB);
  f.render();
  assert.equal(f.stored.size, 0, "actual account cleanup deletes the in-flight A recovery key");
  assert.equal(f.render().createAttempt.current, null);
  const creatingB = f.createForm(unrelated, "Account B create draft").submitForm();
  await tick();
  const keyB = f.requests[1]!.body.requestKey;
  assert.notEqual(keyB, keyA);
  assert.equal(f.stored.size, 1);
  const savedB = JSON.parse([...f.stored.values()][0]!);
  assert.equal(savedB.requestKey, keyB);
  assert.equal(savedB.actorId, actorB);
  assert.equal([...f.stored.values()].some((value) => value.includes(keyA)), false);
  f.reply("network", 0);
  await creatingA;
  f.reply("network", 1);
  await creatingB;
  assert.equal(f.render().createAttempt.current!.requestKey, keyB);
  assert.equal(f.render().createAttempt.current!.uncertain, true);
  f.setActor(actorA);
  f.render();
  assert.equal(f.stored.size, 0, "returning to A also deletes B's uncertain scalar slot");
  assert.equal(f.render().createAttempt.current, null, "A's original key cannot be restored");
});

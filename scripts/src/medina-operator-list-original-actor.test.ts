import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const sourceRef = process.argv.find((arg) => arg.startsWith("--source-ref="))?.slice("--source-ref=".length);
if (sourceRef !== undefined) {
  assert.match(sourceRef, /^[0-9a-f]{40}$/i, "Baseline must be a full local commit SHA");
  assert.equal(execFileSync("git", ["cat-file", "-t", sourceRef], { cwd: root, encoding: "utf8" }).trim(), "commit");
}
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Renderer = {
  hooks: Record<string, unknown>;
  mount(value: Child): void;
  update(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  writes(): number;
  dispose(): void;
};

function compile(source: string, filename: string) {
  const transform: import("typescript").TransformerFactory<import("typescript").SourceFile> = (context) => {
    const visit: import("typescript").Visitor = (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression))
        return context.factory.createObjectLiteralExpression();
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
  };
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [transform] } });
  assert.equal(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return result.outputText;
}

const workdayContractFile = "lib/crm/operator-workday-contracts.ts";
const workdayContracts = {} as { parseOperatorWorkday(value: unknown, expectedOffset: number): unknown };
new Script(compile(await readFile(path.join(root, workdayContractFile), "utf8"), workdayContractFile),
  { filename: workdayContractFile }).runInNewContext({ exports: workdayContracts });

// Reuse only the reconciled hook renderer, not its tests or mocked transport.
// Actual components, operatorApi, crmFetch, serverAuth and sign-out fencing run
// in a VM with synthetic SDK/fetch/storage. No browser, app env, server or DB runs.
// Optional --source-ref=<full local SHA> loads baseline code in memory only.
const helperFile = "scripts/src/medina-operator-composed-denial.test.ts";
const helperText = await readFile(path.join(root, helperFile), "utf8");
const helperAst = ts.createSourceFile(helperFile, helperText, ts.ScriptTarget.Latest, true);
const helpers = ["jsx", "Fragment", "icons", "isElement", "elements", "text", "sameDependencies", "hookDriver", "renderer", "eventTarget"]
  .map((name) => {
    const nodes = helperAst.statements.filter((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === name));
    assert.equal(nodes.length, 1, `reuse renderer helper ${name}`);
    return nodes[0]!.getText(helperAst);
  }).join("\n");
const { renderer, jsx, eventTarget, icons } = new Function("assert", compile(helpers, helperFile)
  + "\nreturn { renderer, jsx, eventTarget, icons };")(assert) as {
  renderer(): Renderer;
  jsx(type: unknown, props: Props, key?: unknown): Element;
  eventTarget(): object;
  icons: Record<string, symbol>;
};

const files = {
  leads: "artifacts/negis/src/components/operators/OperatorLeads.tsx",
  booking: "artifacts/negis/src/components/operators/OperatorBookingForm.tsx",
  catalog: "artifacts/negis/src/components/operators/OperatorServiceCatalog.tsx",
  requests: "artifacts/negis/src/components/operators/OperatorRequests.tsx",
  arrivals: "artifacts/negis/src/components/operators/OperatorArrivals.tsx",
  directory: "artifacts/negis/src/components/admin/ClinicOperators.tsx",
  workday: "artifacts/negis/src/components/operators/OperatorWorkday.tsx",
  api: "artifacts/negis/src/lib/operatorApi.ts",
  crm: "artifacts/negis/src/lib/api.ts",
  auth: "artifacts/negis/src/lib/serverAuth.ts",
  signout: "artifacts/negis/src/lib/authSignOut.ts",
  attempts: "artifacts/negis/src/lib/operatorBookingAttempt.ts",
  contracts: "lib/crm/operator-contracts.ts",
};
const sources: Record<string, string> = {};
const prefixComponents: Record<string, string> = {
  requests: "OperatorRequests", arrivals: "OperatorArrivals", directory: "ClinicOperators", workday: "OperatorWorkday",
};
for (const [key, filename] of Object.entries(files)) {
  let source = sourceRef === undefined ? await readFile(path.join(root, filename), "utf8")
    : execFileSync("git", ["show", `${sourceRef}:${filename}`], { cwd: root, encoding: "utf8" });
  if (Object.hasOwn(prefixComponents, key) && key !== "workday") {
    // These views use the actual component prefix through its
    // list hook, with a narrow observer instead of unrelated mutation forms.
    // This proves their call binding/transport, not their complete rendered UI.
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find((node): node is import("typescript").FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === prefixComponents[key]);
    assert.ok(component?.body);
    const index = component.body.statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl =>
      ts.isCallExpression(decl.initializer!) && decl.initializer.expression.getText(ast) === "useOperatorList"));
    assert.ok(index >= 0, "Execute the actual current list call");
    const prefix = component.body.statements.slice(0, index + 1).map(node => node.getText(ast)).join("\n");
    source = `import { useOperatorList } from "@/lib/operatorApi";\n${source.slice(component.getStart(ast), component.body.getStart(ast) + 1)}\n${prefix}\nreturn <pre>{list.data ? JSON.stringify(list.data) : list.error}</pre>; }`;
  }
  sources[key] = compile(source, filename);
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
type Target = "leads" | "staff" | "catalog" | "requests" | "arrivals" | "directory" | "workday";
type Init = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
type Intent = { url: string; init: Init };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
type Pending = {
  url: string;
  init: RequestInit;
  jsonReads: number;
  respond(data: unknown, status?: number): void;
};

async function fixture(t: TestContext, target: Target, guarded = true, actorId = A) {
  const render = renderer();
  t.after(() => render.dispose());
  const modules = new Map<string, Record<string, unknown>>();
  const intents: Intent[] = [];
  const requests: Pending[] = [];
  const lookups: Array<{ release(): void }> = [];
  const storage = new Map<string, string>();
  let actor = A, token = `synthetic-${A}`, delayed = target !== "staff", denied = 0;
  let lifetime = { current: true };
  const globals = {
    Error, AbortController, DOMException, Headers, Response, crypto: { randomUUID },
    window: { ...eventTarget(), sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    }, localStorage: { getItem: () => null } },
    document: { ...eventTarget(), visibilityState: "visible" },
    fetch(url: string, init: RequestInit) {
      assert.equal(init.method, "GET", "Selection regressions must never write");
      if (target === "workday") {
        assert.equal(url, "/api/crm/operator-workday?offset=0", "Workday must read the complete summary, not an inbox page");
        assert.equal(init.cache, "no-store");
      }
      const response = deferred<unknown>();
      const pending: Pending = { url, init, jsonReads: 0, respond(data, status = 200) {
        response.resolve({ ok: status >= 200 && status < 300, status,
          async json() { pending.jsonReads++; return await data; } });
      } };
      requests.push(pending);
      // Deliver even after abort: publication must not trust cancellation alone.
      return response.promise;
    },
  };
  const links: Record<string, string> = {
    "@/lib/operatorApi": "api", "@/lib/serverAuth": "auth", "@/lib/authSignOut": "signout",
    "@/lib/operatorBookingAttempt": "attempts", "./OperatorBookingForm": "booking", "./OperatorServiceCatalog": "catalog",
  };
  function load(key: string): Record<string, unknown> {
    if (modules.has(key)) return modules.get(key)!;
    const exports = {};
    modules.set(key, exports);
    new Script(sources[key]!, { filename: key }).runInNewContext({ ...globals, exports, require(name: string): unknown {
      if (name === "react") return render.hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
      if (name === "lucide-react") return icons;
      if (name.endsWith("/crm/operator-contracts")) return load("contracts");
      if (name.endsWith("/crm/operator-workday-contracts")) return workdayContracts;
      // Workday's independent search child has its own lifetime suite; this
      // target still exercises the complete parent read and actual transports.
      if (key === "workday" && name === "./OperatorLeadExplorer") return { OperatorLeadExplorer: Symbol("OperatorLeadExplorerBoundary") };
      if (key === "workday" && name === "./OperatorWorkday.css") return {};
      if (name === "@/lib/api") {
        const crm = load("crm") as { crmFetch(url: string, init: Init): Promise<Response> };
        return { ...crm, crmFetch(url: string, init: Init) {
          intents.push({ url, init });
          return crm.crmFetch(url, init);
        } };
      }
      if (name === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: { auth: {
        async getSession() {
          if (delayed) {
            const gate = deferred<void>();
            lookups.push({ release: () => gate.resolve() });
            await gate.promise;
          }
          return { data: { session: { user: { id: actor }, access_token: token } }, error: null };
        },
      } } };
      if (links[name]) return load(links[name]!);
      assert.fail(`Unexpected external dependency: ${name}`);
    } });
    return exports;
  }
  const Component = target === "leads" ? load("leads").OperatorLeads : target === "staff"
    ? load("booking").OperatorBookingForm : target === "catalog" ? load("catalog").OperatorServiceCatalog
      : load(target)[prefixComponents[target]!];
  function props(actorId: string): Props {
    const captured = lifetime;
    return { actorId, requestId: REQUEST, leadId: LEAD, leadScope: "assigned",
      ...(target === "directory" ? { workspaceId: REQUEST } : {}),
      ...(guarded ? { isSessionCurrent: () => captured.current }
        : target === "workday" ? { isSessionCurrent: () => true } : {}),
      onAccessDenied: () => { denied++; }, onBooked: () => assert.fail("Read-only fixture must not book") };
  }
  render.mount(jsx(Component, props(actorId)));
  await render.flush();
  async function context() {
    const pending = requests.at(-1)!;
    assert.match(pending.url, /operator-bookings\?/);
    delayed = true;
    pending.respond({ success: true, data: { timeZone: "Asia/Almaty" } });
    await render.flush();
  }
  if (target === "staff") await context();
  function release() {
    const lookup = lookups.shift();
    assert.ok(lookup, "A real SDK lookup must be paused");
    lookup.release();
  }
  return { render, requests, intents, release, denied: () => denied,
    listIntent: () => intents.at(-1)!,
    async dispatch() { release(); await render.flush(); return requests.at(-1)!; },
    rawActor(id: string, expire = true) {
      if (expire) lifetime.current = false;
      actor = id; token = `synthetic-${id}`;
    },
    rotateToken() { token = "synthetic-rotated-A"; },
    restoreLifetime() { lifetime.current = true; },
    async denyWithNewGuard() {
      render.update(jsx(Component, { ...props(A), isSessionCurrent: () => false }));
      await render.flush();
    },
    async replace(id: string) {
      lifetime.current = false;
      lifetime = { current: true };
      actor = id; token = `synthetic-${id}`;
      delayed = target !== "staff";
      render.update(jsx(Component, props(id)));
      await render.flush();
      if (target === "staff") await context();
    },
  };
}

function workdayRows(marker: string) {
  const data = {
    generatedAt: "2026-10-28T07:00:00.000Z", offset: 0,
    companies: [{ requestId: REQUEST, displayName: marker, leadScope: "assigned", timeZone: "UTC",
      localDate: "2026-10-28", dayStart: "2026-10-28T00:00:00.000Z", dayEnd: "2026-10-29T00:00:00.000Z" }],
    summary: { availableLeads: "3", assignedLeads: "2", clinicLeads: "1", attributedBookings: "1",
      clinicConfirmedArrivals: "0", undatedBookings: "0", contacts: "not_tracked",
      bookingStatuses: { scheduled: "1", confirmed: "0", arrived: "0", no_show: "0", cancelled: "0", unknown: "0" } },
    today: { state: "ready", total: "1", actionable: "1", hasMore: false, items: [{
      appointmentId: LEAD, requestId: REQUEST, startsAt: "2026-10-28T08:00:00.000Z", endsAt: "2026-10-28T08:30:00.000Z",
      status: "scheduled", clientName: marker, clientPhone: "+70000000000", service: "Synthetic service",
      doctorName: "Synthetic doctor", clinicConfirmedAt: null, operatorCheckResult: null,
    }] },
  };
  assert.ok(workdayContracts.parseOperatorWorkday(data, 0), "Workday actor proofs require a valid complete report");
  return { success: true, data };
}

const rows = (target: Target, marker: string) => target === "workday" ? workdayRows(marker) : ({ success: true, data: {
  items: [{ id: LEAD, name: marker, ...(target === "leads" ? { phone: marker, status: "new" } : { specialty: "Synthetic" }) }],
  hasMore: true, stageEditingAvailable: false,
} });

for (const target of ["leads", "staff", "catalog", "requests", "arrivals", "directory", "workday"] as const) {
  test(`${target}: capture original actor and lifetime before SDK lookup; same-actor rotation still dispatches`, async (t) => {
    const ui = await fixture(t, target);
    const intent = ui.listIntent();
    assert.equal(intent.init.expectedUserId, A);
    assert.equal(typeof intent.init.dispatchGuard, "function");
    assert.equal(intent.init.dispatchGuard!(), true);
    ui.rotateToken();
    const pending = await ui.dispatch();
    assert.equal(new Headers(pending.init.headers).get("Authorization"), "Bearer synthetic-rotated-A");
    assert.equal(Object.hasOwn(pending.init, "expectedUserId"), false);
    assert.equal(Object.hasOwn(pending.init, "dispatchGuard"), false);
    pending.respond(rows(target, "CURRENT_A")); await ui.render.flush();
    assert.ok(ui.render.content().includes("CURRENT_A"));
  });

  for (const transition of ["B", "A-B-A", "same-actor-expiry"] as const) {
    test(`${target}: queued lookup after ${transition} never dispatches or publishes under the retired lifetime`, async (t) => {
      const ui = await fixture(t, target);
      const count = ui.requests.length;
      ui.rawActor(transition === "same-actor-expiry" ? A : B);
      if (transition === "A-B-A") ui.rawActor(A);
      ui.release(); await ui.render.flush();
      for (const pending of ui.requests.slice(count)) pending.respond(rows(target, "RETIRED_ROWS"));
      await ui.render.flush();
      assert.equal(ui.requests.length, count, "An expired lookup cannot cross fetch, even if A has returned");
      assert.equal(ui.render.content().includes("RETIRED_ROWS"), false);
      assert.equal(ui.denied(), 0, "An expired read cannot deny a replacement view");
    });
  }

  test(`${target}: explicit A actor refuses silent B even without a parent lifetime event`, async (t) => {
    const ui = await fixture(t, target, false);
    const count = ui.requests.length;
    ui.rawActor(B, false); ui.release(); await ui.render.flush();
    assert.equal(ui.requests.length, count, "No fallback to the replacement session is permitted");
  });

  test(`${target}: observing expiry latches the old lifetime even if its callback later returns true`, async (t) => {
    const ui = await fixture(t, target);
    const guard = ui.listIntent().init.dispatchGuard;
    assert.equal(typeof guard, "function");
    const count = ui.requests.length;
    ui.rawActor(B); assert.equal(guard!(), false);
    ui.rawActor(A); ui.restoreLifetime();
    assert.equal(guard!(), false);
    ui.release(); await ui.render.flush();
    assert.equal(ui.requests.length, count);
  });

  for (const outcome of ["success", "403"] as const) {
    test(`${target}: dispatched late ${outcome} cannot publish after raw A-B-A expiry`, async (t) => {
      const ui = await fixture(t, target);
      const pending = await ui.dispatch();
      const writes = ui.render.writes();
      ui.rawActor(B); ui.rawActor(A);
      pending.respond(outcome === "success" ? rows(target, "OBSOLETE_A") : { success: false }, outcome === "success" ? 200 : 403);
      await ui.render.flush();
      assert.equal(ui.render.writes(), writes);
      assert.equal(ui.render.content().includes("OBSOLETE_A"), false);
      assert.equal(ui.denied(), 0);
      if (outcome === "403") assert.equal(pending.jsonReads, 0);
    });
  }

  test(`${target}: deferred old A body cannot overwrite replacement A after rendered A-B-A`, async (t) => {
    const ui = await fixture(t, target);
    const old = await ui.dispatch();
    const body = deferred<unknown>();
    old.respond(body.promise); await ui.render.flush();
    await ui.replace(B);
    const b = await ui.dispatch(); b.respond(rows(target, "CURRENT_B")); await ui.render.flush();
    await ui.replace(A);
    const current = await ui.dispatch(); current.respond(rows(target, "REPLACEMENT_A")); await ui.render.flush();
    assert.ok(ui.render.content().includes("REPLACEMENT_A"));
    const writes = ui.render.writes(), count = ui.requests.length;
    body.resolve(rows(target, "OBSOLETE_BODY")); await ui.render.flush();
    assert.equal(ui.render.writes(), writes);
    assert.equal(ui.requests.length, count);
    assert.ok(ui.render.content().includes("REPLACEMENT_A"));
    assert.equal(ui.render.content().includes("OBSOLETE_BODY"), false);
  });

  test(`${target}: current 403 headers still revoke without waiting for a body`, async (t) => {
    const ui = await fixture(t, target);
    const pending = await ui.dispatch();
    pending.respond(deferred<unknown>().promise, 403); await ui.render.flush();
    assert.equal(pending.jsonReads, 0);
      assert.equal(ui.denied(), target === "directory" ? 0 : 1, "Directory exposes a list refusal, not an operator-profile denial callback");
    assert.equal(ui.render.nodes().some((node) => node.type === "select"), false);
  });
}

test("owned lead selection with no original actor cannot fall back to an unowned SDK lookup", async (t) => {
  const ui = await fixture(t, "leads", true, "");
  assert.equal(ui.intents.length, 0);
  assert.equal(ui.requests.length, 0);
});

test("same-actor lead read honors a new live denial guard even when the original callback still returns true", async (t) => {
  const ui = await fixture(t, "leads");
  const count = ui.requests.length;
  await ui.denyWithNewGuard();
  ui.release(); await ui.render.flush();
  assert.equal(ui.requests.length, count);
  assert.equal(ui.denied(), 0);
});

for (const target of ["staff", "catalog"] as const) {
  test(`${target}: nested service selection carries the original actor and retired lifetime through SDK lookup`, async (t) => {
    const ui = await fixture(t, target);
    const doctors = await ui.dispatch();
    doctors.respond(rows(target, "CURRENT_DOCTOR")); await ui.render.flush();
    const select = ui.render.nodes().find((node) => node.type === "select");
    assert.ok(select);
    (select.props.onChange as (event: unknown) => void)({ target: { value: LEAD } });
    await ui.render.flush();
    const nested = ui.listIntent();
    assert.match(nested.url, /doctorId=/);
    assert.equal(nested.init.expectedUserId, A);
    assert.equal(nested.init.dispatchGuard?.(), true);
    const count = ui.requests.length;
    ui.rawActor(B); ui.rawActor(A);
    ui.release(); await ui.render.flush();
    assert.equal(ui.requests.length, count);
  });
}

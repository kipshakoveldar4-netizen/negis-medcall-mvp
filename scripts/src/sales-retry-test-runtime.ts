import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Values = Record<string, unknown>;
type Effect = () => void | (() => void);
type Slot = { kind: string; value?: unknown; deps?: readonly unknown[]; set?: (value: unknown) => void;
  create?: Effect; cleanup?: () => void; pending?: boolean };
type View = {
  items: Array<{ id: string; status: string }>;
  loaded: boolean; loadError: boolean; form: Record<string, string>; formOpen: boolean; saving: boolean;
  unconfirmedCreate: boolean; editingId: string | null;
  restoreError: string;
  openAdd(): void; setForm(value: Record<string, string>): void; submitForm(): void;
  openEdit(deal: unknown): void; closeSaleForm(): void;
  retrySaleRecovery(): void;
};
type Request = { path: string; method: "GET" | "POST"; headers: Record<string, string>; body: Values };
type AuthListener = (event: string, session: { user: { id: string } } | null) => void;
const exposed = ["items", "loaded", "loadError", "form", "formOpen", "saving", "openAdd", "setForm", "submitForm",
  "unconfirmedCreate", "editingId", "openEdit", "closeSaleForm", "restoreError", "retrySaleRecovery"];

export type SalesRetryRuntimeOptions = {
  actorId?: string;
  sessionStored?: Map<string, string>;
  localStored?: Map<string, string>;
  storageMode?: "denied" | "no-readback";
  sessionGetItem?: (key: string) => string | null;
  randomUUID?: () => string;
  getAccessToken?: (expectedUserId?: string) => Promise<string>;
  hasSupabaseFrontendEnv?: boolean;
};

function compile(source: string, fileName: string, page = false) {
  let observed = 0;
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        if (page && ts.isFunctionDeclaration(node) && node.name?.text === "SalesPage" && node.body) {
          const returned = node.body.statements.filter(ts.isReturnStatement);
          assert.equal(returned.length, 1, "observe only SalesPage's final JSX return");
          observed++;
          // Expose the real closures; all page operations and hook calls remain intact.
          return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body,
              node.body.statements.map(statement => statement === returned[0]
                ? ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(
                  exposed.map(name => ts.factory.createShorthandPropertyAssignment(name)))) : statement)));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.equal(observed, page ? 1 : 0);
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}

const compiled = Promise.all([
  ["api", "artifacts/negis/src/lib/api.ts"],
  ["storage", "artifacts/negis/src/lib/demoStorage.ts"],
  ["attempt", "artifacts/negis/src/lib/salesCreateAttempt.ts"],
  ["page", "artifacts/negis/src/pages/SalesPage.tsx"],
].map(async ([key, file]) => [key, compile(await readFile(path.join(root, file), "utf8"), file, key === "page")]));

// Deliberately limited to SalesPage and its inline collection hook, not a DOM renderer.
export async function createSalesRetryRuntime(workspaceId: string,
  deals: (method: "GET" | "POST", body: Values) => Promise<Response>, options: SalesRetryRuntimeOptions = {}) {
  const code = Object.fromEntries(await compiled) as Record<string, string>;
  const slots: Slot[] = [];
  const pending = new Set<Promise<Response>>();
  const unexpected: unknown[] = [];
  const calls: Request[] = [];
  const toasts: Array<{ kind: string; message: string }> = [];
  const stored = options.localStored ?? new Map([["negis_workspace_selector", workspaceId]]);
  const sessionStored = options.sessionStored ?? new Map<string, string>();
  const tokenLookups: Array<string | undefined> = [];
  const authListeners = new Set<AuthListener>();
  let actorId = options.actorId ?? "00000000-0000-4000-8000-000000000090";
  let selectedWorkspaceId = workspaceId;
  let cursor = 0, dirty = true, alive = true;
  let view: View;
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) => Boolean(a && b && a.length === b.length
    && a.every((value, index) => Object.is(value, b[index])));
  function slot(kind: string, create: () => Slot) {
    const current = slots[cursor++] ??= create();
    assert.equal(current.kind, kind, "real page/hook order must stay stable");
    return current;
  }
  const hooks = {
    useState(initial: unknown) {
      const state = slot("state", () => {
        const item: Slot = { kind: "state", value: typeof initial === "function" ? initial() : initial };
        item.set = update => {
          if (!alive) { unexpected.push(new Error("state write after disposal")); return; }
          const next = typeof update === "function" ? update(item.value) : update;
          if (!Object.is(next, item.value)) { item.value = next; dirty = true; }
        };
        return item;
      });
      return [state.value, state.set];
    },
    useRef(initial: unknown) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo(create: () => unknown, deps?: readonly unknown[]) {
      const item = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDeps(item.deps, deps)) { item.value = create(); item.deps = deps; }
      return item.value;
    },
    useEffect(create: Effect, deps?: readonly unknown[]) {
      const item = slot("effect", () => ({ kind: "effect", pending: true, create, deps }));
      if (!sameDeps(item.deps, deps)) item.pending = true;
      item.create = create; item.deps = deps;
    },
    useLayoutEffect(create: Effect, deps?: readonly unknown[]) {
      const item = slot("layout", () => ({ kind: "layout", pending: true, create, deps }));
      if (!sameDeps(item.deps, deps)) item.pending = true;
      item.create = create; item.deps = deps;
    },
  };
  function transport(raw: string, init: RequestInit = {}): Promise<Response> {
    let request: Request;
    let reference: string | undefined;
    try {
      assert.ok(raw.startsWith("/api/crm/"), "no external client transport");
      const url = new URL(raw, "https://sales-fixture.invalid");
      assert.equal(url.origin, "https://sales-fixture.invalid");
      assert.equal(url.searchParams.get("workspaceId"), selectedWorkspaceId);
      assert.deepEqual([...url.searchParams.keys()], ["workspaceId"]);
      const method = init.method ?? "GET";
      assert.ok(method === "GET" || method === "POST");
      const headers = Object.fromEntries(new Headers(init.headers));
      assert.equal(headers.authorization, "Bearer fixture.test.signature", "actual crmFetch must attach the synthetic token");
      reference = ({ "/api/crm/clients": "clients", "/api/crm/leads": "leads", "/api/crm/appointments": "appointments",
        "/api/crm/meta-launches": "launches", "/api/crm/clinic-services": "services" } as Record<string, string>)[url.pathname];
      assert.ok(url.pathname === "/api/crm/deals" || (method === "GET" && reference), "only deals and readonly reference GETs");
      assert.equal(init.body === undefined, method === "GET");
      request = { path: url.pathname, method, headers, body: init.body ? JSON.parse(String(init.body)) as Values : {} };
      calls.push(request);
    } catch (error) {
      unexpected.push(error);
      return Promise.reject(error);
    }
    const task = request.path === "/api/crm/deals" ? deals(request.method, request.body)
      : Promise.resolve(Response.json({ success: true, mode: "supabase", data: { [reference!]: [] } }));
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  const listeners = new Map<string, Set<unknown>>();
  const window = { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  }, sessionStorage: {
    getItem: (key: string) => {
      if (options.storageMode === "denied") throw new Error("synthetic storage denial");
      if (options.sessionGetItem) return options.sessionGetItem(key);
      return options.storageMode === "no-readback" ? null : sessionStored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.storageMode === "denied") throw new Error("synthetic storage denial");
      sessionStored.set(key, value);
    },
    removeItem: (key: string) => { sessionStored.delete(key); },
  },
    addEventListener: (name: string, listener: unknown) => {
      const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
    },
    removeEventListener: (name: string, listener: unknown) => { listeners.get(name)?.delete(listener); },
  };
  const toast = Object.fromEntries(["success", "error"].map(kind => [kind, (message: string) => toasts.push({ kind, message })]));
  function evaluate(source: string, imports: Record<string, unknown>) {
    const exports: Record<string, unknown> = {};
    const fixtureCrypto = { randomUUID: options.randomUUID ?? randomUUID };
    new Script(source).runInNewContext({ exports, window, crypto: fixtureCrypto, fetch: transport, Headers, Response, DOMException, Error,
      require(name: string) {
        assert.ok(Object.hasOwn(imports, name), `unexpected VM import: ${name}`);
        return imports[name];
      },
    });
    return exports;
  }
  const api = evaluate(code.api, { "@/lib/serverAuth": { getSupabaseAccessToken: async (expected?: string) => {
    tokenLookups.push(expected);
    if (options.getAccessToken) return options.getAccessToken(expected);
    return !expected || expected === actorId ? "fixture.test.signature" : "";
  } } });
  const storage = evaluate(code.storage, { react: hooks, sonner: { toast }, "@/lib/api": api });
  const attempt = evaluate(code.attempt, {});
  const decorations = new Proxy({}, { get: (_object, key) => String(key) });
  const sessionAuth = { onAuthStateChange(listener: AuthListener) {
    authListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => { authListeners.delete(listener); } } } };
  } };
  const page = evaluate(code.page, {
    react: hooks, sonner: { toast }, wouter: { Link: "Link" }, "lucide-react": decorations,
    "@/components/layout/PageLayout": decorations, "@/components/ui/metric-card": decorations,
    "@/lib/api": api, "@/lib/demoStorage": storage,
    "@/lib/salesCreateAttempt": attempt,
    "@/lib/supabase": { hasSupabaseFrontendEnv: options.hasSupabaseFrontendEnv ?? true, supabase: { auth: sessionAuth }, sessionAuth },
    "@/contexts/AuthContext": { useAuth: () => ({ user: actorId ? { id: actorId } : null, clinicId: selectedWorkspaceId }) },
    "react/jsx-runtime": { jsx: () => assert.fail("final JSX must be observation-only"), jsxs: () => assert.fail("unexpected JSX") },
  }).default as () => View;
  function render() {
    if (!dirty || !alive) return;
    cursor = 0; dirty = false; view = page();
    for (const kind of ["layout", "effect"]) {
      const effects = slots.filter(item => item.kind === kind && item.pending);
      for (const item of effects) item.cleanup?.();
      for (const item of effects) { item.pending = false; item.cleanup = item.create!() || undefined; }
    }
  }
  async function settle() {
    for (let pass = 0; pass < 50; pass++) {
      render();
      await tick();
      await Promise.allSettled([...pending]);
      await tick();
      assert.deepEqual(unexpected, [], "no unapproved transport or lifecycle activity");
      if ((!alive || !dirty) && !pending.size) return;
    }
    assert.fail("SalesPage runtime did not settle");
  }
  function dispose() {
    slots.forEach(item => item.cleanup?.());
    alive = false;
  }
  try { await settle(); } catch (error) { dispose(); throw error; }
  return { calls, toasts, stored, sessionStored, tokenLookups, listeners, authListeners, render, settle, dispose,
    emitSdkActor(nextActorId: string | null, event = nextActorId ? "SIGNED_IN" : "SIGNED_OUT") {
      for (const listener of [...authListeners]) listener(event, nextActorId ? { user: { id: nextActorId } } : null);
    },
    setScope(nextActorId: string, nextWorkspaceId = selectedWorkspaceId) {
      actorId = nextActorId; selectedWorkspaceId = nextWorkspaceId;
      stored.set("negis_workspace_selector", nextWorkspaceId); dirty = true; render();
    },
    get view() { return view; } };
}

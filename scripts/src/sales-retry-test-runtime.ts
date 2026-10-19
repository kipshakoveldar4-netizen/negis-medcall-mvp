import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
  openAdd(): void; setForm(value: Record<string, string>): void; submitForm(): void;
};
type Request = { path: string; method: "GET" | "POST"; headers: Record<string, string>; body: Values };
const exposed = ["items", "loaded", "loadError", "form", "formOpen", "saving", "openAdd", "setForm", "submitForm"];

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
  ["page", "artifacts/negis/src/pages/SalesPage.tsx"],
].map(async ([key, file]) => [key, compile(await readFile(path.join(root, file), "utf8"), file, key === "page")]));

// Deliberately limited to SalesPage and its inline collection hook, not a DOM renderer.
export async function createSalesRetryRuntime(workspaceId: string,
  deals: (method: "GET" | "POST", body: Values) => Promise<Response>) {
  const code = Object.fromEntries(await compiled) as Record<string, string>;
  const slots: Slot[] = [];
  const pending = new Set<Promise<Response>>();
  const unexpected: unknown[] = [];
  const calls: Request[] = [];
  const toasts: Array<{ kind: string; message: string }> = [];
  const stored = new Map([["negis_workspace_selector", workspaceId]]);
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
  };
  function transport(raw: string, init: RequestInit = {}): Promise<Response> {
    let request: Request;
    let reference: string | undefined;
    try {
      assert.ok(raw.startsWith("/api/crm/"), "no external client transport");
      const url = new URL(raw, "https://sales-fixture.invalid");
      assert.equal(url.origin, "https://sales-fixture.invalid");
      assert.equal(url.searchParams.get("workspaceId"), workspaceId);
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
  const window = { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  } };
  const toast = Object.fromEntries(["success", "error"].map(kind => [kind, (message: string) => toasts.push({ kind, message })]));
  function evaluate(source: string, imports: Record<string, unknown>) {
    const exports: Record<string, unknown> = {};
    new Script(source).runInNewContext({ exports, window, fetch: transport, Headers, Response, DOMException, Error,
      require(name: string) {
        assert.ok(Object.hasOwn(imports, name), `unexpected VM import: ${name}`);
        return imports[name];
      },
    });
    return exports;
  }
  const api = evaluate(code.api, { "@/lib/serverAuth": { getSupabaseAccessToken: async () => "fixture.test.signature" } });
  const storage = evaluate(code.storage, { react: hooks, sonner: { toast }, "@/lib/api": api });
  const decorations = new Proxy({}, { get: (_object, key) => String(key) });
  const page = evaluate(code.page, {
    react: hooks, sonner: { toast }, wouter: { Link: "Link" }, "lucide-react": decorations,
    "@/components/layout/PageLayout": decorations, "@/components/ui/metric-card": decorations,
    "@/lib/api": api, "@/lib/demoStorage": storage,
    "react/jsx-runtime": { jsx: () => assert.fail("final JSX must be observation-only"), jsxs: () => assert.fail("unexpected JSX") },
  }).default as () => View;
  function render() {
    if (!dirty || !alive) return;
    cursor = 0; dirty = false; view = page();
    const effects = slots.filter(item => item.kind === "effect" && item.pending);
    for (const item of effects) item.cleanup?.();
    for (const item of effects) { item.pending = false; item.cleanup = item.create!() || undefined; }
  }
  async function settle() {
    for (let pass = 0; pass < 50; pass++) {
      render();
      await tick();
      await Promise.allSettled([...pending]);
      await tick();
      assert.deepEqual(unexpected, [], "no unapproved transport or lifecycle activity");
      if (!dirty && !pending.size) return;
    }
    assert.fail("SalesPage runtime did not settle");
  }
  function dispose() {
    slots.forEach(item => item.cleanup?.());
    alive = false;
  }
  try { await settle(); } catch (error) { dispose(); throw error; }
  return { calls, toasts, stored, render, settle, dispose, get view() { return view; } };
}

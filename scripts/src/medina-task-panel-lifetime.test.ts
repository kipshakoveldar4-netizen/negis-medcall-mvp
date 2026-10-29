import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Whole actual TaskPanel, api.ts, serverAuth.ts and authSignOut.ts. Only hook
// scheduling, Auth context, SDK session/events, storage and HTTP are fakes.
// Native Response/stream decoding is real; this is not browser/concurrent React QA.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-task-panel-lifetime.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-task-panel-lifetime.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const file = "artifacts/negis/src/components/crm/task-panel.tsx";
const baseline = process.argv.includes("--baseline");
const source = baseline ? execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, file), "utf8");
type Json = Record<string, any>;
type Element = { type: unknown; props: Json };
function compile(source: string, name: string) {
  const output = ts.transpileModule(source, { fileName: name, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [context => {
      const visit: import("typescript").Visitor = node => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(output.diagnostics ?? [], [], name);
  return output.outputText;
}
const codes: Record<string, string> = { panel: compile(source, file) };
for (const name of ["api", "serverAuth", "authSignOut"]) {
  codes[name] = compile(await readFile(path.join(root, `artifacts/negis/src/lib/${name}.ts`), "utf8"), `${name}.ts`);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(value: any): Element[] {
  return Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : [];
}
function text(value: any): string {
  return Array.isArray(value) ? value.map(text).join(" ") : value?.props ? text(value.props.children)
    : typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function driver() {
  const slots: Json[] = [];
  let index = 0, dirty = true, mounted = true, rendering = false, count: number | undefined;
  let view: any, render!: () => any, writes = 0, late = 0;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function slot(kind: string, create: () => Json) {
    assert.ok(rendering); const at = index++;
    slots[at] ??= { kind, ...create() }; assert.equal(slots[at].kind, kind); return slots[at];
  }
  function effect(kind: string, create: () => unknown, deps?: unknown[]) {
    const s = slot(kind, () => ({ pending: true }));
    if (!same(s.deps, deps)) s.pending = true;
    s.create = create; s.deps = deps;
  }
  function memo(create: () => unknown, deps?: unknown[]) {
    const s = slot("memo", () => ({ initialized: false }));
    if (!s.initialized || !same(s.deps, deps)) { s.value = create(); s.deps = deps; s.initialized = true; }
    return s.value;
  }
  const hooks = {
    useState(initial: any) {
      const s = slot("state", () => ({ value: typeof initial === "function" ? initial() : initial }));
      s.set ??= (update: any) => { writes++; if (!mounted) { late++; return; }
        const next = typeof update === "function" ? update(s.value) : update;
        if (!Object.is(next, s.value)) { s.value = next; dirty = true; }
      };
      return [s.value, s.set];
    },
    useRef(value: any) { return slot("ref", () => ({ value: { current: value } })).value; },
    useMemo: memo, useCallback: (value: unknown, deps: unknown[]) => memo(() => value, deps),
    useEffect: (create: () => unknown, deps?: unknown[]) => effect("effect", create, deps),
    useLayoutEffect: (create: () => unknown, deps?: unknown[]) => effect("layout", create, deps),
  };
  function commit() {
    if (!dirty || !mounted) return;
    dirty = false; index = 0; rendering = true;
    try { view = render(); } finally { rendering = false; }
    count ??= index; assert.equal(index, count, "Stable actual component hook order");
    for (const kind of ["layout", "effect"]) {
      const pending = slots.filter(s => s.kind === kind && s.pending);
      for (const s of pending) s.cleanup?.();
      for (const s of pending) { s.pending = false; s.cleanup = s.create(); }
    }
  }
  return { hooks, mount(fn: () => any) { render = fn; }, invalidate() { dirty = true; },
    async flush() { for (let i = 0; i < 10; i++) { commit(); await tick(); } assert.equal(dirty, false); },
    nodes: () => nodes(view), text: () => text(view), writes: () => writes, late: () => late,
    dispose() { if (!mounted) return; mounted = false; view = null; for (const s of slots) if (["layout", "effect"].includes(s.kind)) s.cleanup?.(); },
  };
}
type Call = { url: string; init: RequestInit; taken: boolean; response: ReturnType<typeof deferred<Response>> };
const bounded = { timeout: 5000 };
const TASK = { id: "synthetic-task-A", title: "Original task", owner: "Synthetic owner", deadline: "", priority: "medium", status: "new" };
async function fixture(t: TestContext, patch: Json = {}) {
  const d = driver(), calls: Call[] = [], notices: Array<{ kind: string; message: string }> = [];
  let workspace = "synthetic-workspace-A";
  let auth: Json = { user: { id: "synthetic-actor-A" }, clinicId: workspace, userRole: "owner", rolePermissions: { tasks: true },
    isSigningOut: false, isImpersonation: false, isDemoMode: false, isLoading: false };
  let props = { entityType: "lead", entityId: "synthetic-lead-A", clientId: "synthetic-client-A", ...patch };
  let session = { user: { id: auth.user.id }, access_token: "synthetic-token-A" };
  let gate: ReturnType<typeof deferred<any>> | null = null;
  const subscribers = new Set<(event: string, session: any) => void>();
  const storage = new Map<string, string>();
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const sdk = { hasSupabaseFrontendEnv: true,
    get sessionAuth() { return { onAuthStateChange: this.supabase.auth.onAuthStateChange }; }, supabase: { auth: {
    async getSession() { return gate ? gate.promise : { data: { session }, error: null }; },
    onAuthStateChange(callback: (event: string, session: any) => void) {
      subscribers.add(callback); return { data: { subscription: { unsubscribe() { subscribers.delete(callback); } } } };
    },
  } } };
  function evaluate(code: string, imports: Json) {
    const exports: Json = {};
    new Script(code).runInNewContext({ exports, Date, Error, DOMException, AbortController, Headers, Response,
      window: { localStorage: store, sessionStorage: store },
      console: { warn() {} },
      fetch: (url: string, init: RequestInit) => {
        assert.match(url, /^\/api\/crm\/(tasks(?:\?|$)|staff\?)/, "No external/unrelated HTTP");
        const response = deferred<Response>(); calls.push({ url, init, response, taken: false }); return response.promise;
      },
      require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    }, { timeout: 1000 });
    return exports;
  }
  const signOut = evaluate(codes.authSignOut, {});
  const serverAuth = evaluate(codes.serverAuth, { "@/lib/supabase": sdk, "@/lib/authSignOut": signOut });
  const api = evaluate(codes.api, { "@/lib/serverAuth": serverAuth });
  const jsx = (type: unknown, props: Json): Element => ({ type, props });
  const panel = evaluate(codes.panel, { react: d.hooks, "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": { CheckCircle2: "CheckCircle2", ListTodo: "ListTodo", Loader2: "Loader2", Plus: "Plus" },
    sonner: { toast: { success: (message: string) => notices.push({ kind: "success", message }), error: (message: string) => notices.push({ kind: "error", message }) } },
    "@/lib/api": api, "@/lib/serverAuth": serverAuth, "@/lib/supabase": sdk, "@/lib/authSignOut": signOut,
    "@/contexts/AuthContext": { useAuth: () => auth }, "@/lib/demoStorage": { readWorkspaceId: () => workspace },
  });
  d.mount(() => panel.TaskPanel(props));
  const f = {
    d, calls, notices, signOut,
    control(testId: string) { const node = d.nodes().find(n => n.props["data-testid"] === testId); assert.ok(node, testId); return node.props; },
    field(label: string) { const node = d.nodes().find(n => n.props["aria-label"] === label); assert.ok(node, label); return node.props; },
    closeButton() { const node = d.nodes().find(n => n.type === "button" && n.props["aria-label"]?.startsWith("Закрыть задачу:")); assert.ok(node); return node.props; },
    async title(value: string) { f.control("task-title-input").onChange({ target: { value } }); await d.flush(); },
    async fieldValue(label: string, value: string) { f.field(label).onChange({ target: { value } }); await d.flush(); },
    take(method = "GET", part = "/tasks") { const call = calls.find(c => !c.taken && (c.init.method ?? "GET") === method && c.url.includes(part)); assert.ok(call, `${method} ${part}`); call.taken = true; return call; },
    async answer(call: Call, body: unknown, status = 200) { call.response.resolve(Response.json(body, { status })); await d.flush(); },
    async list(items: unknown[] = [TASK], part = "/tasks") { await f.answer(f.take("GET", part), { success: true, data: { tasks: items } }); },
    async ready(items: unknown[] = [TASK]) {
      await f.list(items);
      const staff = calls.find(c => !c.taken && c.url.includes("/staff?"));
      if (staff) { staff.taken = true; await f.answer(staff, { success: true, data: { staff: [
        { id: "synthetic-staff-A", name: "Current staff", status: "active" },
        { id: "synthetic-staff-inactive", name: "Inactive staff", status: "inactive" },
      ] } }); }
    },
    async holdBody(call: Call, body: unknown, status = 200) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const response = new Response(stream, { status, headers: { "content-type": "application/json" } });
      call.response.resolve(response); await d.flush();
      return { response, async release() { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); await d.flush(); } };
    },
    async props(patch: Json) { props = { ...props, ...patch }; d.invalidate(); await d.flush(); },
    async auth(patch: Json) { auth = { ...auth, ...patch }; d.invalidate(); await d.flush(); },
    async workspace(value: string) { workspace = value; auth = { ...auth, clinicId: value }; d.invalidate(); await d.flush(); },
    async sdk(actor: string | null, notify = true, token = "synthetic-token-refreshed") {
      session = actor ? { user: { id: actor }, access_token: token } : null as any;
      if (notify) for (const callback of [...subscribers]) callback("TOKEN_REFRESHED", session);
      await d.flush();
    },
    holdSession() { gate = deferred<any>(); return () => { const held = gate!; gate = null; held.resolve({ data: { session }, error: null }); }; },
    mutations: () => calls.filter(c => ["POST", "PATCH"].includes(c.init.method ?? "")),
    hidden() { assert.equal(d.nodes().some(n => n.props["data-testid"] === "task-create-button"), false); assert.doesNotMatch(d.text(), /Original task|Current staff/); },
  };
  t.after(() => d.dispose()); await d.flush(); return f;
}

test("authorized create and close preserve exact target, staff and ISO deadline", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("  Follow up  ");
  await f.fieldValue("Срок", "2026-11-12T10:30"); await f.fieldValue("Исполнитель", "synthetic-staff-A");
  assert.doesNotMatch(f.d.text(), /Inactive staff/);
  f.control("task-create-button").onClick(); await f.d.flush();
  const post = f.take("POST");
  assert.deepEqual(JSON.parse(String(post.init.body)), { workspaceId: "synthetic-workspace-A", title: "Follow up", status: "new", priority: "medium",
    deadline: new Date("2026-11-12T10:30").toISOString(), assigneeUserId: "synthetic-staff-A", leadId: "synthetic-lead-A", clientId: "synthetic-client-A" });
  assert.equal(new Headers(post.init.headers).get("Authorization"), "Bearer synthetic-token-A");
  await f.answer(post, { success: true }); await f.list();
  assert.equal(f.control("task-title-input").value, ""); assert.equal(f.field("Срок").value, "");
  f.closeButton().onClick(); await f.d.flush(); const patch = f.take("PATCH");
  assert.deepEqual(JSON.parse(String(patch.init.body)), { id: TASK.id, workspaceId: "synthetic-workspace-A", updates: { status: "done" } });
  await f.answer(patch, { success: true }); await f.list([{ ...TASK, status: "done" }]);
  assert.match(f.d.text(), /Закрытые/); assert.equal(f.notices.filter(n => n.kind === "success").length, 1);
});

test("client creation without deadline remains allowed", bounded, async t => {
  const f = await fixture(t, { entityType: "client", entityId: "synthetic-client-B" }); await f.ready([]); await f.title("Client task");
  f.control("task-create-button").onClick(); await f.d.flush(); const body = JSON.parse(String(f.take("POST").init.body));
  assert.equal(body.clientId, "synthetic-client-B"); assert.equal("leadId" in body, false); assert.equal("deadline" in body, false);
});

for (const action of ["create", "close"] as const) {
  test(`${action} uses a synchronous mutex before a second captured click`, bounded, async t => {
    const f = await fixture(t); await f.ready(); await f.title("One task");
    const handler = action === "create" ? f.control("task-create-button").onClick : f.closeButton().onClick;
    handler(); handler(); await f.d.flush(); assert.equal(f.mutations().length, 1);
    if (action === "create") {
      assert.equal(f.control("task-title-input").disabled, true); assert.equal(f.field("Срок").disabled, true);
    }
  });
}

for (const due of ["not-a-date", "2026-02-30T10:30", "2026-11-12T24:00"]) {
  test(`invalid deadline ${due} is refused locally without clearing the draft`, bounded, async t => {
    const f = await fixture(t); await f.ready(); await f.title("Keep draft"); await f.fieldValue("Срок", due);
    f.control("task-create-button").onClick(); await f.d.flush();
    assert.equal(f.mutations().length, 0); assert.equal(f.control("task-title-input").value, "Keep draft");
    assert.match(f.notices.at(-1)?.message ?? "", /срок/i);
  });
}

for (const scope of ["lead", "account", "workspace"] as const) {
  test(`${scope} A/B/A invalidates captured create/close and field handlers`, bounded, async t => {
    const f = await fixture(t); await f.ready(); await f.title("Old draft");
    const create = f.control("task-create-button").onClick, close = f.closeButton().onClick;
    const change = f.control("task-title-input").onChange;
    if (scope === "lead") { await f.props({ entityId: "synthetic-lead-B" }); await f.props({ entityId: "synthetic-lead-A" }); }
    if (scope === "account") { await f.auth({ user: { id: "synthetic-actor-B" } }); await f.auth({ user: { id: "synthetic-actor-A" } }); }
    if (scope === "workspace") { await f.workspace("synthetic-workspace-B"); await f.workspace("synthetic-workspace-A"); }
    const before = f.calls.length, writes = f.d.writes(); create(); close(); change({ target: { value: "Stale edit" } }); await f.d.flush();
    assert.equal(f.calls.length, before); assert.equal(f.d.writes(), writes);
  });
}

test("pending create cannot clear the next lead's form, toast or launch an old reload", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("Old submitted task");
  f.control("task-create-button").onClick(); await f.d.flush(); const post = f.take("POST");
  const held = await f.holdBody(post, { success: true });
  await f.props({ entityId: "synthetic-lead-B", clientId: "synthetic-client-B" }); await f.list([], "leadId=synthetic-lead-B");
  assert.equal(f.control("task-title-input").value, ""); await f.title("Next lead draft");
  const before = f.calls.length, writes = f.d.writes(); await held.release();
  assert.equal(f.control("task-title-input").value, "Next lead draft"); assert.equal(f.calls.length, before);
  assert.equal(f.d.writes(), writes); assert.deepEqual(f.notices, []);
});

test("SDK A/B/A without a context render permanently retires original callbacks and data", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("Old actor draft");
  const create = f.control("task-create-button").onClick, close = f.closeButton().onClick;
  await f.sdk("synthetic-actor-B"); await f.sdk("synthetic-actor-A"); f.hidden();
  const before = f.calls.length, writes = f.d.writes(); create(); close(); await f.d.flush();
  assert.equal(f.calls.length, before); assert.equal(f.d.writes(), writes);
});

test("actual serverAuth refuses silent SDK mismatch during pending create token lookup", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("Original actor only");
  const release = f.holdSession(); f.control("task-create-button").onClick(); await f.d.flush();
  await f.sdk("synthetic-actor-B", false); release(); await f.d.flush();
  assert.equal(f.mutations().length, 0); f.hidden();
});

test("same actor token refresh stays usable and dispatches its fresh token", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("Same actor");
  await f.sdk("synthetic-actor-A", true, "synthetic-fresh-token");
  f.control("task-create-button").onClick(); await f.d.flush();
  assert.equal(new Headers(f.take("POST").init.headers).get("Authorization"), "Bearer synthetic-fresh-token");
});

test("list and staff bodies from an old lead cannot populate the next lead", bounded, async t => {
  const f = await fixture(t);
  const list = await f.holdBody(f.take(), { success: true, data: { tasks: [TASK] } });
  const staff = await f.holdBody(f.take("GET", "/staff?"), { success: true, data: { staff: [{ id: "stale", name: "Stale staff" }] } });
  await f.props({ entityId: "synthetic-lead-B" }); await f.list([], "leadId=synthetic-lead-B");
  const writes = f.d.writes(); await list.release(); await staff.release();
  assert.doesNotMatch(f.d.text(), /Original task|Stale staff/); assert.equal(f.d.writes(), writes);
});

for (const action of ["list", "create", "close"] as const) {
  test(`unmount fences delayed ${action} body and every captured handler/finally`, bounded, async t => {
    const f = await fixture(t); if (action !== "list") await f.ready();
    if (action === "create") { await f.title("Unmounted draft"); f.control("task-create-button").onClick(); }
    if (action === "close") f.closeButton().onClick();
    await f.d.flush(); const request = f.take(action === "list" ? "GET" : action === "create" ? "POST" : "PATCH");
    const body = await f.holdBody(request, action === "list" ? { success: true, data: { tasks: [TASK] } } : { success: true });
    const callback = action === "list" ? null : f.control("task-create-button").onClick;
    f.d.dispose(); const before = f.calls.length; await body.release(); callback?.(); await f.d.flush();
    assert.equal(f.d.late(), 0); assert.equal(f.calls.length, before); assert.deepEqual(f.notices, []);
  });
}

for (const status of [401, 403, 404]) {
  test(`${status} mutation headers hide data/actions before body decoding and retire captured events`, bounded, async t => {
    const f = await fixture(t); await f.ready(); await f.title("Refused task");
    const create = f.control("task-create-button").onClick, close = f.closeButton().onClick;
    create(); await f.d.flush(); const held = await f.holdBody(f.take("POST"), { success: false }, status);
    try {
      f.hidden(); assert.equal(held.response.bodyUsed, false, "Do not await a denial body to remove actions");
      const before = f.calls.length, writes = f.d.writes(); create(); close(); await f.d.flush();
      assert.equal(f.calls.length, before); assert.equal(f.d.writes(), writes);
    } finally { await held.release(); }
  });
}

test("a missing tasks array is unavailable, not a confirmed empty list", bounded, async t => {
  const f = await fixture(t); await f.answer(f.take(), { success: true, data: {} });
  f.hidden(); assert.doesNotMatch(f.d.text(), /Задач пока нет/); assert.match(f.d.text(), /не значит, что задач нет/);
});

test("ordinary server validation failure retains fields and supports a current-origin retry", bounded, async t => {
  const f = await fixture(t); await f.ready(); await f.title("Keep fields"); await f.fieldValue("Срок", "2026-11-12T10:30");
  f.control("task-create-button").onClick(); await f.d.flush();
  await f.answer(f.take("POST"), { success: false, details: ["Synthetic validation detail"] }, 400);
  assert.equal(f.control("task-title-input").value, "Keep fields"); assert.equal(f.field("Срок").value, "2026-11-12T10:30");
  assert.equal(f.control("task-create-button").disabled, false); assert.equal(f.notices.at(-1)?.message, "Synthetic validation detail");
  f.control("task-create-button").onClick(); await f.d.flush(); assert.equal(f.mutations().length, 2);
});

test("lost close response is not falsely reported as a cancelled change", bounded, async t => {
  const f = await fixture(t); await f.ready(); f.closeButton().onClick(); await f.d.flush();
  f.take("PATCH").response.reject(new Error("synthetic lost response")); await f.d.flush();
  assert.doesNotMatch(f.notices.at(-1)?.message ?? "", /отменено/i); assert.match(f.notices.at(-1)?.message ?? "", /подтверд|проверьте/i);
});

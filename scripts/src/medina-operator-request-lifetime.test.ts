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
const componentFile = "artifacts/negis/src/components/operators/OperatorRequests.tsx";
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "789d896", "only the reviewed component baseline is supported");
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Driver = {
  hooks: Record<string, unknown>; mount(component: () => Child): void; flush(): Promise<void>;
  drainBeforeEffects(): Promise<void>; invalidate(): void; nodes(): Element[]; setterCalls(): number; dispose(): void;
};
function compile(source: string, filename: string) {
  const config: import("typescript").TransformerFactory<import("typescript").SourceFile> = (context) => {
    const visit: import("typescript").Visitor = (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)
        && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return context.factory.createObjectLiteralExpression();
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
  };
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [config] } });
  assert.equal(result.diagnostics?.length ?? 0, 0);
  return result.outputText;
}
// Reuse the established renderer only, not its tests or simulated transport.
// Actual component, operatorApi, crmFetch and serverAuth run below. Descendant
// components are boundary records; there is no React DOM or real authentication.
const helperFile = "scripts/src/medina-operator-action-denial.test.ts";
const helperText = await readFile(path.join(root, helperFile), "utf8");
const helperAst = ts.createSourceFile(helperFile, helperText, ts.ScriptTarget.Latest, true);
const helpers = ["jsx", "elements", "text", "sameDependencies", "hookDriver"].map((name) => {
  const nodes = helperAst.statements.filter((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === name));
  assert.equal(nodes.length, 1, `reuse actual renderer helper ${name}`);
  return nodes[0]!.getText(helperAst);
}).join("\n");
const { jsx, elements, text, hookDriver } = new Function("assert", compile(helpers, helperFile)
  + "\nreturn { jsx, elements, text, hookDriver };")(assert) as {
  jsx(type: unknown, props: Props): Element; elements(child: Child): Element[]; text(child: Child): string; hookDriver(): Driver;
};
const sources: Record<string, string> = {};
for (const [name, filename] of Object.entries({ component: componentFile, api: "artifacts/negis/src/lib/operatorApi.ts",
  crm: "artifacts/negis/src/lib/api.ts", auth: "artifacts/negis/src/lib/serverAuth.ts",
  signout: "artifacts/negis/src/lib/authSignOut.ts", contracts: "lib/crm/operator-contracts.ts",
  commandHook: "artifacts/negis/src/lib/useOperatorCommand.ts", commandAttempts: "artifacts/negis/src/lib/operatorCommandAttempt.ts" })) {
  sources[name] = compile(name === "component" && baseline
    ? execFileSync("git", ["show", `${baseline}:${filename}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, filename), "utf8"), filename);
}
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const boundaries = { OperatorLeads: Symbol("OperatorLeads"), OperatorServiceCatalog: Symbol("OperatorServiceCatalog"), OperatorArrivals: Symbol("OperatorArrivals") };
const RecoveryBoundary = Symbol("OperatorCommandRecovery");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
type Pending = { method: string; url: string; body: unknown; headers: Headers; signal?: AbortSignal | null; jsonReads: number; claimed: boolean;
  respond(status: number, body: unknown | Promise<unknown>): void };
async function fixture(t: TestContext, options: { clinic?: boolean; status?: "requested" | "accepted"; guarded?: boolean } = {}) {
  const driver = hookDriver();
  t.after(() => driver.dispose());
  let actor: string | null = A;
  let epoch = 0, denied = 0, authReads = 0;
  const requests: Pending[] = [];
  const modules = new Map<string, Record<string, unknown>>();
  const storage = new Map<string, string>();
  let props: Props = { actorId: A, ...(options.clinic ? { workspaceId: WORKSPACE } : {}),
    ...(options.guarded ? { isSessionCurrent: () => actor === A && epoch === 0 } : {}), onAccessDenied: () => { denied++; } };
  const unused = (value: string): never => assert.fail(`Unexpected external boundary: ${value}`);
  function load(name: string): Record<string, unknown> {
    if (modules.has(name)) return modules.get(name)!;
    const exports = {};
    modules.set(name, exports);
    new Script(sources[name]!, { filename: name }).runInNewContext({ exports, Error, AbortController, DOMException, Headers, crypto: { randomUUID },
      window: { confirm: () => true, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
        localStorage: { getItem: (key: string) => storage.get(key) ?? null } },
      fetch(url: string, init: RequestInit) {
        assert.equal(init.cache, "no-store");
        const response = deferred<unknown>();
        const pending: Pending = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init.headers), signal: init.signal, jsonReads: 0, claimed: false,
          respond(status, body) {
            const payload = body as {success?:boolean;data?:unknown};
            if (status === 200 && payload?.success === true && !Object.hasOwn(payload,"data") && pending.method === "PATCH") {
              const input = pending.body as Record<string,string>, action=input.commandAction??input.action;
              body={success:true,data:input.action==="abandon"?{state:"abandoned",commandId:input.commandId,action,targetId:input.targetId,closedAt:"2030-01-07T05:00:00Z"}
                :{state:"committed",commandId:input.commandId,action,targetId:input.id,requestId:input.id,
                  statusAtCommit:action==="accept"?"accepted":action==="end"?"ended":"declined",committedAt:"2030-01-07T05:00:00Z"}};
            }
            response.resolve({ ok: status >= 200 && status < 300, status,
            async json() { pending.jsonReads++; return await body; } }); },
        };
        requests.push(pending);
        return response.promise;
      },
      require(id: string) {
        if (id === "react") return { ...driver.hooks, useLayoutEffect: driver.hooks.useEffect };
        if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
        if (id === "lucide-react") return {};
        if (id.endsWith("/crm/operator-contracts")) return load("contracts");
        if (id === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: { auth: {
          async getSession() { authReads++; return { data: { session: actor ? { user: { id: actor }, access_token: `synthetic-${actor}` } : null }, error: null }; },
        } } };
        if (id === "@/lib/authSignOut") return load("signout");
        if (id === "@/lib/serverAuth") return load("auth");
        if (id === "@/lib/api") return load("crm");
        if (id === "@/lib/operatorApi") return load("api");
        if (id === "@/lib/useOperatorCommand") return load("commandHook");
        if (id === "./operatorCommandAttempt") return load("commandAttempts");
        if (id === "./OperatorCommandRecovery") return {OperatorCommandRecovery:RecoveryBoundary};
        if (id.startsWith("./Operator")) { const key = id.slice(2) as keyof typeof boundaries; return { [key]: boundaries[key] }; }
        return unused(id);
      },
    });
    return exports;
  }
  const component = load("component").OperatorRequests as (props: Props) => Child;
  driver.mount(() => component(props));
  const take = (method: string) => {
    const pending = requests.find((item) => !item.claimed && item.method === method);
    assert.ok(pending, `actual ${method} dispatch must exist`);
    pending.claimed = true;
    return pending;
  };
  const list = (label = "current") => ({ success: true, data: { hasMore: true, items: [{ id: REQUEST,
    displayName: `Synthetic ${label}`, clinicBrief: "Synthetic agreement", status: options.status ?? "accepted",
    pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned" }] } });
  const action = () => {
    const node = driver.nodes().find((item) => item.type === "button"
      && (text(item.props.children).includes("\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044c")
        || text(item.props.children).includes(options.clinic ? "\u041e\u0442\u043e\u0437\u0432\u0430\u0442\u044c" : "\u041f\u0440\u0438\u043d\u044f\u0442\u044c")));
    assert.ok(node, "actual request action button must exist");
    return node;
  };
  const refresh = () => {
    const node = driver.nodes().find((item) => item.type === "button" && item.props["aria-label"] === "\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f");
    assert.ok(node); (node.props.onClick as () => void)();
  };
  const open = async () => {
    for (const node of driver.nodes().filter((item) => item.type === "button" && item.props["aria-expanded"] === false)) {
      (node.props.onClick as () => void)();
    }
    await driver.flush();
  };
  await driver.flush();
  take("GET").respond(200, list()); await driver.flush();
  await open();
  async function closeOriginalCommand() {
    // This renderer treats descendants as boundaries. Simulate an explicit
    // recovery control through the real transport/controller, never KV deletion.
    const boundary=driver.nodes().find(node=>node.type===RecoveryBoundary);assert.ok(boundary);
    const command=boundary.props.command as {attempt:{commandId:string;action:string;targetId:string;actorId:string};path:string;
      isCurrent(attempt?:unknown):boolean;complete(attempt:unknown,value:unknown):unknown};
    const attempt=command.attempt;assert.ok(attempt);
    const api=load("api") as {operatorApi(path:string,body:unknown,method:string,signal:undefined,actor:string,guard:()=>boolean):Promise<unknown>};
    const result=api.operatorApi(command.path,{action:"abandon",commandId:attempt.commandId,commandAction:attempt.action,targetId:attempt.targetId},"PATCH",undefined,attempt.actorId,()=>command.isCurrent(attempt));
    await driver.flush();take("PATCH").respond(200,{success:true});const value=await result;
    const confirmed=command.complete(attempt,value);assert.ok(confirmed);
    (boundary.props.onResolved as (attempt:unknown,value:unknown)=>void)(attempt,confirmed);await driver.flush();
  }
  return { driver, requests, take, list, action, refresh, open, denied: () => denied, authReads: () => authReads,
    closeOriginalCommand,
    async start() { (action().props.onClick as () => void)(); await driver.flush(); return take("PATCH"); },
    silentActor(value: string | null) { if (actor !== value) epoch++; actor = value; },
    async renderActor(value: string) { actor = value; props = { ...props, actorId: value }; driver.invalidate(); await driver.flush(); },
    async reload(label = "fresh") {
      // A rendered actor change already starts a read. A manual refresh retires
      // it; answering only that old read leaves the current one unresolved.
      const previous = requests.filter(item => item.method === "GET" && !item.claimed);
      refresh(); await driver.flush();
      for (const old of previous) {
        assert.equal(old.signal?.aborted, true, "refresh must retire the preceding actor/list read");
        old.claimed = true; old.respond(200, list(`retired-${label}`));
      }
      if (previous.length) {
        await driver.flush();
        assert.equal(driver.nodes().filter(node => node.type === "article").length, 0,
          "the retired list cannot repopulate the replacement actor's cards");
      }
      assert.equal(requests.filter(item => item.method === "GET" && !item.claimed).length, 1);
      take("GET").respond(200, list(label)); await driver.flush(); await open();
      assert.ok(driver.nodes().some(node => node.type === "h3" && text(node.props.children) === `Synthetic ${label}`),
        "the fresh list, not its retired predecessor, must be visible");
    },
    snapshot() { return { content: driver.nodes().filter((node) => ["p", "h3"].includes(String(node.type))).map((node) => text(node.props.children)),
      cards: driver.nodes().filter((node) => node.type === "article").length,
      nested: driver.nodes().filter((node) => Object.values(boundaries).includes(node.type as symbol)).length,
      busy: action().props.disabled }; },
    childDenial() { const node = driver.nodes().find((item) => item.type === boundaries.OperatorLeads); assert.ok(node);
      return node.props.onAccessDenied as () => void; },
  };
}

for (const clinic of [false, true]) {
  for (const status of ["requested", "accepted"] as const) {
    test(`request ${clinic ? "clinic" : "operator"} ${status}: repeated retained action dispatches only once`, async t => {
      const ui = await fixture(t, { clinic, status });
      const captured = ui.action().props.onClick as () => void;
      captured(); captured(); await ui.driver.flush();
      assert.equal(ui.requests.filter(item => item.method === "PATCH").length, 1,
        "An unresolved action must own the command before React commits disabled=true");
      ui.take("PATCH").respond(200, { success: true }); await ui.driver.flush();
    });
    test(`request ${clinic ? "clinic" : "operator"} ${status}: refresh cannot unlock an unresolved action`, async t => {
      const ui = await fixture(t, { clinic, status });
      const old = await ui.start(); await ui.reload("refreshed-while-pending");
      assert.equal(ui.snapshot().busy, true, "A new list snapshot cannot release the old in-flight command");
      const count = ui.requests.length;
      (ui.action().props.onClick as () => void)(); await ui.driver.flush();
      assert.equal(ui.requests.length, count);
      old.respond(200, { success: true }); await ui.driver.flush();
      assert.equal(ui.snapshot().busy, true, "A retired response cannot drop the unresolved original key");
      assert.equal(ui.requests.length, count, "Obsolete success must not replace/refetch the newer list");
      await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);
      (await ui.start()).respond(200, { success: true }); await ui.driver.flush();
    });
  }
  test(`request ${clinic ? "clinic withdrawal" : "operator acceptance"} positive action uses actual transport and original actor`, async (t) => {
    const ui = await fixture(t, { clinic, status: "requested" });
    const pending = await ui.start();
    assert.deepEqual(pending.body, { id: REQUEST, action: clinic ? "withdraw" : "accept", commandId:(pending.body as Record<string,unknown>).commandId });
    assert.match(String((pending.body as Record<string,unknown>).commandId),/^[0-9a-f-]{36}$/i);
    assert.equal(pending.headers.get("Authorization"), `Bearer synthetic-${A}`);
    pending.respond(200, { success: true }); await ui.driver.flush();
    assert.equal(ui.requests.filter((item) => item.method === "GET").length, 2);
    ui.take("GET").respond(200, ui.list("saved")); await ui.driver.flush();
    assert.equal(ui.snapshot().cards, 1); assert.equal(ui.snapshot().busy, false); assert.equal(ui.denied(), 0);
  });
}
for (const status of [401, 403]) {
  test(`request ${status} headers revoke immediately without waiting for or reading a stalled body`, async (t) => {
    const ui = await fixture(t);
    const pending = await ui.start();
    pending.respond(status, deferred<unknown>().promise);
    await ui.driver.drainBeforeEffects();
    assert.equal(pending.jsonReads, 0);
    assert.equal(ui.driver.nodes().filter((node) => node.type === "article").length, 0);
    assert.equal(ui.driver.nodes().filter((node) => Object.values(boundaries).includes(node.type as symbol)).length, 0);
    assert.equal(ui.denied(), 1);
    await ui.driver.flush(); assert.equal(ui.requests.length, 3);
  });
}
for (const status of [200, 409]) {
  test(`request deferred ${status} body cannot mutate or refresh after a silent actor change`, async (t) => {
    const ui = await fixture(t);
    const pending = await ui.start();
    const body = deferred<unknown>(); pending.respond(status, body.promise); await ui.driver.flush();
    assert.equal(pending.jsonReads, 1);
    ui.silentActor(B);
    const writes = ui.driver.setterCalls(), count = ui.requests.length, before = ui.snapshot();
    body.resolve({ success: status === 200, error: "OBSOLETE_REQUEST_ERROR" }); await ui.driver.flush();
    assert.equal(ui.driver.setterCalls(), writes, "stale body must not even attempt a state write");
    assert.deepEqual(ui.snapshot(), before); assert.equal(ui.requests.length, count); assert.equal(ui.denied(), 0);
  });
}
test("request 401 with a silently missing session still removes protected cards without parsing its body", async (t) => {
  const ui = await fixture(t);
  const pending = await ui.start(); ui.silentActor(null);
  pending.respond(401, deferred<unknown>().promise); await ui.driver.drainBeforeEffects();
  assert.equal(pending.jsonReads, 0);
  assert.equal(ui.driver.nodes().filter((node) => node.type === "article").length, 0);
  assert.equal(ui.driver.nodes().filter((node) => Object.values(boundaries).includes(node.type as symbol)).length, 0);
  assert.equal(ui.denied(), 1);
});
test("request 401 under a silently different actor cannot revoke or refresh the old callback's view", async (t) => {
  const ui = await fixture(t);
  const pending = await ui.start(); ui.silentActor(B);
  const writes = ui.driver.setterCalls(), count = ui.requests.length, before = ui.snapshot();
  pending.respond(401, deferred<unknown>().promise); await ui.driver.flush();
  assert.equal(pending.jsonReads, 0); assert.equal(ui.denied(), 0);
  assert.equal(ui.driver.setterCalls(), writes); assert.equal(ui.requests.length, count); assert.deepEqual(ui.snapshot(), before);
});
test("request observing silent B permanently invalidates the old A callback even if A returns", async (t) => {
  const ui = await fixture(t);
  const capturedAction = ui.action().props.onClick as () => void;
  const pending = await ui.start();
  ui.silentActor(B); pending.respond(409, { success: false, error: "OBSOLETE_CONFLICT" }); await ui.driver.flush();
  ui.silentActor(A); const writes = ui.driver.setterCalls(), count = ui.requests.length;
  capturedAction(); await ui.driver.flush();
  assert.equal(ui.requests.length, count, "observed A-B-A must not revive an old action");
  assert.equal(ui.driver.setterCalls(), writes);
});
test("request old A denial cannot revoke a replacement A view after rendered A-B-A", async (t) => {
  const ui = await fixture(t);
  const old = await ui.start();
  await ui.renderActor(B); await ui.reload("B");
  await ui.renderActor(A); await ui.reload("replacement-A");
  await ui.closeOriginalCommand();
  const current = await ui.start();
  const before = ui.snapshot(), writes = ui.driver.setterCalls(), count = ui.requests.length;
  old.respond(401, deferred<unknown>().promise); await ui.driver.flush();
  assert.equal(old.jsonReads, 0); assert.equal(ui.denied(), 0);
  assert.deepEqual(ui.snapshot(), before); assert.equal(ui.driver.setterCalls(), writes); assert.equal(ui.requests.length, count);
  current.respond(200, { success: true }); await ui.driver.flush();
  assert.equal(ui.requests.length, count + 1, "replacement actor's real action still refreshes normally");
});
test("request obsolete child revocation cannot revoke a replacement A scope after A-B-A", async (t) => {
  const ui = await fixture(t);
  const obsolete = ui.childDenial();
  await ui.renderActor(B); await ui.reload("B");
  await ui.renderActor(A); await ui.reload("replacement-A");
  const before = ui.snapshot(), writes = ui.driver.setterCalls(), count = ui.requests.length;
  obsolete(); await ui.driver.flush();
  assert.deepEqual(ui.snapshot(), before); assert.equal(ui.driver.setterCalls(), writes);
  assert.equal(ui.requests.length, count); assert.equal(ui.denied(), 0);
});
test("request current-scope late 403 still revokes a newer list snapshot", async (t) => {
  const ui = await fixture(t);
  const old = await ui.start(); await ui.reload("new-page");
  const count = ui.requests.length;
  old.respond(403, deferred<unknown>().promise); await ui.driver.flush();
  assert.equal(old.jsonReads, 0); assert.equal(ui.denied(), 1);
  assert.equal(ui.driver.nodes().filter((node) => node.type === "article").length, 0);
  assert.equal(ui.requests.length, count + 1);
});
test("request current 409 clears its private panes and requires a fresh list before a genuine action", async (t) => {
  const ui = await fixture(t);
  const pending = await ui.start(); pending.respond(409, { success: false, error: "CURRENT_CONFLICT" }); await ui.driver.flush();
  assert.equal(ui.driver.nodes().filter((node) => node.type === "article").length, 1);
  assert.equal(ui.driver.nodes().filter((node) => Object.values(boundaries).includes(node.type as symbol)).length, 0);
  assert.equal(ui.requests.length, 3); assert.equal(ui.denied(), 0, "a request conflict is not a global account revocation");
  ui.take("GET").respond(200, ui.list("fresh-authorized")); await ui.driver.flush(); await ui.open();
  assert.equal(ui.snapshot().nested, 3); assert.equal(ui.snapshot().busy, true);
  await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);
  (await ui.start()).respond(200, { success: true }); await ui.driver.flush();
  assert.equal(ui.requests.length, 6);
});
test("request unmounted deferred completion cannot write state or refresh", async (t) => {
  const ui = await fixture(t); const pending = await ui.start();
  const body = deferred<unknown>(); pending.respond(200, body.promise); await ui.driver.flush();
  ui.driver.dispose(); const writes = ui.driver.setterCalls(), count = ui.requests.length;
  body.resolve({ success: true }); await ui.driver.flush();
  assert.equal(ui.driver.setterCalls(), writes); assert.equal(ui.requests.length, count); assert.equal(ui.denied(), 0);
});

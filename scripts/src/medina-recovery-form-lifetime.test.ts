import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual recovery JSX/validation with synthetic hooks and held session/update
// boundaries. Integration cases use the installed SDK and facade, fake storage,
// public lock adapters and an allowlisted in-memory HTTP responder only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontendRequire = createRequire(path.join(root, "artifacts/negis/package.json"));
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const sourcePath = "artifacts/negis/src/pages/ResetPassword.tsx";
const source = await readFile(path.join(root, sourcePath), "utf8");
type Stamp = { revision: string | null; intent: string | null };
type Proof = { id: string; actorId: string; stamp: Stamp; expiresAt: number };
type Props = Record<string, any>;
type Element = { type: unknown; props: Props };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Effect = () => void | (() => void);
type Deps = readonly unknown[] | undefined;
type Slot =
  | { kind: "state"; value: any; set: (value: any) => void }
  | { kind: "ref"; value: { current: any } }
  | { kind: "effect"; create: Effect; deps: Deps; pending: boolean; cleanup?: () => void };
const actorA = "recovery-local-a", actorB = "recovery-local-b";
const password = "Synthetic-recovery-42";
const session = (actor: string | null) => actor ? { user: { id: actor } } : null;

function evaluate(file: string, code: string, imports: Props, bindings: Props = {}, env = false) {
  const compiled = ts.transpileModule(code, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    transformers: env ? { before: [context => {
      const visit: import("typescript").Visitor = node => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
          return ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment("env",
            ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("VITE_SUPABASE_URL", ts.factory.createStringLiteral("https://recovery.example.test")),
              ts.factory.createPropertyAssignment("VITE_SUPABASE_ANON_KEY", ts.factory.createStringLiteral("synthetic-public-key")),
            ]))]);
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] } : undefined,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const exports: Props = {};
  new Script(compiled.outputText, { filename: file }).runInNewContext({
    exports, AbortController, DOMException, Error, URL, Headers, Request, Response, TextEncoder,
    queueMicrotask, setTimeout, clearTimeout,
    fetch() { assert.fail("Real network is forbidden"); }, ...bindings,
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`); return imports[name]; },
  });
  return exports;
}
const rulesPath = "lib/auth/password-rules.ts";
const rules = evaluate(rulesPath, await readFile(path.join(root, rulesPath), "utf8"), {});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(nodes);
  if (!child || typeof child !== "object") return [];
  return [child, ...nodes(child.props.children)];
}
function content(child: Child): string {
  if (Array.isArray(child)) return child.map(content).join("");
  if (child && typeof child === "object") return content(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function driver() {
  const slots: Slot[] = [], writes: { mounted: boolean; value: any }[] = [];
  let cursor = 0, mounted = true, dirty = false, tree: Child, component: () => Child;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    const index = cursor++; slots[index] ??= create(); assert.equal(slots[index].kind, kind);
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  const hooks = {
    useState(initial: any) {
      const item = slot("state", () => {
        const state: Extract<Slot, { kind: "state" }> = { kind: "state", value: initial,
          set(update: any) {
            writes.push({ mounted, value: update });
            const next = typeof update === "function" ? update(state.value) : update;
            if (!Object.is(next, state.value)) { state.value = next; if (mounted) dirty = true; }
          } };
        return state;
      });
      return [item.value, item.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useLayoutEffect(create: Effect, deps: Deps) {
      const item = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!deps || !item.deps || deps.length !== item.deps.length || deps.some((d, i) => !Object.is(d, item.deps![i]))) item.pending = true;
      item.create = create; item.deps = deps;
    },
  };
  function commit() {
    dirty = false; cursor = 0; tree = component();
    const pending = slots.filter((s): s is Extract<Slot, { kind: "effect" }> => s.kind === "effect" && s.pending);
    for (const item of pending) item.cleanup?.();
    for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
  }
  return { hooks, writes, nodes: () => nodes(tree), text: () => content(tree),
    mount(value: () => Child) { component = value; dirty = true; },
    invalidate() { if (mounted) dirty = true; },
    async flush() {
      for (let i = 0; i < 30; i++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      await setImmediate();
      for (let i = 0; i < 30; i++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      assert.equal(dirty, false);
    },
    replay() {
      for (const item of slots) if (item.kind === "effect") { item.cleanup?.(); item.cleanup = undefined; item.pending = true; }
      dirty = true;
    },
    unmount() {
      if (!mounted) return; mounted = false; dirty = false;
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
    } };
}
type Scope = { expectedUserId: string; expected: Stamp; signal: AbortSignal; isCurrent(): boolean; onReceipt(stamp: Stamp): void };
type Call = { password: string; scope: Scope; hold: ReturnType<typeof deferred<any>> };
async function fixture(t: TestContext, options: { actor?: string | null; proof?: boolean; holdBootstrap?: boolean; facade?: Props; invite?: boolean; proofExpiresAt?: unknown; omitExpiry?: boolean } = {}) {
  const ui = driver(), forms: Props[] = [], calls: Call[] = [], locations: string[] = [], consumed: string[] = [], trace: string[] = [];
  const listeners = new Set<(event: string, value: ReturnType<typeof session>) => void>();
  const timers = new Map<number, { callback: () => void; ms: number; due: number }>();
  const bootstrap = deferred<any>(); let nextLookup: ReturnType<typeof deferred<any>> | null = options.holdBootstrap ? bootstrap : null;
  let timerId = 0, now = Date.now(), actor = options.actor === undefined ? actorA : options.actor;
  let stamp: Stamp = { revision: "recovery-r1", intent: null }, brokenStampRead = false;
  let proof: Proof | null = options.proof === false ? null : { id: "recovery-proof-a", actorId: actorA, stamp, expiresAt: now + 60_000 };
  if (proof && Object.hasOwn(options, "proofExpiresAt")) Object.defineProperty(proof, "expiresAt", { value: options.proofExpiresAt, writable: true });
  if (proof && options.omitExpiry) Reflect.deleteProperty(proof, "expiresAt");
  const isCurrentStamp = (candidate: Stamp) => {
    if (brokenStampRead) throw new Error("Synthetic storage unavailable");
    return stamp.revision === candidate.revision && stamp.intent === candidate.intent;
  };
  const local = {
    arrivedByRecoveryLink: true,
    getRecoverySessionProof() { return proof ? { ...proof, stamp: { ...stamp } } : null; },
    consumeRecoverySessionProof(id: string) { if (proof?.id === id) proof = null; },
    sessionAuth: {
      onAuthStateChange(callback: (event: string, value: ReturnType<typeof session>) => void) {
        trace.push("subscribe"); listeners.add(callback);
        return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
      },
      isCurrent: isCurrentStamp,
      updateUserPassword(value: string, scope: Scope) {
        assert.equal(forms[0].values.password, ""); assert.equal(forms[0].values.confirm, "");
        const hold = deferred<any>(); calls.push({ password: value, scope, hold }); return hold.promise;
      },
    },
    supabase: { auth: {
      getSession() {
        trace.push("getSession");
        const hold = nextLookup; nextLookup = null;
        return hold ? hold.promise : Promise.resolve({ data: { session: session(actor) }, error: null });
      },
      updateUser() { assert.fail("Raw updateUser is forbidden"); },
    } },
  };
  const api = options.facade ?? local;
  const boundApi = { ...api, consumeRecoverySessionProof(id: string) { consumed.push(id); api.consumeRecoverySessionProof(id); },
    sessionAuth: { ...api.sessionAuth, updateUserPassword(value: string, scope: Scope) {
      assert.equal(forms[0].values.password, ""); assert.equal(forms[0].values.confirm, "");
      return api.sessionAuth.updateUserPassword(value, scope);
    } } };
  function useForm(config: Props) {
    const ref = ui.hooks.useRef(null);
    if (!ref.current) {
      const values: Props = {}, form: Props = { values, formState: { errors: {} },
        register(name: string) { return { name, value: values[name] ?? "", onChange(event: any) { values[name] = event.target.value; ui.invalidate(); } }; },
        reset(next: Props = {}) {
          for (const name of Object.keys(values)) delete values[name]; Object.assign(values, next);
          form.formState.errors = {}; ui.invalidate();
        },
        handleSubmit(callback: (values: any) => Promise<void>) { return async () => {
          const result = await config.resolver({ ...values }, {}, { fields: {}, shouldUseNativeValidation: false });
          form.formState.errors = result.errors; ui.invalidate();
          if (!Object.keys(result.errors).length) await callback(result.values);
        }; },
      };
      ref.current = form; forms.push(form);
    }
    return ref.current;
  }
  const jsx = (type: unknown, props: Props): Element => ({ type, props });
  const page = evaluate(sourcePath, source, {
    react: ui.hooks, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol("fragment") },
    wouter: { useLocation: () => ["/reset-password", (location: string) => locations.push(location)] },
    "@/lib/supabase": boundApi, "../../../../lib/auth/password-rules": rules,
    zod: frontendRequire("zod"), "react-hook-form": { useForm },
    "@hookform/resolvers/zod": frontendRequire("@hookform/resolvers/zod"),
    "lucide-react": { Check: Symbol("check"), Eye: Symbol("eye"), EyeOff: Symbol("eye-off") },
  }, {
    Date: class extends Date { static now() { return now; } },
    window: { sessionStorage: { getItem: (key: string) => options.invite && key === "negis_pending_invite" ? "synthetic-invite" : null } },
    setTimeout(callback: () => void, ms: number) { const id = ++timerId; timers.set(id, { callback, ms, due: now + ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  ui.mount(page.default); await ui.flush();
  t.after(() => ui.unmount());
  const find = (predicate: (node: Element) => boolean) => { const node = ui.nodes().find(predicate); assert.ok(node); return node; };
  const fill = () => { forms[0].values.password = password; forms[0].values.confirm = password; ui.invalidate(); };
  const submit = () => find(node => node.type === "form").props.onSubmit;
  function emit(event: string, next = actor) {
    actor = next;
    for (const callback of [...listeners]) callback(event, session(next));
  }
  function settle(index = 0, error: any = null) {
    const call = calls[index]; call.scope.onReceipt({ ...stamp });
    call.hold.resolve({ data: { user: { id: actorA } }, error });
  }
  return { ui, forms, calls, locations, consumed, trace, listeners, timers, bootstrap, fill, submit, emit, settle,
    lookup(hold: ReturnType<typeof deferred<any>>) { nextLookup = hold; },
    change(nextActor: string | null, nextProof: Proof | null, nextStamp: Stamp = { revision: "other-r", intent: "other-i" }) {
      actor = nextActor; proof = nextProof; stamp = nextStamp;
    },
    setStamp(next: Stamp) { stamp = next; },
    setExpiry(value: number) { if (proof) proof.expiresAt = value; },
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timers.has(id) && timer.due <= now) { timers.delete(id); timer.callback(); }
      }
    },
    breakStampReads() { brokenStampRead = true; },
    run(ms: number) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); } },
  };
}

test("Recovery marker and an ordinary live session cannot authorize the form", async t => {
  const f = await fixture(t, { proof: false });
  assert.deepEqual(f.trace, ["subscribe", "getSession"]);
  assert.equal(f.ui.nodes().some(node => node.type === "form"), false);
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.equal(f.calls.length, 0);
});

test("Recovery proof alone stays neutral until matching current-session bootstrap resolves", async t => {
  const f = await fixture(t, { holdBootstrap: true });
  assert.deepEqual(f.trace, ["subscribe", "getSession"]); assert.match(f.ui.text(), /Проверка ссылки/);
  f.bootstrap.resolve({ data: { session: session(actorA) }, error: null }); await f.ui.flush();
  assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
});

test("Recovery A proof cannot open a B session, including a late bootstrap after account notification", async t => {
  const mismatch = await fixture(t, { actor: actorB }); assert.match(mismatch.ui.text(), /Ссылка недействительна/);
  const f = await fixture(t, { holdBootstrap: true });
  f.change(actorB, null); f.emit("SIGNED_IN", actorB); await f.ui.flush();
  const writes = f.ui.writes.length;
  f.bootstrap.resolve({ data: { session: session(actorA) }, error: null }); await f.ui.flush();
  assert.equal(f.ui.writes.length, writes); assert.match(f.ui.text(), /Ссылка недействительна/);
});

test("Recovery native event wins over bootstrap; duplicate INITIAL does not cancel its verification", async t => {
  const f = await fixture(t, { proof: false, holdBootstrap: true });
  const fresh: Proof = { id: "native-recovery", actorId: actorA, stamp: { revision: "native-r", intent: null }, expiresAt: f.now() + 60_000 };
  f.change(actorA, fresh, fresh.stamp); f.emit("PASSWORD_RECOVERY"); f.emit("INITIAL_SESSION"); await f.ui.flush();
  assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
  f.bootstrap.resolve({ data: { session: session(actorB) }, error: null }); await f.ui.flush();
  assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
});

test("Recovery shared validation, synchronous dedupe, pre-IO clearing and original proof scope", async t => {
  const f = await fixture(t); f.forms[0].values.password = "short"; f.forms[0].values.confirm = "different";
  await f.submit()(); await f.ui.flush(); assert.equal(f.calls.length, 0);
  assert.ok(f.forms[0].formState.errors.password); assert.ok(f.forms[0].formState.errors.confirm);
  f.fill(); await f.ui.flush(); const originalSubmit = f.submit(), first = originalSubmit(), duplicate = originalSubmit();
  await f.ui.flush(); assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.password, password); assert.equal(call.scope.expectedUserId, actorA);
  assert.equal(call.scope.expected.revision, "recovery-r1"); assert.equal(call.scope.isCurrent(), true);
  f.settle(0, { message: "temporary failure" }); await first; await duplicate; await f.ui.flush();
  assert.match(f.ui.text(), /Не удалось сменить пароль/); assert.equal(call.scope.isCurrent(), false);
  f.fill(); await originalSubmit(); assert.equal(f.calls.length, 1, "Settled callback cannot replay captured values");
});

test("Recovery pending ownership survives its own intent claim and same-proof INITIAL/USER_UPDATED", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.setStamp({ revision: "recovery-r1", intent: "own-update-intent" });
  f.emit("INITIAL_SESSION"); f.emit("USER_UPDATED"); await f.ui.flush();
  assert.equal(f.calls[0].scope.isCurrent(), true);
  f.setStamp({ revision: "own-update-r", intent: "own-update-intent" });
  f.emit("SIGNED_IN"); await f.ui.flush();
  f.settle(); await pending; await f.ui.flush();
  assert.match(f.ui.text(), /Пароль обновлён/); assert.deepEqual(f.consumed, ["recovery-proof-a"]);
  assert.equal(f.calls[0].scope.isCurrent(), false);
});

test("Recovery refresh uses a fresh proof stamp for the next update", async t => {
  const f = await fixture(t); f.setStamp({ revision: "refreshed-r", intent: "refreshed-i" });
  f.emit("TOKEN_REFRESHED"); await f.ui.flush(); f.fill(); await f.ui.flush();
  const pending = f.submit()(); await f.ui.flush();
  assert.equal(f.calls[0].scope.expected.revision, "refreshed-r");
  f.settle(); await pending; await f.ui.flush(); assert.match(f.ui.text(), /Пароль обновлён/);
});

for (const [label, value] of [["missing", undefined], ["null", null], ["NaN", NaN], ["infinite", Infinity],
  ["negative infinite", -Infinity], ["past", 0], ["numeric string", String(Date.now() + 60_000)]] as const) {
  test(`Recovery rejects ${label} proof expiry without inventing a grant or starting verification IO`, async t => {
    const f = await fixture(t, label === "missing" ? { omitExpiry: true } : { proofExpiresAt: value });
    assert.match(f.ui.text(), /Ссылка недействительна/);
    assert.equal(f.ui.nodes().some(node => node.type === "form"), false);
    assert.deepEqual(f.trace, ["subscribe"]); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  });
}

test("Recovery expires during a held bootstrap before its verified form can open", async t => {
  const f = await fixture(t, { proofExpiresAt: Date.now() + 1000, holdBootstrap: true });
  f.advance(1001); f.bootstrap.resolve({ data: { session: session(actorA) }, error: null }); await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0);
});

test("Recovery original expiry clears the idle form and private fields without new IO", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush();
  assert.equal(f.timers.size, 1); const trace = [...f.trace];
  f.advance(59_999); await f.ui.flush(); assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
  f.advance(1); await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/);
  assert.equal(f.forms[0].values.password, ""); assert.equal(f.forms[0].values.confirm, "");
  assert.equal(f.calls.length, 0); assert.deepEqual(f.trace, trace); assert.equal(f.timers.size, 0);
});

test("Recovery original expiry aborts a pending update and silences late receipt/result/finally", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  const trace = [...f.trace]; f.advance(60_000); await f.ui.flush();
  assert.equal(f.calls[0].scope.isCurrent(), false); assert.equal(f.calls[0].scope.signal.aborted, true);
  assert.match(f.ui.text(), /Ссылка недействительна/); const writes = f.ui.writes.length;
  f.calls[0].scope.onReceipt({ revision: "late-expired-r", intent: null });
  f.calls[0].hold.resolve({ data: { user: { id: actorA } }, error: null }); await pending; await f.ui.flush();
  assert.equal(f.ui.writes.length, writes); assert.deepEqual(f.locations, []); assert.deepEqual(f.consumed, []);
  assert.deepEqual(f.trace, trace); assert.equal(f.timers.size, 0);
});

test("Recovery TOKEN_REFRESHED and duplicate notifications cannot extend or rearm the original expiry", async t => {
  const f = await fixture(t); const original = [...f.timers.entries()][0]; const trace = [...f.trace];
  f.advance(10_000); f.setExpiry(f.now() + 90_000);
  f.setStamp({ revision: "refreshed-ttl-r", intent: "refreshed-ttl-i" });
  f.emit("TOKEN_REFRESHED"); f.emit("INITIAL_SESSION"); f.emit("USER_UPDATED"); await f.ui.flush();
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.keys()][0], original[0]);
  assert.equal([...f.timers.values()][0].ms, 60_000);
  f.advance(50_000); await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.deepEqual(f.trace, trace); assert.equal(f.calls.length, 0);
});

test("Recovery old expiry callback cannot expire a newer proof or write after unmount", async t => {
  const f = await fixture(t); const old = [...f.timers.values()][0].callback;
  const fresh: Proof = { id: "new-expiry-proof", actorId: actorA,
    stamp: { revision: "new-expiry-r", intent: null }, expiresAt: f.now() + 120_000 };
  f.change(actorA, fresh, fresh.stamp); f.emit("PASSWORD_RECOVERY"); await f.ui.flush();
  const writes = f.ui.writes.length; old(); await f.ui.flush(); assert.equal(f.ui.writes.length, writes);
  assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
  const current = [...f.timers.values()][0].callback;
  f.ui.unmount(); current(); old(); await f.ui.flush();
  assert.equal(f.ui.writes.length, writes); assert.equal(f.timers.size, 0);
});

for (const event of ["SIGNED_OUT", "different actor", "same actor new session", "ABA"] as const) {
  test(`Recovery ${event} revokes pending update and ignores late results`, async t => {
    const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
    f.change(event === "SIGNED_OUT" ? null : actorB, null);
    f.emit(event === "SIGNED_OUT" ? "SIGNED_OUT" : "SIGNED_IN", event === "same actor new session" ? actorA : event === "SIGNED_OUT" ? null : actorB);
    if (event === "ABA") { f.change(actorA, { id: "new-proof-a", actorId: actorA, stamp: { revision: "aba", intent: null }, expiresAt: f.now() + 60_000 }); f.emit("PASSWORD_RECOVERY", actorA); }
    await f.ui.flush(); const writes = f.ui.writes.length;
    assert.equal(f.calls[0].scope.isCurrent(), false); assert.equal(f.calls[0].scope.signal.aborted, true);
    f.calls[0].scope.onReceipt({ revision: "stale-receipt", intent: null });
    f.calls[0].hold.resolve({ data: { user: { id: actorA } }, error: null }); await pending; await f.ui.flush();
    assert.equal(f.ui.writes.length, writes); assert.deepEqual(f.consumed, []); assert.deepEqual(f.locations, []);
  });
}

test("Recovery stale receipt without any local auth notification cannot publish success", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.calls[0].scope.onReceipt({ revision: "recovery-r1", intent: null });
  f.change(actorB, null); f.calls[0].hold.resolve({ data: { user: { id: actorA } }, error: null });
  await pending; await f.ui.flush(); assert.doesNotMatch(f.ui.text(), /Пароль обновлён/);
  assert.deepEqual(f.consumed, []); assert.deepEqual(f.locations, []);
});

test("Recovery success requires a post-cleanup receipt, not just a user result", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.calls[0].hold.resolve({ data: { user: { id: actorA } }, error: null }); await pending; await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.deepEqual(f.consumed, []);
});

for (const invite of [false, true]) {
  test(`Recovery owned receipt preserves ${invite ? "invite" : "login"} return and cancels redirect after navigation`, async t => {
    const f = await fixture(t, { invite }); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
    f.settle(); await pending; await f.ui.flush();
    const savedTimer = [...f.timers.values()].find(timer => timer.ms === 3000)!.callback;
    f.ui.nodes().find(node => node.type === "button" && content(node) === "Войти")!.props.onClick();
    savedTimer(); await f.ui.flush(); assert.deepEqual(f.locations, [invite ? "/join" : "/login"]);
    assert.equal(f.timers.size, 0);
  });
}

test("Recovery delayed redirect and saved success handler reject an unseen B revision", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.settle(); await pending; await f.ui.flush();
  const saved = f.ui.nodes().find(node => node.type === "button" && content(node) === "Войти")!.props.onClick;
  f.change(actorB, null); f.run(3000); saved(); await f.ui.flush();
  assert.deepEqual(f.locations, []); assert.match(f.ui.text(), /Ссылка недействительна/);
});

test("Recovery unmount cancels an already scheduled success redirect and its saved handler", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.settle(); await pending; await f.ui.flush();
  const timer = [...f.timers.values()].find(value => value.ms === 3000)!.callback;
  const click = f.ui.nodes().find(node => node.type === "button" && content(node) === "Войти")!.props.onClick;
  f.ui.unmount(); const writes = f.ui.writes.length;
  timer(); click(); await f.ui.flush();
  assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.ui.writes.length, writes); assert.deepEqual(f.locations, []);
});

test("Recovery receipt storage failure quarantines success without an unhandled timer exception", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.settle(); await pending; await f.ui.flush();
  f.breakStampReads(); f.run(3000); await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.deepEqual(f.locations, []);
});

test("Recovery stale loading deadline cannot expire a newer native recovery verification", async t => {
  const f = await fixture(t, { holdBootstrap: true });
  const oldTimer = [...f.timers.values()].find(timer => timer.ms === 4000)!.callback;
  const next: Proof = { id: "replacement-proof", actorId: actorA, stamp: { revision: "replacement-r", intent: null }, expiresAt: f.now() + 60_000 };
  const hold = deferred<any>(); f.lookup(hold); f.change(actorA, next, next.stamp); f.emit("PASSWORD_RECOVERY");
  await f.ui.flush(); oldTimer(); await f.ui.flush(); assert.match(f.ui.text(), /Проверка ссылки/);
  hold.resolve({ data: { session: session(actorA) }, error: null }); await f.ui.flush();
  assert.equal(f.ui.nodes().filter(node => node.type === "form").length, 1);
  f.bootstrap.resolve({ data: { session: session(actorB) }, error: null }); await f.ui.flush();
});

test("Recovery rejected update is contained; expired errors do not leave a live form", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush(); let pending = f.submit()(); await f.ui.flush();
  f.calls[0].hold.reject(new Error("synthetic transport failure")); await pending; await f.ui.flush();
  assert.match(f.ui.text(), /Не удалось сменить пароль/);
  f.fill(); await f.ui.flush(); pending = f.submit()(); await f.ui.flush();
  f.settle(1, { message: "invalid recovery token" }); await pending; await f.ui.flush();
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.equal(f.timers.size, 0);
});

test("Recovery StrictMode replay clears private fields while the replacement bootstrap is held", async t => {
  const f = await fixture(t); f.fill(); await f.ui.flush();
  const oldSubmit = f.submit(); const hold = deferred<any>(); f.lookup(hold);
  f.ui.replay(); await f.ui.flush(); assert.match(f.ui.text(), /Проверка ссылки/);
  assert.equal(f.forms[0].values.password, ""); assert.equal(f.forms[0].values.confirm, "");
  assert.equal(f.listeners.size, 1);
  hold.resolve({ data: { session: session(actorA) }, error: null }); await f.ui.flush();
  f.fill(); await oldSubmit(); assert.equal(f.calls.length, 0);
});

test("Recovery timeout and unmount revoke lookup, pending callbacks and delayed redirects", async t => {
  const loading = await fixture(t, { holdBootstrap: true }); loading.run(4000); await loading.ui.flush();
  loading.bootstrap.resolve({ data: { session: session(actorA) }, error: null }); await loading.ui.flush();
  assert.match(loading.ui.text(), /Ссылка недействительна/);
  const f = await fixture(t); f.fill(); await f.ui.flush(); const pending = f.submit()(); await f.ui.flush();
  f.ui.unmount(); const writes = f.ui.writes.length;
  f.calls[0].hold.reject(new Error("late unmounted update")); await pending; await f.ui.flush();
  assert.equal(f.ui.writes.length, writes); assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.locations, []);
});

function lockAdapter() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(name: string, _timeout: number, callback: () => Promise<T>): Promise<T> => {
    const operation = (tails.get(name) ?? Promise.resolve()).then(callback);
    const tail = operation.then(() => {}, () => {}); tails.set(name, tail);
    try { return await operation; } finally { if (tails.get(name) === tail) tails.delete(name); }
  };
}
async function realFacade(t: TestContext) {
  const sdk = frontendRequire("@supabase/supabase-js");
  assert.equal(frontendRequire("@supabase/supabase-js/package.json").version, "2.118.0");
  const values = new Map<string, string>(), storageEvents = new Set<unknown>(), puts: ReturnType<typeof deferred<Response>>[] = [];
  const lock = lockAdapter(); let nonce = 0, verifyActor = actorA;
  const user = (id: string) => ({ id, aud: "authenticated", role: "authenticated", email: `${id}@example.test`, user_metadata: {} });
  const savedSession = (id: string) => ({ access_token: ["e30", Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "synthetic"].join("."),
    refresh_token: `synthetic-refresh-${id}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: user(id) });
  const transport = async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://recovery.example.test");
    if (url.pathname === "/auth/v1/verify" && init.method === "POST") return Response.json(savedSession(verifyActor));
    if (url.pathname === "/auth/v1/user" && init.method === "GET") return Response.json(user(verifyActor));
    if (url.pathname === "/auth/v1/user" && init.method === "PUT") {
      assert.equal(JSON.parse(String(init.body)).password, password);
      const hold = deferred<Response>(); puts.push(hold); return hold.promise;
    }
    assert.fail("Unexpected synthetic transport route");
  };
  const authorityPath = "artifacts/negis/src/lib/authSessionAuthority.ts";
  const authority = evaluate(authorityPath, await readFile(path.join(root, authorityPath), "utf8"),
    { "@supabase/supabase-js": sdk }, { fetch: transport, crypto: { randomUUID: () => `synthetic-nonce-${++nonce}` } });
  const facadePath = "artifacts/negis/src/lib/supabase.ts";
  let native: any;
  const facade = evaluate(facadePath, await readFile(path.join(root, facadePath), "utf8"), {
    "./authSessionAuthority": authority,
    "@supabase/supabase-js": { ...sdk, navigatorLock: lock, processLock: lock,
      createClient(url: string, key: string, options: Props) {
        native = sdk.createClient(url, key, { ...options, global: { fetch: transport },
          auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false } }); return native;
      } },
  }, {
    fetch: transport, crypto: { randomUUID: () => `synthetic-nonce-${++nonce}` }, navigator: { locks: {} },
    window: { location: { hash: "#type=recovery", search: "" },
      localStorage: { getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } },
      addEventListener(_name: string, callback: unknown) { storageEvents.add(callback); },
      removeEventListener(_name: string, callback: unknown) { storageEvents.delete(callback); } },
  }, true);
  t.after(async () => {
    for (const hold of puts) hold.resolve(Response.json({ msg: "synthetic cleanup" }, { status: 409 }));
    await setImmediate(); facade.sessionAuth.dispose(); await native.auth.dispose();
    assert.equal(storageEvents.size, 0);
  });
  await native.auth.getSession();
  async function authenticate(id = actorA, recovery = true) {
    verifyActor = id;
    const { error } = await native.auth.verifyOtp({ token_hash: "synthetic-otp-hash", type: recovery ? "recovery" : "email" });
    assert.equal(error, null); await setImmediate();
  }
  return { facade, native, puts, user, authenticate };
}

test("Recovery uses an early native proof and owned cleanup receipt with actual installed SDK, no real HTTP", async t => {
  const real = await realFacade(t); await real.authenticate();
  assert.equal(real.facade.getRecoverySessionProof()?.actorId, actorA);
  const f = await fixture(t, { facade: real.facade }); f.fill(); await f.ui.flush();
  const pending = f.submit()();
  for (let i = 0; i < 20 && !real.puts.length; i++) await f.ui.flush();
  assert.equal(real.puts.length, 1);
  real.puts[0].resolve(Response.json(real.user(actorA))); await pending; await f.ui.flush();
  assert.match(f.ui.text(), /Пароль обновлён/); assert.equal(f.consumed.length, 1);
  assert.equal(real.facade.getRecoverySessionProof(), null);
});

test("Recovery real SDK late A update cannot publish success or alter switched B session", async t => {
  const real = await realFacade(t); await real.authenticate();
  const f = await fixture(t, { facade: real.facade }); f.fill(); await f.ui.flush();
  const pending = f.submit()();
  for (let i = 0; i < 20 && !real.puts.length; i++) await f.ui.flush();
  assert.equal(real.puts.length, 1);
  await real.authenticate(actorB, false); await f.ui.flush();
  real.puts[0].resolve(Response.json(real.user(actorA))); await pending; await f.ui.flush();
  const { data } = await real.native.auth.getSession(); assert.equal(data.session?.user.id, actorB);
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.deepEqual(f.locations, []); assert.deepEqual(f.consumed, []);
});

test("Recovery forged URL marker plus actual ordinary session still has no recovery authority", async t => {
  const real = await realFacade(t); await real.authenticate(actorA, false);
  assert.equal(real.facade.arrivedByRecoveryLink, true); assert.equal(real.facade.getRecoverySessionProof(), null);
  const f = await fixture(t, { facade: real.facade });
  assert.match(f.ui.text(), /Ссылка недействительна/); assert.equal(real.puts.length, 0);
});

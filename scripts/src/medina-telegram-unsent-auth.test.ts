import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.env.MEDINA_TELEGRAM_UNSENT_AUTH_BASELINE_REF;
assert.ok(baseline === undefined || baseline === "7c61854", "Only the agreed read-only baseline is supported");

async function source(relative: string) {
  return baseline
    ? execFileSync("git", ["show", `${baseline}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 })
    : readFile(path.join(root, relative), "utf8");
}

function parse(relative: string, text: string) {
  return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true,
    relative.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function select(nodes: readonly import("typescript").Statement[], ast: import("typescript").SourceFile, names: string[]) {
  return names.map((name) => {
    const matches = nodes.filter((node) => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === name));
    assert.equal(matches.length, 1, `Execute exactly one actual ${name} declaration`);
    return matches[0].getText(ast);
  }).join("\n");
}

function compile(text: string) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

async function program(relative: string, names: string[]) {
  const ast = parse(relative, await source(relative));
  return compile(`${select(ast.statements, ast, names)}\nexports.selected = { ${names.join(", ")} };`);
}

// Keep the actual import so instanceof uses the same class as the real transport.
const pagePath = "artifacts/negis/src/pages/ContentStudio.tsx";
const ast = parse(pagePath, await source(pagePath));
const apiImports = ast.statements.filter((node) => ts.isImportDeclaration(node)
  && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@/lib/api");
assert.equal(apiImports.length, 1);
const session = ast.statements.find((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.ok(session?.body);
const scope = session.body.statements;
const effects = scope.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === "useLayoutEffect" && node.getText(ast).includes("onAuthStateChange"));
assert.equal(effects.length, 1);
const pageCode = compile([
  apiImports[0].getText(ast),
  select(ast.statements, ast, ["STORAGE_KEY", "safeJson", "handoffAccessDenied", "buildTelegramPackage", "parseTelegramResponse", "telegramErrorMessage"]),
  select(scope, ast, ["sessionRef", "signOutRevisionRef"]), effects[0].getText(ast),
  select(scope, ast, ["librarySnapshotRef", "libraryWritePending", "libraryReadEpoch", "libraryView", "libraryStorageKey",
    "isSessionAlive", "isGenerationSessionCurrent", "isHandoffSessionAlive", "isHandoffSessionCurrent",
    "beginLibraryWrite", "isLibraryWriteCurrent", "isLibraryWriteVerified", "runLibraryTelegram"]),
  "exports.selected = { sessionRef, librarySnapshotRef, libraryWritePending, runLibraryTelegram, buildTelegramPackage };",
].join("\n"));
const authCode = await program("artifacts/negis/src/lib/serverAuth.ts", ["getSupabaseAccessToken"]);
const apiCode = await program("artifacts/negis/src/lib/api.ts", ["CrmApiError", "resolveAccessToken", "inflightGets", "getCache",
  "REFERENCE_TTL_MS", "LIST_TTL_MS", "cacheEpoch", "isUncacheable", "ttlFor", "clearCrmCache", "crmFetch"]);
const deliveryCode = await program("lib/content-studio/telegram-delivery-guard.ts", ["readContentVideoVersion", "storageError", "duplicateError",
  "reserveTelegramDelivery", "confirmTelegramDelivery", "releaseUnsentTelegramDelivery"]);
const workspaceCode = await program("artifacts/negis/src/lib/demoStorage.ts", ["UUID_PATTERN", "isRealWorkspace"]);

function evaluate<T>(code: string, bindings: Record<string, unknown>, imports: Record<string, unknown> = {}): T {
  const exports = {};
  new Script(code, { filename: "telegram-unsent-auth.actual.cjs" }).runInNewContext({
    exports, Error, TypeError, DOMException, AbortController, Headers, Response, TextEncoder, crypto: webcrypto,
    fetch() { assert.fail("Network access is forbidden"); },
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unlisted import: ${name}`); return imports[name]; },
    ...bindings,
  }, { timeout: 1000 });
  return (exports as { selected: T }).selected;
}

type Ref<T> = { current: T };
type Row = { id: string; title: string; script: string; status: string; updatedAt: string };
type Snapshot = { form: Record<string, unknown>; videos: Row[]; activeId: string };
type Write = { snapshot: Snapshot; published?: Snapshot; persistence?: string };
type Receipt = { version: number; attemptId: string; state: string };
type Captured = {
  sessionRef: Ref<AbortController | null>; librarySnapshotRef: Ref<Snapshot>; libraryWritePending: Ref<Write | null>;
  runLibraryTelegram(test: boolean): Promise<void>; buildTelegramPackage(row: Row): string;
};
type Api = {
  CrmApiError: new (status: number, code: string, message: string) => Error & { status: number; code: string };
  crmFetch(url: string, init: RequestInit): Promise<Response>;
};
type SdkFailure = "missing" | "error" | "wrong-actor" | "throw";
type Mode = "sent" | "network" | "type-error" | "abort" | "lookalike" | "error-lookalike"
  | "wrong-crm-code" | "wrong-crm-status" | "http502" | "partial" | "unknown" | "http401" | "http403"
  | "recipient-refused" | "recipient-wrong-status" | "recipient-missing-proof" | "recipient-partial" | "recipient-stale";

function fixture() {
  const actorId = "synthetic-A", workspaceId = "11111111-1111-4111-8111-111111111111";
  const row: Row = { id: "33333333-3333-4333-8333-333333333333", title: "Synthetic unsent auth package",
    script: "A".repeat(3499) + "\uD83D\uDE00" + "B".repeat(3501), status: "idea", updatedAt: "2026-10-24T08:00:00.123456Z" };
  const records = new Map<string, string>(), failures = new Map<number, SdkFailure>();
  const posts: Array<{ path: string; body: unknown }> = [], events: string[] = [], notices: string[] = [];
  const toasts: Array<{ kind: string; message: string }> = [];
  const listeners = new Set<(event: string, value: { user: { id: string } }) => void>();
  let sdkReads = 0, releaseCalls = 0, statusWrites = 0, loading: string | null = null;
  let mode: Mode = "sent", patchFailure = false;
  let cleanup: (() => void) | undefined, onFailure: ((error: unknown) => void) | undefined;
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem(key: string, raw: string) { records.set(key, raw); events.push(`store:${JSON.parse(raw).state}`); },
    removeItem(key: string) { records.delete(key); events.push("remove"); },
  };
  const supabase = { auth: {
    async getSession() {
      sdkReads++; events.push(`auth:${sdkReads}`);
      if (sdkReads === 3) {
        assert.equal(posts.length, 0, "The transport lookup must follow reservation but precede POST");
        assert.equal(records.size, 1);
        assert.equal(JSON.parse([...records.values()][0]).state, "uncertain");
      }
      const failure = failures.get(sdkReads);
      if (failure === "throw") throw Error("Synthetic SDK throw");
      return { data: { session: failure === "missing" ? null : {
        user: { id: failure === "wrong-actor" ? "synthetic-B" : actorId }, access_token: "synthetic-fixture-only",
      } }, error: failure === "error" ? { message: "Synthetic transient SDK refusal" } : null };
    },
    onAuthStateChange(listener: (event: string, value: { user: { id: string } }) => void) {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe() { listeners.delete(listener); } } } };
    },
  } };
  const auth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(authCode, {
    hasSupabaseFrontendEnv: true, supabase, sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange },
    isSignOutPending: () => false, getSignOutRevision: () => 0,
  });
  let captured: Captured;
  const api = evaluate<Api>(apiCode, {
    apiUrl: (url: string) => url,
    async fetch(url: string, init: RequestInit) {
      assert.equal(url, `/api/content-studio/send-telegram?workspaceId=${workspaceId}`);
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-fixture-only");
      assert.equal(records.size, 1, "A POST must have a persisted receipt");
      posts.push({ path: url, body: JSON.parse(String(init.body)) }); events.push("POST");
      if (mode === "network") throw Error("Synthetic ambiguous network failure");
      if (mode === "type-error") throw TypeError("Synthetic failed fetch");
      if (mode === "abort") throw new DOMException("Synthetic aborted response", "AbortError");
      if (mode === "lookalike") throw { name: "CrmApiError", status: 401, code: "authentication_required" };
      if (mode === "error-lookalike") throw Object.assign(Error("Synthetic lookalike"), { name: "CrmApiError", status: 401, code: "authentication_required" });
      if (mode === "wrong-crm-code") throw new api.CrmApiError(401, "different_code", "Synthetic different refusal");
      if (mode === "wrong-crm-status") throw new api.CrmApiError(403, "authentication_required", "Synthetic different status");
      const recipient = mode.startsWith("recipient-");
      const status = mode === "http401" ? 401 : mode === "http403" ? 403
        : mode === "http502" || mode === "partial" || mode === "recipient-wrong-status" ? 502 : recipient ? 503 : 200;
      return { ok: status === 200, status, async text() {
        if (mode === "recipient-stale") for (const listener of listeners) listener("SIGNED_IN", { user: { id: "synthetic-B" } });
        if (status !== 200) return JSON.stringify({ success: false, error: "Synthetic server refusal",
          ...(recipient ? { code: "telegram_recipient_unconfirmed",
            ...(mode === "recipient-missing-proof" ? {} : { data: { sent: false, phase: "recipient_lookup" } }),
            ...(mode === "recipient-partial" ? { part: 2, totalParts: 4 } : {}) } : {}),
          ...(mode === "partial" ? { part: 2, totalParts: 4 } : {}) });
        if (mode === "unknown") return "{unreadable";
        return JSON.stringify({ success: true, mode: "telegram", data: {
          sent: true, test: false, parts: 4, packageText: captured.buildTelegramPackage(row),
        } });
      } };
    },
  }, { "@/lib/serverAuth": auth });
  const delivery = evaluate<Record<string, (...args: unknown[]) => unknown>>(deliveryCode, {});
  const workspace = evaluate<Record<string, unknown>>(workspaceCode, {});
  function mount() {
    cleanup?.(); loading = null;
    captured = evaluate<Captured>(pageCode, {
      ...auth, ...delivery, ...workspace, actorId, workspaceId, localDraftsOnly: false,
      hasSupabaseFrontendEnv: true, supabase, sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange },
      readWorkspaceId: () => workspaceId,
      isSignOutPending: () => false, getSignOutRevision: () => 0,
      form: {}, videos: [row], activeId: row.id,
      useRef: <T>(current: T) => ({ current }), useLayoutEffect(create: () => () => void) { cleanup = create(); },
      window: { localStorage: storage }, navigator: { locks: { async request(_key: string, work: () => unknown) { return work(); } } },
      releaseUnsentTelegramDelivery(...args: unknown[]) { releaseCalls++; events.push("release"); return delivery.releaseUnsentTelegramDelivery(...args); },
      setLoading(value: string | null | ((current: string | null) => string | null)) { loading = typeof value === "function" ? value(loading) : value; },
      setNotice(message: string) { notices.push(message); },
      toast: Object.fromEntries(["error", "warning", "success"].map((kind) => [kind, (message: string) => toasts.push({ kind, message })])),
      async applyCurrentVideoPatch(patch: { status: string }, write: Write) {
        statusWrites++;
        if (patchFailure) throw new api.CrmApiError(401, "authentication_required", "Synthetic post-delivery auth refusal");
        write.published = { ...write.snapshot, videos: [{ ...row, ...patch }] };
        captured.librarySnapshotRef.current = write.published; write.persistence = "server";
        return true;
      },
    }, { "@/lib/api": { ...api, crmFetch: async (url: string, init: RequestInit) => {
      try { return await api.crmFetch(url, init); }
      catch (error) { onFailure?.(error); throw error; }
    } } });
    return captured;
  }
  mount();
  return {
    records, failures, posts, events, notices, toasts, api, row, mount,
    send: () => captured.runLibraryTelegram(false),
    mode(value: Mode) { mode = value; },
    failPatch() { patchFailure = true; },
    observeFailure(callback: (error: unknown) => void) { onFailure = callback; },
    expire() { for (const listener of listeners) listener("SIGNED_IN", { user: { id: "synthetic-B" } }); },
    receipt(): Receipt { assert.equal(records.size, 1); return JSON.parse([...records.values()][0]) as Receipt; },
    counts() { return { sdkReads, releaseCalls, statusWrites, loading, pending: captured.libraryWritePending.current !== null }; },
    dispose() { cleanup?.(); assert.equal(listeners.size, 0); },
  };
}

for (const failure of ["missing", "error", "wrong-actor"] as const) {
  test(`actual pre-dispatch ${failure}: release, reload, and same-package POST recovery`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.failures.set(3, failure);
    let refused = false;
    f.observeFailure((error) => {
      assert.ok(error instanceof f.api.CrmApiError); assert.equal(error.status, 401); assert.equal(error.code, "authentication_required");
      assert.equal(f.posts.length, 0); assert.equal(f.receipt().state, "uncertain"); refused = true;
    });
    await f.send();
    assert.equal(refused, true); assert.equal(f.posts.length, 0); assert.equal(f.records.size, 0);
    assert.deepEqual(f.counts(), { sdkReads: 4, releaseCalls: 1, statusWrites: 0, loading: null, pending: false });
    assert.ok(f.events.indexOf("release") < f.events.indexOf("auth:4"), "Release precedes asynchronous current verification");
    assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].kind, "error"); assert.match(f.notices.at(-1)!, /отозван/);
    f.mount(); await f.send();
    assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0].body, f.row); assert.equal(f.receipt().state, "sent");
    assert.equal(f.counts().statusWrites, 1); assert.equal(f.counts().pending, false); assert.equal(f.counts().loading, null);
    assert.equal(f.toasts.filter((toast) => toast.kind === "success").length, 1);
  });
}

test("proven unsent release does not wait for a second failed SDK verification", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.failures.set(3, "error"); f.failures.set(4, "error");
  await f.send();
  assert.equal(f.posts.length, 0); assert.equal(f.records.size, 0); assert.deepEqual(f.toasts, []);
  assert.deepEqual(f.notices, [""]); assert.ok(f.events.indexOf("release") < f.events.indexOf("auth:4"));
  assert.equal(f.counts().pending, false); assert.equal(f.counts().loading, null);
  await f.send(); assert.equal(f.posts.length, 1); assert.equal(f.receipt().state, "sent");
});

test("stale account after the actual pre-dispatch refusal releases its receipt without late UI", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.failures.set(3, "missing");
  f.observeFailure(() => f.expire());
  await f.send();
  assert.equal(f.posts.length, 0); assert.equal(f.records.size, 0); assert.deepEqual(f.toasts, []); assert.deepEqual(f.notices, [""]);
  assert.equal(f.counts().sdkReads, 3); assert.equal(f.counts().pending, false);
  f.mount(); await f.send(); assert.equal(f.posts.length, 1); assert.equal(f.receipt().state, "sent");
});

for (const replacement of ["newer-uncertain", "newer-sent", "same-attempt-sent"] as const) {
  test(`stale pre-dispatch cleanup preserves ${replacement} receipt`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.failures.set(3, "error");
    let expected = "";
    f.observeFailure(() => {
      const [key, raw] = [...f.records][0], previous = JSON.parse(raw) as Receipt;
      expected = JSON.stringify({ ...previous, attemptId: replacement === "same-attempt-sent" ? previous.attemptId : "synthetic-newer-attempt",
        state: replacement === "newer-uncertain" ? "uncertain" : "sent" });
      f.records.set(key, expected); f.expire();
    });
    await f.send();
    assert.equal(f.counts().releaseCalls, 1, "Attempt scoped cleanup even when the session has ended");
    assert.deepEqual([...f.records.values()], [expected]); assert.equal(f.posts.length, 0); assert.deepEqual(f.toasts, []);
    f.mount(); await f.send();
    assert.equal(f.posts.length, 0); assert.deepEqual([...f.records.values()], [expected]);
    assert.match(f.notices.at(-1)!, /повторная отправка заблокирована/); assert.equal(f.counts().pending, false);
  });
}

test("a thrown SDK Error is not proof of the specific unsent auth refusal", async (t) => {
  const f = fixture(); t.after(() => f.dispose()); f.failures.set(3, "throw");
  await f.send(); const original = [...f.records.values()][0];
  assert.equal(f.posts.length, 0); assert.equal(f.receipt().state, "uncertain"); assert.equal(f.counts().releaseCalls, 0);
  f.mount(); await f.send();
  assert.equal(f.posts.length, 0); assert.deepEqual([...f.records.values()], [original]); assert.match(f.notices.at(-1)!, /повторная отправка заблокирована/);
});

for (const mode of ["network", "type-error", "abort", "lookalike", "error-lookalike", "wrong-crm-code", "wrong-crm-status",
  "http502", "partial", "unknown", "recipient-wrong-status", "recipient-missing-proof", "recipient-partial"] as const) {
  test(`ambiguous ${mode} retains its receipt and blocks replay after reload`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.mode(mode);
    await f.send(); const original = [...f.records.values()][0];
    assert.equal(f.posts.length, 1); assert.equal(f.receipt().state, "uncertain");
    assert.equal(f.counts().releaseCalls, 0); assert.equal(f.counts().statusWrites, 0); assert.equal(f.counts().pending, false); assert.equal(f.counts().loading, null);
    assert.equal(f.toasts.some((toast) => toast.kind === "success"), false);
    f.mode("sent"); f.mount(); await f.send();
    assert.equal(f.posts.length, 1); assert.deepEqual([...f.records.values()], [original]); assert.match(f.notices.at(-1)!, /повторная отправка заблокирована/);
  });
}

test("confirmed pre-admission recipient refusal releases only its receipt for a later manual retry", async t => {
  const f = fixture();t.after(() => f.dispose());f.mode("recipient-refused");
  await f.send();
  assert.equal(f.posts.length, 1, "No automatic lookup or delivery retry");assert.equal(f.records.size, 0);
  assert.equal(f.counts().releaseCalls, 1);assert.equal(f.counts().statusWrites, 0);
  assert.equal(f.counts().pending, false);assert.equal(f.counts().loading, null);
  assert.equal(f.toasts.some(toast => toast.kind === "success"), false);
  assert.match(f.notices.at(-1)!, /В этом запросе сообщения не отправлялись/);
  assert.doesNotMatch(f.notices.at(-1)!, /часть сообщения могла быть доставлена/);
  f.mode("sent");f.mount();await f.send();
  assert.equal(f.posts.length, 2);assert.equal(f.receipt().state, "sent");assert.equal(f.counts().statusWrites, 1);
});

test("known unsent lookup releases its old attempt after account replacement without publishing late UI", async t => {
  const f = fixture();t.after(() => f.dispose());f.mode("recipient-stale");
  await f.send();assert.equal(f.posts.length, 1);assert.equal(f.records.size, 0);assert.equal(f.counts().releaseCalls, 1);
  assert.deepEqual(f.toasts, []);assert.deepEqual(f.notices, [""]);assert.equal(f.counts().statusWrites, 0);
  f.mode("sent");f.mount();await f.send();assert.equal(f.posts.length, 2);assert.equal(f.receipt().state, "sent");
});

for (const mode of ["http401", "http403"] as const) {
  test(`existing server ${mode} denial still releases its own receipt and clears loading`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.mode(mode);
    await f.send();
    assert.equal(f.posts.length, 1); assert.equal(f.records.size, 0); assert.equal(f.counts().releaseCalls, 1);
    assert.equal(f.counts().statusWrites, 0); assert.equal(f.counts().pending, false); assert.equal(f.counts().loading, null);
    assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].kind, "error"); assert.match(f.notices.at(-1)!, /отозван/);
  });
}

for (const failedStatus of [false, true]) {
  test(`delivered package ${failedStatus ? "with post-delivery CrmApiError" : "success"} never releases or resends`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); if (failedStatus) f.failPatch();
    await f.send(); const original = [...f.records.values()][0];
    assert.equal(f.posts.length, 1); assert.equal(f.receipt().state, "sent"); assert.equal(f.counts().releaseCalls, 0);
    assert.equal(f.counts().statusWrites, 1); assert.equal(f.counts().pending, false); assert.equal(f.counts().loading, null);
    assert.equal(f.toasts[0].kind, failedStatus ? "warning" : "success");
    f.mount(); await f.send(); assert.equal(f.posts.length, 1); assert.deepEqual([...f.records.values()], [original]);
  });
}

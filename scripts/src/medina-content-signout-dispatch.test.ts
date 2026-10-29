import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Working tree by default. Set only MEDINA_CONTENT_SIGNOUT_BASELINE_REF=6fa47ad
// for the red run; git show reads the old page without changing the checkout.
// No React commit, real SDK, network, browser, clipboard or database is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.env.MEDINA_CONTENT_SIGNOUT_BASELINE_REF;
assert.ok(baseline === undefined || baseline === "6fa47ad", "Only the agreed baseline is supported");
const pagePath = "artifacts/negis/src/pages/ContentStudio.tsx";
const page = baseline
  ? execFileSync("git", ["show", `${baseline}:${pagePath}`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 })
  : await readFile(path.join(root, pagePath), "utf8");
const ast = ts.createSourceFile(pagePath, page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sessions = ast.statements.filter((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.equal(sessions.length, 1);
const scope = sessions[0].body!.statements;

function select(nodes: readonly import("typescript").Statement[], source: import("typescript").SourceFile, names: string[]) {
  return names.map((name) => {
    const matches = nodes.filter((node) => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === name));
    assert.equal(matches.length, 1, `Execute exactly one actual ${name} declaration`);
    return matches[0].getText(source);
  }).join("\n");
}

function compile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

async function moduleCode(relative: string, names?: string[]) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (!names) return compile(source);
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return compile(select(parsed.statements, parsed, names) + `\nexports.selected = { ${names.join(", ")} };`);
}

const revisionRefs = scope.filter((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => item.initializer && ts.isCallExpression(item.initializer)
    && item.initializer.expression.getText(ast) === "useRef" && item.initializer.getText(ast).includes("getSignOutRevision")));
assert.equal(revisionRefs.length, baseline ? 0 : 1, "Capture the real mount-time revision ref, never a default zero");
const effects = scope.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === "useLayoutEffect" && node.getText(ast).includes("onAuthStateChange"));
assert.equal(effects.length, 1);
const pageCode = compile([
  select(ast.statements, ast, ["STORAGE_KEY", "safeJson", "handoffAccessDenied", "buildTelegramPackage", "parseTelegramResponse", "telegramErrorMessage"]),
  select(scope, ast, ["sessionRef"]), ...revisionRefs.map((node) => node.getText(ast)), effects[0].getText(ast),
  select(scope, ast, ["librarySnapshotRef", "libraryWritePending", "libraryReadEpoch", "clipboardPending", "libraryView", "libraryStorageKey",
    "photoArtifactRef", "photoRenderPending", "isSessionAlive", "isGenerationSessionCurrent", "isHandoffSessionAlive", "isHandoffSessionCurrent",
    "beginLibraryWrite", "isLibraryWriteCurrent", "isLibraryWriteVerified", "isPhotoArtifactCurrent", "runLibraryTelegram", "downloadPhotoCreative", "copyText"]),
  "exports.selected = { sessionRef, librarySnapshotRef, clipboardPending, photoArtifactRef, isSessionAlive, isHandoffSessionAlive, runLibraryTelegram, downloadPhotoCreative, copyText, buildTelegramPackage };",
].join("\n"));
const signOutCode = await moduleCode("artifacts/negis/src/lib/authSignOut.ts");
const authCode = await moduleCode("artifacts/negis/src/lib/serverAuth.ts");
const apiCode = await moduleCode("artifacts/negis/src/lib/api.ts", ["CrmApiError", "resolveAccessToken", "inflightGets", "getCache",
  "REFERENCE_TTL_MS", "LIST_TTL_MS", "cacheEpoch", "isUncacheable", "ttlFor", "clearCrmCache", "crmFetch"]);
const deliveryCode = await moduleCode("lib/content-studio/telegram-delivery-guard.ts");
const workspaceCode = await moduleCode("artifacts/negis/src/lib/demoStorage.ts", ["UUID_PATTERN", "isRealWorkspace"]);

function evaluate<T>(code: string, bindings: Record<string, unknown>, imports: Record<string, unknown> = {}): T {
  const exports = {};
  new Script(code, { filename: "content-signout.actual.cjs" }).runInNewContext({
    exports, Error, DOMException, AbortController, Headers, Response, TextEncoder, crypto: webcrypto,
    fetch() { assert.fail("Unlisted network access"); },
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unlisted import: ${name}`); return imports[name]; },
    ...bindings,
  }, { timeout: 1000 });
  return exports as T;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Phase = "pending" | "cleared";
type Ref<T> = { current: T };
type SignOut = { markSignOutPending(): void; clearSignOutPending(): boolean; isSignOutPending(): boolean; getSignOutRevision(): number };
type Captured = {
  sessionRef: Ref<AbortController | null>; librarySnapshotRef: Ref<unknown>; clipboardPending: Ref<unknown>; photoArtifactRef: Ref<unknown>;
  isSessionAlive(session: AbortController): boolean; isHandoffSessionAlive(session: AbortController): boolean;
  runLibraryTelegram(test: boolean): Promise<void>; downloadPhotoCreative(): Promise<void>; copyText(text: string, label: string): Promise<boolean>;
  buildTelegramPackage(video: Record<string, unknown>): string;
};

function fixture(demo = false, freshAfterSignOut = false) {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  };
  const window = { localStorage: memory(), sessionStorage: memory() };
  const signOut = evaluate<SignOut>(signOutCode, { window });
  if (freshAfterSignOut) { signOut.markSignOutPending(); assert.equal(signOut.clearSignOutPending(), true); }
  const mountRevision = signOut.getSignOutRevision();
  const actorId = demo ? "" : "synthetic-A";
  const workspaceId = demo ? "demo-signout-workspace" : "11111111-1111-4111-8111-111111111111";
  const notices: string[] = [], toasts: Array<{ kind: string; message: string }> = [], anchors: string[] = [], copies: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const bodyStarted = deferred<void>(), bodyGate = deferred<void>(), copyStarted = deferred<void>(), copyGate = deferred<void>();
  let holdBody = false, holdCopy = false, tokenReads = 0, statusWrites = 0, hookCalls = 0;
  let token = "synthetic-token-A";
  let pageTokenHook: (() => void) | undefined, transportTokenHook: (() => void) | undefined, finalCopyHook: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const listeners = new Set<unknown>();
  const supabase = { auth: {
    async getSession() { tokenReads++; return { data: { session: { user: { id: actorId }, access_token: token } }, error: null }; },
    onAuthStateChange(listener: unknown) { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; },
  } };
  const auth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(authCode, {}, {
    "@/lib/supabase": { supabase, hasSupabaseFrontendEnv: true,
      sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } }, "@/lib/authSignOut": signOut,
  });
  const tokenLookup = (transport: boolean) => async (expected?: string) => {
    const value = await auth.getSupabaseAccessToken(expected);
    const hook = transport ? transportTokenHook : pageTokenHook;
    if (value && hook) {
      if (transport) transportTokenHook = undefined; else pageTokenHook = undefined;
      hookCalls++; hook();
    }
    return value;
  };
  const { selected: api } = evaluate<{ selected: { crmFetch(path: string, init: RequestInit): Promise<Response> } }>(apiCode, {
    apiUrl: (url: string) => url,
    async fetch(url: string, init: RequestInit) {
      assert.equal(url, `/api/content-studio/send-telegram?workspaceId=${workspaceId}`);
      assert.equal(init.method, "POST"); assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${token}`);
      const row = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(row.id, "33333333-3333-4333-8333-333333333333");
      posts.push({ path: url, body: row });
      return { ok: true, status: 200, async text() {
        bodyStarted.resolve(); if (holdBody) await bodyGate.promise;
        // A synthetic unsent response proves dispatch, not successful delivery.
        return JSON.stringify({ success: true, mode: "demo", data: { sent: false, test: false, packageText: captured.buildTelegramPackage(row) } });
      } };
    },
  }, { "@/lib/serverAuth": { getSupabaseAccessToken: tokenLookup(true) } });
  const delivery = evaluate<Record<string, unknown>>(deliveryCode, {});
  const { selected: workspace } = evaluate<{ selected: Record<string, unknown> }>(workspaceCode, { readWorkspaceId: () => workspaceId });
  const form = { title: "Synthetic signout idea" }, videos = [{ ...form, id: "33333333-3333-4333-8333-333333333333", updatedAt: "2026-10-24T08:00:00.123456Z" }];
  const inputs = { format: "feed" }, photoBlob = new Blob(["synthetic JPEG fixture"], { type: "image/jpeg" });
  const photoTextInputsRef = { current: inputs }, photoTextRevision = { current: 0 };
  const { selected: captured } = evaluate<{ selected: Captured }>(pageCode, {
    ...signOut, ...delivery, ...workspace, ...api, window, actorId, workspaceId, localDraftsOnly: demo,
    form, videos, activeId: videos[0].id, readWorkspaceId: () => workspaceId,
    hasSupabaseFrontendEnv: !demo, supabase, sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange },
    getSupabaseAccessToken: tokenLookup(false),
    useRef: <T>(current: T) => ({ current }), useLayoutEffect(create: () => () => void) { cleanup = create(); },
    photoTextInputsRef, photoTextRevision, photoBlob, photoPreviewUrl: "blob:synthetic-jpeg",
    document: { createElement(tag: string) { assert.equal(tag, "a"); return { href: "", download: "", click() { anchors.push("download"); } }; } },
    navigator: {
      locks: { async request(_key: string, callback: () => unknown) { return callback(); } },
      clipboard: { async writeText(text: string) { copies.push(text); copyStarted.resolve(); if (holdCopy) await copyGate.promise; } },
    },
    setLoading() {}, setNotice: (message: string) => notices.push(message),
    applyCurrentVideoPatch() { statusWrites++; assert.fail("An unsent Telegram response must never persist readiness"); },
    toast: Object.fromEntries(["success", "warning", "error"].map((kind) => [kind, (message: string) => toasts.push({ kind, message })])),
  });
  const controller = captured.sessionRef.current!;
  assert.ok(controller);
  captured.photoArtifactRef.current = { blob: photoBlob, previewUrl: "blob:synthetic-jpeg", inputs, revision: 0, session: controller };
  const snapshot = captured.librarySnapshotRef.current;
  let sourceChecks = 0;
  Object.defineProperty(captured.librarySnapshotRef, "current", { get() {
    sourceChecks++;
    if (finalCopyHook && sourceChecks === 3) {
      const hook = finalCopyHook; finalCopyHook = undefined;
      // verified() has just accepted its final source check. Expire before its caller resumes.
      queueMicrotask(() => { hookCalls++; hook(); });
    }
    return snapshot;
  } });
  return {
    captured, controller, signOut, notices, toasts, posts, anchors, copies,
    expire(phase: Phase) {
      signOut.markSignOutPending(); if (phase === "cleared") assert.equal(signOut.clearSignOutPending(), true);
      assert.equal(signOut.getSignOutRevision(), mountRevision + 1); assert.equal(signOut.isSignOutPending(), phase === "pending");
      assert.equal(captured.sessionRef.current, controller); assert.equal(controller.signal.aborted, false);
      assert.equal(listeners.size, demo ? 0 : 1, "No React commit replaces the captured session subscription");
    },
    afterToken(callback: () => void, transport = false) { if (transport) transportTokenHook = callback; else pageTokenHook = callback; },
    afterVerifiedCopy(callback: () => void) { sourceChecks = 0; finalCopyHook = callback; },
    holdTelegramBody() { holdBody = true; return bodyStarted.promise; }, releaseTelegramBody() { bodyGate.resolve(); },
    holdClipboard() { holdCopy = true; return copyStarted.promise; }, releaseClipboard() { copyGate.resolve(); },
    refreshToken() { token = "synthetic-refreshed-A"; },
    counts() { return { posts: posts.length, anchors: anchors.length, copies: copies.length, statusWrites, tokenReads, hookCalls, toasts: toasts.length }; },
    dispose() { bodyGate.resolve(); copyGate.resolve(); cleanup?.(); assert.equal(listeners.size, 0); },
  };
}

for (const demo of [false, true]) for (const phase of ["pending", "cleared"] as const) {
  test(`signout guard ${demo ? "local demo" : "owner"}: ${phase}, no commit`, (t) => {
    const f = fixture(demo); t.after(() => f.dispose()); f.expire(phase);
    assert.equal(f.captured.isSessionAlive(f.controller), false);
    assert.equal(f.captured.isHandoffSessionAlive(f.controller), false);
    assert.deepEqual(f.counts(), { posts: 0, anchors: 0, copies: 0, statusWrites: 0, tokenReads: 0, hookCalls: 0, toasts: 0 });
  });
}

for (const phase of ["pending", "cleared"] as const) for (const boundary of ["before token", "after token", "body completion"] as const) {
  test(`signout Telegram ${phase}: ${boundary}`, { timeout: 5000 }, async (t) => {
    const f = fixture(); t.after(() => f.dispose());
    if (boundary === "before token") f.expire(phase);
    if (boundary === "after token") f.afterToken(() => f.expire(phase), true);
    const started = boundary === "body completion" ? f.holdTelegramBody() : undefined;
    const work = f.captured.runLibraryTelegram(false);
    let noticeCount = 0;
    if (started) { await started; noticeCount = f.notices.length; f.expire(phase); f.releaseTelegramBody(); }
    await work;
    assert.equal(f.posts.length, started ? 1 : 0, "Only an already-dispatched POST may survive signout");
    assert.equal(f.counts().statusWrites, 0); assert.deepEqual(f.toasts, []);
    assert.equal(f.notices.length, boundary === "after token" ? 1 : noticeCount, "No stale notice after signout");
    if (boundary === "before token") assert.equal(f.counts().tokenReads, 0);
    if (boundary === "after token") assert.equal(f.counts().hookCalls, 1);
  });
}

for (const phase of ["pending", "cleared"] as const) for (const boundary of ["before token", "after token"] as const) {
  test(`signout JPEG ${phase}: ${boundary}`, async (t) => {
    const f = fixture(); t.after(() => f.dispose());
    if (boundary === "before token") f.expire(phase); else f.afterToken(() => f.expire(phase));
    await f.captured.downloadPhotoCreative();
    assert.deepEqual(f.anchors, []); assert.deepEqual(f.toasts, []); assert.deepEqual(f.posts, []);
    assert.equal(f.counts().tokenReads, boundary === "before token" ? 0 : 1);
    assert.equal(f.counts().hookCalls, boundary === "before token" ? 0 : 1);
  });
}

for (const demo of [false, true]) for (const phase of ["pending", "cleared"] as const) {
  test(`signout clipboard ${demo ? "local demo" : "owner"} ${phase}: final verified microtask`, async (t) => {
    const f = fixture(demo); t.after(() => f.dispose()); f.afterVerifiedCopy(() => f.expire(phase));
    const accepted = await f.captured.copyText("Synthetic clipboard text", "TEST");
    assert.equal(f.counts().hookCalls, 1, "The expiry must land after the final verified source check");
    assert.equal(accepted, false); assert.deepEqual(f.copies, []); assert.deepEqual(f.toasts, []); assert.deepEqual(f.notices, []);
    assert.equal(f.captured.clipboardPending.current, null);
  });
}

for (const phase of ["pending", "cleared"] as const) {
  test(`signout clipboard owner ${phase}: completion cannot publish success`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); const started = f.holdClipboard();
    const work = f.captured.copyText("Synthetic clipboard text", "TEST");
    await started; assert.equal(f.copies.length, 1); f.expire(phase); f.releaseClipboard();
    assert.equal(await work, false); assert.equal(f.copies.length, 1); assert.deepEqual(f.toasts, []); assert.deepEqual(f.notices, []);
    assert.equal(f.captured.clipboardPending.current, null);
  });
}

for (const control of ["Telegram", "JPEG", "owner clipboard", "demo clipboard"] as const) {
  test(`current ${control}: fresh mount after cleared signout still works`, async (t) => {
    const f = fixture(control === "demo clipboard", true); t.after(() => f.dispose()); f.refreshToken();
    assert.equal(f.signOut.getSignOutRevision(), 1); assert.equal(f.signOut.isSignOutPending(), false);
    assert.equal(f.captured.isHandoffSessionAlive(f.controller), true);
    if (control === "Telegram") {
      await f.captured.runLibraryTelegram(false);
      assert.equal(f.posts.length, 1); assert.equal(f.counts().statusWrites, 0);
      assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].kind, "warning", "sent:false is never delivery success");
      assert.equal(f.counts().tokenReads, 5);
    } else if (control === "JPEG") {
      await f.captured.downloadPhotoCreative(); assert.deepEqual(f.anchors, ["download"]);
      assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].kind, "success"); assert.equal(f.counts().tokenReads, 1);
    } else {
      assert.equal(await f.captured.copyText("Synthetic clipboard text", "TEST"), true);
      assert.deepEqual(f.copies, ["Synthetic clipboard text"]); assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0].kind, "success");
      assert.equal(f.counts().tokenReads, control === "demo clipboard" ? 0 : 2);
    }
  });
}

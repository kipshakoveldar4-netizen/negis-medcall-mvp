import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual wrapper, session subscription, local restore callback and copy handler.
// Hooks capture callbacks without a React commit; storage/auth/clipboard are synthetic.
// This tests the pre-passive-effect boundary, not React DOM or browser acceptance.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pagePath = "artifacts/negis/src/pages/ContentStudio.tsx";
const source = await readFile(path.join(root, pagePath), "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sessions = ast.statements.filter((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.equal(sessions.length, 1);
const scope = sessions[0].body!.statements;

function select(nodes: readonly import("typescript").Statement[], parsed: import("typescript").SourceFile, name: string) {
  const matches = nodes.filter((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(parsed) === name));
  assert.equal(matches.length, 1, `Execute exactly one actual ${name} declaration`);
  return matches[0].getText(parsed);
}

function calls(node: import("typescript").Node, name: string): boolean {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === name) return true;
  return ts.forEachChild(node, (child) => calls(child, name) || undefined) === true;
}

function effect(hook: string, contains: string, localDraftsOnly = false) {
  const matches = scope.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(ast) === hook && calls(node.expression.arguments[0], contains)
    && (!localDraftsOnly || node.expression.arguments[0].getText(ast).includes("localDraftsOnly")));
  assert.equal(matches.length, 1, `Execute exactly one actual ${contains} ${hook}`);
  return matches[0] as import("typescript").ExpressionStatement & { expression: import("typescript").CallExpression };
}

const restore = effect("useEffect", "readVideos", true);
const lifetime = effect("useLayoutEffect", "sessionAuth.onAuthStateChange");
const local = (name: string) => select(scope, ast, name);
const top = (name: string) => select(ast.statements, ast, name);

function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}

const pageCode = compile([
  ...["STORAGE_KEY", "statusLabels", "parseContentVideo", "readVideos", "ContentStudio"].map(top),
  "function ContentStudioSession({ actorId, workspaceId, localDraftsOnly }) {",
  ...["sessionRef", "signOutRevisionRef"].map(local), lifetime.getText(ast),
  ...["isSessionAlive", "isGenerationSessionCurrent", "isHandoffSessionAlive", "isHandoffSessionCurrent",
    "librarySnapshotRef", "clipboardPending", "libraryStorageKey"].map(local),
  `return { sessionRef, librarySnapshotRef, clipboardPending, libraryStorageKey,
    alive: () => isHandoffSessionAlive(sessionRef.current),
    restore: ${restore.expression.arguments[0].getText(ast)},
    captureCopy() { ${local("libraryView")} ${local("copyText")} return copyText; }
  }; }`,
  "exports.selected = { ContentStudio, ContentStudioSession };",
].join("\n"), "content-draft-restore.fixture.tsx");
const markerCode = compile(await readFile(path.join(root, "artifacts/negis/src/lib/authSignOut.ts"), "utf8"), "authSignOut.ts");
const workspaceSource = await readFile(path.join(root, "artifacts/negis/src/lib/demoStorage.ts"), "utf8");
const workspaceAst = ts.createSourceFile("demoStorage.ts", workspaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const workspaceCode = compile([
  ...["UUID_PATTERN", "isRealWorkspace"].map((name) => select(workspaceAst.statements, workspaceAst, name)),
  "exports.isRealWorkspace = isRealWorkspace;",
].join("\n"), "workspace.fixture.ts");

function evaluate<T>(code: string, bindings: Record<string, unknown> = {}, imports: Record<string, unknown> = {}): T {
  const exports = {};
  new Script(code, { filename: "content-draft-restore.actual.cjs" }).runInNewContext({
    exports, AbortController,
    fetch() { assert.fail("Network access is forbidden"); },
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unlisted import: ${name}`); return imports[name]; },
    ...bindings,
  }, { timeout: 1000 });
  return exports as T;
}

type Ref<T> = { current: T };
type Draft = { id: string; title: string; niche: string; goal: string; duration: string; style: string;
  audience: string; status: string; createdAt: string; avatarPrompt: string };
type Snapshot = { form: object; videos: Draft[]; activeId: string };
type Captured = {
  restore(): void;
  captureCopy(): (text: string, label: string, source?: "library") => Promise<boolean>;
  alive(): boolean;
  sessionRef: Ref<AbortController | null>;
  librarySnapshotRef: Ref<Snapshot>;
  clipboardPending: Ref<object | null>;
  libraryStorageKey: string;
};
type Marker = { markSignOutPending(): void; clearSignOutPending(): boolean; getSignOutRevision(): number; isSignOutPending(): boolean };
const draft: Draft = { id: "content-synthetic-local-draft", title: "TEST local idea", niche: "TEST niche", goal: "TEST goal",
  duration: "30", style: "TEST style", audience: "TEST audience", status: "idea", createdAt: "2090-01-01T00:00:00Z",
  avatarPrompt: "TEST restored plain text" };

function fixture({ actor = "", freshAfterSignOut = false } = {}) {
  const reads: string[] = [];
  let onRead: ((key: string) => void) | undefined;
  const memory = () => {
    const values = new Map<string, string>();
    return {
      getItem(key: string) {
        reads.push(key);
        const value = values.get(key) ?? null;
        onRead?.(key);
        return value;
      },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    };
  };
  const window = { localStorage: memory(), sessionStorage: memory() };
  const marker = evaluate<Marker>(markerCode, { window });
  if (freshAfterSignOut) { marker.markSignOutPending(); assert.equal(marker.clearSignOutPending(), true); }
  const workspaceId = "demo-draft-restore-test";
  const workspace = evaluate<{ isRealWorkspace(id: string): boolean }>(workspaceCode);
  const listeners = new Set<(event: string, next: { user: { id: string } } | null) => void>();
  const cleanups: Array<() => void> = [];
  const state: { videos: Draft[]; activeId: string } = { videos: [], activeId: "" };
  const writes: string[] = [], copies: string[] = [], toasts: string[] = [], notices: string[] = [];
  const sessionAuth = { onAuthStateChange(listener: Parameters<typeof listeners.add>[0]) {
    listeners.add(listener);
    return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } };
  const { selected } = evaluate<{ selected: {
    ContentStudio(): { props: { actorId: string; workspaceId: string; localDraftsOnly: boolean } };
    ContentStudioSession(props: object): Captured;
  } }>(pageCode, {
    ...marker, ...workspace, window, localStorage: window.localStorage,
    form: {}, videos: state.videos, activeId: state.activeId,
    readWorkspaceId: () => workspaceId, hasSupabaseFrontendEnv: true,
    useAuth: () => ({ user: actor ? { id: actor } : null, userRole: "owner", clinicId: workspaceId, workspacePurpose: "test",
      isLoading: false, isSigningOut: false, isDemoMode: true, isImpersonation: false }),
    useRef: <T>(current: T) => ({ current }),
    useState<T>(initial: T) {
      let current = initial;
      return [current, (next: T | ((old: T) => T)) => { current = typeof next === "function" ? (next as (old: T) => T)(current) : next; }];
    },
    useLayoutEffect(create: () => (() => void) | undefined) { const cleanup = create(); if (cleanup) cleanups.push(cleanup); },
    supabase: { auth: sessionAuth },
    sessionAuth,
    getSupabaseAccessToken() { assert.fail("Local draft restore/copy must not read a token"); },
    // These optional metadata paths are deliberately absent from the plain-text fixture.
    normalizeAdvertisingContentApproval(value: unknown) { assert.equal(value, undefined); return null; },
    readContentVideoVersion(value: unknown) { assert.equal(value, undefined); return null; },
    setVideos(value: Draft[]) { writes.push("videos"); state.videos = value; },
    setActiveId(value: string) { writes.push("activeId"); state.activeId = value; },
    setNotice(value: string) { notices.push(value); },
    navigator: { clipboard: { async writeText(value: string) { copies.push(value); } } },
    toast: Object.fromEntries(["success", "warning", "error"].map((kind) => [kind, () => toasts.push(kind)])),
  }, { "react/jsx-runtime": { jsx: (_type: unknown, props: object) => ({ props }) } });
  const element = selected.ContentStudio();
  assert.deepEqual({ ...element.props }, { actorId: "", workspaceId, localDraftsOnly: true }, "Eligibility comes from the actual wrapper");
  const captured = selected.ContentStudioSession(element.props);
  assert.equal(listeners.size, 2, "The actual wrapper and child subscriptions are mounted");
  assert.equal(captured.alive(), true);
  const seed = (value: Draft) => window.localStorage.setItem(captured.libraryStorageKey, JSON.stringify([value]));
  seed(draft);
  return {
    captured, marker, state, writes, copies, toasts, notices,
    draftReads: () => reads.filter((key) => key === captured.libraryStorageKey).length,
    duringDraftRead(callback: () => void) {
      onRead = (key) => {
        if (key !== captured.libraryStorageKey) return;
        onRead = undefined;
        callback();
      };
    },
    auth(actor: string) { for (const listener of listeners) listener(actor ? "SIGNED_IN" : "SIGNED_OUT", actor ? { user: { id: actor } } : null); },
    dispose() { for (const cleanup of cleanups.reverse()) cleanup(); assert.equal(listeners.size, 0); },
  };
}

for (const boundary of ["account ABA", "pending signout", "cleared signout", "replacement session"] as const) {
  test(`local restore revalidates its captured session before publication after ${boundary} during cache read`, (t) => {
    const f = fixture({ actor: "synthetic-account-A" }); t.after(() => f.dispose());
    const snapshot = f.captured.librarySnapshotRef.current;
    const original = f.captured.sessionRef.current!;
    let interruptions = 0;
    f.duringDraftRead(() => {
      interruptions++;
      if (boundary === "account ABA") {
        f.auth("synthetic-account-B"); f.auth("synthetic-account-A");
      } else if (boundary === "replacement session") {
        f.captured.sessionRef.current = new AbortController();
      } else {
        f.marker.markSignOutPending();
        if (boundary === "cleared signout") assert.equal(f.marker.clearSignOutPending(), true);
      }
    });
    f.captured.restore();
    assert.equal(interruptions, 1, "Expire the lifetime inside the actual readVideos storage read");
    assert.equal(f.draftReads(), 1, "The already-started cache read is allowed, publication is not");
    assert.deepEqual(f.writes, []);
    assert.equal(f.captured.librarySnapshotRef.current, snapshot);
    assert.deepEqual(f.state, { videos: [], activeId: "" });
    assert.deepEqual(f.copies, []);
    assert.deepEqual(f.toasts, []);
    assert.deepEqual(f.notices, []);
    if (boundary === "replacement session") {
      assert.equal(original.signal.aborted, false, "Identity must be rechecked even when the old signal was not aborted");
      assert.equal(f.captured.alive(), true, "The replacement is live; it must not validate the original read");
    }
  });
}

for (const freshAfterSignOut of [false, true]) {
  test(`local restore invalidates a pending pre-hydration copy and permits a fresh text copy${freshAfterSignOut ? " on a fresh mount after cleared signout" : ""}`, async (t) => {
    const f = fixture({ freshAfterSignOut }); t.after(() => f.dispose());
    assert.equal(f.marker.getSignOutRevision(), freshAfterSignOut ? 1 : 0);
    const pending = f.captured.captureCopy()("", "TEST");
    assert.ok(f.captured.clipboardPending.current);
    f.captured.restore();
    assert.equal(await pending, false);
    assert.deepEqual(f.copies, []);
    assert.deepEqual(f.toasts, []);
    assert.equal(f.captured.clipboardPending.current, null);
    assert.equal(f.draftReads(), 1);
    assert.deepEqual(f.writes, ["videos", "activeId"]);
    assert.equal(f.state.activeId, draft.id);
    assert.equal(f.state.videos[0].avatarPrompt, draft.avatarPrompt);
    assert.equal(await f.captured.captureCopy()(f.state.videos[0].avatarPrompt, "TEST"), true);
    assert.deepEqual(f.copies, [draft.avatarPrompt]);
    assert.deepEqual(f.toasts, ["success"]);
    assert.deepEqual(f.notices, []);
    assert.equal(f.captured.clipboardPending.current, null);
  });
}

for (const boundary of ["account change", "account ABA", "pending signout", "cleared signout"] as const) {
  test(`captured local restore must not read or publish after ${boundary} before a React commit`, async (t) => {
    const f = fixture({ actor: "synthetic-account-A" }); t.after(() => f.dispose());
    const snapshot = f.captured.librarySnapshotRef.current;
    const controller = f.captured.sessionRef.current;
    if (boundary.startsWith("account")) {
      f.auth("synthetic-account-B");
      if (boundary === "account ABA") f.auth("synthetic-account-A");
      assert.equal(controller!.signal.aborted, true);
    } else {
      f.marker.markSignOutPending();
      if (boundary === "cleared signout") assert.equal(f.marker.clearSignOutPending(), true);
      assert.equal(f.marker.getSignOutRevision(), 1);
      assert.equal(f.marker.isSignOutPending(), boundary === "pending signout");
      assert.equal(controller!.signal.aborted, false, "No SDK event or unmount is needed for the signout fence");
    }
    assert.equal(f.captured.sessionRef.current, controller, "No component replacement has committed");
    assert.equal(f.captured.alive(), false);
    const copy = f.captured.captureCopy()(draft.avatarPrompt, "TEST");
    f.captured.restore();
    assert.equal(await copy, false);
    assert.deepEqual(f.copies, []);
    assert.deepEqual(f.toasts, []);
    assert.deepEqual(f.notices, []);
    assert.deepEqual({ reads: f.draftReads(), writes: f.writes }, { reads: 0, writes: [] },
      "An expired local restore must honor the same lifetime fence as copy");
    assert.equal(f.captured.librarySnapshotRef.current, snapshot);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-content-clipboard-dispatch.test.ts
// Actual AST handler, guards and lifetime effect; synthetic SDK/clipboard only.
// Microtask ordering is deterministic, not browser or React acceptance coverage.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pagePath = "artifacts/negis/src/pages/ContentStudio.tsx";
const source = await readFile(path.join(root, pagePath), "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pages = ast.statements.filter((node): node is import("typescript").FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "ContentStudioSession");
assert.equal(pages.length, 1);
const statements = pages[0].body!.statements;
function declaration(name: string) {
  const matches = statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(ast) === name)));
  assert.equal(matches.length, 1, `Execute exactly one actual ${name} declaration`);
  return matches[0].getText(ast);
}
const effects = statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "useLayoutEffect"
  && node.getText(ast).includes("onAuthStateChange"));
assert.equal(effects.length, 1, "Execute the actual session abort subscription");
const program = ts.transpileModule([
  declaration("sessionRef"), declaration("clipboardPending"), effects[0].getText(ast),
  ...["isSessionAlive", "isGenerationSessionCurrent", "isHandoffSessionAlive", "isHandoffSessionCurrent", "copyText"].map(declaration),
  "exports.fixture = { copyText, sessionRef, clipboardPending };",
].join("\n"), {
  fileName: "content-clipboard-fixture.ts",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type Source = "library" | "package" | "photo";
type Scenario = "current" | "early A/B" | "final A/B" | "final A/B/A";
type Ref<T> = { current: T };
type Captured = {
  copyText(text: string, label: string, source: Source): Promise<boolean>;
  sessionRef: Ref<AbortController | null>;
  clipboardPending: Ref<object | null>;
};

function fixture(source: Source, scenario: Scenario) {
  const exports = {} as { fixture: Captured };
  const listeners = new Set<(event: string, session: { user: { id: string } }) => void>();
  const snapshot = {};
  const writes: Array<{ text: string; actor: string; aborted: boolean }> = [];
  const toasts: Array<{ kind: string; message: string }> = [];
  const notices: string[] = [];
  const events: string[] = [];
  let actor = "A", tokenReads = 0, sourceChecks = 0;
  let boundary: { sourceChecks: number; tokenReads: number; pending: boolean } | undefined;
  let cleanup: (() => void) | undefined;
  const sourceRef = (kind: Source) => ({ get current() {
    assert.equal(kind, source, "The actual guard must check the requested source");
    sourceChecks++;
    return snapshot;
  } });
  const emit = (next: string) => {
    actor = next;
    events.push(`auth:${next}`);
    for (const listener of listeners) listener("SIGNED_IN", { user: { id: next } });
  };
  new Script(program, { filename: "ContentStudio.clipboard.actual.cjs" }).runInNewContext({
    exports, AbortController, actorId: "A", workspaceId: "TEST-workspace", localDraftsOnly: false,
    signOutRevisionRef: { current: 0 }, getSignOutRevision: () => 0, isSignOutPending: () => false,
    hasSupabaseFrontendEnv: true, readWorkspaceId: () => "TEST-workspace",
    useRef: <T>(current: T) => ({ current }),
    useLayoutEffect(create: () => () => void) { cleanup = create(); },
    supabase: { auth: { onAuthStateChange(listener: Parameters<typeof listeners.add>[0]) {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    } } },
    get sessionAuth() { return { onAuthStateChange: this.supabase.auth.onAuthStateChange }; },
    async getSupabaseAccessToken(expected: string) {
      assert.equal(expected, "A");
      if (++tokenReads === 1 && scenario !== "current") {
        // Five hops put auth after verified()'s final current(), before dispatch.
        const later = (remaining: number) => queueMicrotask(() => {
          if (remaining) return later(remaining - 1);
          boundary = { sourceChecks, tokenReads, pending: exports.fixture.clipboardPending.current !== null };
          emit("B");
          if (scenario === "final A/B/A") emit("A");
        });
        later(scenario === "early A/B" ? 0 : 5);
      }
      return actor === expected ? "TEST-invalid-token-A" : "";
    },
    librarySnapshotRef: sourceRef("library"), libraryView: snapshot,
    packageCopySnapshotRef: sourceRef("package"), packageCopyView: snapshot,
    photoTextInputsRef: sourceRef("photo"), photoCopyView: snapshot,
    photoTextRevision: { current: 0 }, photoCopyViewRevision: 0,
    navigator: { clipboard: { async writeText(text: string) {
      events.push(`clipboard:${actor}`);
      writes.push({ text, actor, aborted: exports.fixture.sessionRef.current!.signal.aborted });
    } } },
    toast: Object.fromEntries(["success", "warning", "error"].map((kind) =>
      [kind, (message: string) => toasts.push({ kind, message })])),
    setNotice: (message: string) => notices.push(message),
    fetch() { assert.fail("Network must never be used"); },
  });
  assert.equal(listeners.size, 1);
  assert.ok(exports.fixture.sessionRef.current);
  return {
    captured: exports.fixture, writes, toasts, notices, events,
    get boundary() { return boundary; }, get tokenReads() { return tokenReads; }, get actor() { return actor; },
    dispose() { cleanup?.(); assert.equal(listeners.size, 0); },
  };
}

for (const source of ["library", "package", "photo"] as const) {
  for (const scenario of ["current", "early A/B", "final A/B", "final A/B/A"] as const) {
    test(`clipboard dispatch ${source}: ${scenario}`, (t) => {
      const f = fixture(source, scenario);
      t.after(() => f.dispose());
      return (async () => {
        const text = `TEST ${source} draft A`;
        const pending = f.captured.copyText(text, "TEST", source);
        assert.ok(f.captured.clipboardPending.current, "The real handler must acquire its pending lock");
        const accepted = await pending;
        assert.equal(f.captured.clipboardPending.current, null, "finally must release pending");
        assert.deepEqual(f.notices, []);
        if (scenario === "current") {
          assert.equal(accepted, true);
          assert.deepEqual(f.writes, [{ text, actor: "A", aborted: false }]);
          assert.equal(f.toasts.length, 1);
          assert.equal(f.toasts[0].kind, "success");
          assert.match(f.toasts[0].message, /^TEST /);
          assert.deepEqual(f.events, ["clipboard:A"]);
          assert.equal(f.tokenReads, 2);
          return;
        }
        assert.equal(accepted, false);
        assert.equal(f.captured.sessionRef.current!.signal.aborted, true);
        assert.equal(f.actor, scenario === "final A/B/A" ? "A" : "B");
        assert.deepEqual(f.boundary, {
          sourceChecks: scenario === "early A/B" ? 2 : 3, tokenReads: 1, pending: true,
        }, "The final boundary must follow verified()'s successful source check, not an earlier rejection");
        assert.deepEqual(f.toasts, []);
        assert.deepEqual(f.writes, [], "An aborted lifetime must never dispatch its old text");
        assert.deepEqual(f.events, scenario === "final A/B/A" ? ["auth:B", "auth:A"] : ["auth:B"]);
      })();
    });
  }
}

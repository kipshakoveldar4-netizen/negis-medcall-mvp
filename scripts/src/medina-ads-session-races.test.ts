import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Executes the real page closures/hooks and real transport with synthetic SDK,
// HTTP, Storage and thumbnail promises. No DOM, provider, env or network reads.
// Key reconciliation, auth callbacks and effect replay are simulations, not
// concurrent React, actual Supabase event delivery or browser acceptance.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-ads-session-races.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-ads-session-races.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");
const pagePath = "artifacts/negis/src/pages/AdsAutomation.tsx";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const exposed = [
  "creative", "creativeFile", "videoJob", "aiPackage", "compliance", "launchResult", "confirmations", "brief",
  "historyItems", "historyInsightsAccess", "historyInsightsByLaunch", "historyInsightsMessage", "historyInsightsRequestRef",
  "loading", "notice", "lastUploadError", "realLaunchStatus",
  "setCreative", "setCreativeFile", "setAiPackage", "setMetaSummary", "setConfirmations", "setUiMode", "setVideoJob",
  "uploadCreative", "uploadLargeVideo", "regenerateThumbnail", "pollVideoJob",
  "launch", "loadHistory", "checkHealth", "fillWithAi", "runComplianceCheck", "prelaunchErrors",
];

function historyRefreshClick(node: import("typescript").Node) {
  const handlers: import("typescript").Expression[] = [];
  function visit(child: import("typescript").Node) {
    if (ts.isJsxAttribute(child) && child.name.getText() === "onClick"
      && child.initializer && ts.isJsxExpression(child.initializer)) {
      const expression = child.initializer.expression;
      if (expression && ts.isArrowFunction(expression) && ts.isVoidExpression(expression.body)
        && ts.isCallExpression(expression.body.expression) && ts.isIdentifier(expression.body.expression.expression)
        && ["loadHistory", "refreshHistory"].includes(expression.body.expression.expression.text)) handlers.push(expression);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  assert.equal(handlers.length, 1, "Execute the actual History Refresh button callback");
  return handlers[0];
}

function compile(source: string, fileName: string, page = false) {
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
            ts.factory.createPropertyAssignment("VITE_SUPABASE_URL", ts.factory.createStringLiteral("https://storage.invalid")),
          ]);
        }
        if (page && ts.isFunctionDeclaration(node) && node.body) {
          if (node.name?.text === "captureVideoThumbnail") {
            return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
              node.typeParameters, node.parameters, node.type,
              ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createCallExpression(
                ts.factory.createIdentifier("fixtureCapture"), undefined, [ts.factory.createIdentifier("source")],
              ))]));
          }
          const inner = source.includes("function AdsAutomationSession(") ? "AdsAutomationSession" : "AdsAutomation";
          if (node.name?.text === inner) {
            // Only replace the page's final JSX return. Its state, effects,
            // guards, payload builders and async operations stay unchanged.
            return ts.visitEachChild(ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
              node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body,
                node.body.statements.map((statement) => ts.isReturnStatement(statement)
                  ? ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(
                    [...exposed.map((name) => ts.factory.createShorthandPropertyAssignment(name)),
                      ts.factory.createPropertyAssignment("refreshHistoryClick", historyRefreshClick(node))])) : statement))), visit, context);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => "\n",
  }));
  return result.outputText;
}

const compiled = (async () => {
  const page = baseline
    ? execFileSync("git", ["show", `36f0bb4:${pagePath}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, pagePath), "utf8");
  return {
    page: compile(page, pagePath, true), wrapped: page.includes("function AdsAutomationSession("),
    api: compile(await readFile(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8"), "api.ts"),
    auth: compile(await readFile(path.join(root, "artifacts/negis/src/lib/serverAuth.ts"), "utf8"), "serverAuth.ts"),
    signOut: compile(await readFile(path.join(root, "artifacts/negis/src/lib/authSignOut.ts"), "utf8"), "authSignOut.ts"),
    insights: compile(await readFile(path.join(root, "artifacts/negis/src/lib/metaInsightsHistory.ts"), "utf8"), "metaInsightsHistory.ts"),
    verifiedUpload: compile(await readFile(path.join(root, "artifacts/negis/src/lib/verified-creative-upload.ts"), "utf8"), "verified-creative-upload.ts"),
  };
})();

type View = Record<string, unknown>;
type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set(update: unknown): void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies }
  | { kind: "layout" | "effect"; create: Effect; deps: Dependencies; cleanup?: () => void; pending: boolean };
type Element = { type: (props: View) => View; props: View; key: unknown };

function sameDependencies(a: Dependencies, b: Dependencies) {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

function driver() {
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = true;
  let alive = true;
  let tree: View;
  let component: () => View;
  let lateWrites = 0;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    const index = cursor++;
    if (!slots[index]) slots[index] = create();
    assert.equal(slots[index].kind, kind, "Hook order must remain stable");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  function effect(kind: "layout" | "effect", create: Effect, deps?: Dependencies) {
    const current = slot(kind, () => ({ kind, create, deps, pending: true }));
    if (!sameDependencies(current.deps, deps)) current.pending = true;
    current.create = create; current.deps = deps;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", () => {
        const value: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            if (!alive) { lateWrites++; return; }
            const next = typeof update === "function" ? (update as (x: unknown) => unknown)(value.value) : update;
            if (!Object.is(next, value.value)) { value.value = next; dirty = true; }
          },
        };
        return value;
      });
      return [state.value as T, state.set] as const;
    },
    useRef<T>(initial: T) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo<T>(create: () => T, deps?: Dependencies) {
      const current = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDependencies(current.deps, deps)) { current.value = create(); current.deps = deps; }
      return current.value as T;
    },
    useEffect: (create: Effect, deps?: Dependencies) => effect("effect", create, deps),
    useLayoutEffect: (create: Effect, deps?: Dependencies) => effect("layout", create, deps),
  };
  const effects = (kind: "layout" | "effect") => slots.filter((s): s is Extract<Slot, { kind: "layout" | "effect" }> => s.kind === kind);
  function setup(kind: "layout" | "effect", all = false) {
    const pending = effects(kind).filter((s) => all || s.pending);
    for (const item of pending) item.cleanup?.();
    for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
  }
  return {
    hooks, mount(fn: () => View) { component = fn; }, force() { dirty = true; },
    render(passiveEffects = true) {
      if (!alive) return;
      if (dirty) { cursor = 0; dirty = false; tree = component(); setup("layout"); }
      if (passiveEffects) setup("effect");
    },
    replayEffects() {
      for (const kind of ["layout", "effect"] as const) for (const item of effects(kind)) { item.cleanup?.(); item.cleanup = undefined; }
      setup("layout", true); setup("effect", true);
    },
    dispose() {
      for (const kind of ["layout", "effect"] as const) for (const item of effects(kind)) item.cleanup?.();
      alive = false;
    },
    get view() { return tree; }, get lateWrites() { return lateWrites; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const record = (value: unknown): View => value && typeof value === "object" ? value as View : {};
type HttpCall = {
  url: string; init: RequestInit; actor: string; body: View; claimed: boolean;
  answer(data: unknown, status?: number): void;
  answerBody(body: unknown, status?: number, gate?: Promise<void>): void;
  reject(error: Error): void;
};
const photo = Object.assign(new Blob([new Uint8Array(1024)], { type: "image/jpeg" }), { name: "synthetic.jpg" });
const video = { name: "synthetic.mp4", type: "video/mp4", size: 1024 };
const creative = (kind = "image") => ({
  id: "synthetic-asset", fileName: kind === "video" ? video.name : photo.name,
  fileType: kind, mimeType: kind === "video" ? video.type : photo.type, fileSize: 1024,
  previewUrl: "https://storage.invalid/creative", publicUrl: "https://storage.invalid/creative",
  thumbnailUrl: kind === "video" ? "https://storage.invalid/thumbnail.jpg" : undefined, status: "uploaded",
  ...(kind === "video" ? { workerJobId: "synthetic-worker-job", storageBucket: "ad-creatives", storagePath: `${W1}/optimized.mp4` } : {}),
});
const photoTicket = { bucket: "ad-creatives-staging", storagePath: `${W1}/staged/cccccccc-cccc-4ccc-8ccc-cccccccccccc/original.jpg`,
  token: "signed-synthetic", uploadHandle: `u1.synthetic.${"a".repeat(43)}`, fileName: photo.name, fileType: "image", mimeType: photo.type, fileSize: photo.size };

async function fixture(t: TestContext, options: { history?: boolean; holdHealth?: boolean; prefill?: View } = {}) {
  const code = await compiled;
  const auth = { user: { id: "A", email: "a@example.invalid" }, userRole: "owner", clinicId: W1 };
  const sdk = { actor: "A", token: "synthetic-A", lookups: 0 };
  const listeners = new Set<(event: string, session: unknown) => void>();
  const tokenGates: Array<ReturnType<typeof deferred<void>>> = [];
  let afterTokenValidation: ((token: string) => void) | undefined;
  const calls: HttpCall[] = [];
  const storage: Array<ReturnType<typeof deferred<{ error: null }>> & { path: string }> = [];
  const captures: Array<ReturnType<typeof deferred<unknown>>> = [];
  const notifications: unknown[][] = [];
  const local = new Map<string, string>([["negis_ads_automation_ui_mode", JSON.stringify("admin")]]);
  const signOutStorage = new Map<string, string>();
  const writes: string[] = [];
  const removals: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let location = options.history ? "/ads-automation/history" : "/ads-automation";
  let activeDriver = driver();
  const outer = driver();
  let inner: ReturnType<typeof driver> | undefined;
  let innerKey: unknown = Symbol("unmounted");
  let mounted = true;
  const retired: Array<ReturnType<typeof driver>> = [];
  const session = () => ({ user: { id: sdk.actor }, access_token: sdk.token });
  const supabase = {
    auth: {
      async getSession() {
        sdk.lookups++;
        const gate = tokenGates.shift();
        if (gate) await gate.promise;
        return { error: null, data: { session: session() } };
      },
      onAuthStateChange(callback: (event: string, session: unknown) => void) {
        listeners.add(callback);
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
      },
    },
    storage: { from: () => ({ uploadToSignedUrl(storagePath: string) {
      const pending = { ...deferred<{ error: null }>(), path: storagePath };
      storage.push(pending); return pending.promise;
    } }) },
  };
  const unexpected = (name: string): never => assert.fail(`Unexpected fixture dependency: ${name}`);
  function evaluate<T>(source: string, filename: string, require: (name: string) => unknown) {
    const exports = {} as T;
    new Script(source, { filename }).runInNewContext({
      exports, require, Error, DOMException, AbortController, Headers, Response, Blob, TextEncoder, crypto: webcrypto,
      URL: class extends URL { static createObjectURL() { return "blob:synthetic"; } static revokeObjectURL() {} },
      fixtureCapture() { const pending = deferred<unknown>(); captures.push(pending); return pending.promise; },
      window: {
        location: { origin: "https://simulation.invalid" }, scrollTo() {},
        localStorage: {
          getItem: (key: string) => local.get(key) ?? null,
          setItem: (key: string, value: string) => { writes.push(key); local.set(key, value); },
          removeItem: (key: string) => {
            if (key !== "negis_signout_pending_v1") removals.push(key);
            local.delete(key);
          },
        },
        sessionStorage: {
          getItem: (key: string) => signOutStorage.get(key) ?? null,
          setItem: (key: string, value: string) => { signOutStorage.set(key, value); },
          removeItem: (key: string) => { signOutStorage.delete(key); },
        },
        setTimeout: () => ++timerId, clearTimeout() {},
        setInterval: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
        clearInterval: (id: number) => timers.delete(id),
      },
      fetch(url: string, init: RequestInit) {
        const pending = deferred<Response>();
        const call: HttpCall = {
          url, init, actor: sdk.actor, body: init.body ? JSON.parse(String(init.body)) : {}, claimed: false,
          reject: pending.reject,
          answer(data, status = 200) { call.answerBody({ success: status < 400, mode: "supabase", data }, status); },
          answerBody(body, status = 200, gate) {
            const response = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
            if (gate) {
              const wrap = (value: Response): Response => {
                const text = value.text.bind(value);
                const clone = value.clone.bind(value);
                Object.defineProperties(value, {
                  text: { configurable: true, value: async () => { await gate; return text(); } },
                  clone: { configurable: true, value: () => wrap(clone()) },
                });
                return value;
              };
              wrap(response);
            }
            pending.resolve(response);
          },
        };
        calls.push(call);
        // Intentionally ignore signal abort when delivering a response/body.
        // The page must independently reject late publication.
        if (url.endsWith("/health") && !options.holdHealth) call.answer({ meta: { configured: true, videoLaunchEnabled: true } });
        return pending.promise;
      },
    });
    return exports;
  }
  const signOut = evaluate<{
    isSignOutPending(): boolean; getSignOutRevision(): number; markSignOutPending(): void; clearSignOutPending(): boolean;
  }>(code.signOut, "authSignOut.simulation.cjs", unexpected);
  const serverAuth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(code.auth, "auth.simulation.cjs", (name) => {
    if (name === "@/lib/authSignOut") return signOut;
    assert.equal(name, "@/lib/supabase"); return { hasSupabaseFrontendEnv: true, supabase,
      sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } };
  });
  const api = evaluate<{ crmFetch(path: string, init?: RequestInit): Promise<Response> }>(code.api, "api.simulation.cjs", (name) => {
    assert.equal(name, "@/lib/serverAuth");
    return {
      async getSupabaseAccessToken(expected?: string) {
        const token = await serverAuth.getSupabaseAccessToken(expected);
        // Interleave only after the real auth helper has validated the token,
        // before the real transport resumes its post-token dispatch checks.
        if (token) {
          const hook = afterTokenValidation;
          afterTokenValidation = undefined;
          hook?.(token);
        }
        return token;
      },
    };
  });
  if (options.prefill) local.set(`synthetic-prefill::${W1}`, JSON.stringify(options.prefill));
  const insightsPayload = evaluate(code.insights, "metaInsightsHistory.simulation.cjs", unexpected);
  const verifiedUpload = evaluate(code.verifiedUpload, "verified-creative-upload.simulation.cjs", unexpected);
  const page = evaluate<{ default: () => View }>(code.page, "AdsAutomation.simulation.cjs", (name) => {
    if (name === "react") return Object.fromEntries(Object.keys(outer.hooks).map((key) => [key,
      (...args: unknown[]) => (activeDriver.hooks[key as keyof typeof outer.hooks] as (...args: unknown[]) => unknown)(...args)]));
    if (name === "react/jsx-runtime") {
      const jsx = (type: Element["type"], props: View, key: unknown) => ({ type, props, key });
      return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
    }
    if (name === "@/contexts/AuthContext") return { useAuth: () => auth };
    if (name === "@/lib/api") return api;
    if (name === "@/lib/serverAuth") return serverAuth;
    if (name === "@/lib/authSignOut") return signOut;
    if (name === "@/lib/metaInsightsHistory") return insightsPayload;
    if (name === "@/lib/verified-creative-upload") return verifiedUpload;
    if (name === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase,
      sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } };
    if (name === "wouter") return { Link: Symbol("Link"), useLocation: () => [location, (next: string) => { location = next; inner?.force(); }] };
    if (name === "sonner") return { toast: Object.fromEntries(["success", "error", "warning", "info", "message"].map((key) => [key, (...args: unknown[]) => notifications.push(args)])) };
    if (name === "@/lib/demoStorage") return { readWorkspaceId: () => auth.clinicId, workspaceScopedKey: (key: string) => `${key}::${auth.clinicId}` };
    if (name === "@/lib/planFeatures") return { normalizePlan: () => "pro", getPlanFeature: () => ({ enabled: true }), planFeatureBadge: () => "Pro" };
    if (name === "../../../../lib/advertising/campaignBrief") return {
      ADVERTISING_CAMPAIGN_PREFILL_KEY: "synthetic-prefill", contentApprovalMatchesCopy: () => true,
      normalizeAdvertisingContentApproval: (x: unknown) => x, parseAdvertisingCampaignPrefillForPlatform: (x: unknown) => x,
    };
    if (name === "../../../../lib/meta/cities") return {
      KZ_META_CITY_OPTIONS: [], getKzMetaCityOption: (id: string) => ({ id: id || "astana", labelRu: "Synthetic city", canonicalName: "Synthetic" }),
    };
    if (name === "lucide-react" || name.startsWith("@/components/")) return {};
    return unexpected(name);
  });
  outer.mount(code.wrapped ? page.default : () => ({}));
  function render(passiveEffects = true) {
    if (!mounted) return;
    activeDriver = outer; outer.render(passiveEffects);
    const element = code.wrapped ? outer.view as unknown as Element : { type: page.default, props: {}, key: undefined };
    if (!inner || !Object.is(innerKey, element.key)) {
      if (inner) { inner.dispose(); retired.push(inner); }
      inner = driver(); innerKey = element.key;
    }
    activeDriver = inner; inner.mount(() => element.type(element.props)); inner.render(passiveEffects);
  }
  async function flush() {
    for (let i = 0; i < 5; i++) { render(); await tick(); }
    render();
  }
  function emit(actor: string) {
    sdk.actor = actor; sdk.token = `synthetic-${actor}`;
    for (const listener of [...listeners]) listener("SIGNED_IN", session());
  }
  function dispose() {
    if (!mounted) return;
    inner?.dispose(); outer.dispose(); mounted = false;
  }
  t.after(dispose);
  await flush();
  return {
    calls, storage, captures, notifications, writes, removals, sdk, flush, signOut,
    renderBeforeEffects: () => render(false),
    get view() { return inner!.view; }, get key() { return innerKey; }, get timers() { return timers.size; },
    lateWrites: () => retired.reduce((sum, d) => sum + d.lateWrites, 0) + (inner?.lateWrites ?? 0),
    invoke(name: string, ...args: unknown[]) {
      const fn = inner!.view[name]; assert.equal(typeof fn, "function", name);
      return Promise.resolve((fn as (...args: unknown[]) => unknown)(...args));
    },
    async seed(kind = "image") {
      if (kind === "video") (inner!.view.setVideoJob as (value: unknown) => void)({ id: "synthetic-worker-job", status: "ready",
        outputPublicUrl: creative("video").publicUrl, outputAssetId: creative("video").id, outputStorageBucket: "ad-creatives",
        outputStoragePath: `${W1}/optimized.mp4`, outputFileName: video.name, outputSizeBytes: video.size, outputMimeType: "video/mp4" });
      for (const [name, value] of Object.entries({
        setCreative: creative(kind), setAiPackage: { primaryText: "Synthetic text", headline: "Synthetic headline" },
        setMetaSummary: { configured: true, videoLaunchEnabled: true },
        setConfirmations: Object.fromEntries(["textChecked", "budgetChecked", "leadDestinationChecked", "clinicAuthority", "manualApproval", "spendUnderstood"].map((x) => [x, true])),
      })) (inner!.view[name] as (x: unknown) => void)(value);
      await flush();
      assert.deepEqual(Array.from(await this.invoke("prelaunchErrors", "PAUSED") as unknown[]), []);
    },
    take(part: string, method = "GET") {
      const call = calls.find((c) => !c.claimed && c.url.includes(part) && (c.init.method || "GET") === method);
      assert.ok(call, `Expected ${method} ${part}; notice=${String(inner!.view.notice)}; upload=${String(inner!.view.lastUploadError)}; calls=${calls.map(item => item.url).join(",")}`); call.claimed = true; return call;
    },
    async change(actor = auth.user.id, workspace = auth.clinicId, role = auth.userRole) {
      auth.user = { id: actor, email: `${actor.toLowerCase()}@example.invalid` }; auth.clinicId = workspace; auth.userRole = role;
      emit(actor); outer.force(); inner?.force(); await flush();
    },
    async roundTrip() { emit("B"); emit("A"); outer.force(); inner?.force(); await flush(); },
    async committedRoundTrip() { await this.change("B"); await this.change("A"); },
    delayToken() { const gate = deferred<void>(); tokenGates.push(gate); return gate; },
    onNextValidatedToken(hook: (token: string) => void) {
      assert.equal(afterTokenValidation, undefined, "Only one deterministic token-boundary hook may be armed");
      afterTokenValidation = hook;
    },
    replaceSdkWithoutEvent(actor: string) { sdk.actor = actor; sdk.token = `synthetic-${actor}`; },
    rotateToken() {
      sdk.token = "synthetic-A-rotated";
      for (const listener of [...listeners]) listener("TOKEN_REFRESHED", session());
    },
    async replay() { outer.replayEffects(); inner!.replayEffects(); await flush(); },
    dispose,
  };
}

for (const switchKind of ["actor", "workspace", "role", "committed-round-trip", "batched-auth-round-trip"] as const) {
  test(`A1 ${switchKind} change remounts and clears creative, approvals and launch state`, async (t) => {
    const f = await fixture(t); await f.seed(); const key = f.key;
    if (switchKind === "actor") await f.change("B");
    if (switchKind === "workspace") await f.change("A", W2);
    if (switchKind === "role") await f.change("A", W1, "marketer");
    if (switchKind === "committed-round-trip") await f.committedRoundTrip();
    if (switchKind === "batched-auth-round-trip") await f.roundTrip();
    assert.notEqual(f.key, key);
    assert.equal(f.view.creative, null); assert.equal(f.view.aiPackage, null); assert.equal(f.view.launchResult, null);
    assert.ok(Object.values(record(f.view.confirmations)).every((x) => x === false));
  });
}

for (const transition of ["sdk-without-event", "unmount", "committed-round-trip", "batched-auth-round-trip"] as const) {
  test(`A2 delayed token lookup refuses old launch after ${transition}`, async (t) => {
    const f = await fixture(t); await f.seed(); const gate = f.delayToken();
    const pending = f.invoke("launch", "PAUSED"); await f.flush();
    if (transition === "sdk-without-event") f.replaceSdkWithoutEvent("B");
    if (transition === "unmount") f.dispose();
    if (transition === "committed-round-trip") await f.committedRoundTrip();
    if (transition === "batched-auth-round-trip") await f.roundTrip();
    const notices = f.notifications.length; gate.resolve(); await f.flush();
    assert.equal(f.calls.filter((c) => c.url.endsWith("/meta-launch")).length, 0);
    await pending;
    if (transition !== "sdk-without-event") assert.equal(f.notifications.length, notices);
    assert.equal(f.lateWrites(), 0);
  });
}

for (const stage of ["signature", "storage", "metadata"] as const) {
  test(`A3 photo upload ignores old ${stage} completion after account switch`, async (t) => {
    const f = await fixture(t);
    const pending = f.invoke("uploadCreative", photo); await f.flush();
    const signed = f.take("signed-upload", "POST");
    if (stage !== "signature") {
      signed.answer(photoTicket); await f.flush();
      assert.equal(f.storage.length, 1);
    }
    if (stage === "metadata") { f.storage[0].resolve({ error: null }); await f.flush(); }
    await f.change("B"); const notices = f.notifications.length;
    if (stage === "signature") signed.answer(photoTicket);
    if (stage === "storage") f.storage[0].resolve({ error: null });
    if (stage === "metadata") f.take("ad-creatives/finalize-upload?", "POST").answer({ id: "old-asset" });
    await f.flush();
    assert.equal(f.storage.length, stage === "signature" ? 0 : 1);
    assert.equal(f.calls.filter((c) => c.url.includes("ad-creatives/finalize-upload?")).length, stage === "metadata" ? 1 : 0);
    await pending;
    assert.equal(f.view.creative, null); assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
  });
}

test("A4 large-video storage completion cannot queue an old job after unmount cleanup", async (t) => {
  const f = await fixture(t);
  (f.view.setMetaSummary as (value: unknown) => void)({ videoOptimization: { enabled: true, maxInputMb: 500 } }); await f.flush();
  const pending = f.invoke("uploadCreative", { ...video, size: 60 * 1024 * 1024 }); await f.flush();
  f.take("video-jobs?", "POST").answer({ job: { id: "old-job", status: "awaiting_upload" }, signedUpload: { bucket: "raw", storagePath: `${W1}/raw.mp4`, token: "signed-synthetic" } }); await f.flush();
  assert.equal(f.storage.length, 1); f.dispose(); const notices = f.notifications.length;
  f.storage[0].resolve({ error: null }); await f.flush();
  assert.equal(f.calls.filter((c) => c.init.method === "PATCH").length, 0);
  await pending;
  assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
});

test("A5 captured thumbnail cannot request signing after workspace switch", async (t) => {
  const f = await fixture(t);
  await f.seed("video"); (f.view.setCreativeFile as (value: unknown) => void)(video); await f.flush();
  const pending = f.invoke("regenerateThumbnail"); await f.flush();
  assert.equal(f.captures.length, 1); await f.change("A", W2); const notices = f.notifications.length;
  f.captures[0].resolve({ blob: new Blob(["synthetic"]), mimeType: "image/jpeg", generatedAt: "synthetic" });
  await f.flush();
  assert.equal(f.calls.filter((c) => c.url.includes("signed-upload")).length, 0);
  await pending;
  assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
});

for (const transition of ["committed-keyed", "batched-auth"] as const) {
  test(`A6 video readiness cannot continue an old PAUSED launch across ${transition} A-B-A`, async (t) => {
    const f = await fixture(t); await f.seed("video");
    const pending = f.invoke("launch", "PAUSED"); await f.flush(); const ready = f.take("ad-creative-meta-upload", "POST");
    if (transition === "committed-keyed") await f.committedRoundTrip();
    else await f.roundTrip();
    const notices = f.notifications.length;
    ready.answer({ metaVideoId: "old-meta-video", videoReady: true }); await f.flush();
    assert.equal(f.calls.filter((c) => c.url.endsWith("/meta-launch")).length, 0);
    await pending;
    assert.equal(f.view.creative, null); assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
  });
}

for (const transition of ["actor", "role", "unmount"] as const) {
  test(`A7 delayed Insights body is never published after ${transition} change`, async (t) => {
    const f = await fixture(t, { history: true });
    f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
    const gate = deferred<void>();
    f.take("meta-insights-history").answerBody({ success: true, mode: "supabase", data: { summaries: [historySummary()] } }, 200, gate.promise);
    await f.flush();
    if (transition === "actor") await f.change("B", W1, "marketer");
    if (transition === "role") await f.change("A", W1, "marketer");
    if (transition === "unmount") f.dispose();
    gate.resolve(); await f.flush();
    assert.notEqual(f.view.historyInsightsAccess, "confirmed");
    assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0); assert.equal(f.lateWrites(), 0);
  });
}

test("A8 already-confirmed Insights are cleared before replacement account revalidation", async (t) => {
  const f = await fixture(t, { history: true });
  f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
  f.take("meta-insights-history").answer({ summaries: [historySummary()] }); await f.flush();
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  await f.change("B", W1, "owner");
  assert.notEqual(f.view.historyInsightsAccess, "confirmed"); assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
  f.take("auth-context").answerBody({ success: false, error: "Synthetic forbidden" }, 403); await f.flush();
  assert.equal(f.view.historyInsightsAccess, "forbidden");
});

test("A9 StrictMode cleanup/setup expires old requests but the replacement session works", async (t) => {
  const f = await fixture(t, { holdHealth: true }); const old = f.take("/health");
  await f.replay(); const fresh = f.take("/health");
  assert.notEqual(fresh, old); assert.equal(old.init.signal?.aborted, true);
  old.answerBody({ success: false, error: "Old failure" }, 500); await f.flush();
  assert.equal(f.view.loading, "health", "Old finally must not clear the replacement operation");
  fresh.answer({ meta: { configured: true, adAccountId: "fresh" } }); await f.flush();
  assert.equal(f.view.notice, ""); assert.equal(f.view.loading, null); assert.equal(f.lateWrites(), 0);
});

test("A10 current session keeps signed upload and PAUSED launch working", async (t) => {
  const f = await fixture(t);
  const pending = f.invoke("uploadCreative", photo); await f.flush();
  f.take("signed-upload", "POST").answer(photoTicket); await f.flush();
  f.storage[0].resolve({ error: null }); await f.flush();
  const path = `${W1}/verified/cccccccc-cccc-4ccc-8ccc-cccccccccccc/${"a".repeat(64)}.jpg`;
  f.take("ad-creatives/finalize-upload?", "POST").answer({ asset: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", workspaceId: W1,
    fileName: photo.name, fileType: "image", mimeType: photo.type, fileSize: photo.size, storageBucket: "ad-creatives", storagePath: path,
    publicUrl: `https://storage.invalid/storage/v1/object/public/ad-creatives/${path}`, status: "uploaded" } });
  await pending; await f.flush();
  assert.equal(record(f.view.creative).id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  await f.seed(); const key = f.key; const gate = f.delayToken();
  const launched = f.invoke("launch", "PAUSED"); await f.flush(); f.rotateToken(); gate.resolve(); await f.flush();
  const request = f.take("/meta-launch", "POST");
  assert.equal(request.body.statusMode, "PAUSED"); assert.equal(request.body.dryRun, false);
  assert.equal(new Headers(request.init.headers).get("Authorization"), "Bearer synthetic-A-rotated");
  assert.equal(f.key, key, "Token rotation for the same actor must not clear the wizard");
  assert.equal(Object.hasOwn(request.init, "expectedUserId"), false);
  request.answer({ dryRun: false, status: "paused", launchId }); await launched; await f.flush();
  assert.equal(f.view.realLaunchStatus, "created");
  assert.equal(f.writes.filter((key) => key === `negis_ads_launch_history_${W1}::A`).length, 1);
});

test("A11 StrictMode consumes a video prefill once without capturing or publishing an unverified original", async (t) => {
  const f = await fixture(t, { prefill: {
    sourceModule: "content-studio", primaryText: "Synthetic prefill",
    creative: { type: "video", assetId: "prefill-asset", url: "https://storage.invalid/prefill.mp4", fileName: video.name },
  } });
  assert.equal(f.captures.length, 0);
  await f.replay();
  assert.equal(f.captures.length, 0);
  assert.equal(f.removals.filter((key) => key === `synthetic-prefill::${W1}`).length, 1);
  assert.equal(f.calls.filter((c) => c.url.includes("signed-upload")).length, 0);
  assert.equal(f.storage.length, 0);
  assert.notEqual(record(f.view.creative).status, "uploaded");
  assert.equal(f.calls.some(call => call.url.includes("ad-creative-meta-upload") || call.url.endsWith("/meta-launch")), false);
});

for (const status of [200, 500]) {
  test(`A12 already-dispatched launch ${status} cannot publish/toast/persist after unmount`, async (t) => {
    const f = await fixture(t); await f.seed();
    const pending = f.invoke("launch", "PAUSED"); await f.flush(); const request = f.take("/meta-launch", "POST");
    f.dispose(); const notices = f.notifications.length; const writes = f.writes.length;
    request.answerBody(status === 200
      ? { success: true, data: { dryRun: false, status: "paused", launchId } }
      : { success: false, error: "Old launch failure", data: { metaError: { message: "Synthetic error" } } }, status);
    await pending; await f.flush();
    assert.equal(f.calls.filter((c) => c.url.endsWith("/meta-launch")).length, 1, "The already-sent request cannot be undone");
    assert.equal(f.notifications.length, notices); assert.equal(f.writes.length, writes); assert.equal(f.lateWrites(), 0);
  });
}

test("A13 old video poll cannot publish a ready job or resume its timer after unmount", async (t) => {
  const f = await fixture(t);
  (f.view.setMetaSummary as (value: unknown) => void)({ videoOptimization: { enabled: true, maxInputMb: 500 } }); await f.flush();
  const uploading = f.invoke("uploadCreative", video); await f.flush();
  f.take("video-jobs?", "POST").answer({ job: { id: "old-job", status: "awaiting_upload" },
    signedUpload: { bucket: "ad-creatives-raw", storagePath: `${W1}/raw.mp4`, token: "signed-synthetic" } }); await f.flush();
  f.storage[0].resolve({ error: null }); await f.flush();
  f.take("video-jobs?", "PATCH").answer({ job: { id: "old-job", status: "queued" } }); await uploading; await f.flush();
  const pending = f.invoke("pollVideoJob", "old-job"); await f.flush(); const request = f.take("video-jobs?");
  f.dispose(); const notices = f.notifications.length;
  request.answer({ job: { id: "old-job", status: "ready", outputPublicUrl: "https://storage.invalid/old-output.mp4" } });
  await pending; await f.flush();
  assert.equal(f.timers, 0); assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
});

test("A14 old video-processing response cannot write local launch history after unmount", async (t) => {
  const f = await fixture(t); await f.seed("video");
  const pending = f.invoke("launch", "PAUSED"); await f.flush(); const request = f.take("ad-creative-meta-upload", "POST");
  f.dispose(); const notices = f.notifications.length; const writes = f.writes.length;
  request.answer({ metaVideoId: "old-meta-video", videoReady: false, processingStatus: "processing" });
  await pending; await f.flush();
  assert.equal(f.calls.filter((c) => c.url.endsWith("/meta-launch")).length, 0);
  assert.equal(f.notifications.length, notices); assert.equal(f.writes.length, writes); assert.equal(f.lateWrites(), 0);
});

test("A15 live video readiness still passes its Meta video id into the PAUSED launch", async (t) => {
  const f = await fixture(t); await f.seed("video");
  const pending = f.invoke("launch", "PAUSED"); await f.flush();
  f.take("ad-creative-meta-upload", "POST").answer({ metaVideoId: "fresh-meta-video", videoReady: true, processingStatus: "ready" }); await f.flush();
  const request = f.take("/meta-launch", "POST");
  assert.equal(request.body.videoId, "fresh-meta-video"); assert.equal(request.body.statusMode, "PAUSED");
  assert.equal(request.body.workspaceId, W1); assert.equal(request.body.manualApprovalConfirmed, true);
  request.answer({ dryRun: false, status: "paused", metaVideoId: "fresh-meta-video", launchId }); await pending; await f.flush();
  assert.equal(f.view.realLaunchStatus, "created"); assert.equal(record(f.view.creative).metaVideoId, "fresh-meta-video");
});

function historySummary(spendMinor = "100") {
  return {
    metaCampaignLaunchId: launchId, availability: "available", freshness: "fresh", rowCount: 1,
    latestFetchedAt: "2026-10-22T00:00:00.000Z", coveredDateStart: "2026-10-21", coveredDateStop: "2026-10-21",
    spendByCurrency: [{ currency: "USD", currencyExponent: 2, spendMinor }],
    impressions: "10", clicks: "2", inlineLinkClicks: "1", metaLeads: "0",
  };
}

async function readyHistory(t: TestContext) {
  const f = await fixture(t, { history: true });
  f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Initial campaign", status: "paused" }] });
  f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
  f.take("meta-insights-history").answer({ summaries: [historySummary()] }); await f.flush();
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  return f;
}

async function answerFreshHistory(f: Awaited<ReturnType<typeof fixture>>) {
  f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Refreshed campaign", status: "paused" }] });
  f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
  f.take("meta-insights-history").answer({ summaries: [historySummary("200")] }); await f.flush();
}

test("A16 History Refresh clears Insights before effects and reloads both reports once without remounting", async (t) => {
  const f = await readyHistory(t); const key = f.key;
  const requestRef = record(f.view.historyInsightsRequestRef);
  const generation = Number(requestRef.current);
  void f.invoke("refreshHistoryClick");
  assert.ok(Number(requestRef.current) > generation, "Invalidate the old request in the click, before passive effects");
  f.renderBeforeEffects();
  assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
  assert.equal(f.view.historyInsightsMessage, ""); assert.equal(f.view.historyInsightsAccess, "idle");
  await f.flush();
  assert.equal(f.view.historyInsightsAccess, "checking");
  await answerFreshHistory(f);
  assert.equal(f.key, key); assert.equal(f.view.historyInsightsAccess, "confirmed");
  const fresh = record(record(f.view.historyInsightsByLaunch)[launchId]);
  assert.equal(record((fresh.spendByCurrency as unknown[])[0]).spendMinor, "200");
  assert.equal(record((f.view.historyItems as unknown[])[0]).campaignName, "Refreshed campaign");
  assert.equal(f.view.historyInsightsMessage, ""); assert.equal(f.view.loading, null);
  await f.flush();
  for (const part of ["meta-launches?", "auth-context", "meta-insights-history"]) {
    const reads = f.calls.filter((call) => call.url.includes(part));
    assert.equal(reads.length, 2, `${part}: one automatic read and one manual read, no effect loop`);
    for (const read of reads) {
      assert.equal(read.init.cache, "no-store"); assert.equal(read.actor, "A");
      assert.equal(new Headers(read.init.headers).get("Authorization"), "Bearer synthetic-A");
      assert.ok(read.url.includes(`workspaceId=${W1}`)); assert.equal(read.init.signal?.aborted, false);
    }
  }
  assert.ok(f.calls.every((call) => !call.init.method || call.init.method === "GET"));
});

for (const timing of ["before-effects", "after-replacement"] as const) {
  for (const outcome of [200, 401, 403, 500, "reject"] as const) {
    test(`A17 History Refresh ignores old Insights ${outcome} ${timing}`, async (t) => {
      const f = await fixture(t, { history: true });
      f.take("meta-launches?").answer({ launches: [] });
      f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
      const old = f.take("meta-insights-history");
      void f.invoke("refreshHistoryClick");
      if (timing === "after-replacement") { await f.flush(); await answerFreshHistory(f); }
      if (outcome === "reject") old.reject(new Error("Synthetic old transport failure"));
      else if (outcome === 200) old.answer({ summaries: [historySummary("999")] });
      else old.answerBody({ success: false, error: "Synthetic old Insights failure" }, outcome);
      if (timing === "before-effects") {
        for (let i = 0; i < 5; i++) await tick();
        f.renderBeforeEffects();
        assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
        assert.equal(f.view.historyInsightsAccess, "idle"); assert.equal(f.view.historyInsightsMessage, "");
        await f.flush(); await answerFreshHistory(f);
      }
      await f.flush();
      assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "200");
      assert.equal(f.view.historyInsightsAccess, "confirmed"); assert.equal(f.view.historyInsightsMessage, "");
      assert.equal(f.lateWrites(), 0);
    });
  }
}

for (const status of [200, 500]) {
  test(`A18 History Refresh ignores an old delayed Insights JSON body ${status}`, async (t) => {
    const f = await fixture(t, { history: true });
    f.take("meta-launches?").answer({ launches: [] });
    f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
    const gate = deferred<void>();
    f.take("meta-insights-history").answerBody(status === 200
      ? { success: true, mode: "supabase", data: { summaries: [historySummary("999")] } }
      : { success: false, error: "Synthetic old body failure" }, status, gate.promise);
    await f.flush(); void f.invoke("refreshHistoryClick"); await f.flush(); await answerFreshHistory(f);
    gate.resolve(); await f.flush();
    assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "200");
    assert.equal(f.view.historyInsightsAccess, "confirmed"); assert.equal(f.view.historyInsightsMessage, "");
    assert.equal(f.lateWrites(), 0);
  });
}

for (const stage of ["auth", "insights"] as const) {
  for (const outcome of [401, 403, 500, "reject"] as const) {
    test(`A19 History Refresh fails closed on current ${stage} ${outcome} and can retry`, async (t) => {
      const f = await readyHistory(t);
      void f.invoke("refreshHistoryClick"); await f.flush();
      f.take("meta-launches?").answer({ launches: [] });
      let request = f.take("auth-context");
      if (stage === "insights") {
        request.answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
        request = f.take("meta-insights-history");
      }
      if (outcome === "reject") request.reject(new Error("Synthetic current transport failure"));
      else request.answerBody({ success: false, error: "Synthetic current failure" }, outcome);
      await f.flush();
      assert.equal(f.view.historyInsightsAccess, outcome === 401 ? "required" : outcome === 403 ? "forbidden"
        : stage === "auth" ? "unavailable" : "confirmed");
      assert.ok(String(f.view.historyInsightsMessage).length > 0);
      assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
      if (stage === "auth") assert.equal(f.calls.filter((call) => call.url.includes("meta-insights-history")).length, 1);
      void f.invoke("refreshHistoryClick"); f.renderBeforeEffects();
      assert.equal(f.view.historyInsightsMessage, ""); assert.equal(f.view.historyInsightsAccess, "idle");
      await f.flush(); await answerFreshHistory(f);
      assert.equal(f.view.historyInsightsAccess, "confirmed"); assert.equal(f.view.historyInsightsMessage, "");
      assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "200");
    });
  }
}

for (const transition of ["actor", "role", "unmount"] as const) {
  test(`A20 captured History Refresh callback is inert after ${transition} invalidates its session`, async (t) => {
    const f = await readyHistory(t);
    const click = f.view.refreshHistoryClick as () => void;
    if (transition === "actor") await f.change("B");
    if (transition === "role") await f.change("A", W1, "marketer");
    if (transition === "unmount") f.dispose();
    const calls = f.calls.length, lookups = f.sdk.lookups, writes = f.writes.length;
    click(); await f.flush();
    assert.equal(f.calls.length, calls); assert.equal(f.sdk.lookups, lookups);
    assert.equal(f.writes.length, writes); assert.equal(f.lateWrites(), 0);
  });
}

for (const workspace of [W1, W2]) {
  test(`A21 fresh lead_manager session in ${workspace === W1 ? "same" : "different"} workspace refuses contradictory server admin confirmation`, async (t) => {
    const f = await readyHistory(t);
    assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 1);
    const previousReads = f.calls.filter((call) => call.url.includes("meta-insights-history")).length;
    await f.change("A", workspace, "lead_manager");
    // If an implementation still asks for server confirmation, even a positive
    // contradictory reply must not override the current client role denial.
    for (const call of f.calls.filter((item) => !item.claimed && item.url.includes("auth-context"))) {
      call.claimed = true;
      call.answer({ isAdmin: true, role: "lead_manager", workspaceId: workspace });
    }
    await f.flush();
    assert.equal(f.calls.filter((call) => call.url.includes("meta-insights-history")).length, previousReads);
    assert.equal(f.view.historyInsightsAccess, "forbidden");
    assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
    assert.ok(String(f.view.historyInsightsMessage).length > 0);
    assert.equal(f.lateWrites(), 0);
  });
}

for (const [name, summaries] of [
  ["missing summaries", undefined], ["null summaries", null], ["non-array summaries", { broken: true }],
  ["null row", [null]], ["nested null spend", [{ ...historySummary(), spendByCurrency: null }]],
  ["mixed valid and invalid rows", [historySummary(), { ...historySummary(), metaCampaignLaunchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", spendByCurrency: null }]],
] as Array<[string, unknown]>) {
  test(`A22 successful envelope with ${name} clears History metrics, warns and can retry`, async (t) => {
    const f = await readyHistory(t);
    void f.invoke("refreshHistoryClick"); await f.flush();
    f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Current campaign", status: "paused" }] });
    f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
    f.take("meta-insights-history").answer({ summaries }); await f.flush();
    assert.equal(f.view.historyInsightsAccess, "confirmed", "Valid authorization is distinct from an invalid report payload");
    assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
    assert.ok(String(f.view.historyInsightsMessage).length > 0, "A malformed payload cannot be a silent confirmed-empty state");
    assert.equal((f.view.historyItems as unknown[]).length, 1);
    void f.invoke("refreshHistoryClick"); await f.flush(); await answerFreshHistory(f);
    assert.equal(f.view.historyInsightsAccess, "confirmed");
    assert.equal(f.view.historyInsightsMessage, "");
    assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "200");
    assert.equal(f.lateWrites(), 0);
  });
}

test("A23 a genuine empty summaries array confirms History without a warning", async (t) => {
  const f = await fixture(t, { history: true });
  f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Current campaign", status: "paused" }] });
  f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 }); await f.flush();
  f.take("meta-insights-history").answer({ summaries: [] }); await f.flush();
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  assert.equal(f.view.historyInsightsMessage, "");
  assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
});

for (const [name, roleFields] of [
  ["contradictory lead_manager role", { role: "lead_manager" }],
  ["missing role", {}],
] as Array<[string, Record<string, unknown>]>) {
  test(`A24 owner client rejects server ${name} despite isAdmin true without requesting Insights`, async (t) => {
    const f = await readyHistory(t);
    const previousReads = f.calls.filter((call) => call.url.includes("meta-insights-history")).length;
    void f.invoke("refreshHistoryClick"); await f.flush();
    f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Current campaign", status: "paused" }] });
    f.take("auth-context").answer({ isAdmin: true, workspaceId: W1, ...roleFields }); await f.flush();
    assert.equal(f.view.historyInsightsAccess, "unavailable");
    assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
    assert.ok(String(f.view.historyInsightsMessage).length > 0);
    assert.equal(f.calls.filter((call) => call.url.includes("meta-insights-history")).length, previousReads);
    assert.equal(f.lateWrites(), 0);
  });
}

test("A25 an explicit server admin role authorizes a nonempty History report", async (t) => {
  const f = await fixture(t, { history: true });
  f.take("meta-launches?").answer({ launches: [{ id: launchId, campaignName: "Current campaign", status: "paused" }] });
  f.take("auth-context").answer({ isAdmin: true, role: "admin", workspaceId: W1 }); await f.flush();
  f.take("meta-insights-history").answer({ summaries: [historySummary()] }); await f.flush();
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  assert.equal(f.view.historyInsightsMessage, "");
  assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 1);
  assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "100");
});

for (const report of ["launches", "insights"] as const) {
  for (const phase of ["pending", "cleared"] as const) {
    test(`A26 delayed ${report} body cannot publish across ${phase} sign-out before render or SDK event`, async (t) => {
      const f = await fixture(t, { history: true });
      const gate = deferred<void>();
      t.after(() => gate.resolve());
      f.take("meta-launches?").answerBody({ success: true, mode: "supabase", data: {
        launches: report === "launches" ? [{ id: launchId, campaignName: "Held owner campaign", status: "paused" }] : [],
      } }, 200, report === "launches" ? gate.promise : undefined);
      f.take("auth-context").answer({ isAdmin: true, role: "owner", workspaceId: W1 });
      await f.flush();
      f.take("meta-insights-history").answerBody({ success: true, mode: "supabase", data: {
        summaries: report === "insights" ? [historySummary("999")] : [],
      } }, 200, report === "insights" ? gate.promise : undefined);
      await f.flush();
      assert.equal((f.view.historyItems as unknown[]).length, 0);
      assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
      const key = f.key, calls = f.calls.length, writes = f.writes.length, notices = f.notifications.length;
      const revision = f.signOut.getSignOutRevision();
      f.signOut.markSignOutPending();
      assert.equal(f.signOut.getSignOutRevision(), revision + 1);
      if (phase === "cleared") assert.equal(f.signOut.clearSignOutPending(), true);
      assert.equal(f.signOut.isSignOutPending(), phase === "pending");
      gate.resolve(); await f.flush();
      assert.equal(f.key, key, "Keep context, SDK actor and committed lifetime unchanged");
      assert.equal((f.view.historyItems as unknown[]).length, 0, "An expired lifetime must not publish launch history");
      assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0, "An expired lifetime must not publish Insights");
      if (report === "insights") assert.notEqual(f.view.historyInsightsAccess, "confirmed");
      assert.equal(f.calls.length, calls); assert.equal(f.writes.length, writes);
      assert.equal(f.notifications.length, notices); assert.equal(f.lateWrites(), 0);
    });
  }
}

test("A27 cleared sign-out retires retained refresh but a fresh same-owner lifetime can read reports again", async (t) => {
  const f = await readyHistory(t);
  const refresh = f.view.refreshHistoryClick as () => void;
  const key = f.key, calls = f.calls.length, lookups = f.sdk.lookups, writes = f.writes.length;
  f.signOut.markSignOutPending();
  refresh(); await f.flush();
  assert.equal(f.calls.length, calls); assert.equal(f.sdk.lookups, lookups);
  assert.equal(f.writes.length, writes);
  assert.equal(f.signOut.clearSignOutPending(), true);
  refresh(); await f.flush();
  assert.equal(f.key, key, "Clearing pending does not remount or revive the old lifetime");
  assert.equal(f.calls.length, calls); assert.equal(f.sdk.lookups, lookups);
  assert.equal(f.writes.length, writes);

  await f.change("");
  await f.change("A");
  assert.notEqual(f.key, key);
  await answerFreshHistory(f);
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "200");
  assert.equal(record((f.view.historyItems as unknown[])[0]).campaignName, "Refreshed campaign");
  const recoveredCalls = f.calls.length, recoveredLookups = f.sdk.lookups;
  refresh(); await f.flush();
  assert.equal(f.calls.length, recoveredCalls); assert.equal(f.sdk.lookups, recoveredLookups);
  void f.invoke("refreshHistoryClick"); await f.flush(); await answerFreshHistory(f);
  assert.equal(f.view.historyInsightsAccess, "confirmed");
  assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 1);
  assert.ok(f.calls.every((call) => !call.init.method || call.init.method === "GET"));
  assert.equal(f.notifications.length, 0); assert.equal(f.lateWrites(), 0);
});

type DispatchBoundaryScenario = "request-history" | "fetch-insights" | "request-launch";

async function dispatchBoundaryFixture(t: TestContext, scenario: DispatchBoundaryScenario) {
  const f = await fixture(t, { history: scenario === "fetch-insights" });
  if (scenario === "request-launch") await f.seed();
  let authResponse: HttpCall | undefined;
  if (scenario === "fetch-insights") {
    f.take("meta-launches?").answer({ launches: [] });
    authResponse = f.take("auth-context");
    await f.flush();
  }
  return {
    f,
    start() {
      if (authResponse) {
        authResponse.answer({ isAdmin: true, role: "owner", workspaceId: W1 });
        return Promise.resolve();
      }
      return scenario === "request-launch" ? f.invoke("launch", "PAUSED") : f.invoke("loadHistory");
    },
    reply(call: HttpCall) {
      if (scenario === "fetch-insights") call.answer({ summaries: [historySummary("300")] });
      else if (scenario === "request-launch") call.answer({ dryRun: false, status: "paused", launchId });
      else call.answer({ launches: [{ id: launchId, campaignName: "Boundary campaign", status: "paused" }] });
    },
  };
}

for (const scenario of ["request-history", "fetch-insights", "request-launch"] as const) {
  for (const phase of ["pending", "cleared"] as const) {
    test(`A28 ${scenario} refuses ${phase} sign-out after validated token but before HTTP dispatch`, async (t) => {
      const { f, start, reply } = await dispatchBoundaryFixture(t, scenario);
      const key = f.key, before = f.calls.length, writes = f.writes.length, notices = f.notifications.length;
      const revision = f.signOut.getSignOutRevision();
      let fired = 0;
      f.onNextValidatedToken((token) => {
        assert.equal(token, "synthetic-A", "The actual auth helper returned the original actor's nonempty token");
        fired++;
        f.signOut.markSignOutPending();
        if (phase === "cleared") assert.equal(f.signOut.clearSignOutPending(), true);
      });
      const work = start(); await f.flush();
      const dispatched = f.calls.slice(before);
      // Drain a regression's synthetic responses as well, so a red test never
      // leaves a page operation waiting on its forbidden transport.
      for (const call of dispatched) reply(call);
      await work; await f.flush();
      assert.equal(fired, 1);
      assert.equal(f.signOut.getSignOutRevision(), revision + 1);
      assert.equal(f.signOut.isSignOutPending(), phase === "pending");
      assert.equal(f.key, key, "No context update or SDK event invalidates the original lifetime");
      assert.equal(f.sdk.actor, "A");
      assert.equal(f.view.launchResult, null);
      assert.equal((f.view.historyItems as unknown[]).length, 0);
      assert.equal(Object.keys(record(f.view.historyInsightsByLaunch)).length, 0);
      if (scenario === "fetch-insights") assert.notEqual(f.view.historyInsightsAccess, "confirmed");
      assert.equal(f.writes.length, writes); assert.equal(f.notifications.length, notices);
      assert.equal(f.lateWrites(), 0);
      assert.equal(dispatched.filter((call) => call.init.method === "POST").length, 0, "Expired actions must not dispatch a synthetic POST");
      assert.equal(dispatched.length, 0, "The post-token lifetime fence must stop HTTP before dispatch");
    });
  }

  test(`A29 current ${scenario} still dispatches and accepts its response after token validation`, async (t) => {
    const { f, start, reply } = await dispatchBoundaryFixture(t, scenario);
    const before = f.calls.length;
    let fired = 0;
    f.onNextValidatedToken((token) => { assert.equal(token, "synthetic-A"); fired++; });
    const work = start(); await f.flush();
    const dispatched = f.calls.slice(before);
    assert.equal(fired, 1); assert.equal(dispatched.length, 1);
    const call = dispatched[0];
    assert.equal(call.actor, "A"); assert.equal(call.init.signal?.aborted, false);
    assert.equal(call.init.cache, "no-store");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer synthetic-A");
    assert.equal(Object.hasOwn(call.init, "dispatchGuard"), false, "The actual transport consumes its private guard");
    if (scenario === "request-launch") {
      assert.equal(call.init.method, "POST");
      assert.equal(call.body.statusMode, "PAUSED"); assert.equal(call.body.dryRun, false);
    } else assert.equal(call.init.method || "GET", "GET");
    reply(call); await work; await f.flush();
    if (scenario === "request-history") assert.equal(record((f.view.historyItems as unknown[])[0]).campaignName, "Boundary campaign");
    else if (scenario === "fetch-insights") {
      assert.equal(f.view.historyInsightsAccess, "confirmed");
      assert.equal(record((record(record(f.view.historyInsightsByLaunch)[launchId]).spendByCurrency as unknown[])[0]).spendMinor, "300");
    } else {
      assert.equal(f.view.realLaunchStatus, "created");
      assert.equal(f.writes.filter((key) => key === `negis_ads_launch_history_${W1}::A`).length, 1);
    }
    assert.equal(f.lateWrites(), 0);
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real TSX closures/hooks, api.ts, serverAuth.ts and campaignBrief.ts; only the
// SDK, HTTP, clock, storage and presentation helpers are synthetic. No env,
// actual storage or network access. Key reconciliation and effects below are
// hook simulations, not concurrent React, SDK delivery or browser acceptance.
// Baseline: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-advertising-hub-session.test.ts --baseline
// Selector baseline: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-advertising-hub-session.test.ts --selector-baseline
// Reconstructs only the prior actor eligibility and selector lifetime in memory.
// Current: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-advertising-hub-session.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");
const selectorBaseline = process.argv.includes("--selector-baseline");
assert.ok(!(baseline && selectorBaseline), "Choose either the Git baseline or the reconstructed selector baseline");
const pagePath = "artifacts/negis/src/pages/AdvertisingHub.tsx";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-10-22T08:00:00.000Z";
const CREATED = "2026-10-21T07:00:00.000Z";
const exposed = [
  "launches", "loadState", "insightsAccess", "insightsSummaries", "insightsMessage",
  "crmOutcomesAccess", "crmOutcomes", "crmOutcomesMessage", "campaignGoal",
  "campaignGoalError", "updateCampaignGoal", "prepareCampaign", "setReloadKey",
];

function compile(source: string, fileName: string, page = false) {
  const inner = source.includes("function AdvertisingHubSession(") ? "AdvertisingHubSession" : "AdvertisingHub";
  let replaced = 0;
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
        if (page && ts.isFunctionDeclaration(node) && node.name?.text === inner && node.body) {
          // Keep the wrapper JSX/key intact. Only the inner final JSX becomes
          // an observation surface; nested returns and real effects are kept.
          return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body,
              node.body.statements.map((statement) => {
                if (!ts.isReturnStatement(statement)) return statement;
                replaced++;
                return ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression(
                  exposed.map((name) => ts.factory.createShorthandPropertyAssignment(name))));
              })));
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
  if (page) assert.equal(replaced, 1, "Expose exactly one inner-page return, never the wrapper");
  return result.outputText;
}

function restoreSelectorBaseline(source: string) {
  // This is a two-expression reconstruction, not a frozen historical commit.
  // The on-disk runtime, wrapper JSX, effects and real transports stay intact.
  let actorChanges = 0;
  let lifetimeChanges = 0;
  const file = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const transformed = ts.transform(file, [(context) => {
    const stripVerifiedClinic: import("typescript").Visitor = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && ts.isIdentifier(node.left) && node.left.text === "clinicId") {
        actorChanges++;
        return node.right;
      }
      return ts.visitEachChild(node, stripVerifiedClinic, context);
    };
    const visit: import("typescript").Visitor = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "actorId" && node.initializer) {
        return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
          ts.visitNode(node.initializer, stripVerifiedClinic) as import("typescript").Expression);
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "isSessionAlive" && node.body) {
        return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
          node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body,
            node.body.statements.map((statement) => {
              if (!ts.isReturnStatement(statement) || !statement.expression) return statement;
              const call = statement.expression;
              assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "Boolean");
              assert.equal(call.arguments.length, 1);
              lifetimeChanges++;
              return ts.factory.updateReturnStatement(statement, ts.factory.updateCallExpression(call, call.expression,
                call.typeArguments, [ts.factory.createBinaryExpression(call.arguments[0], ts.SyntaxKind.AmpersandAmpersandToken,
                  ts.factory.createBinaryExpression(ts.factory.createCallExpression(ts.factory.createIdentifier("readWorkspaceId"), undefined, []),
                    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.factory.createIdentifier("workspaceId")))]));
            })));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit) as import("typescript").SourceFile;
  }]);
  try {
    assert.equal(actorChanges, 1, "Restore exactly the prior unverified actor eligibility");
    assert.equal(lifetimeChanges, 1, "Restore exactly the prior selector-dependent lifetime");
    return ts.createPrinter().printFile(transformed.transformed[0]);
  } finally { transformed.dispose(); }
}

const compiled = (async () => {
  let page = baseline
    ? execFileSync("git", ["show", `2076a40:${pagePath}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, pagePath), "utf8");
  if (selectorBaseline) page = restoreSelectorBaseline(page);
  return {
    page: compile(page, pagePath, true), wrapped: page.includes("function AdvertisingHubSession("),
    api: compile(await readFile(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8"), "api.ts"),
    auth: compile(await readFile(path.join(root, "artifacts/negis/src/lib/serverAuth.ts"), "utf8"), "serverAuth.ts"),
    signOut: compile(await readFile(path.join(root, "artifacts/negis/src/lib/authSignOut.ts"), "utf8"), "authSignOut.ts"),
    brief: compile(await readFile(path.join(root, "lib/advertising/campaignBrief.ts"), "utf8"), "campaignBrief.ts"),
    insights: compile(await readFile(path.join(root, "artifacts/negis/src/lib/metaInsightsHistory.ts"), "utf8"), "metaInsightsHistory.ts"),
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
  return a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function driver() {
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = true;
  let alive = true;
  let tree: View;
  let component: () => View;
  let lateWrites = 0;
  let stateChanges = 0;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    const index = cursor++;
    if (!slots[index]) slots[index] = create();
    assert.equal(slots[index].kind, kind, "Hook order must remain stable");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  function effect(kind: "layout" | "effect", create: Effect, deps?: Dependencies) {
    const current = slot(kind, () => ({ kind, create, deps, pending: true }));
    if (!sameDependencies(current.deps, deps)) current.pending = true;
    current.create = create;
    current.deps = deps;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", () => {
        const value: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            if (!alive) { lateWrites++; return; }
            const next = typeof update === "function" ? (update as (x: unknown) => unknown)(value.value) : update;
            if (!Object.is(next, value.value)) { value.value = next; dirty = true; stateChanges++; }
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
    useCallback<T>(callback: T, deps?: Dependencies) { return hooks.useMemo(() => callback, deps); },
    useEffect: (create: Effect, deps?: Dependencies) => effect("effect", create, deps),
    useLayoutEffect: (create: Effect, deps?: Dependencies) => effect("layout", create, deps),
  };
  const effects = (kind: "layout" | "effect") => slots.filter(
    (item): item is Extract<Slot, { kind: "layout" | "effect" }> => item.kind === kind);
  function setup(kind: "layout" | "effect", all = false) {
    const pending = effects(kind).filter((item) => all || item.pending);
    for (const item of pending) item.cleanup?.();
    for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
  }
  return {
    hooks, mount(fn: () => View) { component = fn; }, force() { dirty = true; },
    render() {
      if (!alive || !dirty) return;
      cursor = 0;
      dirty = false;
      tree = component();
      setup("layout");
      setup("effect");
    },
    replayEffects() {
      for (const kind of ["layout", "effect"] as const) for (const item of effects(kind)) {
        item.cleanup?.();
        item.cleanup = undefined;
      }
      setup("layout", true);
      setup("effect", true);
    },
    dispose() {
      for (const kind of ["layout", "effect"] as const) for (const item of effects(kind)) item.cleanup?.();
      alive = false;
    },
    get view() { return tree; }, get lateWrites() { return lateWrites; },
    get stateChanges() { return stateChanges; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const record = (value: unknown): View => value && typeof value === "object" ? value as View : {};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const rows = (value: unknown) => Array.from(value as View[]);
const launch = (name = "Private A") => ({
  id: launchId, campaignName: name, status: "paused", metaStatus: "PAUSED", metaCampaignId: "synthetic-campaign",
  budgetDailyMinor: 700, currency: "USD", lastError: "", createdAt: CREATED,
});
const insights = () => ({
  metaCampaignLaunchId: launchId, availability: "available", freshness: "fresh", coveredDateStart: "2026-10-20",
  coveredDateStop: "2026-10-21", latestFetchedAt: NOW, rowCount: 2,
  spendByCurrency: [{ currency: "USD", currencyExponent: 2, spendMinor: "1234" }],
  impressions: "200", clicks: "15", inlineLinkClicks: "11", metaLeads: "3",
});
const outcomes = () => ({
  attributedLeads: 7, unattributedLeads: 2, paidAttributedDeals: 4, paidUnattributedDeals: 1,
  paidAppointmentDeals: 3, paidAttributedAppointmentDeals: 2, pendingDeals: 6,
  attributedRevenueByCurrency: [{ currency: "KZT", currencyExponent: 2, amountMinor: "567800" }], generatedAt: NOW,
});
type HttpCall = {
  url: string; init: RequestInit; actor: string; at: number; answered: boolean;
  answer(data: unknown, status?: number, gate?: Promise<void>): void;
  answerBody(body: unknown, status?: number, gate?: Promise<void>): void;
};
type Auth = {
  user: { id: string; email: string } | null; clinicId: string | null; userRole: string; workspacePurpose: string;
  isLoading: boolean; isSigningOut: boolean; isDemoMode: boolean; isImpersonation: boolean;
};
type PrivateResource = "meta-insights-history" | "advertising-outcomes";
const resources: PrivateResource[] = ["meta-insights-history", "advertising-outcomes"];

async function fixture(t: TestContext, options: {
  auth?: Partial<Auth>; selector?: string; holdTokens?: boolean; history?: unknown[];
  sdkActor?: string; initialSessionCallbacks?: boolean;
} = {}) {
  const code = await compiled;
  const auth: Auth = {
    user: { id: "A", email: "a@example.invalid" }, clinicId: W1, userRole: "owner", workspacePurpose: "clinic",
    isLoading: false, isSigningOut: false, isDemoMode: false, isImpersonation: false, ...options.auth,
  };
  let selector = options.selector ?? auth.clinicId ?? "demo-workspace";
  const sdkActor = options.sdkActor ?? auth.user?.id ?? "";
  const sdk = { actor: sdkActor, token: options.sdkActor === undefined ? "synthetic-A" : `synthetic-${sdkActor}`, lookups: 0 };
  const listeners = new Set<(event: string, session: unknown) => void>();
  const initialSessions: Array<{ registration: number; actor: string }> = [];
  let listenerRegistrations = 0;
  let listenerUnsubscriptions = 0;
  let pendingInitialCallbacks = 0;
  const tokenGates: Array<ReturnType<typeof deferred<void>>> = [];
  const calls: HttpCall[] = [];
  const writes: Array<{ key: string; value: string }> = [];
  const historyReads: string[] = [];
  const navigations: string[] = [];
  const notifications: unknown[][] = [];
  const signOutStorage = new Map<string, string>();
  let holdTokens = options.holdTokens ?? false;
  let activeDriver = driver();
  let outer = driver();
  let inner: ReturnType<typeof driver> | undefined;
  let innerKey: unknown = Symbol("unmounted");
  let mounted = true;
  const retired: Array<ReturnType<typeof driver>> = [];
  const session = () => sdk.actor ? { user: { id: sdk.actor }, access_token: sdk.token } : null;
  const supabase = { auth: {
    async getSession() {
      sdk.lookups++;
      if (holdTokens) { const gate = deferred<void>(); tokenGates.push(gate); await gate.promise; }
      return { error: null, data: { session: session() } };
    },
    onAuthStateChange(callback: (event: string, session: unknown) => void) {
      const registration = ++listenerRegistrations;
      let active = true;
      listeners.add(callback);
      if (options.initialSessionCallbacks) {
        pendingInitialCallbacks++;
        // Model cached-session delivery after registration, without getSession
        // or a render. A subscription removed before delivery stays silent.
        queueMicrotask(() => {
          pendingInitialCallbacks--;
          if (!active) return;
          const next = session();
          initialSessions.push({ registration, actor: next?.user.id ?? "" });
          callback("INITIAL_SESSION", next);
        });
      }
      return { data: { subscription: { unsubscribe() {
        if (!active) return;
        active = false;
        listeners.delete(callback);
        listenerUnsubscriptions++;
      } } } };
    },
  } };
  const unexpected = (name: string): never => assert.fail(`Unexpected fixture dependency: ${name}`);
  class FixtureDate extends Date {
    constructor(value: string | number = NOW) { super(value); }
    static now() { return Date.parse(NOW); }
  }
  function evaluate<T>(source: string, filename: string, require: (name: string) => unknown) {
    const exports = {} as T;
    const storage = {
      getItem: (key: string) => key === "negis_signout_pending_v1" ? signOutStorage.get(key) ?? null : unexpected("localStorage read"),
      setItem: (key: string, value: string) => {
        if (key === "negis_signout_pending_v1") signOutStorage.set(key, value);
        else writes.push({ key, value });
      },
      removeItem: (key: string) => {
        if (key === "negis_signout_pending_v1") signOutStorage.delete(key);
        else unexpected("localStorage removal");
      },
    };
    new Script(source, { filename }).runInNewContext({
      exports, require, Error, DOMException, AbortController, AbortSignal, Headers, Response, Date: FixtureDate,
      localStorage: storage,
      window: { location: { origin: "https://simulation.invalid" }, localStorage: storage, sessionStorage: storage },
      fetch(url: string, init: RequestInit) {
        assert.match(url, /^\/api\/crm\/(meta-launches|auth-context|meta-insights-history|advertising-outcomes)\?workspaceId=/);
        assert.equal(init.method ?? "GET", "GET", "The Hub fixture allows read-only HTTP only");
        assert.equal(init.body, undefined);
        const pending = deferred<Response>();
        const call: HttpCall = {
          url, init, actor: sdk.actor, at: FixtureDate.now(), answered: false,
          answer(data, status = 200, gate) {
            call.answerBody({ success: status < 400, mode: "supabase", data }, status, gate);
          },
          answerBody(body, status = 200, gate) {
            assert.equal(call.answered, false, "Each synthetic HTTP promise settles exactly once");
            call.answered = true;
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
        // Ignore abort deliberately, including deferred body reads. Guards must
        // reject late publication even if transport cannot retract a response.
        return pending.promise;
      },
    });
    return exports;
  }
  const signOut = evaluate<{
    isSignOutPending(): boolean; getSignOutRevision(): number; markSignOutPending(): void; clearSignOutPending(): boolean;
  }>(code.signOut, "authSignOut.simulation.cjs", unexpected);
  const serverAuth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(code.auth, "serverAuth.simulation.cjs", (name) => {
    if (name === "@/lib/authSignOut") return {
      isSignOutPending: () => auth.isSigningOut || signOut.isSignOutPending(), getSignOutRevision: signOut.getSignOutRevision,
    };
    assert.equal(name, "@/lib/supabase");
    return { hasSupabaseFrontendEnv: true, supabase, sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } };
  });
  const api = evaluate(code.api, "api.simulation.cjs", (name) => {
    assert.equal(name, "@/lib/serverAuth");
    return serverAuth;
  });
  const brief = evaluate(code.brief, "campaignBrief.simulation.cjs", unexpected);
  const insightsPayload = evaluate(code.insights, "metaInsightsHistory.simulation.cjs", unexpected);
  const page = evaluate<{ default: () => View }>(code.page, "AdvertisingHub.simulation.cjs", (name) => {
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
    if (name === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase,
      sessionAuth: { onAuthStateChange: supabase.auth.onAuthStateChange } };
    if (name === "wouter") return { Link: Symbol("Link"), useLocation: () => ["/advertising", (next: string) => navigations.push(next)] };
    if (name === "sonner") return { toast: Object.fromEntries(["success", "error", "warning", "info"].map((key) => [key, (...args: unknown[]) => notifications.push(args)])) };
    if (name === "@/lib/demoStorage") return {
      isRealWorkspace: (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      readWorkspaceId: () => selector,
      workspaceScopedKey: (key: string) => `${key}::${selector}`,
      readDemoStorage: (key: string) => { historyReads.push(key); return options.history ?? []; },
    };
    if (name === "../../../../lib/advertising/campaignBrief") return brief;
    if (name === "../../../../lib/advertising/assistant") return { buildAdvertisingAssistantBrief: () => ({ tone: "info", reason: "synthetic" }) };
    if (name === "../../../../lib/advertising/creativeEvidence") return { buildCreativeExperimentGroups: () => [] };
    if (name === "../../../../lib/meta/cities") return { KZ_META_CITY_OPTIONS: [{ id: "astana", labelRu: "Synthetic City" }] };
    if (name === "lucide-react" || name.startsWith("@/components/")) return {};
    return unexpected(name);
  });
  outer.mount(code.wrapped ? page.default : () => ({}));
  function render() {
    if (!mounted) return;
    activeDriver = outer;
    outer.render();
    const element = code.wrapped ? outer.view as unknown as Element : { type: page.default, props: {}, key: undefined };
    assert.equal(typeof element.type, "function", "The real wrapper must render its session component");
    if (!inner || !Object.is(innerKey, element.key)) {
      if (inner) { inner.dispose(); retired.push(inner); }
      inner = driver();
      innerKey = element.key;
    }
    activeDriver = inner;
    inner.mount(() => element.type(element.props));
    inner.render();
  }
  async function flush() {
    for (let i = 0; i < 6; i++) { render(); await tick(); }
    render();
  }
  function emit(actor: string, event = "SIGNED_IN") {
    sdk.actor = actor;
    sdk.token = `synthetic-${actor}`;
    for (const listener of [...listeners]) listener(event, session());
  }
  function dispose() {
    if (!mounted) return;
    inner?.dispose();
    outer.dispose();
    mounted = false;
  }
  function changeBeforeRender(patch: Partial<Auth>) {
    Object.assign(auth, patch);
    if (Object.hasOwn(patch, "clinicId")) selector = auth.clinicId ?? "demo-workspace";
    if (Object.hasOwn(patch, "user")) emit(auth.user?.id ?? "");
    outer.force(); inner?.force();
  }
  t.after(() => {
    dispose();
    holdTokens = false;
    for (const gate of tokenGates.splice(0)) gate.resolve();
  });
  await flush();
  return {
    calls, writes, historyReads, navigations, notifications, sdk, flush, render, dispose, initialSessions, signOut,
    get view() { return inner!.view; }, get key() { return innerKey; },
    get lifetime() { return retired.length; },
    get listenerCount() { return listeners.size; },
    get listenerRegistrations() { return listenerRegistrations; },
    get listenerUnsubscriptions() { return listenerUnsubscriptions; },
    get pendingInitialCallbacks() { return pendingInitialCallbacks; },
    get sessionStateChanges() { return inner!.stateChanges; },
    lateWrites: () => retired.reduce((sum, item) => sum + item.lateWrites, 0) + (inner?.lateWrites ?? 0),
    matching(part: string) { return calls.filter((call) => call.url.includes(`/${part}?`)); },
    take(part: string) {
      const call = calls.find((item) => !item.answered && item.url.includes(`/${part}?`));
      assert.ok(call, `Expected pending GET ${part}`);
      return call;
    },
    invoke(name: string, ...args: unknown[]) {
      const fn = inner!.view[name];
      assert.equal(typeof fn, "function", name);
      return (fn as (...values: unknown[]) => unknown)(...args);
    },
    changeNow(patch: Partial<Auth>) {
      changeBeforeRender(patch); render();
    },
    changeBeforeRender,
    async change(patch: Partial<Auth>) { this.changeNow(patch); await flush(); },
    async remount() {
      assert.ok(mounted, "Only a mounted route can be replaced");
      inner!.dispose(); retired.push(inner!);
      inner = undefined;
      outer.dispose();
      outer = driver();
      outer.mount(code.wrapped ? page.default : () => ({}));
      await flush();
    },
    async changeSelector(value: string) {
      selector = value;
      outer.force(); inner?.force(); await flush();
    },
    replayNow() { outer.replayEffects(); inner!.replayEffects(); },
    async replay() { this.replayNow(); await flush(); },
    emitSdkBeforeRender(actor: string) { emit(actor); },
    async sdkRoundTrip() {
      emit("B"); emit("A"); outer.force(); inner?.force(); await flush();
    },
    replaceSdkWithoutEvent() { sdk.actor = "B"; sdk.token = "synthetic-B"; },
    rotateToken() {
      sdk.token = `synthetic-${sdk.actor}-rotated`;
      for (const listener of [...listeners]) listener("TOKEN_REFRESHED", session());
    },
    releaseTokens() {
      holdTokens = false;
      const count = tokenGates.length;
      for (const gate of tokenGates.splice(0)) gate.resolve();
      return count;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertPrivateEmpty(f: Fixture) {
  assert.notEqual(f.view.insightsAccess, "ready");
  assert.notEqual(f.view.crmOutcomesAccess, "ready");
  assert.equal(rows(f.view.insightsSummaries).length, 0);
  const crm = record(f.view.crmOutcomes);
  for (const key of ["attributedLeads", "unattributedLeads", "paidAttributedDeals", "paidUnattributedDeals", "paidAppointmentDeals", "paidAttributedAppointmentDeals", "pendingDeals"]) {
    assert.equal(crm[key], 0, `Private CRM ${key} must be cleared`);
  }
  assert.equal(rows(crm.attributedRevenueByCurrency).length, 0);
  assert.equal(crm.generatedAt, "");
}
function privateStatus(f: Fixture) {
  return [f.view.insightsAccess, f.view.crmOutcomesAccess, f.view.insightsMessage, f.view.crmOutcomesMessage];
}
function resourceData(resource: PrivateResource) {
  return resource === "meta-insights-history" ? { summaries: [insights()] } : { outcomes: outcomes() };
}
async function allowPrivate(f: Fixture, workspace = W1, role: "owner" | "admin" = "owner") {
  const requests = f.matching("auth-context").filter((call) => !call.answered);
  assert.equal(requests.length, 2, "Independent CRM and Insights access checks each revalidate once");
  for (const call of requests) call.answer({ isAdmin: true, role, workspaceId: workspace });
  await f.flush();
}
async function loadOwner(f: Fixture, role: "owner" | "admin" = "owner") {
  assert.equal(f.calls.length, 3, "One launches read and two independent auth checks before access confirmation");
  f.take("meta-launches").answer({ launches: [launch()] });
  await allowPrivate(f, W1, role);
  assert.equal(f.calls.length, 5);
  for (const resource of resources) f.take(resource).answer(resourceData(resource));
  await f.flush();
  assert.equal(f.view.loadState, "ready");
  assert.equal(f.view.insightsAccess, "ready");
  assert.equal(f.view.crmOutcomesAccess, "ready");
}
async function setGoal(f: Fixture) {
  for (const [key, value] of Object.entries({ service: "Synthetic consultation", targetPatients: "12", durationDays: "14", maxBudget: "98" })) {
    f.invoke("updateCampaignGoal", key, value);
  }
  await f.flush();
}

for (const role of ["owner", "admin"] as const) {
  test(`H1 ${role} reads exact launches, private Insights and CRM payloads`, async (t) => {
    const f = await fixture(t, { auth: { userRole: role } });
    await loadOwner(f, role);
    assert.deepEqual(json(rows(f.view.launches)), [launch()]);
    assert.deepEqual(json(rows(f.view.insightsSummaries)), [insights()]);
    const crm = record(f.view.crmOutcomes);
    assert.equal(crm.attributedLeads, 7);
    assert.equal(record(rows(crm.attributedRevenueByCurrency)[0]).amountMinor, 567800n);
    assert.equal(crm.generatedAt, NOW);
    assert.deepEqual(f.calls.map((call) => call.at), Array(5).fill(Date.parse(NOW)));
    assert.equal(f.matching("meta-launches").length, 1);
    assert.equal(f.matching("auth-context").length, 2);
    for (const resource of resources) assert.equal(f.matching(resource).length, 1);
    for (const call of f.calls) {
      assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer synthetic-A");
      assert.equal(new URL(call.url, "https://simulation.invalid").searchParams.get("workspaceId"), W1);
      assert.equal(Object.hasOwn(call.init, "expectedUserId"), false, "Real api.ts consumes expectedUserId before fetch");
      assert.equal(Object.hasOwn(call.init, "dispatchGuard"), false);
    }
    assert.equal(f.writes.length, 0);
    assert.equal(f.navigations.length, 0);
  });
}

test("H2 same actor/workspace owner-to-manager clears already loaded private reports immediately", async (t) => {
  const f = await fixture(t);
  await loadOwner(f);
  const key = f.key;
  f.changeNow({ userRole: "manager" });
  assertPrivateEmpty(f);
  assert.notEqual(f.key, key);
  await f.flush();
  assertPrivateEmpty(f);
  assert.equal(f.matching("auth-context").length, 2, "Downgrade cannot start a new private auth check");
  for (const resource of resources) assert.equal(f.matching(resource).length, 1);
  assert.equal(f.lateWrites(), 0);
});

for (const stage of ["headers", "body"] as const) {
  for (const status of [200, 500]) {
    test(`H3 delayed access ${stage} HTTP ${status} cannot restore reports or error after downgrade`, async (t) => {
      const f = await fixture(t);
      const old = f.matching("auth-context");
      assert.equal(old.length, 2);
      const gate = deferred<void>();
      if (stage === "body") {
        for (const call of old) call.answer({ isAdmin: true, role: "owner", workspaceId: W1 }, status, gate.promise);
        await f.flush();
      }
      await f.change({ userRole: "manager" });
      const state = privateStatus(f);
      if (stage === "headers") for (const call of old) call.answer({ isAdmin: true, role: "owner", workspaceId: W1 }, status);
      gate.resolve();
      await f.flush();
      assertPrivateEmpty(f);
      assert.deepEqual(privateStatus(f), state, "Old success/error must not replace the downgraded access state");
      assert.equal(f.matching("auth-context").length, 2);
      for (const resource of resources) assert.equal(f.matching(resource).length, 0);
      assert.equal(f.lateWrites(), 0);
    });
  }
}

for (const resource of resources) {
  for (const stage of ["headers", "body"] as const) {
    for (const status of [200, 500]) {
      test(`H4 delayed ${resource} ${stage} HTTP ${status} cannot republish after downgrade`, async (t) => {
        const f = await fixture(t);
        await allowPrivate(f);
        const old = f.take(resource);
        const gate = deferred<void>();
        if (stage === "body") { old.answer(resourceData(resource), status, gate.promise); await f.flush(); }
        await f.change({ userRole: "manager" });
        const state = privateStatus(f);
        if (stage === "headers") old.answer(resourceData(resource), status);
        gate.resolve();
        await f.flush();
        assertPrivateEmpty(f);
        assert.deepEqual(privateStatus(f), state);
        assert.equal(f.matching("auth-context").length, 2);
        for (const part of resources) assert.equal(f.matching(part).length, 1);
        assert.equal(f.lateWrites(), 0);
      });
    }
  }
}

const transitions = ["account", "workspace", "account-ABA", "workspace-ABA", "SDK-ABA"] as const;
type Transition = typeof transitions[number];
async function transition(f: Fixture, kind: Transition) {
  if (kind === "account") await f.change({ user: { id: "B", email: "b@example.invalid" } });
  if (kind === "workspace") await f.change({ clinicId: W2 });
  if (kind === "account-ABA") {
    await f.change({ user: { id: "B", email: "b@example.invalid" } });
    await f.change({ user: { id: "A", email: "a@example.invalid" } });
  }
  if (kind === "workspace-ABA") { await f.change({ clinicId: W2 }); await f.change({ clinicId: W1 }); }
  if (kind === "SDK-ABA") await f.sdkRoundTrip();
}
for (const kind of transitions) {
  test(`H5 ${kind} resets loaded private data, launches and unsubmitted campaign goal`, async (t) => {
    const f = await fixture(t);
    await loadOwner(f);
    await setGoal(f);
    const lifetime = f.lifetime;
    await transition(f, kind);
    assert.ok(f.lifetime > lifetime, "Committed workspace ABA may reuse a key string, never the old component lifetime");
    assertPrivateEmpty(f);
    assert.equal(rows(f.view.launches).length, 0);
    assert.equal(record(f.view.campaignGoal).service, "");
    assert.equal(f.writes.length, 0);
    assert.equal(f.lateWrites(), 0);
  });
}

for (const kind of ["account", "workspace", "SDK-ABA", "unmount"] as const) {
  for (const status of [200, 500]) {
    test(`H6 old launches/private bodies HTTP ${status} cannot publish after ${kind}`, async (t) => {
      const f = await fixture(t);
      await allowPrivate(f);
      const old = [f.take("meta-launches"), ...resources.map((resource) => f.take(resource))];
      const gate = deferred<void>();
      old[0].answer({ launches: [launch("Obsolete A")] }, status, gate.promise);
      for (const [i, resource] of resources.entries()) old[i + 1].answer(resourceData(resource), status, gate.promise);
      await f.flush();
      if (kind === "unmount") f.dispose();
      else await transition(f, kind);
      const state = privateStatus(f);
      gate.resolve();
      await f.flush();
      assertPrivateEmpty(f);
      assert.deepEqual(privateStatus(f), state);
      assert.equal(rows(f.view.launches).length, 0);
      assert.equal(f.lateWrites(), 0);
      assert.equal(f.writes.length, 0);
      assert.equal(f.notifications.length, 0);
    });
  }
}

test("H7 SDK actor replaced during token wait cannot dispatch with the replacement actor token", async (t) => {
  const f = await fixture(t, { holdTokens: true });
  assert.equal(f.calls.length, 0);
  assert.ok(f.sdk.lookups >= 3, "All three read effects have reached synthetic token lookup");
  f.replaceSdkWithoutEvent();
  assert.ok(f.releaseTokens() >= 3);
  await f.flush();
  assert.equal(f.calls.length, 0, "Real serverAuth(expectedUserId) must reject actor B before any fetch");
  assertPrivateEmpty(f);
  assert.equal(f.writes.length, 0);
});

const inactive: Array<[string, Partial<Auth>]> = [
  ["missing actor", { user: null }],
  ["loading", { isLoading: true }],
  ["signout", { isSigningOut: true }],
  ["UUID demo", { isDemoMode: true }],
  ["impersonation", { isImpersonation: true }],
];
for (const [name, auth] of inactive) {
  test(`H8 ${name} cannot start server or private requests`, async (t) => {
    const f = await fixture(t, { auth });
    assert.equal(f.calls.length, 0);
    assert.equal(f.sdk.lookups, 0, "Ineligible sessions stop before SDK/token lookup");
    assertPrivateEmpty(f);
    assert.equal(f.historyReads.length, 0, "A real UUID never becomes a local demo fallback");
    assert.equal(f.writes.length, 0);
  });
}

test("H9 same-actor token refresh keeps confirmed reports and the unsubmitted goal", async (t) => {
  const f = await fixture(t);
  await loadOwner(f);
  await setGoal(f);
  const key = f.key;
  const launches = f.view.launches;
  const summaries = f.view.insightsSummaries;
  const crm = f.view.crmOutcomes;
  f.rotateToken();
  await f.flush();
  assert.equal(f.key, key);
  assert.equal(f.view.launches, launches);
  assert.equal(f.view.loadState, "ready");
  assert.equal(f.view.insightsSummaries, summaries);
  assert.equal(f.view.crmOutcomes, crm);
  assert.equal(f.view.insightsAccess, "ready");
  assert.equal(f.view.crmOutcomesAccess, "ready");
  assert.equal(record(f.view.campaignGoal).service, "Synthetic consultation");
  assert.equal(f.calls.length, 5);
});

test("H10 same-actor refresh during token wait sends only exact current scoped reads", async (t) => {
  const f = await fixture(t, { holdTokens: true });
  const key = f.key;
  f.rotateToken();
  f.releaseTokens();
  await f.flush();
  assert.equal(f.key, key);
  await loadOwner(f);
  for (const call of f.calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer synthetic-A-rotated");
    assert.ok(call.init.signal, "Every read belongs to a cancellable session");
    assert.equal(call.init.cache, "no-store", "Old reports cannot re-enter through the transport cache");
  }
});

test("H11 explicit non-UUID demo preserves local history without SDK, private or server reads", async (t) => {
  const f = await fixture(t, {
    auth: { user: null, isDemoMode: true, clinicId: "synthetic-demo" }, history: [launch("Demo history")],
  });
  assert.equal(f.view.loadState, "ready");
  assert.deepEqual(json(rows(f.view.launches)), [launch("Demo history")]);
  assert.deepEqual(f.historyReads, ["negis_ads_launch_history_synthetic-demo"]);
  assert.equal(f.sdk.lookups, 0);
  assert.equal(f.calls.length, 0);
  assertPrivateEmpty(f);
  assert.equal(f.writes.length, 0);
});

test("H12 anonymous non-demo cannot read even a synthetic local history", async (t) => {
  const f = await fixture(t, { auth: { user: null, clinicId: "synthetic-demo" }, history: [launch()] });
  assert.equal(f.historyReads.length, 0);
  assert.equal(rows(f.view.launches).length, 0);
  assert.equal(f.calls.length, 0);
});

for (const destination of ["/ads-automation", "/content-studio"]) {
  test(`H13 current goal prepares exactly one local prefill for ${destination}`, async (t) => {
    const f = await fixture(t);
    await setGoal(f);
    await f.invoke("prepareCampaign", destination);
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].key, `${destination === "/content-studio" ? "negis_content_studio_goal_prefill" : "negis_ads_automation_prefill"}::${W1}`);
    assert.deepEqual(JSON.parse(f.writes[0].value), {
      schemaVersion: 1, platform: "meta", sourceModule: "advertising-hub", sourceKind: "goal",
      campaignName: "Synthetic consultation \u00b7 Synthetic City", service: "Synthetic consultation", city: "Synthetic City",
      cityId: "astana", targetPatients: 12, durationDays: 14, maxBudget: 98, dailyBudget: 7,
      budgetCurrency: "USD", generatedAt: NOW,
    });
    assert.deepEqual(f.navigations, [destination]);
    assert.equal(f.calls.length, 3, "Preparing a local goal must not send a server mutation");
  });
}

for (const kind of ["account", "workspace", "SDK-ABA", "role"] as const) {
  test(`H14 retained goal handler cannot write prefill or navigate after ${kind}`, async (t) => {
    const f = await fixture(t);
    await setGoal(f);
    const prepare = f.view.prepareCampaign as (destination: string) => unknown;
    if (kind === "role") await f.change({ userRole: "manager" });
    else await transition(f, kind);
    await prepare("/content-studio");
    await f.flush();
    assert.equal(f.writes.length, 0);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.lateWrites(), 0);
  });
}

test("H15 downgrade during SDK token wait dispatches only the new manager's launches read", async (t) => {
  const f = await fixture(t, { holdTokens: true });
  assert.equal(f.calls.length, 0);
  await f.change({ userRole: "manager" });
  f.releaseTokens();
  await f.flush();
  assertPrivateEmpty(f);
  assert.equal(f.matching("meta-launches").length, 1);
  assert.equal(f.matching("auth-context").length, 0);
  for (const resource of resources) assert.equal(f.matching(resource).length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.lateWrites(), 0);
});

test("H16 verified W1 owner loads scoped reports when unavailable selector persistence falls back to demo-workspace", async (t) => {
  const f = await fixture(t, { selector: "demo-workspace" });
  await loadOwner(f);
  assert.deepEqual(json(rows(f.view.launches)), [launch()]);
  assert.deepEqual(json(rows(f.view.insightsSummaries)), [insights()]);
  assert.equal(record(f.view.crmOutcomes).attributedLeads, 7);
  assert.equal(record(f.view.crmOutcomes).generatedAt, NOW);
  assert.deepEqual(f.calls.map((call) => new URL(call.url, "https://simulation.invalid").searchParams.get("workspaceId")), Array(5).fill(W1));
  assert.equal(f.historyReads.length, 0, "A fallback selector must not replace verified membership with demo history");
  assert.equal(f.writes.length, 0);
  assert.equal(f.navigations.length, 0);
});

test("H17 mismatched W2 selector neither redirects W1 report reads nor permits prefill/navigation", async (t) => {
  const f = await fixture(t, { selector: W2 });
  await loadOwner(f);
  await setGoal(f);
  const key = f.key;
  const reports = [f.view.launches, f.view.insightsSummaries, f.view.crmOutcomes];
  for (const destination of ["/ads-automation", "/content-studio"]) await f.invoke("prepareCampaign", destination);
  await f.changeSelector("demo-workspace");
  assert.equal(f.key, key, "A local selector change does not replace verified W1 membership");
  assert.equal(f.view.launches, reports[0]);
  assert.equal(f.view.insightsSummaries, reports[1]);
  assert.equal(f.view.crmOutcomes, reports[2]);
  for (const destination of ["/ads-automation", "/content-studio"]) await f.invoke("prepareCampaign", destination);
  await f.flush();
  assert.equal(f.calls.length, 5);
  for (const call of f.calls) {
    assert.equal(new URL(call.url, "https://simulation.invalid").searchParams.get("workspaceId"), W1);
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer synthetic-A");
    assert.equal(call.actor, "A");
  }
  assert.equal(f.writes.length, 0, "Neither mismatched selector may receive a scoped prefill");
  assert.equal(f.navigations.length, 0);
  assert.equal(f.historyReads.length, 0);
  assert.equal(f.lateWrites(), 0);
});

test("H18 stale W1 selector without verified clinicId cannot authorize real/private reads or prefill", async (t) => {
  const f = await fixture(t, { auth: { clinicId: null }, selector: W1, history: [launch("Stale history")] });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sdk.lookups, 0, "A stale selector cannot supply verified workspace authority to token lookup");
  assertPrivateEmpty(f);
  assert.equal(rows(f.view.launches).length, 0);
  assert.equal(f.historyReads.length, 0);
  await setGoal(f);
  await f.invoke("prepareCampaign", "/content-studio");
  await f.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.navigations.length, 0);
});

for (const status of [200, 500]) {
  test(`H19 simulated StrictMode cleanup/setup keeps replacement reports usable after old HTTP ${status} bodies`, async (t) => {
    const f = await fixture(t);
    await allowPrivate(f);
    assert.equal(f.calls.length, 5);
    const old = [f.take("meta-launches"), ...resources.map((resource) => f.take(resource))];
    const gate = deferred<void>();
    old[0].answer({ launches: [launch("Obsolete replay launch")] }, status, gate.promise);
    old[1].answer({ summaries: [{ ...insights(), impressions: "999" }] }, status, gate.promise);
    old[2].answer({ outcomes: { ...outcomes(), attributedLeads: 99 } }, status, gate.promise);
    await f.flush();
    const key = f.key;
    // Replay effect cleanup/setup in the same hook instance. This models the
    // local lifecycle contract only, not React's real StrictMode scheduler.
    await f.replay();
    assert.equal(f.key, key);
    for (const call of old) assert.equal(call.init.signal?.aborted, true);
    assert.equal(f.calls.length, 8, "Replacement setup starts one launches read and two fresh access checks");
    f.take("meta-launches").answer({ launches: [launch("Replacement launch")] });
    await allowPrivate(f);
    for (const resource of resources) f.take(resource).answer(resourceData(resource));
    await f.flush();
    assert.equal(f.calls.length, 10);
    assert.equal(f.view.loadState, "ready");
    assert.equal(f.view.insightsAccess, "ready");
    assert.equal(f.view.crmOutcomesAccess, "ready");
    const reports = [f.view.launches, f.view.insightsSummaries, f.view.crmOutcomes];
    const state = privateStatus(f);
    gate.resolve();
    await f.flush();
    assert.equal(f.view.launches, reports[0]);
    assert.equal(f.view.insightsSummaries, reports[1]);
    assert.equal(f.view.crmOutcomes, reports[2]);
    assert.deepEqual(privateStatus(f), state);
    assert.equal(f.view.loadState, "ready");
    assert.deepEqual(json(rows(f.view.launches)), [launch("Replacement launch")]);
    assert.deepEqual(json(rows(f.view.insightsSummaries)), [insights()]);
    assert.equal(record(f.view.crmOutcomes).attributedLeads, 7);
    assert.equal(f.calls.length, 10);
    assert.equal(f.matching("meta-launches").length, 2);
    assert.equal(f.matching("auth-context").length, 4);
    for (const resource of resources) assert.equal(f.matching(resource).length, 2);
    assert.equal(f.lateWrites(), 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.navigations.length, 0);
    assert.equal(f.notifications.length, 0);
  });
}

const DEMO_WORKSPACE = "synthetic-demo";
const demoContext = {
  user: { id: "demo-user", email: "demo@example.invalid" }, clinicId: DEMO_WORKSPACE, isDemoMode: true,
};

async function cachedSdkDemo(t: TestContext) {
  return fixture(t, {
    auth: demoContext, sdkActor: "A", initialSessionCallbacks: true, history: [launch("Local demo history")],
  });
}

function assertLocalOnly(f: Fixture) {
  assertPrivateEmpty(f);
  assert.equal(f.sdk.lookups, 0, "Local-only demo must not call SDK getSession");
  assert.equal(f.calls.length, 0, "SDK callbacks cannot grant demo server authority");
  assert.equal(f.notifications.length, 0);
  assert.equal(f.lateWrites(), 0);
}

function assertDemoPrefill(f: Fixture, destination: string, index = 0) {
  assert.equal(f.writes.length, index + 1, "The current local demo handler must prepare one prefill");
  assert.equal(f.writes[index].key,
    `${destination === "/content-studio" ? "negis_content_studio_goal_prefill" : "negis_ads_automation_prefill"}::${DEMO_WORKSPACE}`);
  assert.deepEqual(JSON.parse(f.writes[index].value), {
    schemaVersion: 1, platform: "meta", sourceModule: "advertising-hub", sourceKind: "goal",
    campaignName: "Synthetic consultation \u00b7 Synthetic City", service: "Synthetic consultation", city: "Synthetic City",
    cityId: "astana", targetPatients: 12, durationDays: 14, maxBudget: 98, dailyBudget: 7,
    budgetCurrency: "USD", generatedAt: NOW,
  });
  assert.deepEqual(f.navigations.slice(index, index + 1), [destination]);
  assert.equal(f.navigations.length, index + 1);
  assertLocalOnly(f);
}

for (const destination of ["/ads-automation", "/content-studio"]) {
  test(`H20 INITIAL_SESSION cached SDK actor settles explicit local demo and prepares ${destination}`, async (t) => {
    const f = await cachedSdkDemo(t);
    assert.equal(f.sdk.actor, "A", "Cached SDK actor must be independent of demo AuthContext user");
    assert.ok(f.initialSessions.length >= 3, "Wrapper, original inner and replacement inner each receive INITIAL_SESSION");
    assert.deepEqual(f.initialSessions.map((item) => item.actor), Array(f.listenerRegistrations).fill("A"));
    assert.deepEqual(f.initialSessions.map((item) => item.registration),
      Array.from({ length: f.listenerRegistrations }, (_, index) => index + 1));
    assert.equal(f.pendingInitialCallbacks, 0);
    assert.equal(f.listenerCount, 2);
    const key = f.key, lifetime = f.lifetime, registrations = f.listenerRegistrations;
    await f.flush();
    assert.equal(f.key, key); assert.equal(f.lifetime, lifetime);
    assert.equal(f.listenerRegistrations, registrations, "Initial callbacks must settle without a remount loop");
    assert.equal(f.view.loadState, "ready");
    assert.deepEqual(json(rows(f.view.launches)), [launch("Local demo history")]);
    assert.ok(f.historyReads.every((historyKey) => historyKey === `negis_ads_launch_history_${DEMO_WORKSPACE}`));
    assertLocalOnly(f);
    await setGoal(f);
    f.invoke("prepareCampaign", destination);
    assertDemoPrefill(f, destination);
  });
}

test("H21 INITIAL_SESSION same SDK actor token refresh preserves the current local demo handoff", async (t) => {
  const f = await cachedSdkDemo(t);
  await setGoal(f);
  const prepare = f.view.prepareCampaign as (destination: string) => void;
  const key = f.key, lifetime = f.lifetime, registrations = f.listenerRegistrations;
  const goal = f.view.campaignGoal;
  f.rotateToken();
  // Invoke the retained real closure before any simulated render.
  prepare("/ads-automation");
  assertDemoPrefill(f, "/ads-automation");
  await f.flush();
  assert.equal(f.key, key); assert.equal(f.lifetime, lifetime);
  assert.equal(f.listenerRegistrations, registrations);
  assert.equal(f.view.campaignGoal, goal);
  assert.equal(f.sdk.token, "synthetic-A-rotated");
  f.invoke("prepareCampaign", "/content-studio");
  assertDemoPrefill(f, "/content-studio", 1);
});

for (const transition of ["A-to-B", "A-to-B-to-A"] as const) {
  test(`H22 INITIAL_SESSION stale local demo handler refuses ${transition} before render`, async (t) => {
    const f = await cachedSdkDemo(t);
    await setGoal(f);
    const prepare = f.view.prepareCampaign as (destination: string) => void;
    prepare("/ads-automation");
    assertDemoPrefill(f, "/ads-automation");
    const key = f.key;
    f.emitSdkBeforeRender("B");
    prepare("/content-studio");
    assert.equal(f.writes.length, 1, "SDK actor change must synchronously invalidate the old local handler");
    assert.equal(f.navigations.length, 1);
    if (transition === "A-to-B-to-A") {
      f.emitSdkBeforeRender("A");
      prepare("/ads-automation");
      assert.equal(f.writes.length, 1, "Returning to A before render must not revive the old lifetime");
      assert.equal(f.navigations.length, 1);
    }
    assert.equal(f.key, key, "No render may occur between SDK events and stale-handler assertions");
    await f.flush();
    assert.notEqual(f.key, key);
    assert.equal(record(f.view.campaignGoal).service, "");
    prepare("/content-studio");
    assert.equal(f.writes.length, 1);
    await setGoal(f);
    f.invoke("prepareCampaign", "/content-studio");
    assertDemoPrefill(f, "/content-studio", 1);
    assert.equal(f.listenerCount, 2);
  });
}

for (const [name, auth] of [
  ["real UUID demo", { ...demoContext, clinicId: W1 }],
  ["real UUID impersonation", { isImpersonation: true }],
  ["local demo impersonation", { ...demoContext, isImpersonation: true }],
] satisfies Array<[string, Partial<Auth>]>) {
  test(`H23 INITIAL_SESSION ${name} never gains server, private or prefill authority`, async (t) => {
    const f = await fixture(t, { auth, sdkActor: "A", initialSessionCallbacks: true, history: [launch("Forbidden history")] });
    assert.ok(f.initialSessions.length >= 2);
    assert.equal(f.pendingInitialCallbacks, 0);
    await setGoal(f);
    const prepare = f.view.prepareCampaign as (destination: string) => void;
    for (const actor of ["A", "B", "A"]) {
      f.emitSdkBeforeRender(actor);
      for (const destination of ["/ads-automation", "/content-studio"]) prepare(destination);
      f.rotateToken();
      await f.flush();
      await setGoal(f);
      for (const destination of ["/ads-automation", "/content-studio"]) f.invoke("prepareCampaign", destination);
      assert.equal(f.writes.length, 0);
      assert.equal(f.navigations.length, 0);
      assert.equal(f.historyReads.length, 0);
      assert.equal(rows(f.view.launches).length, 0);
      assertLocalOnly(f);
    }
    assert.equal(f.listenerCount, 2);
  });
}

test("H24 INITIAL_SESSION listeners clean up across SDK remounts, replay and queued delivery after disposal", async (t) => {
  const f = await cachedSdkDemo(t);
  for (const actor of ["B", "A"]) {
    f.emitSdkBeforeRender(actor);
    await f.flush();
    assert.equal(f.listenerCount, 2);
    assert.equal(f.listenerRegistrations - f.listenerUnsubscriptions, 2);
    assert.equal(f.initialSessions.length, f.listenerRegistrations);
    assert.equal(f.pendingInitialCallbacks, 0);
  }
  for (let i = 0; i < 2; i++) {
    await f.replay();
    assert.equal(f.listenerCount, 2);
    assert.equal(f.listenerRegistrations - f.listenerUnsubscriptions, 2);
    assert.equal(f.initialSessions.length, f.listenerRegistrations);
  }
  const delivered = f.initialSessions.length;
  f.replayNow();
  assert.equal(f.pendingInitialCallbacks, 2, "Registration must queue delivery, never invoke it inline");
  assert.equal(f.initialSessions.length, delivered);
  f.dispose();
  assert.equal(f.listenerCount, 0);
  assert.equal(f.listenerRegistrations, f.listenerUnsubscriptions);
  f.emitSdkBeforeRender("B");
  await f.flush();
  assert.equal(f.pendingInitialCallbacks, 0);
  assert.equal(f.initialSessions.length, delivered, "Unsubscribed queued callbacks cannot reach disposed hooks");
  assert.equal(f.writes.length, 0);
  assert.equal(f.navigations.length, 0);
  assertLocalOnly(f);
});

for (const status of [401, 403]) {
  test(`H25 current outcomes HTTP ${status} has an authorization state, clears data and can retry`, async (t) => {
    const f = await fixture(t);
    await loadOwner(f);
    f.invoke("setReloadKey", (value: number) => value + 1); await f.flush();
    f.take("meta-launches").answer({ launches: [launch()] });
    await allowPrivate(f);
    f.take("meta-insights-history").answer({ summaries: [insights()] });
    f.take("advertising-outcomes").answerBody({ success: false, error: "Synthetic outcomes denied" }, status);
    await f.flush();
    assert.equal(f.view.crmOutcomesAccess, status === 401 ? "required" : "forbidden");
    assert.ok(String(f.view.crmOutcomesMessage).length > 0);
    for (const key of ["attributedLeads", "unattributedLeads", "paidAttributedDeals", "paidUnattributedDeals", "paidAppointmentDeals", "paidAttributedAppointmentDeals", "pendingDeals"]) {
      assert.equal(record(f.view.crmOutcomes)[key], 0, `Denied ${key} must not retain old counts`);
    }
    assert.equal(rows(record(f.view.crmOutcomes).attributedRevenueByCurrency).length, 0);
    assert.equal(record(f.view.crmOutcomes).generatedAt, "");
    assert.equal(f.view.insightsAccess, "ready", "A separately confirmed Insights report remains usable");
    assert.equal(rows(f.view.insightsSummaries).length, 1);
    f.invoke("setReloadKey", (value: number) => value + 1); await f.flush();
    f.take("meta-launches").answer({ launches: [launch()] });
    await allowPrivate(f);
    for (const resource of resources) f.take(resource).answer(resourceData(resource));
    await f.flush();
    assert.equal(f.view.crmOutcomesAccess, "ready");
    assert.equal(f.view.crmOutcomesMessage, "");
    assert.equal(record(f.view.crmOutcomes).attributedLeads, 7);
    assert.equal(f.lateWrites(), 0);
  });
}

for (const stage of ["headers", "body"] as const) for (const status of [401, 403]) {
  test(`H26 old outcomes HTTP ${status} ${stage} cannot replace a newer nonempty success`, async (t) => {
    const f = await fixture(t);
    await allowPrivate(f);
    f.take("meta-launches").answer({ launches: [launch()] });
    f.take("meta-insights-history").answer({ summaries: [insights()] });
    const old = f.take("advertising-outcomes"), gate = deferred<void>();
    const denial = { success: false, error: "Synthetic obsolete outcomes denial" };
    if (stage === "body") { old.answerBody(denial, status, gate.promise); await f.flush(); }
    f.invoke("setReloadKey", (value: number) => value + 1); await f.flush();
    f.take("meta-launches").answer({ launches: [launch("Latest report")] });
    await allowPrivate(f);
    f.take("meta-insights-history").answer({ summaries: [insights()] });
    const latest = f.matching("advertising-outcomes").find((call) => call !== old && !call.answered);
    assert.ok(latest, "The replacement outcomes request must be independent of the held old request");
    latest.answer({ outcomes: { ...outcomes(), attributedLeads: 17 } });
    await f.flush();
    assert.equal(f.view.crmOutcomesAccess, "ready");
    const current = f.view.crmOutcomes;
    if (stage === "headers") old.answerBody(denial, status);
    gate.resolve(); await f.flush();
    assert.equal(f.view.crmOutcomesAccess, "ready");
    assert.equal(f.view.crmOutcomes, current);
    assert.equal(record(f.view.crmOutcomes).attributedLeads, 17);
    assert.equal(f.view.crmOutcomesMessage, "");
    assert.equal(f.lateWrites(), 0);
  });
}

for (const stage of ["headers", "body"] as const) for (const status of [401, 403]) {
  test(`H27 old outcomes success ${stage} cannot replace a newer HTTP ${status} denial`, async (t) => {
    const f = await fixture(t);
    await allowPrivate(f);
    f.take("meta-launches").answer({ launches: [launch()] });
    f.take("meta-insights-history").answer({ summaries: [insights()] });
    const old = f.take("advertising-outcomes"), gate = deferred<void>();
    const obsolete = { outcomes: { ...outcomes(), attributedLeads: 99 } };
    if (stage === "body") { old.answer(obsolete, 200, gate.promise); await f.flush(); }
    f.invoke("setReloadKey", (value: number) => value + 1); await f.flush();
    f.take("meta-launches").answer({ launches: [launch()] });
    await allowPrivate(f);
    f.take("meta-insights-history").answer({ summaries: [insights()] });
    const latest = f.matching("advertising-outcomes").find((call) => call !== old && !call.answered);
    assert.ok(latest, "The replacement outcomes request must be independent of the held old request");
    latest.answerBody({ success: false, error: "Synthetic latest outcomes denial" }, status);
    await f.flush();
    const message = f.view.crmOutcomesMessage;
    assert.equal(f.view.crmOutcomesAccess, status === 401 ? "required" : "forbidden");
    if (stage === "headers") old.answer(obsolete);
    gate.resolve(); await f.flush();
    assert.equal(f.view.crmOutcomesAccess, status === 401 ? "required" : "forbidden");
    assert.equal(f.view.crmOutcomesMessage, message);
    assert.equal(record(f.view.crmOutcomes).attributedLeads, 0);
    assert.equal(rows(record(f.view.crmOutcomes).attributedRevenueByCurrency).length, 0);
    assert.equal(record(f.view.crmOutcomes).generatedAt, "");
    assert.equal(f.lateWrites(), 0);
  });
}

for (const [name, summaries] of [
  ["missing summaries", undefined], ["null summaries", null], ["non-array summaries", { broken: true }],
  ["null row", [null]], ["nested null spend", [{ ...insights(), spendByCurrency: null }]],
  ["mixed valid and invalid rows", [insights(), { ...insights(), metaCampaignLaunchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", spendByCurrency: null }]],
] as Array<[string, unknown]>) {
  test(`H28 successful envelope with ${name} is an error, never confirmed empty or partial`, async (t) => {
    const f = await fixture(t);
    f.take("meta-launches").answer({ launches: [launch()] });
    await allowPrivate(f);
    f.take("advertising-outcomes").answer({ outcomes: outcomes() });
    f.take("meta-insights-history").answer({ summaries });
    await f.flush();
    assert.equal(f.view.insightsAccess, "error");
    assert.equal(rows(f.view.insightsSummaries).length, 0);
    assert.ok(String(f.view.insightsMessage).length > 0);
    assert.equal(f.view.crmOutcomesAccess, "ready");
    assert.equal(f.view.loadState, "ready");
    assert.equal(f.lateWrites(), 0);
  });
}

test("H29 a genuine empty summaries array remains a confirmed empty report", async (t) => {
  const f = await fixture(t);
  f.take("meta-launches").answer({ launches: [launch()] });
  await allowPrivate(f);
  f.take("advertising-outcomes").answer({ outcomes: outcomes() });
  f.take("meta-insights-history").answer({ summaries: [] }); await f.flush();
  assert.equal(f.view.insightsAccess, "ready");
  assert.equal(rows(f.view.insightsSummaries).length, 0);
  assert.equal(f.view.insightsMessage, "");
});

for (const [name, roleFields] of [
  ["contradictory lead_manager role", { role: "lead_manager" }],
  ["missing role", {}],
] as Array<[string, Record<string, unknown>]>) {
  test(`H30 owner client rejects server ${name} despite isAdmin true in both private auth checks`, async (t) => {
    const f = await fixture(t);
    await loadOwner(f);
    const previousReads = resources.map((resource) => f.matching(resource).length);
    f.invoke("setReloadKey", (value: number) => value + 1); await f.flush();
    f.take("meta-launches").answer({ launches: [launch()] });
    const auth = f.matching("auth-context").filter((call) => !call.answered);
    assert.equal(auth.length, 2, "Both independent auth checks receive the contradictory fixture reply");
    for (const call of auth) call.answer({ isAdmin: true, workspaceId: W1, ...roleFields });
    await f.flush();
    assert.equal(f.view.insightsAccess, "forbidden");
    assert.equal(f.view.crmOutcomesAccess, "forbidden");
    assertPrivateEmpty(f);
    assert.deepEqual(resources.map((resource) => f.matching(resource).length), previousReads,
      "Neither Insights nor CRM outcomes may be requested after invalid server-role confirmation");
    assert.ok(String(f.view.insightsMessage).length > 0);
    assert.ok(String(f.view.crmOutcomesMessage).length > 0);
    assert.equal(f.view.loadState, "ready");
    assert.equal(f.lateWrites(), 0);
  });
}

for (const mode of ["owner", "demo"] as const) {
  for (const destination of ["/ads-automation", "/content-studio"]) {
    for (const phase of ["pending", "cleared"] as const) {
      test(`H31 ${mode} retained ${destination} handler refuses ${phase} sign-out before render or SDK event`, async (t) => {
        const f = await fixture(t, mode === "demo" ? {
          auth: { clinicId: "demo-workspace", isDemoMode: true },
        } : {});
        await setGoal(f);
        const prepare = f.view.prepareCampaign as (destination: string) => void;
        prepare(destination);
        assert.equal(f.writes.length, 1, "Positive control: the current goal can be handed off");
        assert.deepEqual(f.navigations, [destination]);
        const key = f.key, calls = f.calls.length, lookups = f.sdk.lookups;
        const revision = f.signOut.getSignOutRevision();
        f.signOut.markSignOutPending();
        assert.equal(f.signOut.getSignOutRevision(), revision + 1);
        if (phase === "cleared") assert.equal(f.signOut.clearSignOutPending(), true);
        assert.equal(f.signOut.isSignOutPending(), phase === "pending");
        // Keep the committed view and SDK actor unchanged across the immediate fence.
        prepare(destination);
        assert.equal(f.key, key);
        assert.equal(f.writes.length, 1, "A pre-sign-out handler must not write another brief");
        assert.deepEqual(f.navigations, [destination], "A pre-sign-out handler must not navigate");
        assert.equal(f.calls.length, calls);
        assert.equal(f.sdk.lookups, lookups);

        f.changeNow({ isSigningOut: true });
        assert.equal(f.signOut.clearSignOutPending(), true);
        await f.change({ isSigningOut: false });
        await setGoal(f);
        prepare(destination);
        assert.equal(f.writes.length, 1, "Recovery must not revive the retired handler");
        f.invoke("prepareCampaign", destination);
        assert.equal(f.writes.length, 2, "A fresh same-identity screen can prepare a new brief");
        assert.deepEqual(f.navigations, [destination, destination]);
      });
    }
  }
}

for (const phase of ["pending", "cleared"] as const) {
  test(`H32 held report bodies cannot publish across ${phase} sign-out before context or SDK change`, async (t) => {
    const f = await fixture(t);
    const gate = deferred<void>();
    t.after(() => gate.resolve());
    f.take("meta-launches").answer({ launches: [launch()] }, 200, gate.promise);
    await allowPrivate(f);
    for (const resource of resources) f.take(resource).answer(resourceData(resource), 200, gate.promise);
    await f.flush();
    assertPrivateEmpty(f);
    assert.equal(rows(f.view.launches).length, 0);
    const key = f.key, calls = f.calls.length;
    f.signOut.markSignOutPending();
    if (phase === "cleared") assert.equal(f.signOut.clearSignOutPending(), true);
    gate.resolve(); await f.flush();
    assert.equal(f.key, key, "No context change, SDK event or keyed remount invalidates these replies");
    assertPrivateEmpty(f);
    assert.equal(rows(f.view.launches).length, 0);
    assert.equal(f.calls.length, calls);
    assert.equal(f.lateWrites(), 0);
  });
}

for (const mode of ["owner", "demo"] as const) {
  for (const destination of ["/ads-automation", "/content-studio"]) {
    test(`H33 ${mode} ${destination} stays fenced across batched sign-out and recovers only in a fresh route`, async (t) => {
      const f = await fixture(t, mode === "demo" ? {
        auth: { clinicId: "demo-workspace", isDemoMode: true },
      } : {});
      await setGoal(f);
      const prepare = f.view.prepareCampaign as (destination: string) => void;
      prepare(destination);
      assert.equal(f.writes.length, 1, "Positive control: the committed handler works before sign-out");
      const key = f.key, lifetime = f.lifetime, view = f.view;
      const calls = f.calls.length, lookups = f.sdk.lookups;
      const registrations = f.listenerRegistrations, revision = f.signOut.getSignOutRevision();

      f.signOut.markSignOutPending();
      f.changeBeforeRender({ isSigningOut: true });
      prepare(destination);
      assert.equal(f.writes.length, 1);
      assert.equal(f.signOut.clearSignOutPending(), true);
      f.changeBeforeRender({ isSigningOut: false });
      prepare(destination);
      assert.equal(f.signOut.getSignOutRevision(), revision + 1);
      assert.equal(f.signOut.isSignOutPending(), false);
      assert.equal(f.sdk.actor, "A", "No SDK actor event supplies an alternate invalidation path");
      assert.equal(f.view, view, "Neither pending nor cleared context state has committed");
      assert.equal(f.key, key);
      assert.equal(f.lifetime, lifetime);
      assert.equal(f.listenerRegistrations, registrations);
      assert.equal(f.writes.length, 1, "Clearing pending cannot revive the committed handler");
      assert.deepEqual(f.navigations, [destination]);
      assert.equal(f.calls.length, calls);
      assert.equal(f.sdk.lookups, lookups);

      await f.flush();
      assert.equal(f.key, key, "Batched same-identity context does not manufacture a keyed remount");
      assert.equal(f.lifetime, lifetime);
      f.invoke("prepareCampaign", destination);
      assert.equal(f.writes.length, 1, "A render alone cannot refresh the retired revision");

      await f.remount();
      assert.equal(f.lifetime, lifetime + 1, "The positive recovery control is an actual new hook lifetime");
      assert.equal(record(f.view.campaignGoal).service, "");
      await setGoal(f);
      prepare(destination);
      assert.equal(f.writes.length, 1, "A new mount must not revive its predecessor's closure");
      f.invoke("prepareCampaign", destination);
      assert.equal(f.writes.length, 2, "The current legitimate session can prepare its own fresh brief");
      assert.deepEqual(f.navigations, [destination, destination]);
      assert.equal(f.listenerCount, 2);
      assert.equal(f.lateWrites(), 0);
      if (mode === "demo") assertLocalOnly(f);
    });
  }
}

for (const mode of ["owner", "demo"] as const) {
  for (const destination of ["/ads-automation", "/content-studio"]) {
    test(`H34 ${mode} retained ${destination} handler cannot survive SDK ABA before React commits`, async (t) => {
      const f = await fixture(t, mode === "demo" ? {
        auth: { clinicId: "demo-workspace", isDemoMode: true },
      } : {});
      await setGoal(f);
      const prepare = f.view.prepareCampaign as (destination: string) => void;
      prepare(destination);
      assert.equal(f.writes.length, 1);
      const key = f.key, lifetime = f.lifetime, view = f.view;
      const calls = f.calls.length, lookups = f.sdk.lookups, registrations = f.listenerRegistrations;
      const revision = f.signOut.getSignOutRevision();

      f.emitSdkBeforeRender("B");
      prepare(destination);
      assert.equal(f.writes.length, 1);
      f.emitSdkBeforeRender("A");
      prepare(destination);
      assert.equal(f.sdk.actor, "A");
      assert.equal(f.signOut.getSignOutRevision(), revision, "The sign-out revision cannot mask a broken SDK lifetime guard");
      assert.equal(f.signOut.isSignOutPending(), false);
      assert.equal(f.view, view, "Both SDK events precede the next context commit");
      assert.equal(f.key, key);
      assert.equal(f.lifetime, lifetime);
      assert.equal(f.listenerRegistrations, registrations);
      assert.equal(f.writes.length, 1, "Returning to A cannot revive its old brief");
      assert.deepEqual(f.navigations, [destination]);
      assert.equal(f.calls.length, calls);
      assert.equal(f.sdk.lookups, lookups);

      await f.flush();
      assert.notEqual(f.key, key, "Observed SDK ABA supplies a new epoch even when React only sees A");
      assert.equal(f.lifetime, lifetime + 1);
      assert.equal(record(f.view.campaignGoal).service, "");
      await setGoal(f);
      prepare(destination);
      assert.equal(f.writes.length, 1);
      f.invoke("prepareCampaign", destination);
      assert.equal(f.writes.length, 2, "The replacement A lifetime is independently usable");
      assert.deepEqual(f.navigations, [destination, destination]);
      assert.equal(f.listenerCount, 2);
      assert.equal(f.lateWrites(), 0);
      if (mode === "demo") assertLocalOnly(f);
    });
  }
}

for (const stage of ["headers", "body"] as const) {
  for (const transition of ["sign-out", "SDK-ABA", "sign-out+SDK-ABA"] as const) {
    test(`H35 held report ${stage} cannot update hooks before ${transition} commits`, async (t) => {
      const f = await fixture(t);
      await allowPrivate(f);
      const old = [f.take("meta-launches"), ...resources.map((resource) => f.take(resource))];
      const payloads = [
        { launches: [launch("Obsolete batched A")] },
        { summaries: [{ ...insights(), impressions: "999" }] },
        { outcomes: { ...outcomes(), attributedLeads: 99 } },
      ];
      const gate = deferred<void>();
      t.after(() => gate.resolve());
      if (stage === "body") {
        for (const [index, call] of old.entries()) call.answer(payloads[index], 200, gate.promise);
        await f.flush();
      }
      assertPrivateEmpty(f);
      assert.equal(rows(f.view.launches).length, 0);
      const key = f.key, lifetime = f.lifetime, view = f.view, calls = f.calls.length;
      const revision = f.signOut.getSignOutRevision();
      const sdkChanges = transition !== "sign-out";

      if (transition !== "SDK-ABA") {
        f.signOut.markSignOutPending();
        f.changeBeforeRender({ isSigningOut: true });
      }
      if (sdkChanges) f.emitSdkBeforeRender("B");
      if (transition !== "SDK-ABA") {
        assert.equal(f.signOut.clearSignOutPending(), true);
        f.changeBeforeRender({ isSigningOut: false });
      }
      if (sdkChanges) f.emitSdkBeforeRender("A");
      assert.equal(f.signOut.isSignOutPending(), false);
      assert.equal(f.signOut.getSignOutRevision(), revision + (transition === "SDK-ABA" ? 0 : 1));
      for (const call of old) assert.equal(call.init.signal?.aborted, sdkChanges);
      const stateChanges = f.sessionStateChanges;
      if (stage === "headers") for (const [index, call] of old.entries()) call.answer(payloads[index]);
      gate.resolve();
      // Drain real transport/body continuations without letting a keyed remount
      // hide an obsolete write to the still-mounted hooks.
      for (let i = 0; i < 6; i++) await tick();
      assert.equal(f.view, view);
      assert.equal(f.key, key);
      assert.equal(f.lifetime, lifetime);
      assert.equal(f.sessionStateChanges, stateChanges, "Late replies must not update even the uncommitted old hooks");
      assert.equal(f.calls.length, calls);
      assert.equal(f.writes.length, 0);
      assert.equal(f.navigations.length, 0);

      await f.flush();
      assertPrivateEmpty(f);
      assert.equal(rows(f.view.launches).length, 0);
      if (!sdkChanges) {
        assert.equal(f.key, key);
        assert.equal(f.lifetime, lifetime);
        await f.remount();
      } else {
        assert.notEqual(f.key, key);
      }
      assert.equal(f.lifetime, lifetime + 1);
      f.take("meta-launches").answer({ launches: [launch("Fresh legitimate A")] });
      await allowPrivate(f);
      f.take("meta-insights-history").answer({ summaries: [{ ...insights(), impressions: "400" }] });
      f.take("advertising-outcomes").answer({ outcomes: { ...outcomes(), attributedLeads: 17 } });
      await f.flush();
      assert.equal(f.view.loadState, "ready");
      assert.deepEqual(json(rows(f.view.launches)), [launch("Fresh legitimate A")]);
      assert.equal(f.view.insightsAccess, "ready");
      assert.equal(record(rows(f.view.insightsSummaries)[0]).impressions, "400");
      assert.equal(f.view.crmOutcomesAccess, "ready");
      assert.equal(record(f.view.crmOutcomes).attributedLeads, 17);
      assert.equal(f.listenerCount, 2);
      assert.equal(f.notifications.length, 0);
      assert.equal(f.lateWrites(), 0);
    });
  }
}

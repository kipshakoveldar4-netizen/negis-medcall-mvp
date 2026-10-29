import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real page closures, list effects, normalizers, button props and api.ts.
// Hooks/effects are a deterministic simulation, not concurrent React or browser QA.
// SDK identity, storage and all requests are isolated fakes; no external calls.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-ad-launch-list-lifetime.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-ad-launch-list-lifetime.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");
const workspace = "11111111-1111-4111-8111-111111111111";
const legacyKey = `negis_ads_launch_history_${workspace}`;
type Page = "AdsAutomation" | "AdvertisingHub";
type View = Record<string, any>;
type Element = { type: unknown; props: View };
const launch = (id: string, extra: View = {}) => ({
  id, campaignName: id, status: "paused", metaStatus: "PAUSED",
  createdAt: "2026-10-25T00:00:00Z", ...extra,
});
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

function compile(source: string, fileName: string, page?: Page) {
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
        if (page && ts.isFunctionDeclaration(node) && node.name?.text === `${page}Session` && node.body) {
          const names = page === "AdsAutomation"
            ? ["historyItems", "historyLoaded", "loading", "notice", "loadHistory", "checkHealth", "saveLocalLaunch", "recheckHistoryVideo"]
            : ["launches", "loadState"];
          const statements = node.body.statements.map((statement) => {
            if (!ts.isReturnStatement(statement)) return statement;
            replaced++;
            const ui = page === "AdsAutomation"
              ? ts.factory.createCallExpression(ts.factory.createIdentifier("renderHistory"), undefined, [])
              : statement.expression!;
            return ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression([
              ...names.map((name) => ts.factory.createShorthandPropertyAssignment(name)),
              ts.factory.createPropertyAssignment("ui", ui),
            ]));
          });
          return ts.visitEachChild(ts.factory.updateFunctionDeclaration(node,
            node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, ts.factory.updateBlock(node.body, statements)), visit, context);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.equal(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
  if (page) assert.equal(replaced, 1, "Observe only the session's final return; keep real functions/effects");
  return result.outputText + (page ? `\nexports.fixtureSession = ${page}Session;\n` : "");
}

const compiled = (async () => {
  const result: Record<string, string> = {};
  for (const page of ["AdsAutomation", "AdvertisingHub"] as const) {
    const file = `artifacts/negis/src/pages/${page}.tsx`;
    const source = baseline
      ? execFileSync("git", ["show", `7c61854:${file}`], { cwd: root, encoding: "utf8" })
      : await readFile(path.join(root, file), "utf8");
    result[page] = compile(source, file, page);
  }
  const apiPath = "artifacts/negis/src/lib/api.ts";
  result.api = compile(baseline
    ? execFileSync("git", ["show", `7c61854:${apiPath}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, apiPath), "utf8"), "api.ts");
  return result;
})();

type Effect = { create: () => void | (() => void); deps?: unknown[]; cleanup?: () => void; pending: boolean };
function hooks() {
  const slots: any[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let dirty = true;
  let view: View;
  function effect(create: Effect["create"], deps?: unknown[]) {
    const index = cursor++;
    let item: Effect = slots[index];
    if (!item) { item = { create, deps, pending: true }; slots[index] = item; effects.push(item); }
    else {
      if (!deps || !item.deps || deps.some((value, i) => !Object.is(value, item.deps![i]))) item.pending = true;
      item.create = create; item.deps = deps;
    }
  }
  return {
    api: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
        const state = slots[index];
        return [state.value, (update: any) => {
          const next = typeof update === "function" ? update(state.value) : update;
          if (!Object.is(state.value, next)) { state.value = next; dirty = true; }
        }];
      },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useMemo(create: () => unknown) { cursor++; return create(); },
      useLayoutEffect: effect,
      useEffect: effect,
    },
    render(component: () => View, runEffects = true) {
      if (dirty) { dirty = false; cursor = 0; view = component(); }
      if (runEffects) {
        const pending = effects.filter((item) => item.pending);
        for (const item of pending) item.cleanup?.();
        for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
      }
    },
    dispose() { for (const item of effects) item.cleanup?.(); },
    get view() { return view; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Call = {
  url: string; init: RequestInit; taken: boolean; bodyReads: number;
  answer(data: unknown, status?: number, gate?: Promise<void>): void;
  answerBody(body: unknown, status?: number, gate?: Promise<void>): void;
  reject(error: Error): void;
};
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Element;
  return [node, ...elements(node.props.children)];
}
function textContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(textContent).join(" ");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" && "props" in value ? textContent((value as Element).props.children) : "";
}

async function fixture(t: TestContext, page: Page, options: { actor?: string; demo?: boolean; holdHealth?: boolean; cache?: View } = {}) {
  const code = await compiled;
  const actor = options.actor ?? "B";
  const workspaceId = options.demo ? "synthetic-demo" : workspace;
  const local = new Map<string, string>(Object.entries(options.cache ?? {}).map(([key, rows]) => [key, JSON.stringify(rows)]));
  const reads: string[] = [];
  const writes: string[] = [];
  const removals: string[] = [];
  const calls: Call[] = [];
  const driver = hooks();
  const auth = { user: { id: actor, email: "synthetic@example.invalid" }, userRole: "manager" };
  const serverAuth = { getSupabaseAccessToken: async () => `synthetic-${actor}` };
  const sessionAuth = { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  const storage = {
    getItem(key: string) { reads.push(key); return local.get(key) ?? null; },
    setItem(key: string, value: string) { writes.push(key); local.set(key, value); },
    removeItem(key: string) { removals.push(key); local.delete(key); },
  };
  const fakeFetch = (url: string, init: RequestInit) => {
    assert.match(url, /^\/api\/crm\/(meta-launches\?|health$|ad-creative-meta-upload$)/, "No unrelated or external request");
    const pending = deferred<Response>();
    const call: Call = {
      url, init, taken: false, bodyReads: 0, reject: pending.reject,
      answer(data, status = 200, gate) { call.answerBody({ success: status < 400, mode: "supabase", data }, status, gate); },
      answerBody(body, status = 200, gate) {
        const response = new Response(JSON.stringify(body), { status });
        const wrap = (value: Response): Response => {
          const read = value.text.bind(value);
          const clone = value.clone.bind(value);
          Object.defineProperties(value, {
            text: { value: async () => { call.bodyReads++; if (gate) await gate; return read(); } },
            clone: { value: () => wrap(clone()) },
          });
          return value;
        };
        pending.resolve(wrap(response));
      },
    };
    calls.push(call);
    if (url.endsWith("/health") && !options.holdHealth) call.answer({ meta: { configured: true } });
    return pending.promise;
  };
  function evaluate(source: string, require: (name: string) => unknown): View {
    const exports = {};
    new Script(source).runInNewContext({
      exports, require, Error, DOMException, AbortController, Headers, Response, fetch: fakeFetch,
      window: { localStorage: storage, location: { origin: "https://synthetic.invalid" }, scrollTo() {}, setInterval() {}, clearInterval() {} },
    });
    return exports;
  }
  const api = evaluate(code.api, (name) => { assert.equal(name, "@/lib/serverAuth"); return serverAuth; });
  const city = { id: "astana", labelRu: "Synthetic City", canonicalName: "Synthetic" };
  const module = evaluate(code[page], (name) => {
    if (name === "react") return driver.api;
    if (name === "react/jsx-runtime") {
      const jsx = (type: unknown, props: View) => ({ type, props });
      return { jsx, jsxs: jsx };
    }
    if (name === "@/contexts/AuthContext") return { useAuth: () => auth };
    if (name === "@/lib/api") return api;
    if (name === "@/lib/serverAuth") return serverAuth;
    if (name === "@/lib/verified-creative-upload") return {
      uploadVerifiedCreativeImage() { assert.fail("List lifetime fixture forbids uploads"); },
    };
    if (name === "@/lib/authSignOut") return { getSignOutRevision: () => 0, isSignOutPending: () => false };
    if (name === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: { auth: sessionAuth }, sessionAuth };
    if (name === "wouter") return { useLocation: () => ["/ads-automation/history", () => {}] };
    if (name === "sonner") return { toast: { success() {}, info() {}, error() {} } };
    if (name === "@/lib/demoStorage") return {
      readWorkspaceId: () => workspaceId, isRealWorkspace: (id: string) => id === workspace,
      workspaceScopedKey: (key: string) => `${key}::${workspaceId}`,
      readDemoStorage: (key: string, fallback: unknown) => JSON.parse(storage.getItem(key) ?? JSON.stringify(fallback)),
    };
    if (name === "@/lib/planFeatures") return { normalizePlan: () => "pro", getPlanFeature: () => ({ enabled: true }) };
    if (name === "../../../../lib/meta/cities") return { KZ_META_CITY_OPTIONS: [city], getKzMetaCityOption: () => city };
    if (name === "../../../../lib/advertising/campaignBrief") return {
      ADVERTISING_CAMPAIGN_PREFILL_KEY: "synthetic-prefill", normalizeAdvertisingContentApproval: (value: unknown) => value,
    };
    if (name === "../../../../lib/advertising/assistant") return { buildAdvertisingAssistantBrief: () => ({ tone: "info" }) };
    if (name === "../../../../lib/advertising/creativeEvidence") return { buildCreativeExperimentGroups: () => [] };
    if (name === "@/lib/metaInsightsHistory" || name === "lucide-react" || name.startsWith("@/components/")) return {};
    assert.fail(`Unexpected dependency ${name}`);
  });
  const component = () => module.fixtureSession({
    actorId: options.demo ? "" : actor, observedSdkActorId: actor, workspaceId,
    localDraftsOnly: Boolean(options.demo), canReadPrivate: false,
  });
  function render(runEffects = true) { driver.render(component, runEffects); }
  async function flush() { for (let i = 0; i < 5; i++) { render(); await tick(); } render(); }
  function refreshButton() {
    const buttons = elements(driver.view.ui).filter((node) => node.type === "button" && (
      page === "AdsAutomation" ? textContent(node.props.children).trim() === "Обновить"
        : node.props["aria-label"] === "Обновить статусы рекламы"));
    assert.equal(buttons.length, 1, "Use the real list Refresh control");
    return buttons[0].props;
  }
  t.after(() => driver.dispose());
  await flush();
  return {
    reads, writes, removals, local, calls, flush, render,
    get view() { return driver.view; },
    rows: () => driver.view[page === "AdsAutomation" ? "historyItems" : "launches"] as View[],
    refreshButton,
    refresh() { refreshButton().onClick(); },
    take(part = "meta-launches?") {
      const call = calls.find((item) => !item.taken && item.url.includes(part));
      assert.ok(call, `Expected fake ${part} request`); call.taken = true; return call;
    },
    assertError() {
      assert.equal(this.rows().length, 0);
      if (page === "AdvertisingHub") assert.equal(driver.view.loadState, "error");
      else {
        assert.ok(elements(driver.view.ui).some((node) => node.props.role === "alert"));
        assert.ok(!textContent(driver.view.ui).includes("Запусков пока нет"), "An error is not a true-empty result");
      }
      assert.equal(Boolean(refreshButton().disabled), false);
    },
  };
}

test("actor-scoped cache/save/recheck paths ignore legacy and other actors without migration", async (t) => {
  const ownKey = `${legacyKey}::B`;
  const own = launch("actor-B", { metaCampaignId: "same-campaign", payload: { service: "Local service" } });
  const cached = { [legacyKey]: [launch("legacy-A")], [`${legacyKey}::A`]: [launch("actor-A")], [ownKey]: [own] };
  const f = await fixture(t, "AdsAutomation", { cache: cached });
  assert.equal(f.rows().length, 0, "No cache may publish before an authorized list");
  f.take().answer({ launches: [launch("live-B", { metaCampaignId: "same-campaign" }), launch("live-only")] });
  await f.flush();
  assert.deepEqual(json(f.rows().map((row) => row.campaignName).sort()), ["live-B", "live-only"]);
  assert.equal(f.rows().find((row) => row.campaignName === "live-B")?.payload.service, "Local service");
  assert.ok(f.reads.includes(ownKey));
  assert.ok(!f.reads.includes(legacyKey) && !f.reads.includes(`${legacyKey}::A`));
  f.view.saveLocalLaunch({ launchId: "saved-B", metaCampaignId: "saved-campaign" }, "PAUSED");
  await f.flush();
  const stored = JSON.parse(f.local.get(ownKey)!);
  assert.equal(stored[0].id, "saved-B");
  assert.equal(stored[1].id, "actor-B", "Save reads the same actor key");
  const pending = f.view.recheckHistoryVideo({ ...own, metaVideoId: "synthetic-video" });
  await f.flush();
  f.take("ad-creative-meta-upload").answer({ videoReady: true, processingStatus: "ready", lastCheckedAt: "2026-10-25T01:00:00Z" });
  await pending; await f.flush();
  assert.equal(JSON.parse(f.local.get(ownKey)!)[1].payload.videoProcessingStatus, "ready");
  assert.deepEqual(f.writes.filter((key) => key.startsWith("negis_ads_launch_history_")), [ownKey, ownKey]);
  assert.equal(f.local.get(legacyKey), JSON.stringify(cached[legacyKey]));
  assert.equal(f.local.get(`${legacyKey}::A`), JSON.stringify(cached[`${legacyKey}::A`]));
  assert.equal(f.removals.length, 0);
});

for (const failure of [401, 403, 503, "offline"] as const) {
  test(`AdsAutomation wrong-actor cache stays hidden before and after ${failure}`, async (t) => {
    const f = await fixture(t, "AdsAutomation", { cache: {
      [legacyKey]: [launch("wrong-actor-legacy")], [`${legacyKey}::A`]: [launch("wrong-actor-scoped")],
    } });
    assert.equal(f.rows().length, 0);
    const call = f.take();
    if (failure === "offline") call.reject(new Error("synthetic offline"));
    else call.answer({}, failure);
    await f.flush(); f.assertError();
  });
  test(`AdsAutomation clears authorized cache/live rows when refresh fails with ${failure}`, async (t) => {
    const f = await fixture(t, "AdsAutomation", { cache: {
      [legacyKey]: [launch("own-cache")], [`${legacyKey}::B`]: [launch("own-cache")],
    } });
    f.take().answer({ launches: [launch("live")] }); await f.flush();
    assert.equal(f.rows().length, 2);
    f.refresh(); await f.flush();
    const call = f.take();
    if (failure === "offline") call.reject(new Error("synthetic offline"));
    else call.answer({}, failure);
    await f.flush(); f.assertError();
  });
}

for (const status of [401, 403] as const) {
  test(`AdsAutomation visible rows clear on held ${status} denial headers without body reads`, async (t) => {
    const cachedName = "previous-authorized-cache";
    const liveName = "previous-authorized-live";
    const f = await fixture(t, "AdsAutomation", { cache: {
      [legacyKey]: [launch(cachedName)], [`${legacyKey}::B`]: [launch(cachedName)],
    } });
    f.take().answer({ launches: [launch(liveName)] }); await f.flush();
    assert.equal(f.rows().length, 2, "Start with authorized visible cache and live rows");
    assert.ok(textContent(f.view.ui).includes(liveName));
    assert.ok(textContent(f.view.ui).includes(cachedName));

    const gate = deferred<void>();
    t.after(() => gate.resolve());
    f.refresh(); await f.flush();
    const denied = f.take();
    denied.answerBody({ success: false, error: "synthetic held denial", data: { launches: [launch("denied-body")] } }, status, gate.promise);
    await f.flush();
    assert.equal(denied.bodyReads, 0, "Authorization denial must not wait for or inspect the response body");
    f.assertError();
    assert.ok(!textContent(f.view.ui).includes(liveName));
    assert.ok(!textContent(f.view.ui).includes(cachedName));
    assert.ok(!textContent(f.view.ui).includes("denied-body"));

    gate.resolve(); await f.flush();
    assert.equal(denied.bodyReads, 0);
    f.assertError();
  });
}

test("health completion cannot finalize list loading or re-enable the real Refresh control", async (t) => {
  const f = await fixture(t, "AdsAutomation", { holdHealth: true });
  assert.equal(Boolean(f.refreshButton().disabled), true);
  f.take("/health").answer({ meta: { configured: true } }); await f.flush();
  assert.equal(f.view.loading, null);
  assert.equal(Boolean(f.refreshButton().disabled), true, "List has independent loading ownership");
  assert.equal(f.view.historyLoaded, false);
  f.take().answer({ launches: [] }); await f.flush();
  assert.equal(Boolean(f.refreshButton().disabled), false);
  assert.ok(textContent(f.view.ui).includes("Запусков пока нет"));
});

const malformed: Array<[string, unknown]> = [
  ["missing data", undefined], ["missing lists", {}], ["null launches", { launches: null }],
  ["object launches", { launches: {} }], ["string launches", { launches: "invalid" }],
  ["invalid legacy items", { items: {} }], ["bad launches plus valid items", { launches: {}, items: [launch("must-not-fallback")] }],
  ["null launches plus empty items", { launches: null, items: [] }],
];
for (const page of ["AdsAutomation", "AdvertisingHub"] as const) {
  for (const [label, data] of malformed) {
    test(`${page} rejects ${label}, not ready-empty`, async (t) => {
      const f = await fixture(t, page);
      f.take().answer(data); await f.flush(); f.assertError();
    });
  }
  for (const alias of ["launches", "items"] as const) {
    test(`${page} accepts a real empty ${alias} array and later a valid list`, async (t) => {
      const f = await fixture(t, page);
      f.take().answer({ [alias]: [] }); await f.flush();
      assert.equal(f.rows().length, 0);
      if (page === "AdvertisingHub") assert.equal(f.view.loadState, "ready");
      else assert.ok(textContent(f.view.ui).includes("Запусков пока нет"));
      f.refresh(); await f.flush();
      f.take().answer({ [alias]: [launch("positive-live")] }); await f.flush();
      assert.equal(f.rows()[0]?.campaignName, "positive-live");
      assert.equal(Boolean(f.refreshButton().disabled), false);
    });
  }
  test(`${page} valid launches takes precedence over legacy items`, async (t) => {
    const f = await fixture(t, page);
    f.take().answer({ launches: [], items: [launch("ignored")] }); await f.flush();
    assert.equal(f.rows().length, 0);
    if (page === "AdvertisingHub") assert.equal(f.view.loadState, "ready");
    else assert.ok(textContent(f.view.ui).includes("Запусков пока нет"));
  });

  test(`${page} Refresh invalidates the list before passive-effect cleanup`, async (t) => {
    const f = await fixture(t, page);
    const gate = deferred<void>();
    f.take().answer({ launches: [launch("old-before-effects")] }, 200, gate.promise);
    await f.flush();
    // Invoke the actual retained callback, even while its button is disabled,
    // to exercise overlapping reads and the pre-passive-effect boundary.
    f.refresh(); f.render(false);
    gate.resolve(); await tick(); f.render(false);
    assert.equal(f.rows().length, 0, "Refresh itself must retire the old list response");
    assert.equal(Boolean(f.refreshButton().disabled), true);
    await f.flush();
    f.take().answer({ launches: [launch("fresh-after-effects")] }); await f.flush();
    assert.equal(f.rows()[0]?.campaignName, "fresh-after-effects");
  });

  test(`${page} error retry remains loading until a valid empty list arrives`, async (t) => {
    const f = await fixture(t, page);
    f.take().answer({}); await f.flush(); f.assertError();
    f.refresh(); await f.flush();
    assert.equal(Boolean(f.refreshButton().disabled), true);
    if (page === "AdvertisingHub") assert.equal(f.view.loadState, "loading");
    else assert.ok(!textContent(f.view.ui).includes("Запусков пока нет"));
    f.take().answer({ launches: [] }); await f.flush();
    if (page === "AdvertisingHub") assert.equal(f.view.loadState, "ready");
    else assert.ok(textContent(f.view.ui).includes("Запусков пока нет"));
  });

  for (const outcome of ["success", "malformed", "offline", 401, 403] as const) {
    test(`${page} old ${outcome} cannot overwrite or finalize a newer refresh`, async (t) => {
      const f = await fixture(t, page);
      const old = f.take();
      const gate = deferred<void>();
      if (outcome !== "offline") old.answer(outcome === "malformed" ? {} : { launches: [launch("old")] },
        typeof outcome === "number" ? outcome : 200, gate.promise);
      await f.flush();
      if (outcome !== "offline") {
        // AdsAutomation rejects list denials at headers; other responses still read JSON.
        const earlyDenial = page === "AdsAutomation" && typeof outcome === "number";
        assert.equal(old.bodyReads, earlyDenial ? 0 : 1);
      }
      f.refresh(); await f.flush();
      const fresh = f.take();
      if (outcome === "offline") old.reject(new Error("old synthetic failure"));
      else gate.resolve();
      await f.flush();
      assert.equal(Boolean(f.refreshButton().disabled), true, "Old finally cannot finalize a newer request");
      assert.equal(f.rows().length, 0);
      fresh.answer({ launches: [launch("fresh")] }); await f.flush();
      assert.equal(f.rows()[0]?.campaignName, "fresh");
      assert.equal(Boolean(f.refreshButton().disabled), false);
    });
  }
  for (const status of [200, 401, 403] as const) {
    test(`${page} old ${status} response with a held body cannot affect fresh success`, async (t) => {
      const f = await fixture(t, page);
      const old = f.take(); const gate = deferred<void>();
      old.answer({ launches: [launch("old")] }, status, gate.promise); await f.flush();
      assert.equal(old.bodyReads, page === "AdsAutomation" && status !== 200 ? 0 : 1);
      f.refresh(); await f.flush();
      f.take().answer({ launches: [launch("fresh")] }); await f.flush();
      gate.resolve(); await f.flush();
      assert.equal(f.rows()[0]?.campaignName, "fresh");
      assert.equal(Boolean(f.refreshButton().disabled), false);
      if (page === "AdvertisingHub") assert.equal(f.view.loadState, "ready");
      else assert.ok(!elements(f.view.ui).some((node) => node.props.role === "alert"));
    });
  }
}

test("AdvertisingHub preserves true demo-only local history without requests", async (t) => {
  const f = await fixture(t, "AdvertisingHub", { demo: true,
    cache: { "negis_ads_launch_history_synthetic-demo": [launch("demo-local")] },
  });
  assert.equal(f.view.loadState, "ready");
  assert.equal(f.rows()[0]?.campaignName, "demo-local");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.reads, ["negis_ads_launch_history_synthetic-demo"]);
});

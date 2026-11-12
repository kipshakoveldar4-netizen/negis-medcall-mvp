import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { advertisingDemoFixtureIds: ids, createAdvertisingDemoBrowserFixture, isAdvertisingDemoFixtureLocation,
  readAdvertisingDemoGoalPrefill } = require("./advertising-demo-browser-store.ts");
const { createAdvertisingCampaignPrefill } = require("../../lib/advertising/campaignBrief.ts");
const { KZ_META_CITY_OPTIONS } = require("../../lib/meta/cities.ts");
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; assert.fail("No HTTP in advertising demo fixture tests"); };
test.after(() => { globalThis.fetch = originalFetch; assert.equal(externalCalls, 0); });

const initialLocation = { protocol: "http:", hostname: "127.0.0.1", pathname: "/ads", search: "?advertising=demo", hash: "" };
const destinations = ["/content-studio", "/ads-automation"];
const prefillKey = destination => `${destination === "/content-studio" ? "negis_content_studio_goal_prefill" : "negis_ads_automation_prefill"}::${ids.workspace}`;
const storageFor = values => ({ getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
const goal = () => {
  const city = KZ_META_CITY_OPTIONS.find(city => city.id === "astana");
  return createAdvertisingCampaignPrefill({ platform: "meta", sourceModule: "advertising-hub", sourceKind: "goal",
    campaignName: `TEST consultation · ${city.labelRu}`, service: "TEST consultation", city: city.labelRu, cityId: city.id,
    targetPatients: 12, durationDays: 14, maxBudget: 98, dailyBudget: 7, budgetCurrency: "USD", generatedAt: "2026-10-22T08:00:00.000Z" });
};

test("advertising opt-in requires the literal single-query HTTP loopback initial URL", () => {
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(isAdvertisingDemoFixtureLocation({ ...initialLocation, hostname }), true);
  }
  for (const change of [
    ...["https:", "file:", "ftp:"].map(protocol => ({ protocol })),
    ...["preview.invalid", "localhost.invalid", "127.0.0.1.invalid", "127.0.0.2", "0.0.0.0", "::1", ""].map(hostname => ({ hostname })),
    ...["/", "/ads/", "/appointments", ...destinations].map(pathname => ({ pathname })),
    ...["", "?advertising=Demo", "?advertising=other", "?advertising=demo&other=1", "?advertising=demo&advertising=demo",
      "?advertising=demo&", "?advertising=%64emo", "?%61dvertising=demo", "?advertising=demo&fixtureRole=admin"].map(search => ({ search })),
    { hash: "#hidden" },
  ]) assert.equal(isAdvertisingDemoFixtureLocation({ ...initialLocation, ...change }), false, JSON.stringify(change));
  assert.equal(isAdvertisingDemoFixtureLocation({}), false);
});

test("fixed non-UUID demo is distinct from cached SDK A and snapshots expose counters, never tokens or goal content", () => {
  assert.equal(Object.isFrozen(ids), true);
  assert.equal(ids.demoUser, "demo-user");
  assert.equal(new Set(Object.values(ids)).size, 4);
  for (const id of Object.values(ids)) assert.doesNotMatch(id, /^[\da-f]{8}-[\da-f-]{27,}$/i);
  const fixture = createAdvertisingDemoBrowserFixture(), first = fixture.snapshot();
  assert.equal(first.sdkActor, "A"); assert.equal(first.sdkActorId, ids.A); assert.equal(first.workspaceId, ids.workspace);
  assert.equal(first.demoUserId, ids.demoUser); assert.notEqual(first.sdkActorId, first.demoUserId);
  assert.equal(Object.isFrozen(first), true); assert.equal(fixture.snapshot(), first);
  assert.equal(first.sdkReads, 0); assert.equal(first.calls, 0); assert.equal(first.networkCalls, 0); assert.equal(first.blocked, 0);
  let updates = 0; const stop = fixture.subscribe(() => { updates++; });
  fixture.switchActor(); assert.equal(updates, 1); assert.notEqual(fixture.snapshot(), first);
  stop(); fixture.refreshSameActor(); assert.equal(updates, 1); assert.equal(first.sdkActor, "A");
  assert.doesNotMatch(JSON.stringify(fixture.snapshot()), /access_token|Bearer|invalid-local|TEST consultation/);
  const session = fixture.session(); session.user.id = "corrupt";
  assert.equal(fixture.session().user.id, ids.B);
});

test("each subscription queues INITIAL_SESSION asynchronously, including duplicate callbacks", async () => {
  const fixture = createAdvertisingDemoBrowserFixture(), events = [];
  const callback = (event, session) => events.push([event, session.user.id]);
  const first = fixture.onAuthStateChange(callback), second = fixture.onAuthStateChange(callback);
  assert.deepEqual(events, []); assert.equal(fixture.snapshot().listeners, 2);
  assert.equal(fixture.snapshot().pendingInitialCallbacks, 2);
  await Promise.resolve();
  assert.deepEqual(events, [["INITIAL_SESSION", ids.A], ["INITIAL_SESSION", ids.A]]);
  assert.equal(fixture.snapshot().initialSessions, 2); assert.equal(fixture.snapshot().authEvents, 2);
  assert.equal(fixture.snapshot().pendingInitialCallbacks, 0);
  first.data.subscription.unsubscribe(); second.data.subscription.unsubscribe();
  assert.equal(fixture.snapshot().listeners, 0);
});

test("unsubscribe cancels queued initial delivery and is idempotent under StrictMode-style cleanup/setup", async () => {
  const fixture = createAdvertisingDemoBrowserFixture(), events = [];
  for (let i = 0; i < 3; i++) {
    const stale = fixture.onAuthStateChange(event => events.push(event));
    stale.data.subscription.unsubscribe(); stale.data.subscription.unsubscribe();
  }
  const current = fixture.onAuthStateChange(event => events.push(event));
  assert.equal(fixture.snapshot().pendingInitialCallbacks, 1);
  await Promise.resolve();
  assert.deepEqual(events, ["INITIAL_SESSION"]);
  assert.equal(fixture.snapshot().registrations, 4); assert.equal(fixture.snapshot().unsubscriptions, 3);
  assert.equal(fixture.snapshot().canceledInitialCallbacks, 3); assert.equal(fixture.snapshot().listeners, 1);
  current.data.subscription.unsubscribe(); fixture.switchABA(); await Promise.resolve();
  assert.deepEqual(events, ["INITIAL_SESSION"]); assert.equal(fixture.snapshot().listeners, 0);
  assert.equal(fixture.snapshot().pendingInitialCallbacks, 0);
  assert.equal(fixture.snapshot().registrations, fixture.snapshot().unsubscriptions);
});

test("raw A-to-B and synchronous ABA deliver SDK events before one parent snapshot, without changing demo identity", async () => {
  const fixture = createAdvertisingDemoBrowserFixture(), events = [];
  const { data: { subscription } } = fixture.onAuthStateChange((event, session) => events.push([event, session.user.id]));
  await Promise.resolve(); events.length = 0;
  let updates = 0; const stop = fixture.subscribe(() => { updates++; });
  fixture.switchActor(); assert.deepEqual(events, [["SIGNED_IN", ids.B]]); assert.equal(updates, 1);
  fixture.switchActor(); events.length = 0; updates = 0;
  fixture.switchABA(); assert.deepEqual(events, [["SIGNED_IN", ids.B], ["SIGNED_IN", ids.A]]); assert.equal(updates, 1);
  assert.equal(fixture.snapshot().revision, 4); assert.equal(fixture.snapshot().sdkActor, "A");
  assert.equal(fixture.snapshot().demoUserId, ids.demoUser); assert.equal(fixture.snapshot().sdkReads, 0);
  stop(); subscription.unsubscribe();
});

test("same-actor TOKEN_REFRESHED keeps actor/revision stable and subscription count bounded", async () => {
  const fixture = createAdvertisingDemoBrowserFixture(), events = [];
  const { data: { subscription } } = fixture.onAuthStateChange((event, session) => events.push([event, session.user.id]));
  await Promise.resolve(); const before = fixture.session(); events.length = 0;
  fixture.refreshSameActor();
  assert.deepEqual(events, [["TOKEN_REFRESHED", ids.A]]); assert.equal(fixture.snapshot().revision, 0);
  assert.equal(fixture.snapshot().refreshes, 1); assert.equal(fixture.snapshot().registrations, 1);
  assert.equal(fixture.snapshot().listeners, 1); assert.notEqual(fixture.session().access_token, before.access_token);
  subscription.unsubscribe();
});

test("SDK lookup, every CRM operation and direct HTTP are counted and denied without calling HTTP", async () => {
  const fixture = createAdvertisingDemoBrowserFixture();
  await assert.rejects(fixture.getSession(), /SDK lookup denied/);
  for (const path of ["/api/crm/meta-launches", "/api/crm/auth-context", "/api/crm/meta-insights-history", "/api/crm/advertising-outcomes",
    "/api/meta/launch", "/api/content-studio/generate-photo", "/storage/v1/object", "https://external.invalid"]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await fixture.request(new URL(path, "http://fixture.invalid"), { method });
      assert.equal(response.status, 403); assert.deepEqual((await response.json()).success, false);
    }
  }
  await assert.rejects(fixture.denyNetwork(), /Network disabled/);
  assert.equal(fixture.snapshot().sdkReads, 1); assert.equal(fixture.snapshot().calls, 32);
  assert.equal(fixture.snapshot().networkCalls, 1); assert.equal(fixture.snapshot().blocked, 34);
});

for (const destination of destinations) {
  test(`destination ${destination} reads only validated fixed-scope goal and does not consume it on return`, () => {
    const values = new Map([["negis_workspace_selector", ids.workspace], [prefillKey(destination), JSON.stringify(goal())]]);
    const reads = [], storage = { getItem(key) { reads.push(key); return values.get(key) ?? null; } };
    const first = readAdvertisingDemoGoalPrefill(storage, destination);
    assert.deepEqual(first, JSON.parse(JSON.stringify(goal()))); assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(reads, ["negis_workspace_selector", prefillKey(destination)]);
    assert.deepEqual(readAdvertisingDemoGoalPrefill(storage, destination), first);
    assert.equal(values.size, 2);
    values.set("negis_workspace_selector", "00000000-0000-4000-8000-000000000001"); reads.length = 0;
    assert.equal(readAdvertisingDemoGoalPrefill(storage, destination), null);
    assert.deepEqual(reads, ["negis_workspace_selector"]);
  });
}

test("destination validation rejects malformed, legacy, wrong-platform, asset, library and unbounded drafts", () => {
  const values = new Map([["negis_workspace_selector", ids.workspace]]), storage = storageFor(values);
  const invalid = [null, [], {}, { ...goal(), schemaVersion: 2 }, { ...goal(), sourceModule: "content-studio" },
    { ...goal(), sourceKind: "library" }, { ...goal(), platform: "tiktok" }, { ...goal(), creative: { url: "https://external.invalid" } },
    { ...goal(), contentApproval: {} }, { ...goal(), targetPatients: 0 }, { ...goal(), targetPatients: 1.5 },
    { ...goal(), durationDays: 91 }, { ...goal(), durationDays: 1.5 }, { ...goal(), maxBudget: -1 },
    { ...goal(), dailyBudget: 8 }, { ...goal(), budgetCurrency: "KZT" }, { ...goal(), generatedAt: "not-a-date" },
    { ...goal(), cityId: "other" }, { ...goal(), campaignName: "Wrong campaign" }, { ...goal(), service: "x".repeat(2_001) }];
  for (const value of invalid) {
    values.set(prefillKey("/content-studio"), JSON.stringify(value));
    assert.equal(readAdvertisingDemoGoalPrefill(storage, "/content-studio"), null, JSON.stringify(value));
  }
  for (const raw of ["bad JSON", "x".repeat(10_001)]) {
    values.set(prefillKey("/content-studio"), raw); assert.equal(readAdvertisingDemoGoalPrefill(storage, "/content-studio"), null);
  }
  assert.equal(readAdvertisingDemoGoalPrefill(storage, "/ads"), null);
  assert.equal(readAdvertisingDemoGoalPrefill({ getItem() { throw new Error("Unavailable storage"); } }, "/content-studio"), null);
  values.delete(prefillKey("/content-studio"));
  values.set("negis_content_studio_goal_prefill", JSON.stringify(goal()));
  values.set("negis_content_studio_goal_prefill::00000000-0000-4000-8000-000000000001", JSON.stringify(goal()));
  assert.equal(readAdvertisingDemoGoalPrefill(storage, "/content-studio"), null);
});

let importId = 0;
async function withMocks(location, run) {
  const names = ["window", "localStorage", "sessionStorage"], previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const localValues = new Map(), sessionValues = new Map([
    ["medina-visual:fixtureRole", "lead_manager"], ["medina-visual:fixturePurpose", "mortgage_leads"],
  ]);
  const localStorage = storageFor(localValues), sessionStorage = storageFor(sessionValues);
  const window = { location: { ...initialLocation, ...location }, localStorage };
  for (const [name, value] of Object.entries({ window, localStorage, sessionStorage })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    const mocks = await import(`./crm-browser-mocks.ts?advertising-demo-${++importId}`);
    await run(mocks, { window, localValues, sessionValues });
  } finally {
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]); else delete globalThis[name];
    });
  }
}

test("mocks bind explicit fixed demo while async cached SDK sessions and raw switches remain independent", async () => {
  await withMocks({}, async (mocks, { window, localValues, sessionValues }) => {
    const fixture = mocks.advertisingDemoFixture; assert.ok(fixture);
    assert.equal(mocks.contentStudioFixture, null); assert.equal(mocks.appointmentCreateFixture, null);
    assert.equal(mocks.hasSupabaseFrontendEnv, true);
    const auth = mocks.useAuth();
    assert.equal(auth.isDemoMode, true); assert.equal(auth.isImpersonation, false); assert.equal(auth.isLoading, false);
    assert.equal(auth.user.id, ids.demoUser); assert.equal(auth.session.user.id, ids.demoUser);
    assert.equal(auth.clinicId, ids.workspace); assert.equal(auth.userRole, "owner"); assert.equal(auth.workspacePurpose, "clinic_services");
    assert.equal(localValues.get("negis_workspace_selector"), ids.workspace);
    assert.equal(localValues.size, 1); assert.equal(sessionValues.size, 2);
    const events = [], subscription = mocks.supabase.auth.onAuthStateChange((event, session) => events.push([event, session.user.id])).data.subscription;
    assert.deepEqual(events, []); await Promise.resolve(); assert.deepEqual(events, [["INITIAL_SESSION", ids.A]]);
    fixture.refreshSameActor(); fixture.switchABA(); fixture.switchActor();
    assert.equal(mocks.useAuth(), auth); assert.equal(auth.user.id, ids.demoUser); assert.equal(auth.clinicId, ids.workspace);
    assert.equal(fixture.snapshot().sdkActorId, ids.B); assert.equal(fixture.snapshot().sdkReads, 0);
    assert.equal(fixture.snapshot().calls, 0); assert.equal(fixture.snapshot().blocked, 0);
    // In-document routing retains the original fixture; a fresh destination import below does not.
    for (const pathname of destinations) {
      window.location = { ...initialLocation, pathname, search: "" };
      assert.equal(mocks.advertisingDemoFixture, fixture);
      assert.equal((await mocks.crmFetch("/api/crm/auth-context")).status, 403);
    }
    await assert.rejects(mocks.supabase.auth.getSession(), /SDK lookup denied/);
    await assert.rejects(mocks.crmRequest("/api/crm/meta-launches"), /CRM denied/);
    await assert.rejects(window.fetch("https://external.invalid"), /Network disabled/);
    assert.equal(fixture.snapshot().sdkReads, 1); assert.equal(fixture.snapshot().calls, 3);
    assert.equal(fixture.snapshot().networkCalls, 1); assert.equal(fixture.snapshot().blocked, 5);
    subscription.unsubscribe(); assert.equal(fixture.snapshot().listeners, 0);
  });
});

test("mock activation cannot be persisted through a hard destination navigation or a nearly matching opt-in", async () => {
  for (const location of [
    { protocol: "https:" }, { hostname: "external.invalid" }, { search: "" }, { search: "?advertising=demo&other=1" },
    { search: "?advertising=demo&advertising=demo" }, { hash: "#hidden" },
    ...destinations.flatMap(pathname => [{ pathname }, { pathname, search: "" }]),
  ]) await withMocks(location, async (mocks, { localValues }) => {
    assert.equal(mocks.advertisingDemoFixture, null);
    assert.notEqual(localValues.get("negis_workspace_selector"), ids.workspace);
  });
});

test("advertising mock denies all requests before URL parsing or normal fixture/resource dispatch", async () => {
  await withMocks({}, async mocks => {
    for (const input of ["/api/crm/meta-launches", "/api/crm/auth-context", "/api/crm/meta-insights-history", "/api/crm/advertising-outcomes",
      "/api/crm/clients", "/api/crm/content-videos", "/api/content-studio/generate-video", "/api/meta/launch", "https://external.invalid", "http://["]) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) assert.equal((await mocks.crmFetch(input, { method })).status, 403);
    }
    assert.equal(mocks.advertisingDemoFixture.snapshot().calls, 40);
    assert.equal(mocks.advertisingDemoFixture.snapshot().sdkReads, 0);
    assert.equal(mocks.advertisingDemoFixture.snapshot().blocked, 40);
  });
});

test("real AdvertisingHub mounts unchanged under StrictMode and external-store parent, never real destination UI", async () => {
  const source = await readFile(new URL("./crm-browser.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("crm-browser.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map();
  ts.forEachChild(file, node => { if (ts.isFunctionDeclaration(node)) functions.set(node.name?.text, node.getText(file)); });
  const view = functions.get("AdvertisingDemoFixtureView"), wrapper = functions.get("AdvertisingDemoFixture");
  assert.match(source, /import AdvertisingHub from ['"].*pages\/AdvertisingHub['"]/);
  assert.match(view, /React\.useSyncExternalStore\(fixture\.subscribe, fixture\.snapshot\)/);
  assert.match(wrapper, /<React\.StrictMode><AdvertisingDemoFixtureView \/><\/React\.StrictMode>/);
  assert.match(source, /<Router>\{advertisingDemoFixture \? <AdvertisingDemoFixture \/> : <Switch>/);
  assert.match(source, /<Route path="\/ads" component=\{AdvertisingDemoFixture\}/);
  assert.match(view, /hub \? <AdvertisingHub \/> : <main/);
  assert.match(view, /readAdvertisingDemoGoalPrefill\(localStorage, location\)/);
  assert.match(view, /isAdvertisingDemoFixtureLocation\(window\.location\)/);
  assert.match(view, /<Link href="\/ads\?advertising=demo"/);
  assert.doesNotMatch(view, /<ContentStudio|<AdsAutomation|key=|setCampaignGoal|localStorage\.(?:setItem|removeItem)|clipboard|\.getSession\(/);
  assert.doesNotMatch(source, /import AdsAutomation|<AdsAutomation/);
  const realHub = await readFile(new URL("../../artifacts/negis/src/pages/AdvertisingHub.tsx", import.meta.url), "utf8");
  assert.match(realHub, /key=\{JSON\.stringify\(\[actorId, workspaceId, userRole, workspacePurpose, authEpoch, localDraftsOnly\]\)\}/);
  assert.match(realHub, /setAuthEpoch\(\(value\) => value \+ 1\)/);
});

test("server independently gates exact advertising URL and Host, with API403/CSP intact and no server started", async () => {
  const source = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  assert.match(source, /configFile: false/); assert.match(source, /envDir: false/); assert.match(source, /appType: "custom"/);
  assert.match(source, /const routes = new Set\([^;]*"\/ads"/);
  const file = ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let body;
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === "configureServer") body = node.body.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(body);
  // Execute middleware only, never the Vite entry, env setup, listen() or HTTP.
  const configure = new Function("entryPath", "routes", `return function(vite) ${body}`)(
    "/synthetic/crm-browser.tsx", new Set(["/ads", ...destinations, "/appointments"]));
  let handler;
  configure({ middlewares: { use(value) { handler = value; } }, transformIndexHtml: async (_path, html) => html });
  async function request(url, host = "127.0.0.1:5181", encrypted = false) {
    const result = { statusCode: 200, headers: {}, body: "" };
    await handler({ url, socket: { encrypted }, headers: { host, accept: "text/html" } }, {
      set statusCode(value) { result.statusCode = value; },
      setHeader(key, value) { result.headers[key] = value; }, end(value) { result.body = value; },
    }, () => { assert.fail("No real app fallback"); });
    return result;
  }
  for (const host of ["127.0.0.1:5181", "localhost:5181", "[::1]:5181"]) {
    const result = await request("/ads?advertising=demo", host);
    assert.equal(result.statusCode, 200); assert.match(result.body, /\/synthetic\/crm-browser\.tsx/);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.match(result.headers["Content-Security-Policy"], /connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
    assert.match(result.headers["Content-Security-Policy"], /form-action 'none'; frame-src 'none'/);
  }
  for (const host of ["", "external.invalid", "localhost.external.invalid", "127.0.0.2", "localhost@external.invalid", "127.0.0.1:5181.evil", "::1"]) {
    assert.equal((await request("/ads?advertising=demo", host)).statusCode, 403);
    for (const route of destinations) assert.equal((await request(route, host)).statusCode, 403);
  }
  for (const route of ["/ads", "/ads?advertising=Demo", "/ads?advertising=demo&extra=1", "/ads?advertising=demo&advertising=demo",
    "/ads?advertising=%64emo", "/ads?advertising=demo&", "http://127.0.0.1:5181/ads?advertising=demo"]) {
    assert.equal((await request(route)).statusCode, 403);
  }
  assert.equal((await request("/ads?advertising=demo", "127.0.0.1:5181", true)).statusCode, 403);
  assert.equal((await request("/api/crm/meta-launches")).statusCode, 403);
  assert.equal((await request("/api/meta/launch")).statusCode, 403);
  assert.equal((await request("/not-included")).statusCode, 404);
  assert.equal((await request("/appointments")).statusCode, 200);
});

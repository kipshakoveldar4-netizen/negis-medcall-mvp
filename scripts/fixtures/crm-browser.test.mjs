import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { createBookingRetryFixture } from "./booking-retry.ts";
import ts from "typescript";
import { clinicArrivalFixtureIds as arrivalIds } from "./clinic-arrival-browser-store.ts";

// Supply only synthetic browser globals; never load application credentials.
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map();
const fixtureWindow = { location: { search: "", pathname: "/" } };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: (key, value) => storage.set(key, value) } });
Object.defineProperty(globalThis, "window", { configurable: true, value: fixtureWindow });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { setItem() {}, getItem() { return null; } } });
after(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else delete globalThis.localStorage;
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete globalThis.window;
  if (previousSessionStorage) Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
  else delete globalThis.sessionStorage;
});
const fixture = await import("./crm-browser-mocks.ts");

test("legal notice routes use real pages without enabling environment or API access", async () => {
  const server = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  const entry = await readFile(new URL("./crm-browser.tsx", import.meta.url), "utf8");
  for (const [route, component] of [["privacy", "Privacy"], ["terms", "Terms"], ["data-deletion", "DataDeletion"]]) {
    assert.match(server, new RegExp(`const routes = new Set\\([^;]*"/${route}"`));
    assert.ok(entry.includes(`<Route path="/${route}" component={${component}} />`));
    assert.ok(entry.includes(`import ${component} from "../../artifacts/negis/src/pages/${component}"`));
  }
  assert.match(server, /configFile: false, root: frontend, envDir: false/);
  assert.match(server, /globalThis\.fetch = async \(\) => \{ throw new Error\("External fetch forbidden/);
  assert.match(server, /server: \{ host: "127\.0\.0\.1", port: requestedPort, strictPort: true/);
  assert.match(server, /pathname\.startsWith\("\/api\/"\)[^\n]+403/);
});

test("visual fixture uses fabricated contacts and filters the displayed client list", async () => {
  const response = await fixture.crmFetch("/api/crm/clients?search=" + encodeURIComponent("Мария"));
  const body = await response.json();
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].phone, "+77000000002");
  assert.equal(storage.get("negis_workspace_selector"), "00000000-0000-4000-8000-000000000001");
  assert.equal(fixture.useAuth().user.email, "test@example.invalid");
});

test("visual fixture rejects every mutation and direct request helper", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fixture.crmFetch("/api/crm/appointments", { method });
    assert.equal(response.status, 403);
  }
  await assert.rejects(() => fixture.crmRequest(), /отключены/);
});

test("visual fixture blocks external fetch, real login and non-CRM resources", async () => {
  await assert.rejects(() => fixture.crmFetch("https://example.invalid/api/crm/clients"), /External request forbidden/);
  await assert.rejects(() => fixture.crmFetch("/api/meta/launch"), /External request forbidden/);
  await assert.rejects(() => fixtureWindow.fetch("https://example.invalid"), /Network disabled/);
  assert.equal((await fixture.supabase.auth.getSession()).data.session, null);
  assert.ok((await fixture.supabase.auth.signInWithPassword()).error);
});

test("visual fixture server cannot load application config or fall back to real app entry", async () => {
  const source = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  assert.match(source, /configFile: false/);
  assert.match(source, /envDir: false/);
  assert.match(source, /appType: "custom"/);
  assert.match(source, /host: "127\.0\.0\.1"/);
  assert.match(source, /res\.statusCode = 403/);
  assert.match(source, /res\.statusCode = 404/);
  assert.match(source, /form-action 'none'/);
});

test("opt-in retry simulation keeps one in-memory row and demands the identical body and key", async () => {
  const retry = createBookingRetryFixture();
  const body = { requestKey: "00000000-0000-4000-8000-000000000080", client: "Synthetic retry" };
  await assert.rejects(() => retry.send(body), /reply lost/);
  assert.deepEqual(retry.stats(), { calls: 1, rows: 1 });
  assert.equal((await retry.send({ ...body, requestKey: "changed" })).status, 409);
  assert.equal((await retry.send({ ...body, client: "Changed client" })).status, 409);
  const restored = await (await retry.send(body)).json();
  assert.equal(restored.data.replayed, true);
  assert.equal(restored.data.item.client, "Synthetic retry");
  assert.deepEqual(retry.stats(), { calls: 4, rows: 1 });
});

test("mortgage team preview remains synthetic and restricts analytics to owner/admin", async () => {
  for (const [role, purpose, expected] of [["owner", "mortgage_leads", 200], ["admin", "mortgage_leads", 200],
    ["lead_manager", "mortgage_leads", 403], ["owner", "clinic_services", 403]]) {
    const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() {} } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { search: `?fixtureRole=${role}&fixturePurpose=${purpose}` },
    } });
    try {
      const isolated = await import(`./crm-browser-mocks.ts?team-${role}-${purpose}`);
      const channels = await isolated.crmFetch("/api/crm/whatsapp-channels");
      if (purpose === "mortgage_leads" && expected === 200) {
        const { data } = await channels.json();
        assert.equal(data.channels[0].enabled, true);
        const body = { id: data.channels[0].id, provider: "wazzup", enabled: false };
        assert.equal((await isolated.crmRequest("/api/crm/whatsapp-channels", {
          method: "PATCH", body: JSON.stringify(body),
        })).data.item.enabled, false);
        assert.equal((await isolated.crmRequest("/api/crm/whatsapp-channels")).data.channels[0].enabled, false);
        await assert.rejects(() => isolated.crmRequest("/api/crm/whatsapp-channels", {
          method: "PATCH", body: JSON.stringify({ ...body, enabled: true }),
        }), /отключены/);
        await assert.rejects(() => isolated.crmRequest("https://example.invalid/api/crm/whatsapp-channels"), /External request forbidden/);
      } else if (purpose === "mortgage_leads") {
        assert.equal(channels.status, 403);
        await assert.rejects(() => isolated.crmRequest("/api/crm/whatsapp-channels"), /отключены/);
      }
      const response = await isolated.crmFetch("/api/crm/lead-team-analytics?days=7");
      assert.equal(response.status, expected);
      if (expected === 200) {
        const { data: { analytics } } = await response.json();
        const snapshot = (await (await isolated.crmFetch('/api/crm/mortgage-workspace')).json()).data;
        assert.deepEqual(analytics.members.map(member => member.staffId).sort(), snapshot.members.map(member => member.id).sort());
        assert.equal(analytics.members.length, 3);
        assert.ok(analytics.members.some(member => member.role === 'admin'));
        for (const member of analytics.members) assert.equal(member.assigned.total,
          snapshot.contacts.filter(contact => contact.responsibleUserId === member.staffId).length);
        assert.equal(analytics.totalLeads, snapshot.metrics.totalLeads);
        assert.equal(analytics.period.days, 7);
        assert.equal(analytics.members.reduce((total, member) => total + member.assigned.total, 0)
          + analytics.unassignedLeads + analytics.otherAssigneeLeads, analytics.totalLeads);
        assert.ok(analytics.members.every((member) => member.name.startsWith("Тестов")));
        assert.equal((await isolated.crmFetch("/api/crm/lead-team-analytics", { method: "POST" })).status, 403);
      }
    } finally {
      if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore); else delete globalThis.localStorage;
      if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else delete globalThis.window;
    }
  }
});

let arrivalImport = 0;
test("sale retry opt-in only simulates the same immutable keyed sale and leaves other writes blocked", async () => {
  const previous = fixtureWindow.location;
  fixtureWindow.location = { search: "?salesRetry=lost-response", pathname: "/sales" };
  try {
    const isolated = await import("./crm-browser-mocks.ts?sales-retry");
    const sale = { requestKey: "00000000-0000-4000-8000-000000000080", title: "Synthetic pending sale",
      amountMinor: 700050, currency: "KZT", status: "pending" };
    const post = body => isolated.crmFetch("/api/crm/deals", { method: "POST", body: JSON.stringify(body) });
    await assert.rejects(() => post(sale), /reply lost/);
    assert.equal((await post({ ...sale, amountMinor: 1 })).status, 409);
    const { data } = await (await post(sale)).json();
    assert.equal(data.replayed, true);
    assert.equal(data.item.amountMinor, 700050);
    assert.equal(data.item.status, "pending");
    assert.equal((await isolated.crmFetch("/api/crm/appointments", { method: "POST", body: "{}" })).status, 403);
    await assert.rejects(() => isolated.crmFetch("https://example.invalid/api/crm/deals"), /External request forbidden/);
  } finally { fixtureWindow.location = previous; }
});

test("synthetic admin can explicitly assign a contact to herself without adding a manager or widening manager visibility", async () => {
  const previous = fixtureWindow.location;
  fixtureWindow.location = { search: "?fixturePurpose=mortgage_leads&fixtureRole=admin", pathname: "/clients" };
  try {
    const isolated = await import("./crm-browser-mocks.ts?admin-self");
    const context = (await (await isolated.crmFetch("/api/crm/auth-context")).json()).data;
    assert.equal(context.role, "admin");
    assert.equal(context.purpose, "mortgage_leads");
    const assignees = (await (await isolated.crmFetch("/api/crm/lead-assignees")).json()).data.assignees;
    assert.ok(assignees.some(row => row.id === context.staffUserId));
    const { data: { item } } = await (await isolated.crmFetch("/api/crm/leads", { method: "POST", body: JSON.stringify({
      name: "Тестовый клиент администратора", phone: "+12025550143", responsibleUserId: context.staffUserId,
    }) })).json();
    assert.equal(item.responsibleUserId, context.staffUserId);
    const { mortgageBrowserRequest } = await import("./mortgage-browser-store.ts");
    const url = new URL("http://fixture.invalid/api/crm/mortgage-workspace");
    const snapshot = (await (await mortgageBrowserRequest(url, undefined, "admin")).json()).data;
    assert.equal(snapshot.memberMetrics.find(row => row.id === context.staffUserId).assignedLeads, 1);
    assert.equal(snapshot.metrics.activeManagers, 2);
    const restricted = (await (await mortgageBrowserRequest(url, undefined, "lead_manager")).json()).data;
    assert.equal(restricted.contacts.some(row => row.id === item.id), false);
    assert.equal(restricted.members.some(row => row.id === context.staffUserId), false);
    await assert.rejects(() => isolated.crmFetch("https://example.invalid/api/crm/leads"), /External request forbidden/);
  } finally { fixtureWindow.location = previous; }
});

async function withArrivalLocation(location, check) {
  const before = fixtureWindow.location;
  fixtureWindow.location = { search: "", protocol: "http:", hostname: "127.0.0.1", ...location };
  try {
    await check(await import(`./crm-browser-mocks.ts?clinic-arrival-${++arrivalImport}`));
  } finally {
    fixtureWindow.location = before;
  }
}
const arrivalPath = `/api/crm/clinic-operator-arrivals?workspaceId=${arrivalIds.workspace}&requestId=${arrivalIds.request}`;
const arrivalWrite = (local) => ({
  method: "POST", body: JSON.stringify({ appointmentId: arrivalIds.appointment }),
  expectedUserId: local.snapshot().lifetime.actorId,
  dispatchGuard: local.snapshot().lifetime.isSessionCurrent,
});

test("clinic arrival gate is inactive on every existing fixture route even with opt-in query settings", async () => {
  for (const pathname of ["/", "/appointments", "/clients", "/sales", "/leads", "/login", "/dashboard",
    "/tasks", "/analytics", "/admin", "/operator"]) {
    await withArrivalLocation({ pathname, search: "?phase=response&reply=success" }, async (isolated) => {
      assert.equal(isolated.clinicArrivalFixture, null);
      if (pathname === "/operator") {
        await assert.rejects(isolated.crmFetch(arrivalPath, { method: "POST" }), /Only isolated operator fixture routes/);
      } else {
        assert.equal((await isolated.crmFetch(arrivalPath, { method: "POST" })).status, 403);
      }
    });
  }
});

test("clinic arrival route refuses non-loopback activation and cannot fall through to other fixture modes", async () => {
  for (const hostname of ["preview.invalid", "0.0.0.0", undefined]) {
    await withArrivalLocation({ pathname: "/clinic-arrival", hostname,
      search: "?fixturePurpose=mortgage_leads&bookingRetry=lost-response" }, async (isolated) => {
      assert.equal(isolated.clinicArrivalFixture, null);
      assert.equal((await isolated.crmFetch(arrivalPath)).status, 403);
      assert.equal((await isolated.crmFetch("/api/crm/appointments", { method: "POST" })).status, 403);
      assert.equal((await isolated.crmFetch("/api/crm/whatsapp-channels", { method: "PATCH" })).status, 403);
    });
  }
});

test("clinic arrival mocks compose only synthetic reads and guarded writes, without changing auth", async () => {
  await withArrivalLocation({ pathname: "/clinic-arrival" }, async (isolated) => {
    const local = isolated.clinicArrivalFixture;
    assert.ok(local);
    assert.equal(isolated.useAuth().session.user.id, "fixture-user");
    assert.equal((await isolated.supabase.auth.getSession()).data.session, null);
    assert.equal((await isolated.crmFetch("/api/crm/clients")).status, 403);
    assert.equal((await isolated.crmFetch(arrivalPath, { method: "PATCH" })).status, 403);
    const { data } = await (await isolated.crmFetch(arrivalPath)).json();
    assert.equal(data.items[0].clientName, "TEST A: synthetic patient");
    assert.equal(data.items[0].arrivalId, null);
    assert.doesNotMatch(JSON.stringify(data), /phone|email|whatsapp/i);
    const pending = isolated.crmFetch(arrivalPath, arrivalWrite(local));
    const rejected = assert.rejects(pending, { name: "AbortError" });
    local.switchABA();
    local.release();
    await rejected;
    assert.equal(local.snapshot().dispatched, 0);
    assert.equal(local.snapshot().canceled, 1);
    assert.equal(isolated.useAuth().session.user.id, "fixture-user");
    await assert.rejects(() => isolated.crmFetch("https://example.invalid" + arrivalPath), /External request forbidden/);
    await assert.rejects(() => fixtureWindow.fetch(arrivalPath), /Network disabled/);
  });
});

test("clinic arrival response mode forwards the old actor's simulated failure without cancellation", async () => {
  await withArrivalLocation({ pathname: "/clinic-arrival", search: "?phase=response&reply=error" }, async (isolated) => {
    const local = isolated.clinicArrivalFixture;
    const pending = isolated.crmFetch(arrivalPath, arrivalWrite(local));
    await Promise.resolve();
    assert.equal(local.snapshot().dispatched, 1);
    local.switchActor();
    local.release();
    assert.equal((await pending).status, 500);
    assert.equal(local.snapshot().canceled, 0);
    assert.equal(local.snapshot().lastOutcome.actor, "A");
    assert.equal((await (await isolated.crmFetch(arrivalPath)).json()).data.items[0].clientName, "TEST B: synthetic patient");
  });
});

test("appointment create fixture fixes viewport height without relying on scanning fixture-only Tailwind classes", async () => {
  const source = await readFile(new URL("./crm-browser.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("crm-browser.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const roots = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
      && attribute.name.getText(parsed) === "data-testid" && attribute.initializer?.text === "appointment-create-fixture")) roots.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(roots.length, 1);
  const style = roots[0].attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(parsed) === "style");
  assert.ok(style && ts.isJsxExpression(style.initializer) && ts.isObjectLiteralExpression(style.initializer.expression));
  const height = style.initializer.expression.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(parsed) === "height");
  assert.ok(height && ts.isStringLiteral(height.initializer));
  assert.equal(height.initializer.text, "100dvh");
});

test("clinic arrival browser route mounts the real component under StrictMode with lifetime-bound props", async () => {
  const source = await readFile(new URL("./crm-browser.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ OperatorArrivals \} from ['"].*components\/operators\/OperatorArrivals['"]/);
  assert.match(source, /<Route path="\/clinic-arrival" component=\{ClinicArrivalFixture\}/);
  assert.match(source, /<React\.StrictMode><ClinicArrivalFixtureView \/><\/React\.StrictMode>/);
  assert.match(source, /<OperatorArrivals key=\{lifetime\.revision\} actorId=\{lifetime\.actorId\}/);
  assert.match(source, /isSessionCurrent=\{lifetime\.isSessionCurrent\}/);
  assert.match(source, /onClick=\{fixture\.switchABA\}/);
  assert.match(source, /snapshot\.queued.*snapshot\.dispatched.*snapshot\.canceled/);
});

test("clinic arrival server middleware is loopback-only and preserves CSP and API denial without starting a server", async () => {
  const source = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  assert.match(source, /const routes = new Set\([^;]*"\/clinic-arrival"/);
  const parsed = ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let middlewareBody;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === "configureServer") middlewareBody = node.body.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(middlewareBody);
  // Execute just the middleware registration, never Vite, environment setup or listen().
  const configure = new Function("entryPath", "routes", `return function(vite) ${middlewareBody}`)(
    "/synthetic/crm-browser.tsx", new Set(["/clinic-arrival", "/operator"]),
  );
  let handler;
  configure({ middlewares: { use(value) { handler = value; } }, transformIndexHtml: async (_path, html) => html });
  async function request(url, host) {
    const result = { statusCode: 200, headers: {}, body: "" };
    await handler({ url, headers: { host, accept: "text/html" } }, {
      set statusCode(value) { result.statusCode = value; },
      setHeader(key, value) { result.headers[key] = value; },
      end(body) { result.body = body; },
    }, () => { throw new Error("Unexpected fixture fallback"); });
    return result;
  }
  for (const host of ["127.0.0.1:5181", "localhost:5181", "[::1]:5181"]) {
    const result = await request("/clinic-arrival?phase=response&reply=error", host);
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /\/synthetic\/crm-browser\.tsx/);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.match(result.headers["Content-Security-Policy"], /default-src 'self';/);
    assert.match(result.headers["Content-Security-Policy"], /connect-src 'self' ws:\/\/127\.0\.0\.1:\*/);
    assert.match(result.headers["Content-Security-Policy"], /form-action 'none'; frame-src 'none'/);
  }
  for (const host of [undefined, "preview.invalid", "127.0.0.1.external.invalid", "localhost@external.invalid"]) {
    assert.equal((await request("/clinic-arrival", host)).statusCode, 403);
  }
  assert.equal((await request(arrivalPath, "127.0.0.1:5181")).statusCode, 403);
  assert.equal((await request("/not-included", "127.0.0.1:5181")).statusCode, 404);
  assert.equal((await request("/operator", "127.0.0.1:5181")).statusCode, 200);
});

test("content opt-in cannot activate on another route, protocol or host", async () => {
  for (const location of [
    ...["/", "/appointments", "/admin", "/operator", "/clinic-arrival", "/ads-automation"].map(pathname => ({ pathname })),
    { pathname: "/content-studio", hostname: "preview.invalid" },
    { pathname: "/content-studio", hostname: "127.0.0.1.external.invalid" },
    { pathname: "/content-studio", protocol: "https:" },
    { pathname: "/content-studio", search: "?contentStudio=handoff&fixturePurpose=mortgage_leads&fixtureRole=lead_manager" },
  ]) {
    await withArrivalLocation({ search: "?contentStudio=handoff", ...location }, async isolated => {
      assert.equal(isolated.contentStudioFixture, null);
      await assert.rejects(isolated.crmFetch("/api/content-studio/generate-photo", { method: "POST" }), /External request forbidden/);
    });
  }
});

test("content mocks keep synthetic SDK and current auth aligned without enabling other fixtures", async () => {
  const localBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const sessionBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const localValues = new Map(), sessionValues = new Map();
  const makeStorage = values => ({ getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: makeStorage(localValues) });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: makeStorage(sessionValues) });
  try {
    await withArrivalLocation({ pathname: "/content-studio", search: "?contentStudio=handoff" }, async isolated => {
      const store = isolated.contentStudioFixture;
      assert.ok(store);
      assert.equal(isolated.appointmentCreateFixture, null);
      assert.equal(isolated.useAuth().workspacePurpose, "clinic_services");
      assert.equal(isolated.useAuth().userRole, "owner");
      assert.equal(isolated.useAuth().user.id, store.session().user.id);
      assert.equal((await isolated.supabase.auth.getSession()).data.session.user.id, store.session().user.id);
      const workspace = store.snapshot().workspaceId;
      assert.equal(localValues.get("negis_workspace_selector"), workspace);
      const init = { expectedUserId: store.session().user.id, dispatchGuard: () => true, signal: new AbortController().signal };
      const read = await isolated.crmFetch(`/api/crm/content-videos?workspaceId=${workspace}`, init);
      assert.equal(read.status, 200);
      assert.ok((await read.json()).data.videos[0].avatarPrompt);
      store.switchActor();
      assert.equal(isolated.useAuth().user.id, store.session().user.id);
      assert.equal((await isolated.supabase.auth.getSession()).data.session.user.id, store.session().user.id);
      assert.equal((await isolated.crmFetch(`/api/crm/appointments?workspaceId=${workspace}`, init)).status, 403);
      assert.equal((await isolated.crmFetch(`/api/content-studio/send-telegram?workspaceId=${workspace}`, { ...init, method: "POST" })).status, 403);
      assert.ok((await isolated.supabase.auth.signInWithPassword()).error);
      await assert.rejects(fixtureWindow.fetch("https://example.invalid"), /Network disabled/);
    });
  } finally {
    Object.defineProperty(globalThis, "localStorage", localBefore);
    Object.defineProperty(globalThis, "sessionStorage", sessionBefore);
  }
});

test("content view mounts real studio, simulated write-only clipboard and receipt-only advertising destination", async () => {
  const source = await readFile(new URL("./crm-browser.tsx", import.meta.url), "utf8");
  assert.match(source, /import ContentStudio from ['"].*pages\/ContentStudio['"]/);
  assert.match(source, /<Route path="\/content-studio" component=\{ContentStudioFixture\}/);
  assert.match(source, /<Route path="\/ads-automation" component=\{ContentStudioFixture\}/);
  assert.match(source, /Object\.defineProperty\(navigator, "clipboard", \{ configurable: false, writable: false, value: contentClipboard \}\)/);
  assert.match(source, /writeText: contentStudioFixture\.writeClipboard/);
  assert.match(source, /!clipboardReady \|\| Object\.getOwnPropertyDescriptor\(navigator, "clipboard"\)\?\.value !== contentClipboard/);
  assert.match(source, /sourceId === sourceId/);
  assert.match(source, /parseAdvertisingCampaignPrefillForPlatform\(value, "meta"\)/);
  assert.doesNotMatch(source, /navigator\.clipboard\.(?:read|readText)\s*\(/);
  assert.doesNotMatch(source, /import AdsAutomation |component=\{AdsAutomation\}|<AdsAutomation/);
  assert.match(source, /import\.meta\.hot\.dispose\(\(\) => fixtureRoot\.unmount\(\)\)/);
});

test("content server routes remain loopback-only with no API or unknown-document fallback", async () => {
  const source = await readFile(new URL("./crm-browser.mjs", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("fixture.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let body;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === "configureServer") body = node.body.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(body);
  const configure = new Function("entryPath", "routes", `return function(vite) ${body}`)(
    "/synthetic/crm-browser.tsx", new Set(["/content-studio", "/ads-automation"]));
  let handler;
  configure({ middlewares: { use(value) { handler = value; } }, transformIndexHtml: async (_path, html) => html });
  async function request(url, host) {
    const result = { statusCode: 200, headers: {}, body: "" };
    await handler({ url, headers: { host, accept: "text/html" } }, {
      set statusCode(value) { result.statusCode = value; },
      setHeader(key, value) { result.headers[key] = value; }, end(body) { result.body = body; },
    }, () => { throw new Error("Unexpected content fixture fallback"); });
    return result;
  }
  for (const route of ["/content-studio?contentStudio=handoff", "/ads-automation"]) {
    for (const host of ["127.0.0.1:5205", "localhost:5205", "[::1]:5205"]) {
      const result = await request(route, host);
      assert.equal(result.statusCode, 200);
      assert.match(result.headers["Content-Security-Policy"], /form-action 'none'; frame-src 'none'/);
      assert.equal(result.headers["Cache-Control"], "no-store");
    }
    for (const host of [undefined, "preview.invalid", "127.0.0.1.external.invalid", "localhost@external.invalid"]) {
      assert.equal((await request(route, host)).statusCode, 403);
    }
  }
  assert.equal((await request("/api/content-studio/generate-package", "127.0.0.1:5205")).statusCode, 403);
  assert.equal((await request("/other-document", "127.0.0.1:5205")).statusCode, 404);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import type * as TypeScript from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof TypeScript;
const frontend = path.join(root, "artifacts/negis");
const origin = "https://medinaos.com";
const privateQuery = "?name=Fixture%20Person&phone=%2B77000000000&email=fixture%40example.invalid&lead=11111111-1111-4111-8111-111111111111&token=fixture-private-token";
const privateHash = "#name=Fixture%20Person&phone=%2B77000000000&email=fixture%40example.invalid&lead=11111111-1111-4111-8111-111111111111&access_token=fixture-private-token";
const allowedPaths = [
  "/", "/login", "/dashboard", "/analytics", "/booking", "/appointments",
  "/reception", "/calls", "/sales", "/services", "/client-base", "/staff-schedule",
  "/leads", "/clients", "/tasks", "/chat", "/marketplace", "/market", "/admin",
  "/ads", "/ads-automation/history", "/ads-automation", "/advertising", "/reports",
  "/profile", "/targeting-agent", "/content-studio", "/site-blog",
  "/ai-content-studio", "/content", "/studio", "/privacy", "/terms",
  "/data-deletion", "/ai-control-center", "/operator",
];
const authPaths = ["/onboarding", "/join", "/join-request", "/reset-password", "/contributors", "/r/:code", "/partner-company"];

type Pageview = { type: "pageview"; url: string };
type Policy = {
  canCollectWebAnalytics(production: boolean, currentOrigin: string): boolean;
  sanitizeWebAnalyticsEvent(event: unknown, currentOrigin: string, referrer: string): Pageview | null;
};
const policySource = await readFile(path.join(frontend, "src/lib/web-analytics.ts"), "utf8");
const componentSource = await readFile(path.join(frontend, "src/components/WebAnalytics.tsx"), "utf8");
const appSource = await readFile(path.join(frontend, "src/App.tsx"), "utf8");
const componentAst = ts.createSourceFile("WebAnalytics.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const appAst = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function compile(source: string, fileName: string, replaceImportMeta = false): Script {
  return new Script(ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    transformers: replaceImportMeta ? {
      before: [(context) => (file) => ts.visitNode(file, function visit(node: TypeScript.Node): TypeScript.VisitResult<TypeScript.Node> {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createIdentifier("fixtureImportMeta");
        }
        return ts.visitEachChild(node, visit, context);
      }) as TypeScript.SourceFile],
    } : undefined,
  }).outputText, { filename: fileName });
}

// Execute the real modules with no process, network, SDK side effects or live data.
const policy = {} as Policy;
compile(policySource, "web-analytics.ts").runInNewContext({
  exports: policy,
  URL,
  require(name: string) { assert.fail(`Unexpected policy dependency: ${name}`); },
  fetch() { assert.fail("Analytics policy must not access the network"); },
});
const componentScript = compile(componentSource, "WebAnalytics.tsx", true);

function assertPageview(result: unknown, pathname: string, input?: unknown): asserts result is Pageview {
  assert.ok(result && typeof result === "object" && !Array.isArray(result));
  assert.notEqual(result, input, "Return a fresh object, never the original SDK event");
  assert.deepEqual(Reflect.ownKeys(result).sort(), ["type", "url"], "No identity, metadata, flags or extra properties");
  assert.equal((result as Pageview).type, "pageview");
  assert.equal((result as Pageview).url, origin + pathname);
}

function sanitize(event: unknown, referrer = "", currentOrigin = origin) {
  return policy.sanitizeWebAnalyticsEvent(event, currentOrigin, referrer);
}

function descendants(node: TypeScript.Node): TypeScript.Node[] {
  const result = [node];
  ts.forEachChild(node, (child) => { result.push(...descendants(child)); });
  return result;
}

type Element = { type: unknown; props: Record<string, unknown> };
function componentFixture(production = true, currentOrigin = origin, browser = true) {
  const collector = () => null;
  const exports: Record<string, () => Element | null> = {};
  const state = { attribution: null as string | null, flags: false, storageThrows: false, queryThrows: false, referrer: "" };
  const gateCalls: Array<[boolean, string]> = [];
  const sanitizations: Array<[unknown, string, string]> = [];
  const document = {
    get referrer() { return state.referrer; },
    querySelector(selector: string) {
      assert.equal(selector, "[data-flag-values]");
      if (state.queryThrows) throw new Error("Fixture selector is unavailable");
      return state.flags ? { dataset: { flagValues: "fixture-private-flag" } } : null;
    },
  };
  const window = {
    location: { origin: currentOrigin },
    localStorage: {
      getItem(key: string) {
        assert.equal(key, "__va_attribution");
        if (state.storageThrows) throw new Error("Fixture storage is unavailable");
        return state.attribution;
      },
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  componentScript.runInNewContext({
    exports,
    fixtureImportMeta: { env: { PROD: production } },
    ...(browser ? { window, document } : {}),
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@vercel/analytics/react") return { Analytics: collector };
      assert.equal(name, "@/lib/web-analytics", "Only the official SDK and privacy policy may be imported at runtime");
      return {
        canCollectWebAnalytics(prod: boolean, value: string) {
          gateCalls.push([prod, value]);
          return policy.canCollectWebAnalytics(prod, value);
        },
        sanitizeWebAnalyticsEvent(event: unknown, value: string, referrer: string) {
          sanitizations.push([event, value, referrer]);
          return policy.sanitizeWebAnalyticsEvent(event, value, referrer);
        },
      };
    },
    fetch() { assert.fail("Component fixtures must never access the network"); },
  });
  const render = () => exports.WebAnalytics();
  const beforeSend = () => {
    const tree = render();
    assert.ok(tree && tree.type === collector, "Expected the official Analytics component");
    assert.equal(typeof tree.props.beforeSend, "function");
    return tree.props.beforeSend as (event: unknown) => Pageview | null;
  };
  return { state, window, render, beforeSend, collector, gateCalls, sanitizations };
}

test("collection requires the boolean true and the exact canonical production origin", () => {
  assert.equal(policy.canCollectWebAnalytics(true, origin), true);
  for (const production of [false, undefined, null, 0, 1, "true", "production"]) {
    assert.equal(policy.canCollectWebAnalytics(production as boolean, origin), false, String(production));
  }
  for (const currentOrigin of [
    "", "null", "http://medinaos.com", origin + "/", origin + ":443", "https://MEDINAOS.COM",
    " " + origin, origin + " ", "https://www.medinaos.com", "https://app.medinaos.com",
    "https://medinaos.com.attacker.invalid", "https://medina-preview.vercel.app",
    "http://localhost:5173", "https://localhost", "http://127.0.0.1:5173", "https://user:secret@medinaos.com",
  ]) {
    assert.equal(policy.canCollectWebAnalytics(true, currentOrigin), false, currentOrigin);
    assert.equal(sanitize({ type: "pageview", url: origin + "/leads" }, "", currentOrigin), null, currentOrigin);
  }
});

test("the static allowlist stays in sync with actual App routes and excludes credential flows", () => {
  const routes = descendants(appAst).filter((node) => ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
    .filter((node) => node.tagName.getText(appAst) === "Route")
    .flatMap((node) => node.attributes.properties.flatMap((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(appAst) === "path" && attribute.initializer && ts.isStringLiteral(attribute.initializer)
        ? [attribute.initializer.text] : []));
  assert.deepEqual(routes.filter((route) => !authPaths.includes(route)).sort(), [...allowedPaths].sort());
  for (const route of authPaths) assert.ok(routes.includes(route), `Credential route fixture: ${route}`);
});

for (const pathname of allowedPaths) {
  test(`pageview allows the static section and strips private query/hash values: ${pathname}`, () => {
    for (const suffix of ["", privateQuery, privateHash, privateQuery + privateHash]) {
      const event = Object.freeze({ type: "pageview", url: origin + pathname + suffix });
      assertPageview(sanitize(event), pathname, event);
      assert.equal(event.url, origin + pathname + suffix, "Do not mutate the original URL");
    }
  });
}

test("pageviews return new two-key objects without forwarding even hostile extras", () => {
  const event = Object.freeze(Object.defineProperties({ type: "pageview", url: origin + "/leads" + privateQuery }, {
    name: { enumerable: true, value: "Fixture Person" },
    phone: { enumerable: true, value: "+77000000000" },
    crm: { enumerable: true, value: { note: "fixture private clinical content" } },
    referrer: { enumerable: true, value: "https://foreign.invalid/private?token=fixture" },
    flags: { enumerable: true, value: { identity: "fixture-private-flag" } },
    attribution: { enumerable: true, get() { throw new Error("Never inspect or spread attribution"); } },
    toJSON: { enumerable: true, get() { throw new Error("Never serialize the input event"); } },
    [Symbol("private-extra")]: { enumerable: true, value: "fixture-private-symbol" },
  }));
  const first = sanitize(event);
  const second = sanitize(event);
  assertPageview(first, "/leads", event);
  assertPageview(second, "/leads", event);
  assert.notEqual(first, second, "Do not reuse a mutable result across calls");
});

test("unknown, dynamic, credential, invitation and nonexistent section paths are dropped", () => {
  for (const pathname of [
    ...authPaths, "/r/" + "A".repeat(32), "/reset", "/forgot-password", "/auth/callback", "/invite", "/invitations/fixture-token",
    "/join/fixture-token", "/leads/11111111-1111-4111-8111-111111111111", "/clients/Fixture-Person",
    "/booking/+77000000000", "/operator/fixture@example.invalid", "/ads-automation/history/fixture-id",
    "/unknown", "/directory", "/statistics", "/ai-control", "/api/crm/leads", "/_vercel/insights/event",
    "/leads/", "/Leads", "/%6ceads", "/clients%2Ffixture-id",
  ]) {
    assert.equal(sanitize({ type: "pageview", url: origin + pathname + privateQuery + privateHash }), null, pathname);
  }
});

test("relative, HTTP, off-origin, credential-bearing and malformed event URLs fail closed", () => {
  for (const url of [
    "", "/leads", "leads", "//medinaos.com/leads", "not a URL", "https://", "https://[invalid]/leads",
    "http://medinaos.com/leads", "https://foreign.invalid/leads", "https://www.medinaos.com/leads",
    "https://medinaos.com:444/leads", "https://medinaos.com.attacker.invalid/leads",
    "https://medinaos.com@attacker.invalid/leads", "https://user:secret@medinaos.com/leads",
    "https://user@medinaos.com/leads", "https://:secret@medinaos.com/leads",
    "javascript:alert('fixture')", "data:text/plain,fixture", "file:///leads", "ftp://medinaos.com/leads",
  ]) assert.equal(sanitize({ type: "pageview", url }), null, url);
});

test("malformed inputs and custom events are dropped without coercing or mutating URL inputs", () => {
  const url = new URL(origin + "/leads" + privateQuery + privateHash);
  const before = url.href;
  for (const event of [
    undefined, null, true, 42, "pageview", [], ["pageview", origin], () => null, url,
    {}, { type: "pageview" }, { url: origin + "/leads" }, { type: "event", name: "Fixture Person", url: origin + "/leads" },
    { type: "custom", url: origin + "/leads" }, { type: "PAGEVIEW", url: origin + "/leads" },
    { type: "pageview", url }, { type: "pageview", url: new String(origin + "/leads") },
    { type: "pageview", url: { toString() { throw new Error("No URL coercion"); } } },
    { get type() { throw new Error("Unreadable event type"); } },
    { type: "pageview", get url() { throw new Error("Unreadable event URL"); } },
  ]) assert.equal(sanitize(event), null);
  assert.equal(url.href, before);
});

test("empty referrer, foreign HTTP(S) roots and same-origin static sections are permitted", () => {
  for (const referrer of ["", "https://foreign.invalid", "https://foreign.invalid/", "http://foreign.invalid/", ...allowedPaths.map((pathname) => origin + pathname)]) {
    assertPageview(sanitize({ type: "pageview", url: origin + "/leads" }, referrer), "/leads");
  }
});

test("unsafe referrers drop the whole view because the SDK cannot redact raw referrers", () => {
  for (const referrer of [
    "not a URL", "/leads", "//foreign.invalid/", "https://", "javascript:fixture", "data:text/plain,fixture", "file:///",
    "https://user:secret@foreign.invalid/", "https://user@medinaos.com/leads", "https://:secret@medinaos.com/",
    "https://foreign.invalid/private", "https://foreign.invalid/leads", "https://foreign.invalid/fixture@example.invalid",
    "http://medinaos.com/leads", origin + "/clients/11111111-1111-4111-8111-111111111111",
    origin + "/unknown", origin + "/r/" + "A".repeat(32), ...authPaths.map((pathname) => origin + pathname),
    ...["https://foreign.invalid/", origin + "/", origin + "/leads"].flatMap((base) => [base + privateQuery, base + privateHash, base + privateQuery + privateHash]),
  ]) assert.equal(sanitize({ type: "pageview", url: origin + "/leads" }, referrer), null, referrer);
});

test("WebAnalytics imports only the official React Analytics and the local privacy policy", () => {
  const imports = componentAst.statements.filter(ts.isImportDeclaration);
  assert.deepEqual(imports.map((node) => (node.moduleSpecifier as TypeScript.StringLiteral).text).sort(), ["@/lib/web-analytics", "@vercel/analytics/react"]);
  const sdk = imports.find((node) => (node.moduleSpecifier as TypeScript.StringLiteral).text === "@vercel/analytics/react")!;
  const bindings = sdk.importClause?.namedBindings;
  assert.ok(bindings && ts.isNamedImports(bindings));
  assert.deepEqual(bindings.elements.filter((node) => !node.isTypeOnly).map((node) => (node.propertyName ?? node.name).text), ["Analytics"]);
});

test("the official Analytics component has fixed production mode, debug disabled and only a beforeSend guard", () => {
  const fixture = componentFixture();
  const tree = fixture.render();
  assert.ok(tree && tree.type === fixture.collector);
  assert.deepEqual(Reflect.ownKeys(tree.props).sort(), ["beforeSend", "debug", "mode"]);
  assert.equal(tree.props.mode, "production");
  assert.equal(tree.props.debug, false);
  assert.equal(typeof tree.props.beforeSend, "function");
  assert.deepEqual(fixture.gateCalls, [[true, origin]]);
});

test("development, localhost, Preview, foreign origins and SSR never mount a collector", () => {
  for (const [production, currentOrigin] of [
    [false, origin], [false, "http://localhost:5173"], [true, "http://localhost:5173"],
    [true, "http://127.0.0.1:5173"], [true, "https://medina-preview.vercel.app"],
    [true, "https://foreign.invalid"], [true, "http://medinaos.com"], [true, "https://www.medinaos.com"],
  ] as const) assert.equal(componentFixture(production, currentOrigin).render(), null, `${production}: ${currentOrigin}`);
  assert.equal(componentFixture(true, origin, false).render(), null);
});

test("beforeSend delegates to the real sanitizer with current origin and raw referrer, forwarding no extras", () => {
  const fixture = componentFixture();
  const beforeSend = fixture.beforeSend();
  const event = Object.freeze({ type: "pageview", url: origin + "/leads" + privateQuery + privateHash, name: "Fixture Person", phone: "+77000000000", flags: { private: "fixture" } });
  fixture.state.referrer = origin + "/dashboard";
  assertPageview(beforeSend(event), "/leads", event);
  assert.deepEqual(fixture.sanitizations, [[event, origin, origin + "/dashboard"]]);
  fixture.state.referrer = "https://foreign.invalid/private?token=fixture";
  assert.equal(beforeSend(event), null);
  fixture.state.referrer = "";
  fixture.window.location.origin = "https://medina-preview.vercel.app";
  assert.equal(beforeSend(event), null, "Recheck origin at send time");
});

test("beforeSend never forwards custom events or private paths", () => {
  const beforeSend = componentFixture().beforeSend();
  for (const event of [
    { type: "event", name: "Fixture Person", url: origin + "/leads", data: { phone: "+77000000000" } },
    { type: "pageview", url: origin + "/clients/fixture-id" },
    { type: "pageview", url: origin + "/join?token=fixture" },
  ]) assert.equal(beforeSend(event), null);
});

for (const attribution of ["fixture-person", '{"phone":"+77000000000"}', " "]) {
  test(`nonempty stored SDK attribution blocks the whole view: ${JSON.stringify(attribution)}`, () => {
    const fixture = componentFixture();
    fixture.state.attribution = attribution;
    assert.equal(fixture.beforeSend()({ type: "pageview", url: origin + "/leads" }), null);
    assert.deepEqual(fixture.sanitizations, [], "Do not pass an attributed view to the sanitizer or SDK");
  });
}

test("an empty attribution value is safe but DOM feature flags block the whole view", () => {
  const fixture = componentFixture();
  const beforeSend = fixture.beforeSend();
  fixture.state.attribution = "";
  assertPageview(beforeSend({ type: "pageview", url: origin + "/leads" }), "/leads");
  fixture.state.flags = true;
  const calls = fixture.sanitizations.length;
  assert.equal(beforeSend({ type: "pageview", url: origin + "/leads" }), null);
  assert.equal(fixture.sanitizations.length, calls);
});

for (const failure of ["storageThrows", "queryThrows"] as const) {
  test(`unavailable privacy metadata fails closed without throwing: ${failure}`, () => {
    const fixture = componentFixture();
    fixture.state[failure] = true;
    assert.equal(fixture.beforeSend()({ type: "pageview", url: origin + "/leads" }), null);
    assert.deepEqual(fixture.sanitizations, []);
  });
}

test("SDK attribution and flag guards are checked for every send, not just initial mount", () => {
  const fixture = componentFixture();
  const beforeSend = fixture.beforeSend();
  const event = { type: "pageview", url: origin + "/leads" };
  assertPageview(beforeSend(event), "/leads");
  fixture.state.attribution = "fixture-private-attribution";
  assert.equal(beforeSend(event), null);
  fixture.state.attribution = null;
  fixture.state.flags = true;
  assert.equal(beforeSend(event), null);
  fixture.state.flags = false;
  assertPageview(beforeSend(event), "/leads");
});

test("App mounts WebAnalytics once inside WouterRouter and outside AuthProvider", () => {
  const mounts = descendants(appAst).filter((node) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(appAst) === "WebAnalytics");
  assert.equal(mounts.length, 1);
  const mount = mounts[0];
  assert.ok(ts.isJsxSelfClosingElement(mount));
  assert.equal(mount.attributes.properties.length, 0, "Do not pass auth, CRM or identity props");
  const ancestors: TypeScript.Node[] = [];
  for (let node = mount.parent; node; node = node.parent) ancestors.push(node);
  const containers = ancestors.filter(ts.isJsxElement).map((node) => node.openingElement.tagName.getText(appAst));
  assert.ok(containers.includes("WouterRouter"));
  assert.ok(!containers.includes("AuthProvider"));
  assert.ok(ancestors.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App"));
  assert.ok(!appAst.statements.filter(ts.isImportDeclaration).some((node) => (node.moduleSpecifier as TypeScript.StringLiteral).text.startsWith("@vercel/analytics")), "App uses the guarded wrapper only");
});

test("the document declares one no-referrer policy in its head before scripts", async () => {
  const html = await readFile(path.join(frontend, "index.html"), "utf8");
  const policies = [...html.matchAll(/<meta\b[^>]*>/gi)].filter((match) => /\bname\s*=\s*(["'])referrer\1/i.test(match[0]));
  assert.equal(policies.length, 1);
  assert.match(policies[0][0], /\bcontent\s*=\s*(["'])no-referrer\1/i);
  assert.ok(policies[0].index! > html.search(/<head\b/i));
  assert.ok(policies[0].index! < html.search(/<\/head\s*>/i));
  const firstScript = html.search(/<script\b/i);
  assert.ok(firstScript === -1 || policies[0].index! < firstScript);
});

test("the filesystem-served public privacy page discloses the filtered analytics integration", async () => {
  const html = await readFile(path.join(frontend, "public/privacy/index.html"), "utf8");
  assert.match(html, /Last updated: October 24, 2026/);
  assert.match(html, /Vercel Web Analytics/);
  assert.match(html, /stripped of query parameters and fragments/);
  assert.match(html, /do not measure employee productivity/);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /<script\b/i, "The notice itself does not need a collector");
});

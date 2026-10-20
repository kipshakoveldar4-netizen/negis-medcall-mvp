import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Structural integration checks only; role matrices and session races have their own suites.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = "artifacts/negis/src/";
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pages = ["MortgageOverview", "MortgageClients", "MortgageCalendar", "MortgageTasks", "MortgageAnalytics"];
const routes = ["/dashboard", "/leads", "/clients", "/appointments", "/tasks", "/analytics", "/admin"];
const read = (file: string) => readFile(path.join(root, file), "utf8");
async function parse(file: string) {
  return ts.createSourceFile(file, await read(file), ts.ScriptTarget.Latest, true);
}
function descendants(node: import("typescript").Node): import("typescript").Node[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}
type Element = { type: string; props: Record<string, any> };
function elements(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return value && typeof value === "object" && "props" in value
    ? [value, ...elements(value.props.children)] : [];
}

// Execute just a selected function, never its module imports, effects or application bootstrap.
async function isolatedFunction(file: string, name: string, bindings: Record<string, unknown> = {}) {
  const ast = await parse(src + file);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${file}: missing ${name}`);
  const tags = descendants(declaration).filter((node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    .map((node) => (node as import("typescript").JsxOpeningLikeElement).tagName.getText(ast));
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(`${declaration.getText(ast)}\nexports.subject = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const jsx = (type: string, props: Element["props"]) => ({ type, props });
  new Script(code).runInNewContext({ exports, ...Object.fromEntries(tags.map((tag) => [tag, tag])), ...bindings,
    require(module: string) {
      assert.equal(module, "react/jsx-runtime", "Selected functions cannot load real dependencies");
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    },
  });
  return exports.subject;
}

test("all mortgage page entries keep their data-bearing body inside the real MortgageScope", async () => {
  for (const page of pages) {
    const ast = await parse(`${src}pages/${page}.tsx`);
    const scopeImport = ast.statements.find((node) => ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@/lib/mortgage-workspace"
      && descendants(node).some((child) => ts.isImportSpecifier(child) && child.name.text === "MortgageScope"));
    assert.ok(scopeImport, `${page}: use the shared scope, not a visual stand-in`);
    const entry = await isolatedFunction(`pages/${page}.tsx`, page);
    const tree = entry();
    const scopes = elements(tree).filter((node) => node.type === "MortgageScope");
    assert.equal(scopes.length, 1, `${page}: keep one scope at the page entry`);
    assert.ok(elements(scopes[0].props.children).length, `${page}: scope must contain the page body`);
    function check(value: any, guarded = false) {
      if (Array.isArray(value)) { value.forEach((child) => check(child, guarded)); return; }
      if (!value || typeof value !== "object" || !("props" in value)) return;
      guarded ||= value.type === "MortgageScope";
      if (/^[A-Z]/.test(value.type) && value.type !== "PageLayout") assert.ok(guarded, `${page}: ${value.type} bypasses scope`);
      check(value.props.children, guarded);
    }
    check(tree);
  }
});

test("the shared redesigned shell still gates loading and anonymous sessions before mounting navigation", async () => {
  let auth: Record<string, unknown> = { session: null };
  const layout = await isolatedFunction("components/layout/PageLayout.tsx", "PageLayout", { useAuth: () => auth });
  assert.equal(layout({ children: "Synthetic private page" }).type, "Redirect");
  auth = { session: { user: { id: "synthetic-user" } }, isLoading: true };
  const pending = layout({ children: "Synthetic private page" });
  assert.ok(!JSON.stringify(pending).includes("Synthetic private page"));
  assert.ok(!elements(pending).some((node) => ["Sidebar", "Topbar", "MobileNav"].includes(node.type)));
  auth = { session: { user: { id: "synthetic-user" } } };
  const tree = layout({ children: "Synthetic private page" });
  assert.ok(String(tree.props.className).split(/\s+/).includes("negis-app-shell"), "The private shell owns inherited theme tokens");
  for (const name of ["Sidebar", "Topbar", "MobileNav"]) assert.ok(elements(tree).some((node) => node.type === name), name);
  assert.ok(JSON.stringify(tree).includes("Synthetic private page"));
});

test("analytics mounts its report only for owner/admin with a selected workspace", async () => {
  for (const userRole of ["owner", "admin", "lead_manager", "manager", null]) {
    for (const clinicId of ["synthetic-workspace", null]) {
      const access = await isolatedFunction("pages/MortgageAnalytics.tsx", "MortgageAnalyticsAccess", {
        useAuth: () => ({ userRole, clinicId, user: { id: "synthetic-user" } }),
      });
      const reports = elements(access()).filter((node) => node.type === "MortgageAnalyticsReport");
      assert.equal(reports.length, clinicId && (userRole === "owner" || userRole === "admin") ? 1 : 0,
        `${userRole}/${clinicId}: denied roles must not mount a report or its data hook`);
    }
  }
});

test("desktop/mobile navigation, application router and isolated preview expose the same mortgage routes", async () => {
  for (const file of [`${src}components/layout/Sidebar.tsx`, `${src}components/layout/MobileNav.tsx`,
    `${src}App.tsx`, "scripts/fixtures/crm-browser.tsx", "scripts/fixtures/crm-browser.mjs"]) {
    const ast = await parse(file);
    const nodes = descendants(ast);
    const literals = nodes.filter((node) => {
      if (file.endsWith(".mjs")) return ts.isVariableDeclaration(node) && node.name.getText(ast) === "routes";
      if (file.endsWith("App.tsx") || file.endsWith("crm-browser.tsx")) {
        return ts.isJsxAttribute(node) && node.name.getText(ast) === "path";
      }
      return ts.isPropertyAssignment(node) && node.name.getText(ast) === "href";
    }).flatMap(descendants).filter(ts.isStringLiteral).map((node) => node.text);
    for (const route of routes) assert.ok(literals.includes(route), `${file}: missing shared route ${route}`);
  }
});

test("mint overrides stay inside the private shell and preserve mobile button touch targets", async () => {
  type CssRule = {
    selectors: string[];
    nodes: { prop?: string; value?: string }[];
    parent: { type: string; name?: string; params?: string };
  };
  const frontendRequire = createRequire(path.join(root, "artifacts/negis/package.json"));
  const postcss = createRequire(frontendRequire.resolve("vite"))("postcss") as {
    parse: (css: string) => { walkRules: (visit: (rule: CssRule) => void) => void };
  };
  assert.match(await read(src + "index.css"), /@import\s+["']\.\/styles\/mint-workspace\.css["']/);
  const sheet = postcss.parse(await read(src + "styles/mint-workspace.css"));
  const touchControls = new Set<string>();
  let ruleCount = 0;
  sheet.walkRules((rule) => {
    ruleCount++;
    for (const selector of rule.selectors) assert.match(selector, /^\.negis-app-shell(?:$|[\s:.\[>+~])/,
      `Mint override escapes the signed-in shell: ${selector}`);
    if (rule.parent.type !== "atrule" || rule.parent.name !== "media" || !/max-width/.test(rule.parent.params || "")) return;
    if (!rule.nodes.some((node) => node.prop === "min-height" && /^\d+(?:\.\d+)?px$/.test(node.value || "") && parseFloat(node.value!) >= 44)) return;
    for (const selector of rule.selectors) {
      for (const match of selector.matchAll(/\.([a-z][\w-]*)/gi)) touchControls.add(match[1]);
    }
  });
  assert.ok(ruleCount > 0, "Check actual theme rules, not an empty stylesheet");
  for (const control of ["neu-btn", "neu-btn-primary", "neu-btn-success", "neu-btn-danger"]) {
    assert.ok(touchControls.has(control), `${control}: retain at least 44px mobile touch height`);
  }
  for (const page of ["Login", "Landing"]) {
    const ast = await parse(`${src}pages/${page}.tsx`);
    assert.ok(!descendants(ast).some((node) => ts.isStringLiteral(node) && /\bnegis-app-shell\b/.test(node.text)),
      `${page}: public entry must not opt into private theme overrides`);
  }
});

test("redesigned fixture surfaces use bound transports and local assets, not live network dependencies", async () => {
  const mortgageComponents = (await readdir(path.join(root, src, "components/mortgage")))
    .filter((file) => /\.tsx?$/.test(file)).map((file) => `${src}components/mortgage/${file}`);
  const files = [...pages.map((page) => `${src}pages/${page}.tsx`), `${src}pages/LeadsPage.tsx`,
    ...["PageLayout", "Sidebar", "MobileNav", "Topbar"].map((name) => `${src}components/layout/${name}.tsx`),
    ...mortgageComponents, "scripts/fixtures/mortgage-browser-store.ts"];
  for (const file of files) {
    const ast = await parse(file);
    for (const node of descendants(ast)) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        assert.doesNotMatch(node.moduleSpecifier.text, /^(?:https?:|\/\/|@supabase\/|axios(?:\/|$))/,
          `${file}: keep live transports behind the fixture-aliased API`);
        if (file.startsWith(src)) assert.doesNotMatch(node.moduleSpecifier.text, /(?:^|\/)fixtures\//, `${file}: no fixture imports in app code`);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const target = node.expression;
        const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : "";
        assert.ok(!["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "createClient"].includes(name),
          `${file}: ${name} bypasses the bound fixture transport`);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(ast) === "src" && node.initializer) {
        assert.doesNotMatch(node.initializer.getText(ast), /(?:https?:)?\/\//, `${file}: use local media in the offline preview`);
      }
    }
  }
  const styles = ["index.css", ...(await readdir(path.join(root, src, "styles"))).filter((file) => file.endsWith(".css")).map((file) => `styles/${file}`)];
  for (const file of styles) {
    const css = (await read(src + file)).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?(?:https?:)?\/\//i,
      `${file}: remote fonts/assets must not make the synthetic preview contact a live service`);
  }
});

test("portaled activity forms keep mobile field sizes and the shared dialog sits above navigation", async () => {
  const dialog = await parse(src + "components/ui/dialog.tsx");
  const literals = descendants(dialog).filter(ts.isStringLiteral).map((node) => node.text);
  const overlay = literals.find((value) => value.startsWith("fixed inset-0"));
  const content = literals.find((value) => value.startsWith("fixed left-[50%]"));
  assert.ok(overlay && content);
  const zIndex = (value: string) => Number(/\bz-\[(\d+)\]/.exec(value)?.[1]);
  const css = await read(src + "index.css");
  const navZ = Number(/\.mobile-bottom-nav\s*\{[^}]*z-index:\s*(\d+)/s.exec(css)?.[1]);
  assert.ok(navZ > 0 && zIndex(overlay) > navZ && zIndex(content) > zIndex(overlay),
    "A dialog and its backdrop must cover the fixed navigation, including outside the app shell");
  const primitives = await parse(src + "components/mortgage/MortgagePrimitives.tsx");
  const values = new Map(descendants(primitives).filter(ts.isVariableDeclaration).flatMap((node) =>
    ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)
      ? [[node.name.text, node.initializer.text] as const] : []));
  assert.match(values.get("mortgageInputClass") || "", /\bmin-h-11\b/);
  assert.match(values.get("mortgageInputClass") || "", /\bmax-sm:text-base\b/);
  for (const name of ["mortgageButtonClass", "mortgagePrimaryClass"]) {
    assert.match(values.get(name) || "", /\bmax-sm:min-h-11\b/);
  }
});

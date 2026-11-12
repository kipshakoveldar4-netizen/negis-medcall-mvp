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
type CssNode = {
  type: string;
  name?: string;
  params?: string;
  prop?: string;
  value?: string;
  important?: boolean;
  nodes?: CssNode[];
  parent?: CssNode;
};
type CssRule = CssNode & { selectors: string[]; nodes: CssNode[] };
type CssAtRule = CssNode & { name: string; params: string; nodes: CssNode[] };
type CssSheet = {
  walkRules: (visit: (rule: CssRule) => void) => void;
  walkAtRules: (name: string | RegExp, visit: (rule: CssAtRule) => void) => void;
};
const frontendRequire = createRequire(path.join(root, "artifacts/negis/package.json"));
const postcss = createRequire(frontendRequire.resolve("vite"))("postcss") as {
  parse: (css: string) => CssSheet;
  list: { comma: (value: string) => string[]; space: (value: string) => string[] };
};
const pages = ["MortgageOverview", "MortgageClients", "MortgageCalendar", "MortgageTasks", "MortgageAnalytics"];
const routes = ["/dashboard", "/leads", "/clients", "/appointments", "/tasks", "/analytics", "/admin"];
const read = (file: string) => readFile(path.join(root, file), "utf8");
const declarations = (node: CssNode) => (node.nodes || []).filter((child): child is CssNode & { prop: string; value: string } =>
  child.type === "decl" && typeof child.prop === "string" && typeof child.value === "string");
const cssValue = (node: CssNode, prop: string) => declarations(node).filter((child) => child.prop === prop).at(-1)?.value;
const isKeyframe = (node?: CssNode) => node?.type === "atrule" && /^(?:-\w+-)?keyframes$/i.test(node.name || "");
function inMotionMedia(node: CssNode, preference: "reduce" | "no-preference") {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && parent.name === "media" && postcss.list.comma(parent.params || "").every((query) =>
      new RegExp(`\\(\\s*prefers-reduced-motion\\s*:\\s*${preference}\\s*\\)`, "i").test(query)
        && !/\bnot\b/i.test(query))) return true;
  }
  return false;
  return false;
}
function milliseconds(value: string) {
  assert.match(value, /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/i, `Expected a literal CSS duration: ${value}`);
  return parseFloat(value) * (/ms$/i.test(value) ? 1 : 1000);
}
function disablesMotion(rule: CssRule, property: "animation" | "transition") {
  if (cssValue(rule, property) === "none") return true;
  const duration = cssValue(rule, `${property}-duration`);
  return duration !== undefined && postcss.list.comma(duration).every((value) => milliseconds(value) <= 0.01);
}
function assertReducedMotionReset(sheet: CssSheet, rules: CssRule[], property: "animation" | "transition") {
  const resets: CssRule[] = [];
  sheet.walkRules((rule) => {
    if (inMotionMedia(rule, "reduce") && disablesMotion(rule, property)) resets.push(rule);
  });
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      assert.ok(resets.some((reset) => reset.selectors.some((target) => target === selector
        || (target === ".negis-app-shell *" && declarations(reset).some((decl) => decl.important
          && (decl.prop === property || decl.prop === `${property}-duration`))))),
      `${selector}: reduced motion must disable the new ${property} without losing to more specific UI rules`);
    }
  }
}
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
  assert.match(await read(src + "index.css"), /@import\s+["']\.\/styles\/mint-workspace\.css["']/);
  const sheet = postcss.parse(await read(src + "styles/mint-workspace.css"));
  const touchControls = new Set<string>();
  let ruleCount = 0;
  sheet.walkRules((rule) => {
    if (isKeyframe(rule.parent)) return;
    ruleCount++;
    for (const selector of rule.selectors) assert.match(selector, /^\.negis-app-shell(?:$|[\s:.\[>+~])/,
      `Mint override escapes the signed-in shell: ${selector}`);
    if (rule.parent?.type !== "atrule" || rule.parent.name !== "media" || !/max-width/.test(rule.parent.params || "")) return;
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

test("Inter is self-hosted as a normal variable face with its license and no Google Fonts HTML links", async () => {
  const index = postcss.parse(await read(src + "index.css"));
  const imports: string[] = [];
  index.walkAtRules("import", (rule) => { imports.push(rule.params); });
  assert.ok(imports.some((value) => /^(?:url\(\s*)?["']\.\/styles\/fonts\.css["'](?:\s*\))?$/.test(value)),
    "The application stylesheet must load the shared local font definitions");
  const sheet = postcss.parse(await read(src + "styles/fonts.css"));
  const faces: CssAtRule[] = [];
  sheet.walkAtRules("font-face", (rule) => {
    if (/^["']?Inter["']?$/i.test(cssValue(rule, "font-family") || "")) faces.push(rule);
  });
  assert.ok(faces.length > 0, "Declare an actual Inter @font-face");
  for (const face of faces) {
    assert.equal(cssValue(face, "font-style"), "normal");
    assert.match(cssValue(face, "font-weight") || "", /^(?:100\s+900|400\s+700)$/,
      "Normal Inter must cover the restored UI weights as one variable face");
    assert.equal(cssValue(face, "font-display"), "swap", "The UI must remain readable while a local font loads");
    const source = cssValue(face, "src") || "";
    assert.doesNotMatch(source, /\blocal\s*\(|(?:https?:)?\/\//i, "Use the bundled font, not a machine-installed or remote copy");
    assert.match(source, /\bformat\(\s*["']woff2(?:-variations)?["']\s*\)/i);
    const urls = [...source.matchAll(/\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)]
      .map((match) => match[1] || match[2] || match[3]);
    assert.ok(urls.length > 0, "Inter must reference a local WOFF2 file");
    for (const url of urls) {
      assert.match(url, /^\/fonts\/inter\/[\w.-]+\.woff2$/i);
      const font = await readFile(path.join(root, "artifacts/negis/public", url.slice(1)));
      assert.ok(font.length > 48 && font.subarray(0, 4).toString("ascii") === "wOF2", `${url}: ship real WOFF2 bytes`);
    }
  }
  const license = await read("artifacts/negis/public/fonts/inter/OFL.txt");
  assert.match(license, /SIL OPEN FONT LICENSE\s+Version 1\.1/i);
  assert.match(license, /copyright/i);
  const html = (await read("artifacts/negis/index.html")).replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(html, /<link\b[^>]*\bfonts\.(?:googleapis|gstatic)\.com\b/i,
    "Do not reconnect to Google Fonts through stylesheet, preload or preconnect links");
});

test("shared workspace entry is a short opacity-only animation with an explicit reduced-motion reset", async () => {
  const sheet = postcss.parse(await read(src + "styles/mint-workspace.css"));
  const keyframes: CssAtRule[] = [];
  sheet.walkAtRules(/^(?:-\w+-)?keyframes$/i, (rule) => {
    if (rule.params === "negis-workspace-enter") keyframes.push(rule);
  });
  assert.ok(keyframes.length > 0, "Keep one shared negis-workspace-enter keyframe contract");
  for (const keyframe of keyframes) {
    const frames = keyframe.nodes.filter((node) => node.type !== "comment");
    assert.equal(frames.length, 2, "The entry fade needs only its initial and final frame");
    for (const [index, frame] of frames.entries()) {
      assert.equal(frame.type, "rule");
      const selector = (frame as CssRule).selectors;
      assert.equal(selector.length, 1);
      assert.ok((index === 0 ? ["from", "0%"] : ["to", "100%"]).includes(selector[0]));
      assert.deepEqual(declarations(frame).map((decl) => decl.prop), ["opacity"],
        "Page entry must not animate layout, transforms, filters or promoted layers");
      assert.equal(Number(cssValue(frame, "opacity")), index === 0 ? 0.94 : 1);
    }
  }
  const layout = await isolatedFunction("components/layout/PageLayout.tsx", "PageLayout", {
    useAuth: () => ({ session: { user: { id: "synthetic-user" } } }),
  });
  const mains = elements(layout({ children: "Synthetic page" })).filter((node) => node.type === "main");
  assert.equal(mains.length, 1, "All signed-in sections must keep the same main content surface");
  const mainClasses = String(mains[0].props.className).split(/\s+/);
  const entryRules: CssRule[] = [];
  sheet.walkRules((rule) => {
    if (isKeyframe(rule.parent)) return;
    const animation = cssValue(rule, "animation") || cssValue(rule, "animation-name") || "";
    if (!postcss.list.space(animation).includes("negis-workspace-enter")) return;
    assert.equal(postcss.list.comma(animation).length, 1, "Do not attach additional motion to the entry fade");
    assert.ok(inMotionMedia(rule, "no-preference"), "Entry motion must be opt-in through the system motion preference");
    assert.ok(rule.selectors.every((selector) => mainClasses.some((name) =>
      selector === `.negis-app-shell .${name}` || selector === `.negis-app-shell .${name} > *`)),
    "Apply the shared fade to the actual main surface or its page children, not a page-specific class");
    const duration = cssValue(rule, "animation-duration")
      || postcss.list.space(animation).find((value) => /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/i.test(value));
    assert.ok(duration, "Declare the entry animation duration");
    assert.ok(milliseconds(duration) > 0 && milliseconds(duration) <= 180, "Page entry must finish within 180ms");
    const delay = cssValue(rule, "animation-delay") || postcss.list.space(animation)
      .filter((value) => /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/i.test(value))[1] || "0ms";
    assert.ok(milliseconds(duration) + milliseconds(delay) <= 180, "Entry delay must not hide content beyond 180ms");
    assert.equal(cssValue(rule, "animation-iteration-count") || postcss.list.space(animation)
      .find((value) => /^(?:infinite|\d+(?:\.\d+)?)$/.test(value)) || "1", "1", "Page entry must run only once");
    entryRules.push(rule);
  });
  assert.ok(entryRules.length > 0, "The shared shell must actually use the entry animation");
  assertReducedMotionReset(sheet, entryRules, "animation");
  for (const file of ["index.css", "styles/mint-workspace.css"]) {
    postcss.parse(await read(src + file)).walkRules((rule) => {
      if (!rule.selectors.some((selector) => /\.negis-main(?:$|[:\[])/.test(selector))) return;
      for (const decl of declarations(rule)) assert.doesNotMatch(decl.prop,
        /^(?:transform|translate|rotate|scale|will-change|(?:backdrop-)?filter)$/,
        `${file}: keep main content free of transforms, filters and layer promotion`);
    });
  }
  for (const prop of ["transform", "translate", "rotate", "scale", "willChange", "filter", "backdropFilter"]) {
    assert.ok(!(prop in (mains[0].props.style || {})), `Main must not add inline ${prop}`);
  }
});

test("shared control transitions affect paint only, finish in 140-180ms, and switch off for reduced motion", async () => {
  const sheet = postcss.parse(await read(src + "styles/mint-workspace.css"));
  const paint = new Set(["background", "background-color", "color", "border-color", "border-top-color", "border-right-color",
    "border-bottom-color", "border-left-color", "box-shadow", "text-shadow", "outline-color", "text-decoration-color",
    "opacity", "fill", "stroke", "caret-color", "accent-color"]);
  const transitionRules: CssRule[] = [];
  sheet.walkRules((rule) => {
    for (const decl of declarations(rule).filter((node) => /^(?:-\w+-)?transition(?:-property)?$/.test(node.prop))) {
      for (const entry of postcss.list.comma(decl.value)) {
        if (entry === "none") continue;
        const tokens = postcss.list.space(entry);
        assert.ok(paint.has(tokens[0]), `${rule.selectors.join(", ")}: transition ${tokens[0]} is not paint-only`);
        if (inMotionMedia(rule, "reduce")) {
          assert.ok(disablesMotion(rule, "transition"), "Reduced-motion transitions must actually be disabled");
          continue;
        }
        assert.ok(inMotionMedia(rule, "no-preference"), "New control transitions must respect the system motion preference");
        const duration = decl.prop.endsWith("-property") ? cssValue(rule, "transition-duration")
          : tokens.find((value) => /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/i.test(value));
        assert.ok(duration, "Declare a short control transition duration");
        for (const value of postcss.list.comma(duration)) {
          assert.ok(milliseconds(value) >= 140 && milliseconds(value) <= 180,
            `${rule.selectors.join(", ")}: control transitions must last 140-180ms`);
        }
        transitionRules.push(rule);
      }
    }
  });
  const selectors = transitionRules.flatMap((rule) => rule.selectors).join(" ");
  for (const [control, pattern] of [
    ["inputs", /\b(?:input|select|textarea)\b|\.neu-input\b/],
    ["buttons", /\bbutton\b|\.neu-(?:icon-)?btn\b/],
    ["navigation", /\b(?:nav|a)\b|\.medina-sidebar\b|\.mobile-(?:bottom-nav|nav)[\w-]*/],
  ] as const) assert.match(selectors, pattern, `${control}: include the shared control transitions`);
  assertReducedMotionReset(sheet, transitionRules, "transition");
});

test("the shared layout keeps CSS entry motion off the eager Framer path and never retains exiting pages", async () => {
  for (const file of ["components/layout/PageLayout.tsx", "App.tsx"]) {
    const ast = await parse(src + file);
    const presenceNames = new Set(["AnimatePresence"]);
    for (const node of descendants(ast)) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const module = node.moduleSpecifier.text;
      if (file.endsWith("PageLayout.tsx") && !node.importClause?.isTypeOnly) {
        assert.doesNotMatch(module, /^(?:framer-motion|motion)(?:\/|$)/,
          "The shared layout must not eagerly load the animation runtime");
      }
      for (const child of descendants(node).filter(ts.isImportSpecifier)) {
        if ((child.propertyName || child.name).text === "AnimatePresence") presenceNames.add(child.name.text);
      }
    }
    for (const node of descendants(ast)) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        assert.ok(!presenceNames.has(node.tagName.getText(ast).split(".").at(-1)!),
          `${file}: do not retain exiting route trees with AnimatePresence`);
      }
    }
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

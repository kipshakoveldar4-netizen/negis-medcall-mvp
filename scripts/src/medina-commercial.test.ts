import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Medina OS Commercial-1: the clinic-facing product must not advertise
// unfinished modules, leak internal release engineering, or show old branding.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const admin = await readFile(path.join(negisSrc, "pages", "AdminCenter.tsx"), "utf8");
const sidebar = await readFile(path.join(negisSrc, "components", "layout", "Sidebar.tsx"), "utf8");
const mobileNav = await readFile(path.join(negisSrc, "components", "layout", "MobileNav.tsx"), "utf8");
const acc = await readFile(path.join(negisSrc, "pages", "AiControlCenter.tsx"), "utf8");
const adsAutomation = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");

test("01 no visible «скоро» teasers in clinic-facing navigation or settings", () => {
  for (const [name, source] of [["AdminCenter", admin], ["Sidebar", sidebar], ["MobileNav", mobileNav]] as const) {
    assert.ok(!source.includes("скоро"), `${name} must not advertise unfinished modules`);
  }
});

test("02 no internal release engineering on the clinic settings surface", () => {
  assert.ok(!admin.includes("Release-ready"), "old internal page title removed");
  assert.ok(!admin.includes("Release readiness"), "English readiness metric removed from clinic overview");
  assert.ok(!admin.includes("Critical blockers"), "English blockers metric removed from clinic overview");
  assert.ok(!admin.includes("· blockers"), "raw blockers counter removed");
});

test("03 clinic settings page is titled and branded for clinics", () => {
  assert.ok(admin.includes("Настройки клиники"));
  assert.ok(admin.includes("Администрирование"));
  assert.ok(!admin.includes("Admin OS"), "old Admin OS branding removed");
  assert.ok(!admin.includes("Negis OS"), "old Negis OS branding removed from AdminCenter");
});

test("04 internal diagnostics stay available behind progressive disclosure", () => {
  assert.ok(admin.includes("Диагностика платформы · внутренний раздел Medina Platform"));
  assert.ok(admin.includes("<details"), "platform diagnostics use progressive disclosure");
  assert.ok(admin.includes("ReleaseBanner readiness={readiness}"), "release diagnostics preserved for platform staff");
  assert.ok(admin.includes("Готовность платформы:"), "readiness wording is Russian");
});

test("05 session-expired presentation is professional and non-technical", () => {
  assert.ok(admin.includes("Сессия завершена"));
  assert.ok(admin.includes("Для защиты данных необходимо войти в аккаунт повторно."));
  assert.ok(admin.includes("Войти снова"));
  assert.ok(!admin.includes("Supabase-сессия"), "provider internals are not shown to customers");
});

test("06 customer navigation lists only working modules for its workspace purpose", async (t) => {
  // Like the mortgage navigation harness, execute actual TSX with synthetic
  // elements and hooks; imports cannot reach a DOM, auth provider or network.
  const ts = createRequire(path.join(repoRoot, "package.json"))("typescript") as typeof import("typescript");
  type Surface = "Sidebar" | "MobileNav";
  type Purpose = "clinic_services" | "marketing" | "mortgage_leads" | null;
  type Node = { type: unknown; props: Record<string, any> };
  type Route = { href: string; label: string };
  const sources = { Sidebar: sidebar, MobileNav: mobileNav };
  const surfaces: Surface[] = ["Sidebar", "MobileNav"];
  const roles = ["owner", "admin", "manager", "lead_manager", "receptionist", "doctor", "marketer", "agent", "booking_agent", null];
  const demoRoutes = ["/reception", "/calls", "/tasks", "/chat", "/market"];
  const compile = (source: string) => new Script(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText);
  function evaluate(code: Script, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
    const exports: Record<string, any> = {};
    code.runInNewContext({ ...globals, exports, require(name: string) {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") {
        const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
        return { jsx, jsxs: jsx, Fragment: "Fragment" };
      }
      if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => String(key) });
      throw new Error(`Unmocked import: ${name}`);
    } });
    return exports;
  }
  const compiled = { Sidebar: compile(sidebar), MobileNav: compile(mobileNav) };
  const terms = evaluate(compile(await readFile(path.join(repoRoot, "lib/vertical/terms.ts"), "utf8")));
  const policy = evaluate(compile(await readFile(path.join(negisSrc, "lib/workspaceRoutes.ts"), "utf8")));
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...nodes(value.props.children)];
  }
  function label(value: any): string {
    if (Array.isArray(value)) return value.map(label).join("");
    if (value && typeof value === "object") return label(value.props?.children);
    return typeof value === "string" ? value : "";
  }
  function routes(surface: Surface, purpose: Purpose, role: string | null, code = compiled[surface]): Route[] {
    const states: any[] = [], effects: (() => void)[] = [], navigations: string[] = [];
    let cursor = 0, dirty = true, tree: any;
    const module = evaluate(code, {
      react: {
        useState(initial: any) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
          return [states[slot], (next: any) => {
            const value = typeof next === "function" ? next(states[slot]) : next;
            if (!Object.is(states[slot], value)) { states[slot] = value; dirty = true; }
          }];
        },
        // Context is fixed per fixture, so layout effects run only on mount.
        useLayoutEffect(run: () => void) {
          const slot = cursor++;
          if (!(slot in states)) { states[slot] = true; effects.push(run); }
        },
      },
      wouter: { Link: "Link", useLocation: () => ["/leads", (href: string) => navigations.push(href)] },
      "@/contexts/AuthContext": { useAuth: () => ({
        user: { id: "local-user", email: "staff@example.test", user_metadata: { full_name: "Local staff" } },
        clinicId: "local-workspace", userRole: role, workspacePurpose: purpose, vertical: "clinic",
        rolePermissions: { crm: true, admin: true, dashboard: true, booking: true, directory: true,
          ads: true, marketplace: true, reports: true, reception: true, tasks: true, chat: true },
        availableWorkspaces: [], signOut() {}, clearWorkspaceSelection() {},
      }) },
      "@/lib/workspaceRoutes": policy,
      "@/lib/demoStorage": { isRealWorkspace: () => true },
      "../../../../../lib/vertical/terms": terms,
      "../../../../../lib/auth/staff-logins": { loginFromEmail: () => "local-staff" },
      "./ProfileDialog": { ProfileDialog: "ProfileDialog" },
    });
    function paint() {
      for (let pass = 0; pass < 10 && dirty; pass++) {
        dirty = false; cursor = 0; tree = module[surface]();
        for (const effect of effects.splice(0)) effect();
      }
      assert.equal(dirty, false, "navigation layout effects must settle");
    }
    paint();
    if (surface === "MobileNav") {
      const more = nodes(tree).find((node) => node.type === "button" && label(node) === "Ещё");
      assert.ok(more, "mobile menu must be openable");
      more.props.onClick(); paint();
      assert.ok(nodes(tree).some((node) => node.props.className === "mobile-nav-sheet"));
    }
    const result: Route[] = [];
    for (const node of nodes(tree)) {
      if (node.type === "Link") result.push({ href: node.props.href, label: label(node) });
      else if (node.type === "button" && /^mobile-(bottom-nav-item|nav-drawer-item)(?: |$)/.test(node.props.className ?? "")
        && !["Ещё", "Профиль и пароль"].includes(label(node))) {
        const start = navigations.length;
        node.props.onClick();
        assert.equal(navigations.length, start + 1, `${label(node)} must navigate exactly once`);
        result.push({ href: navigations[start], label: label(node) });
      }
    }
    return result.sort((a, b) => a.href.localeCompare(b.href));
  }
  function assertCustomerMenu(menu: Route[], surface: Surface, purpose: Purpose, role: string | null) {
    for (const href of [...demoRoutes, "/analytics"]) {
      assert.ok(!menu.some((item) => item.href === href), `${surface}/${purpose}/${role} must hide ${href}`);
    }
    if (["owner", "admin", "manager"].includes(role ?? "")) {
      assert.ok(menu.some((item) => item.href === "/sales" && item.label === "Продажи"), "working sales remain visible");
      assert.ok(menu.some((item) => item.href === "/marketplace"), "real marketplace is not the old /market entry");
      if (surface === "Sidebar") {
        assert.ok(menu.some((item) => item.href === "/reports" && item.label === "Статистика"), "real clinic statistics remain visible where listed");
      }
    }
  }

  await t.test("clinic and marketing menus hide demos without hiding working sales or statistics", () => {
    for (const surface of surfaces) for (const purpose of ["clinic_services", "marketing"] as const) for (const role of roles) {
      assertCustomerMenu(routes(surface, purpose, role), surface, purpose, role);
    }
  });
  await t.test("mortgage owner/admin get real tasks and team analytics; lead managers get only own-work sections", () => {
    for (const surface of surfaces) for (const role of ["owner", "admin", "lead_manager"]) {
      const menu = routes(surface, "mortgage_leads", role);
      const own = [{ href: "/appointments", label: "Календарь" }, { href: "/clients", label: "Клиенты" },
        { href: "/dashboard", label: "Главная" }, { href: "/leads", label: "Заявки" }, { href: "/tasks", label: "Задачи" }];
      const expected = role === "lead_manager" ? own
        : [{ href: "/admin", label: "Команда" }, { href: "/analytics", label: "Аналитика команды" }, ...own];
      assert.deepEqual(menu, expected, `${surface}/${role}: no sales, medical or advertising sections`);
    }
  });
  await t.test("an unknown workspace purpose renders no navigation even with broad permissions", () => {
    for (const surface of surfaces) for (const role of roles) {
      assert.deepEqual(routes(surface, null, role), [], `${surface}/${role}`);
    }
  });
  await t.test("App binds statistics and mortgage tasks/analytics to real pages, not clinic task fixtures", async () => {
    const app = ts.createSourceFile("App.tsx", await readFile(path.join(negisSrc, "App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const purposePage = app.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "PurposePage");
    assert.ok(purposePage, "actual purpose selector must exist");
    const pageModules: Record<string, string> = {};
    for (const name of ["StatsPage", "MortgageTasks", "MortgageAnalytics"]) {
      const declaration = app.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations])
        .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
      assert.ok(declaration, `${name} must be a real lazy page`);
      const imports: string[] = [];
      function collectImports(node: import("typescript").Node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
          imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, collectImports);
      }
      collectImports(declaration);
      assert.deepEqual(imports, [`@/pages/${name}`]);
      pageModules[name] = imports[0];
    }
    const routeNodes = new Map<string, import("typescript").JsxSelfClosingElement>();
    function collectRoutes(node: import("typescript").Node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === "Route") {
        const attr = node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(app) === "path");
        if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer)) {
          routeNodes.set(attr.initializer.text, node);
        }
      }
      ts.forEachChild(node, collectRoutes);
    }
    collectRoutes(app);
    for (const [href, purpose, expected] of [
      ["/reports", "clinic_services", pageModules.StatsPage],
      ["/tasks", "clinic_services", "DemoTasks"],
      ["/tasks", "marketing", "DemoTasks"],
      ["/tasks", "mortgage_leads", pageModules.MortgageTasks],
      ["/analytics", "mortgage_leads", pageModules.MortgageAnalytics],
    ] as const) {
      const route = routeNodes.get(href);
      assert.ok(route, `App must declare ${href}`);
      const code = compile(`export ${purposePage.getText(app)}\nexport const renderRoute = () => (${route.getText(app)});`);
      const module = evaluate(code, {}, { ...pageModules, DemoTasks: "DemoTasks", NotFound: "NotFound",
        Route: "Route", ProtectedPage: "ProtectedPage", useAuth: () => ({ workspacePurpose: purpose }) });
      let page = module.renderRoute().props.component();
      while (typeof page.type === "function") page = page.type(page.props);
      assert.equal(page.type, "ProtectedPage");
      assert.equal(page.props.component, expected, `${purpose}:${href}`);
    }
  });

  // Mutate only in-memory ASTs. Each mutant must reach the rendered menu and
  // fail the same customer assertion as production, not a compilation error.
  function mutate(source: string, href: string, injectInto?: string) {
    const ast = ts.createSourceFile("navigation.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const itemHref = (node: import("typescript").Node) => ts.isObjectLiteralExpression(node)
      ? node.properties.find((prop) => ts.isPropertyAssignment(prop) && prop.name.getText(ast) === "href") : undefined;
    let changes = 0;
    const transformed = ts.transform(ast, [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (injectInto && ts.isArrayLiteralExpression(node)) {
          const anchor = node.elements.find((item) => {
            const prop = itemHref(item);
            return prop && ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer) && prop.initializer.text === injectInto;
          });
          if (anchor && ts.isObjectLiteralExpression(anchor)) {
            changes++;
            const injected = ts.factory.updateObjectLiteralExpression(anchor, anchor.properties.map((prop) =>
              prop === itemHref(anchor) && ts.isPropertyAssignment(prop)
                ? ts.factory.updatePropertyAssignment(prop, prop.name, ts.factory.createStringLiteral(href, true)) : prop));
            return ts.factory.updateArrayLiteralExpression(node, [...node.elements, injected]);
          }
        } else if (!injectInto && ts.isObjectLiteralExpression(node)) {
          const prop = itemHref(node);
          if (prop && ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer) && prop.initializer.text === href) {
            const properties = node.properties.filter((item) => !(ts.isPropertyAssignment(item) && item.name.getText(ast) === "mortgageOnly"));
            changes += node.properties.length - properties.length;
            return ts.factory.updateObjectLiteralExpression(node, properties);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit) as typeof node;
    }]);
    assert.equal(changes, 1, "each local mutant must change exactly one menu entry");
    const result = compile(ts.createPrinter().printFile(transformed.transformed[0]));
    transformed.dispose();
    return result;
  }
  function assertMutantRejected(surface: Surface, code: Script, href: string) {
    for (const purpose of ["clinic_services", "marketing"] as const) {
      const menu = routes(surface, purpose, "owner", code);
      assert.ok(menu.some((item) => item.href === href), `mutant must actually expose ${href}`);
      assert.throws(() => assertCustomerMenu(menu, surface, purpose, "owner"),
        (error: unknown) => error instanceof assert.AssertionError && error.message.includes(`must hide ${href}`));
    }
  }
  await t.test("local demo injections fail on sidebar, mobile primary and mobile drawer", () => {
    for (const surface of surfaces) for (const anchor of surface === "MobileNav" ? ["/sales", "/ads"] : ["/sales"]) {
      for (const href of demoRoutes) assertMutantRejected(surface, mutate(sources[surface], href, anchor), href);
    }
  });
  await t.test("removing either sidebar mortgageOnly flag fails for clinic and marketing", () => {
    for (const href of ["/tasks", "/analytics"]) assertMutantRejected("Sidebar", mutate(sidebar, href), href);
  });
});

test("07 Medina OS branding is present on customer routes", () => {
  assert.ok(sidebar.includes("Medina OS"));
  assert.ok(acc.includes("Medina OS"));
  assert.ok(!acc.includes("Negis OS"));
});

test("08 Ads Automation PAUSED safety remains intact", () => {
  assert.ok(adsAutomation.includes("Все рекламные кампании, созданные через Medina OS."), "history subtitle present");
  assert.ok(acc.includes("Реклама в Medina OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager."));
});

test("09 no fake billing or checkout surfaces exist", () => {
  for (const [name, source] of [["AdminCenter", admin], ["Sidebar", sidebar]] as const) {
    assert.ok(!/checkout|Оплатить картой|invoice/i.test(source), `${name} must not fake billing`);
  }
});

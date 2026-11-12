import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const source = await readFile(path.join(root, "artifacts/negis/src/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && ["firstAllowedRoute", "ProtectedPage"].includes(node.name?.text ?? "")
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text === "ROUTE_PERMISSIONS"));
assert.equal(selected.length, 3);
const script = new Script(ts.transpileModule(
  selected.map((node) => node.getText(ast)).join("\n") + "\nexport { ProtectedPage };",
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } },
).outputText);
const routeScript = new Script(ts.transpileModule(
  await readFile(path.join(root, "artifacts/negis/src/lib/workspaceRoutes.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText);
const routeExports: Record<string, any> = {};
routeScript.runInNewContext({ exports: routeExports });
type Tree = { type: unknown; props: Record<string, any> } | null;
type Auth = {
  isLoading: boolean;
  userRole: string | null;
  workspacePurpose: "mortgage_leads" | "clinic_services" | "marketing" | null;
  rolePermissions: Record<string, boolean>;
  isDemoMode: boolean;
};
function nodes(tree: any): Exclude<Tree, null>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}
function fixture(patch: Partial<Auth> = {}, initialPath = "/leads") {
  let auth: Auth = { isLoading: false, userRole: "manager", workspacePurpose: "mortgage_leads",
    rolePermissions: { crm: true, admin: true, dashboard: true }, isDemoMode: false, ...patch };
  let location = initialPath, signOuts = 0;
  const navigations: string[] = [];
  const effects: (() => void)[] = [];
  const exports: Record<string, any> = {};
  const privatePage = () => null;
  script.runInNewContext({ exports, workspaceAllowsRoute: routeExports.workspaceAllowsRoute,
    useAuth: () => ({ ...auth, signOut: () => { signOuts++; } }),
    useLocation: () => [location, (next: string) => { location = next; navigations.push(next); }],
    useEffect: (effect: () => void) => effects.push(effect),
    DemoPlaceholder: "DemoPlaceholder",
    require(name: string) {
      assert.equal(name, "react/jsx-runtime");
      const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
      return { jsx, jsxs: jsx };
    },
  });
  const api = {
    render(permission = location === "/admin" ? "admin" : "crm") {
      effects.length = 0;
      const tree = exports.ProtectedPage({ component: privatePage, permission }) as Tree;
      for (const effect of effects) effect();
      return tree;
    },
    change(next: Partial<Auth>) { auth = { ...auth, ...next }; },
    navigate(next: string) { location = next; },
    location: () => location,
    navigations,
    signOuts: () => signOuts,
    privatePage,
  };
  return api;
}

test("unsupported mortgage roles settle on a denial instead of a Landing -> leads redirect loop", () => {
  for (const role of ["manager", "receptionist", "doctor", "marketer", "agent", "booking_agent", null]) {
    for (const entry of ["/leads", "/admin"]) {
      const app = fixture({ userRole: role }, entry);
      for (let render = 0; render < 12; render++) {
        const tree = app.render();
        assert.ok(nodes(tree).some((node) => node.type === "h1"), String(role));
        assert.ok(!nodes(tree).some((node) => node.type === app.privatePage));
        assert.equal(app.location(), entry);
      }
      assert.deepEqual(app.navigations, [], String(role));
      const exit = nodes(app.render()).find((node) => node.type === "button")!;
      assert.equal(exit.props.children, "Выйти");
      exit.props.onClick();
      assert.equal(app.signOuts(), 1);
    }
  }
});

test("allowed mortgage roles still render their own-work routes", () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    for (const entry of ["/dashboard", "/leads", "/clients", "/appointments", "/booking", "/tasks"]) {
      const app = fixture({ userRole: role }, entry);
      assert.equal(app.render()?.type, app.privatePage, `${role}: ${entry}`);
      assert.deepEqual(app.navigations, []);
    }
  }
});

test("lead-manager admin, analytics and ad URLs stay denied before one purpose-specific fallback", () => {
  for (const purpose of ["mortgage_leads", "clinic_services", "marketing"] as const) {
    for (const [entry, permission] of [["/admin", "admin"], ["/analytics", "crm"],
      ["/ads", "ads"], ["/ads-automation", "ads"]]) {
      const manager = fixture({ workspacePurpose: purpose, userRole: "lead_manager",
        rolePermissions: { crm: true, admin: true, dashboard: true, ads: true } }, entry);
      assert.equal(manager.render(permission), null, `${purpose}: ${entry} must not render before redirect`);
      const target = purpose === "mortgage_leads" ? "/dashboard" : "/leads";
      assert.equal(manager.location(), target);
      assert.equal(manager.render()?.type, manager.privatePage);
      assert.deepEqual(manager.navigations, [target]);
    }
  }
});

test("guests cannot render private routes in any workspace profile", () => {
  for (const purpose of ["mortgage_leads", "clinic_services", "marketing", null] as const) {
    for (const [entry, permission] of [["/dashboard", "dashboard"], ["/leads", "crm"],
      ["/admin", "admin"], ["/ads", "ads"]]) {
      const guest = fixture({ workspacePurpose: purpose, userRole: null, rolePermissions: {} }, entry);
      for (let render = 0; render < 3; render++) {
        assert.ok(!nodes(guest.render(permission)).some((node) => node.type === guest.privatePage),
          `${purpose}: ${entry}`);
      }
      assert.ok(guest.navigations.length <= 1, "guest denial must not create a redirect loop");
    }
  }
});

test("loading and unverified purposes never render the denied private component", () => {
  const loading = fixture({ isLoading: true });
  assert.equal(loading.render(), null);
  assert.deepEqual(loading.navigations, []);
  const pending = fixture({ workspacePurpose: null });
  assert.equal(pending.render(), null);
  assert.ok(!nodes(pending.render()).some((node) => node.type === pending.privatePage));
});

test("role revocation and restoration change the first render without stale private UI", () => {
  const app = fixture({ userRole: "admin" });
  assert.equal(app.render()?.type, app.privatePage);
  app.change({ userRole: "manager" });
  assert.ok(nodes(app.render()).some((node) => node.type === "h1"));
  assert.deepEqual(app.navigations, []);
  app.change({ userRole: "lead_manager" });
  assert.equal(app.render()?.type, app.privatePage);
  app.change({ workspacePurpose: "clinic_services", userRole: "manager" });
  assert.equal(app.render()?.type, app.privatePage);
});

test("existing clinic and marketing role access is not restricted by the mortgage denial", () => {
  for (const purpose of ["clinic_services", "marketing"] as const) {
    const app = fixture({ workspacePurpose: purpose, userRole: "manager" }, "/admin");
    assert.equal(app.render()?.type, app.privatePage);
    assert.deepEqual(app.navigations, []);
  }
});

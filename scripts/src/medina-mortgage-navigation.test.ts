import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the navigation and shared route policy without a DOM, auth or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Surface = "Sidebar" | "MobileNav";
type Purpose = "clinic_services" | "marketing" | "mortgage_leads" | null;
type Node = { type: unknown; props: Record<string, any>; key?: unknown };
type Auth = {
  user: { id: string; email: string; user_metadata: { full_name: string } } | null;
  clinicId: string | null;
  userRole: string | null;
  workspacePurpose: Purpose;
  rolePermissions: Record<string, boolean>;
  vertical: string;
  availableWorkspaces: { id: string }[];
};
const surfaces: Surface[] = ["Sidebar", "MobileNav"];
const compiled: Record<string, Script> = {};
function compile(source: string) {
  return new Script(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText);
}
function evaluate(code: Script, imports: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  code.runInNewContext({ exports, require(name: string) {
    if (name in imports) return imports[name];
    if (name === "react/jsx-runtime") return {
      jsx: (type: unknown, props: Node["props"], key?: unknown) => ({ type, props, key }),
      jsxs: (type: unknown, props: Node["props"], key?: unknown) => ({ type, props, key }),
      Fragment: "Fragment",
    };
    if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => String(key) });
    throw new Error(`Unmocked import: ${name}`);
  } });
  return exports;
}
for (const surface of surfaces) {
  const file = `artifacts/negis/src/components/layout/${surface}.tsx`;
  compiled[surface] = compile(await readFile(path.join(root, file), "utf8"));
  compiled[`${surface}:previous`] = compile(execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, encoding: "utf8" }));
}
const terms = evaluate(compile(await readFile(path.join(root, "lib/vertical/terms.ts"), "utf8")));
const { workspaceAllowsRoute } = evaluate(compile(await readFile(path.join(root, "artifacts/negis/src/lib/workspaceRoutes.ts"), "utf8"))) as {
  workspaceAllowsRoute: (purpose: Purpose, role: string | null, href: string) => boolean;
};
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
function setup(surface: Surface, patch: Partial<Auth> = {}, previous = false, allow = workspaceAllowsRoute) {
  let auth: Auth = {
    user: { id: "account-a", email: "local@example.test", user_metadata: { full_name: "Local staff" } },
    clinicId: "workspace-a", userRole: "owner", workspacePurpose: "mortgage_leads",
    rolePermissions: {}, vertical: "clinic", availableWorkspaces: [], ...patch,
  };
  const states: any[] = [];
  const effects: { deps?: unknown[]; run: () => void; pending: boolean }[] = [];
  const policyCalls: { purpose: Purpose; role: string | null; href: string }[] = [];
  const navigations: string[] = [];
  let cursor = 0, dirty = true, tree: any, location = "/leads", signOuts = 0, switches = 0;
  const hooks = {
    useState(initial: unknown) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
      return [states[slot], (next: any) => {
        const value = typeof next === "function" ? next(states[slot]) : next;
        if (!Object.is(states[slot], value)) { states[slot] = value; dirty = true; }
      }];
    },
    useLayoutEffect(run: () => void, deps?: unknown[]) {
      const slot = cursor++;
      const old = effects[slot];
      const unchanged = old?.deps && deps && old.deps.length === deps.length
        && old.deps.every((value, index) => Object.is(value, deps[index]));
      effects[slot] = { deps, run, pending: !unchanged };
    },
  };
  const module = evaluate(compiled[previous ? `${surface}:previous` : surface], {
    react: hooks,
    wouter: { Link: "Link", useLocation: () => [location, (href: string) => { location = href; navigations.push(href); }] },
    "@/contexts/AuthContext": { useAuth: () => ({ ...auth,
      signOut: () => { signOuts++; }, clearWorkspaceSelection: () => { switches++; },
    }) },
    "@/lib/workspaceRoutes": { workspaceAllowsRoute(purpose: Purpose, role: string | null, href: string) {
      policyCalls.push({ purpose, role, href }); return allow(purpose, role, href);
    } },
    "@/lib/demoStorage": { isRealWorkspace: () => true },
    "../../../../../lib/vertical/terms": terms,
    "../../../../../lib/auth/staff-logins": { loginFromEmail: () => "local-staff" },
    "./ProfileDialog": { ProfileDialog: "ProfileDialog" },
  });
  const fixture = {
    paint() {
      for (let pass = 0; pass < 10 && dirty; pass++) {
        dirty = false; cursor = 0; tree = module[surface]();
        for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.run(); }
      }
      assert.equal(dirty, false, "layout resets must settle before paint");
    },
    change(next: Partial<Auth>) { auth = { ...auth, ...next }; dirty = true; fixture.paint(); },
    nodes: () => nodes(tree),
    text: () => label(tree),
    button(name: string) {
      const button = fixture.nodes().find((node) => node.type === "button"
        && (label(node.props.children) === name || node.props["aria-label"] === name));
      assert.ok(button, `missing button: ${name}`); return button;
    },
    click(name: string) { fixture.button(name).props.onClick(); fixture.paint(); },
    openDrawer() { if (surface === "MobileNav") fixture.click("Ещё"); },
    hasDrawer: () => fixture.nodes().some((node) => node.props.className === "mobile-nav-sheet"),
    hasProfile: () => fixture.nodes().some((node) => node.type === "ProfileDialog"),
    routes() {
      const routes: { href: string; label: string }[] = [];
      for (const node of fixture.nodes()) {
        if (node.type === "Link") routes.push({ href: node.props.href, label: label(node) });
        else if (node.type === "button" && /mobile-(bottom-nav-item|nav-drawer-item)/.test(node.props.className ?? "")
          && !["Ещё", "Профиль и пароль"].includes(label(node))) {
          const start = navigations.length;
          node.props.onClick();
          if (navigations.length > start) routes.push({ href: navigations.at(-1)!, label: label(node) });
        }
      }
      return routes.sort((a, b) => a.href.localeCompare(b.href));
    },
    policyCalls, signOuts: () => signOuts, switches: () => switches,
  };
  fixture.paint();
  return fixture;
}

test("mortgage menus expose leads and team only to the agreed roles", () => {
  for (const surface of surfaces) {
    for (const role of ["owner", "admin", "lead_manager", "manager", "receptionist", "doctor", "marketer", "agent", "booking_agent", null]) {
      const fixture = setup(surface, { userRole: role, rolePermissions: { crm: true, admin: true, booking: true, ads: true } });
      fixture.openDrawer();
      const expected = role === "owner" || role === "admin"
        ? [{ href: "/admin", label: "Команда" }, { href: "/leads", label: "Заявки" }]
        : role === "lead_manager" ? [{ href: "/leads", label: "Заявки" }] : [];
      assert.deepEqual(fixture.routes(), expected, `${surface}: ${role}`);
      assert.ok(fixture.policyCalls.length > 0);
      assert.ok(fixture.policyCalls.every((call) => call.purpose === "mortgage_leads" && call.role === role));
      if (surface === "Sidebar") {
        assert.match(fixture.text(), /Ипотечные заявки/);
        assert.doesNotMatch(fixture.text(), /Медицинская CRM/);
      }
    }
  }
});

test("a null workspace purpose fails closed even with owner or broad permissions", () => {
  for (const surface of surfaces) for (const role of ["owner", "admin", "lead_manager", null]) {
    const fixture = setup(surface, { workspacePurpose: null, userRole: role, rolePermissions: { crm: true, admin: true } });
    fixture.openDrawer();
    assert.deepEqual(fixture.routes(), [], `${surface}: ${role}`);
  }
});

test("clinic, salon and marketing route sets and labels retain existing role and permission checks", () => {
  for (const surface of surfaces) for (const purpose of ["clinic_services", "marketing"] as const) {
    for (const vertical of ["clinic", "beauty", "dental"]) {
      for (const role of ["owner", "admin", "manager", "lead_manager", "receptionist", "doctor", "marketer", "agent", "booking_agent", null]) {
        const permissionSets: Record<string, boolean>[] = [{}, { crm: true, booking: true, directory: true }, { dashboard: true, ads: true, marketplace: true }];
        for (const permissions of permissionSets) {
          const patch = { workspacePurpose: purpose, vertical, userRole: role, rolePermissions: permissions };
          const current = setup(surface, patch), previous = setup(surface, patch, true);
          current.openDrawer(); previous.openDrawer();
          assert.deepEqual(current.routes(), previous.routes(), `${surface}: ${purpose}/${vertical}/${role}`);
        }
      }
    }
  }
});

test("purpose allow cannot override existing restrictions and purpose deny wins for owners", () => {
  for (const surface of surfaces) {
    const restricted = setup(surface, { userRole: "lead_manager" }, false, () => true);
    restricted.openDrawer();
    assert.deepEqual(restricted.routes(), [{ href: "/leads", label: "Заявки" }]);
    const denied = setup(surface, {}, false, () => false);
    denied.openDrawer();
    assert.deepEqual(denied.routes(), []);
  }
});

const contextChanges: Partial<Auth>[] = [
  { user: { id: "account-b", email: "second@example.test", user_metadata: { full_name: "Second staff" } } },
  { user: null }, { clinicId: "workspace-b" }, { clinicId: null },
  { userRole: "admin" }, { userRole: null }, { workspacePurpose: "clinic_services" }, { workspacePurpose: null },
];
test("mobile drawer closes on account, workspace, role or purpose change, including return to A", () => {
  for (const change of contextChanges) {
    const fixture = setup("MobileNav");
    fixture.openDrawer(); assert.equal(fixture.hasDrawer(), true);
    fixture.change(change); assert.equal(fixture.hasDrawer(), false);
    fixture.change({ user: { id: "account-a", email: "local@example.test", user_metadata: { full_name: "Local staff" } },
      clinicId: "workspace-a", userRole: "owner", workspacePurpose: "mortgage_leads" });
    assert.equal(fixture.hasDrawer(), false);
  }
});

test("profile/password dialog unmounts on context change on both surfaces and can be reopened", () => {
  for (const surface of surfaces) for (const change of contextChanges) {
    const fixture = setup(surface);
    const open = () => {
      fixture.openDrawer(); fixture.click(surface === "MobileNav" ? "Профиль и пароль" : "Открыть профиль");
    };
    open(); assert.equal(fixture.hasProfile(), true); assert.equal(fixture.hasDrawer(), false);
    fixture.change(change); assert.equal(fixture.hasProfile(), false);
    open(); assert.equal(fixture.hasProfile(), true);
    fixture.nodes().find((node) => node.type === "ProfileDialog")!.props.onClose();
    fixture.paint(); assert.equal(fixture.hasProfile(), false);
  }
});

test("unchanged identity preserves overlays", () => {
  for (const surface of surfaces) {
    const fixture = setup(surface, { availableWorkspaces: [{ id: "workspace-a" }, { id: "workspace-b" }] });
    fixture.openDrawer();
    fixture.change({ user: { id: "account-a", email: "local@example.test", user_metadata: { full_name: "Updated name" } } });
    if (surface === "MobileNav") assert.equal(fixture.hasDrawer(), true);
    fixture.click(surface === "MobileNav" ? "Профиль и пароль" : "Открыть профиль");
    fixture.change({ rolePermissions: { crm: true } }); assert.equal(fixture.hasProfile(), true);
  }
});

test("workspace switch terminology changes only for mortgage and still requires multiple workspaces", () => {
  for (const purpose of ["mortgage_leads", "clinic_services", "marketing"] as const) {
    const name = purpose === "mortgage_leads" ? "Сменить пространство" : "Сменить клинику";
    const fixture = setup("Sidebar", { workspacePurpose: purpose,
      availableWorkspaces: [{ id: "workspace-a" }, { id: "workspace-b" }] });
    assert.equal(fixture.button(name).props.title, name);
    fixture.click(name); assert.equal(fixture.switches(), 1);
    fixture.change({ availableWorkspaces: [{ id: "workspace-a" }] });
    assert.equal(fixture.nodes().some((node) => node.props["aria-label"] === name), false);
  }
});

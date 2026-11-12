import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Whole actual MobileNav, workspace route policy and vertical labels. Hooks,
// Auth, router, ProfileDialog boundary and focusable DOM nodes are isolated fakes.
// This is deterministic component/event coverage, not browser or ProfileDialog QA.
// SDK events are shared with the actual AuthProvider below; renders can be withheld.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-mobile-nav-lifetime.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const componentFile = "artifacts/negis/src/components/layout/MobileNav.tsx";
class StaleAuthIntentError extends Error { name = "StaleAuthIntentError"; }
function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, { fileName, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }, transformers: { before: [context => {
    const visit: import("typescript").Visitor = node => {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createObjectLiteralExpression([
          ts.factory.createPropertyAssignment("env", ts.factory.createObjectLiteralExpression([])),
        ]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
  }] } });
  assert.deepEqual(result.diagnostics ?? [], [], `${fileName} must transpile`);
  return result.outputText;
}
function evaluate(code: string, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({ exports, Error, AbortController, setTimeout, clearTimeout, ...globals, require(name: string) {
    assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
    return imports[name];
  } }, { timeout: 1000 });
  return exports;
}
const code = compile(await readFile(path.join(root, componentFile), "utf8"), componentFile);
const routes = evaluate(compile(await readFile(path.join(root, "artifacts/negis/src/lib/workspaceRoutes.ts"), "utf8"), "workspaceRoutes.ts"));
const terms = evaluate(compile(await readFile(path.join(root, "lib/vertical/terms.ts"), "utf8"), "terms.ts"));
const authCode = compile(await readFile(path.join(root, "artifacts/negis/src/contexts/AuthContext.tsx"), "utf8"), "AuthContext.tsx");
const signOutCode = compile(await readFile(path.join(root, "artifacts/negis/src/lib/authSignOut.ts"), "utf8"), "authSignOut.ts");
const permissions = evaluate(compile(await readFile(path.join(root, "artifacts/negis/src/lib/permissions.ts"), "utf8"), "permissions.ts"));
const purposes = evaluate(compile(await readFile(path.join(root, "lib/crm/workspace-purpose.ts"), "utf8"), "workspace-purpose.ts"), { "../vertical/terms": terms });
const bounded = { timeout: 5_000 };
type Props = Record<string, any>;
type Node = { type: unknown; props: Props; key?: string; host?: Host };
type Effect = { create: () => void | (() => void); deps?: unknown[]; pending: boolean; cleanup?: () => void };
type Auth = { user: { id: string } | null; clinicId: string | null; userRole: string | null;
  rolePermissions: Record<string, boolean>; vertical: string; workspacePurpose: string | null;
  isSigningOut: boolean; isImpersonation: boolean };
type AuthModule = { useAuth(): Auth & { signOut(): Promise<void> };
  onAuthStateChange?(listener: (event: string, session: { user: { id: string } } | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
};
function elements(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return value?.props ? [value, ...elements(value.props.children)] : [];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  return value?.props ? text(value.props.children) : value == null ? "" : String(value);
}
class Host {
  isConnected = true;
  ownerDocument: any;
  node!: Node;
  children: Host[] = [];
  constructor(private focusNode: (node: Host) => void) {}
  focus() { assert.ok(this.isConnected, "Do not focus an unmounted old account node"); this.focusNode(this); }
  contains(node: Host): boolean { return this === node || this.children.some(child => child.contains(node)); }
  closest() { return null; }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Host[] {
    assert.match(selector, /button/, "The actual drawer contains only native button controls");
    const buttons = (node: Host): Host[] => node.children.flatMap(child => [child, ...buttons(child)]);
    return buttons(this).filter(child => child.node.type === "button" && !child.node.props.disabled && child.node.props.tabIndex !== -1);
  }
}
function fixture(t: TestContext, patch: Partial<Auth> = {}, authModule?: AuthModule) {
  let auth: Auth = { user: { id: "synthetic-A" }, clinicId: "synthetic-workspace-A", userRole: "owner",
    rolePermissions: {}, vertical: "clinic", workspacePurpose: "clinic_services", isSigningOut: false, isImpersonation: false, ...patch };
  const navigations: string[] = [], signOutActors: Array<string | null> = [], focusEvents: Array<string | null> = [];
  const slots: any[] = [], effects: Effect[] = [], hosts = new Map<string, Host>();
  const refs = new Set<{ current: unknown }>();
  const style = () => {
    const values = new Map<string, { value: string; priority: string }>([["overflow", { value: "auto", priority: "" }]]);
    return { get overflow() { return values.get("overflow")?.value ?? ""; },
      getPropertyValue: (key: string) => values.get(key)?.value ?? "",
      getPropertyPriority: (key: string) => values.get(key)?.priority ?? "",
      setProperty(key: string, value: string, priority: string) { values.set(key, { value, priority }); },
      removeProperty(key: string) { values.delete(key); } };
  };
  const listeners = new Map<string, Set<(event: any) => void>>();
  const document = { activeElement: null as Host | null, body: { style: style(), children: [] },
    documentElement: { style: style() },
    defaultView: { scrollX: 0, scrollY: 0, scrollTo() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      MutationObserver: class { observe() {} disconnect() {} },
    },
    addEventListener(key: string, listener: (event: any) => void) { if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key)!.add(listener); },
    removeEventListener(key: string, listener: (event: any) => void) { listeners.get(key)?.delete(listener); },
  };
  let cursor = 0, tree: Node, dirty = false, writes = 0, mounted = true;
  const jsx = (type: unknown, props: Props, key?: string): Node => ({ type, props, key });
  function effect(create: Effect["create"], deps?: unknown[]) {
    const index = cursor++;
    let item: Effect = slots[index];
    if (!item) { item = { create, deps, pending: true }; slots[index] = item; effects.push(item); }
    else {
      if (!deps || !item.deps || deps.length !== item.deps.length || deps.some((value, i) => !Object.is(value, item.deps![i]))) item.pending = true;
      item.create = create; item.deps = deps;
    }
  }
  function commit(value: any, position = "root"): Host[] {
    if (Array.isArray(value)) return value.flatMap((item, index) => commit(item, `${position}.${item?.key ?? index}`));
    if (!value?.props) return [];
    const node = value as Node;
    if (typeof node.type !== "string") return commit(node.props.children, `${position}.children`);
    let host = hosts.get(position);
    if (!host) { host = new Host(node => { document.activeElement = node; focusEvents.push(auth.user?.id ?? null);
      for (const listener of listeners.get("focusin") ?? []) listener({ target: node });
    }); host.ownerDocument = document; hosts.set(position, host); }
    host.node = node; host.isConnected = true; node.host = host;
    host.children = commit(node.props.children, `${position}.children`);
    if (node.props.ref) { assert.equal(typeof node.props.ref, "object"); node.props.ref.current = host; refs.add(node.props.ref); }
    return [host];
  }
  const Profile = () => null;
  const actual = evaluate(code, {
    react: { useLayoutEffect: effect, useEffect: effect,
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
        const state = slots[index];
        return [state.value, (next: any) => {
          writes++; const value = typeof next === "function" ? next(state.value) : next;
          if (!Object.is(value, state.value)) { state.value = value; dirty = true; }
        }];
      },
      useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol("Fragment") },
    "react-dom": { createPortal: (children: unknown) => children },
    wouter: { useLocation: () => ["/leads", (href: string) => navigations.push(href)] },
    "lucide-react": Object.fromEntries(["BadgeDollarSign", "BarChart2", "CalendarDays", "Clapperboard", "FileText", "ClipboardList",
      "LayoutDashboard", "MessageCircle", "Megaphone", "Menu", "PhoneCall", "Rocket", "Settings", "Store", "Tag", "User", "Users", "X", "LogOut"].map(name => [name, () => null])),
    "@/contexts/AuthContext": authModule ?? { useAuth: () => ({ ...auth, signOut: async () => { signOutActors.push(auth.user?.id ?? null); } }) },
    "@/lib/supabase": { hasSupabaseFrontendEnv: !!authModule?.onAuthStateChange,
      supabase: { auth: { onAuthStateChange: authModule?.onAuthStateChange } },
      sessionAuth: { onAuthStateChange: authModule?.onAuthStateChange } },
    "@/lib/workspaceRoutes": routes,
    "../../../../../lib/vertical/terms": terms,
    "./ProfileDialog": { ProfileDialog: Profile },
  }, { document });
  function render(runEffects = true) {
    assert.ok(mounted);
    for (let pass = 0; pass < 12; pass++) {
      dirty = false; cursor = 0;
      tree = actual.MobileNav();
      for (const host of hosts.values()) host.isConnected = false;
      for (const ref of refs) ref.current = null;
      commit(tree);
      if (document.activeElement && !document.activeElement.isConnected) document.activeElement = null;
      if (runEffects) {
        const pending = effects.filter(item => item.pending);
        for (const item of pending) item.cleanup?.();
        for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
      }
      if (!dirty || !runEffects) return tree;
    }
    assert.fail("Unbounded layout-effect updates");
  }
  function find(predicate: (node: Node) => boolean) { const node = elements(tree).find(predicate); assert.ok(node, "Expected actual component control"); return node; }
  function button(label: string) { return find(node => node.type === "button" && (node.props["aria-label"] === label || text(node.props.children) === label)); }
  function route(href: string) { return find(node => node.type === "button" && node.key === href); }
  function click(node: Node) { node.props.onClick(); render(); }
  function open() { click(button("Ещё разделы")); }
  function close() { if (!mounted) return; mounted = false; for (const item of effects) item.cleanup?.(); for (const host of hosts.values()) host.isConnected = false; }
  t.after(close); render();
  return { button, route, open, render, click, close, navigations, signOutActors, focusEvents, document,
    change(patch: Partial<Auth>, runEffects = true) { auth = { ...auth, ...patch }; render(runEffects); },
    mutatePermissions(value: Record<string, boolean>) { Object.assign(auth.rolePermissions, value); render(); },
    writes: () => writes,
    needsRender: () => dirty,
    sheet: () => find(node => node.type === "section" && node.props.className === "mobile-nav-sheet"),
    backdrop: () => find(node => node.type === "div" && node.props.className === "mobile-nav-backdrop lg:hidden"),
    hasSheet: () => elements(tree).some(node => node.type === "section" && node.props.className === "mobile-nav-sheet"),
    profile: () => elements(tree).find(node => node.type === Profile),
    routes: () => elements(tree).filter(node => node.type === "button" && node.key?.startsWith("/")).map(node => node.key!),
  };
}

for (const [label, patch, expected] of [
  ["clinic owner", {}, ["/leads", "/appointments", "/clients", "/sales", "/admin", "/content-studio"]],
  ["clinic doctor", { userRole: "doctor", rolePermissions: { booking: true, crm: false } }, ["/appointments", "/services", "/client-base"]],
  ["clinic lead manager", { userRole: "lead_manager", rolePermissions: { crm: true } }, ["/leads"]],
  ["mortgage owner", { workspacePurpose: "mortgage_leads" }, ["/dashboard", "/leads", "/appointments", "/tasks", "/clients", "/analytics", "/admin"]],
  ["mortgage lead manager", { workspacePurpose: "mortgage_leads", userRole: "lead_manager" }, ["/dashboard", "/leads", "/appointments", "/tasks", "/clients"]],
] as Array<[string, Partial<Auth>, string[]]>) {
  test(`actual MobileNav permits current ${label} route controls and navigation`, bounded, t => {
    const f = fixture(t, patch); f.open();
    for (const href of expected) assert.ok(f.routes().includes(href), href);
    if (label.includes("doctor") || label.includes("lead manager")) {
      assert.deepEqual(f.routes().sort(), [...expected].sort(), "No privileged controls leak into a restricted role");
    }
    const href = expected[0]; f.click(f.route(href)); assert.deepEqual(f.navigations, [href]);
  });
}

const switches: Array<[string, Partial<Auth>]> = [
  ["account", { user: { id: "synthetic-B" } }], ["workspace", { clinicId: "synthetic-workspace-B" }],
  ["role", { userRole: "doctor", rolePermissions: { booking: true } }],
  ["purpose", { workspacePurpose: "mortgage_leads" }], ["permission", { rolePermissions: { crm: false } }],
  ["sign-out pending", { isSigningOut: true }], ["signed out", { user: null }],
  ["impersonation", { isImpersonation: true }],
];
for (const [label, patch] of switches) {
  test(`MobileNav ${label} switch closes local UI and refuses captured navigation/profile/logout callbacks`, bounded, t => {
    const f = fixture(t); f.open();
    const callbacks = [f.route("/leads"), f.route("/admin"), f.button("Профиль и пароль"), f.button("Выйти"),
      f.button("Ещё разделы"), f.button("Закрыть меню")].map(node => node.props.onClick);
    f.change(patch);
    assert.equal(f.hasSheet(), false); assert.equal(f.profile(), undefined);
    const writes = f.writes(), focus = f.focusEvents.length;
    for (const callback of callbacks) callback();
    f.render();
    assert.deepEqual(f.navigations, []); assert.deepEqual(f.signOutActors, []);
    assert.equal(f.hasSheet(), false); assert.equal(f.profile(), undefined);
    assert.equal(f.writes(), writes, "Captured handlers cannot write into the next context");
    assert.equal(f.focusEvents.length, focus, "Captured close cannot move the next actor's focus");
  });
}

test("MobileNav render-observed A-to-B-to-A never revives a captured first-A handler", bounded, t => {
  const f = fixture(t); f.open();
  const old = [f.route("/leads"), f.route("/admin"), f.button("Профиль и пароль"), f.button("Выйти")].map(node => node.props.onClick);
  f.change({ user: { id: "synthetic-B" } }); f.change({ user: { id: "synthetic-A" } });
  const writes = f.writes(); for (const callback of old) callback(); f.render();
  assert.deepEqual(f.navigations, []); assert.deepEqual(f.signOutActors, []); assert.equal(f.profile(), undefined);
  assert.equal(f.writes(), writes);
  f.click(f.route("/leads")); assert.deepEqual(f.navigations, ["/leads"], "Fresh A remains usable");
});

test("MobileNav stale handlers are refused after the next render even before its layout effects", bounded, t => {
  const f = fixture(t); f.open(); const old = f.button("Выйти").props.onClick;
  f.change({ user: { id: "synthetic-B" } }, false); old();
  assert.deepEqual(f.signOutActors, []); f.render();
});

test("MobileNav in-place permission revocation invalidates old controls while fresh permitted routes still work", bounded, t => {
  const f = fixture(t, { userRole: "doctor", rolePermissions: { booking: true, crm: true } });
  const old = f.route("/clients").props.onClick;
  f.mutatePermissions({ crm: false }); old();
  assert.deepEqual(f.navigations, []); assert.ok(!f.routes().includes("/clients"));
  f.click(f.route("/appointments")); assert.deepEqual(f.navigations, ["/appointments"]);
});

test("MobileNav profile is unmounted on context change and its old close cannot dismiss a new profile", bounded, t => {
  const f = fixture(t); f.open(); f.click(f.button("Профиль и пароль"));
  const oldClose = f.profile()!.props.onClose;
  assert.equal(f.hasSheet(), false);
  f.change({ clinicId: "synthetic-workspace-B" }); assert.equal(f.profile(), undefined);
  f.open(); f.click(f.button("Профиль и пароль")); oldClose(); f.render();
  assert.ok(f.profile(), "Old dialog callback cannot close the new workspace's profile");
  f.profile()!.props.onClose(); f.render(); assert.equal(f.profile(), undefined);
});

test("MobileNav current logout dispatches only once to the current account and closes the drawer", bounded, t => {
  const f = fixture(t); f.open(); f.click(f.button("Выйти"));
  assert.deepEqual(f.signOutActors, ["synthetic-A"]); assert.equal(f.hasSheet(), false);
});

test("MobileNav current permitted drawer route navigates and closes without changing profile or signing out", bounded, t => {
  const f = fixture(t); f.open(); f.click(f.route("/admin"));
  assert.deepEqual(f.navigations, ["/admin"]); assert.equal(f.hasSheet(), false);
  assert.equal(f.profile(), undefined); assert.deepEqual(f.signOutActors, []);
});

test("MobileNav fresh B profile and logout controls remain usable after an account switch", bounded, t => {
  const f = fixture(t); f.open(); f.change({ user: { id: "synthetic-B" } });
  f.open(); f.click(f.button("Профиль и пароль")); assert.ok(f.profile());
  f.profile()!.props.onClose(); f.render(); assert.equal(f.profile(), undefined);
  f.open(); f.click(f.button("Выйти")); assert.deepEqual(f.signOutActors, ["synthetic-B"]);
});

test("MobileNav unmount refuses every captured handler without state, navigation, logout or focus writes", bounded, t => {
  const f = fixture(t); f.open();
  const old = [f.route("/leads"), f.route("/admin"), f.button("Профиль и пароль"), f.button("Выйти"), f.button("Закрыть меню")].map(node => node.props.onClick);
  f.close(); const writes = f.writes(), focus = f.focusEvents.length; for (const callback of old) callback();
  assert.equal(f.writes(), writes); assert.equal(f.focusEvents.length, focus);
  assert.deepEqual(f.navigations, []); assert.deepEqual(f.signOutActors, []);
});

test("MobileNav unmounted profile close cannot write state", bounded, t => {
  const f = fixture(t); f.open(); f.click(f.button("Профиль и пароль")); const close = f.profile()!.props.onClose;
  f.close(); const writes = f.writes(); close(); assert.equal(f.writes(), writes);
});

function keyEvent(key: string, shiftKey = false) {
  let prevented = false;
  return { key, shiftKey, preventDefault() { prevented = true; }, isPrevented: () => prevented };
}
test("MobileNav drawer labels its modal dialog and enters button focus", bounded, t => {
  const f = fixture(t); const more = f.button("Ещё разделы"); more.host!.focus(); f.open();
  const sheet = f.sheet();
  assert.equal(sheet.props.role, "dialog"); assert.equal(sheet.props["aria-modal"], "true");
  assert.equal(f.button("Ещё разделы").props["aria-expanded"], true);
  assert.ok(sheet.host!.contains(f.document.activeElement!), "Opening moves focus to a drawer button");
});

test("MobileNav contains programmatic focus and locks scrolling only while open", bounded, t => {
  const f = fixture(t); f.open(); const background = f.route("/leads");
  assert.equal(f.document.body.style.overflow, "hidden");
  background.host!.focus();
  assert.notEqual(f.document.activeElement, background.host);
  assert.equal(f.sheet().host!.contains(f.document.activeElement!), true);
  f.click(f.button("Закрыть меню"));
  assert.equal(f.document.body.style.overflow, "auto");
});

test("MobileNav Escape closes the drawer and restores focus to its More trigger", bounded, t => {
  const f = fixture(t); f.open(); const event = keyEvent("Escape");
  assert.equal(typeof f.sheet().props.onKeyDown, "function"); f.sheet().props.onKeyDown(event); f.render();
  assert.equal(event.isPrevented(), true); assert.equal(f.hasSheet(), false);
  assert.equal(f.document.activeElement, f.button("Ещё разделы").host);
});

for (const dismissal of ["close button", "backdrop"] as const) {
  test(`MobileNav ${dismissal} restores focus without dispatching navigation or account actions`, bounded, t => {
    const f = fixture(t); f.open(); f.click(dismissal === "close button" ? f.button("Закрыть меню") : f.backdrop());
    assert.equal(f.hasSheet(), false); assert.equal(f.document.activeElement, f.button("Ещё разделы").host);
    assert.deepEqual(f.navigations, []); assert.deepEqual(f.signOutActors, []);
  });
}

test("MobileNav Tab and Shift-Tab wrap within the drawer without intercepting an interior Tab", bounded, t => {
  const f = fixture(t); f.open(); const sheet = f.sheet(), buttons = sheet.host!.querySelectorAll("button:not([disabled])");
  assert.equal(typeof sheet.props.onKeyDown, "function"); assert.ok(buttons.length > 2);
  buttons.at(-1)!.focus(); const forward = keyEvent("Tab"); sheet.props.onKeyDown(forward);
  assert.equal(forward.isPrevented(), true); assert.equal(f.document.activeElement, buttons[0]);
  const backward = keyEvent("Tab", true); sheet.props.onKeyDown(backward);
  assert.equal(backward.isPrevented(), true); assert.equal(f.document.activeElement, buttons.at(-1));
  buttons[1].focus(); const interior = keyEvent("Tab"); sheet.props.onKeyDown(interior);
  assert.equal(interior.isPrevented(), false);
});

test("MobileNav stale drawer key events cannot restore or trap focus in the next account", bounded, t => {
  const f = fixture(t); f.open(); const old = f.sheet().props.onKeyDown;
  assert.equal(typeof old, "function"); f.change({ user: { id: "synthetic-B" } });
  const focus = f.focusEvents.length, writes = f.writes(); const event = keyEvent("Escape"); old(event); f.render();
  assert.equal(event.isPrevented(), false); assert.equal(f.writes(), writes); assert.equal(f.focusEvents.length, focus);
});

// Run the whole actual AuthProvider with its real SDK subscription callbacks.
// The scheduler can withhold renders; it does not pretend to reproduce React's
// automatic batching or a real SDK. Every auth-context response is synthetic.
function actualAuthProvider(t: TestContext) {
  const slots: any[] = [], effects: Effect[] = [], forbidden: string[] = [];
  const listeners = new Set<(event: string, nextSession: ReturnType<typeof session>) => void>();
  const signOutActors: Array<string | null> = [];
  let actor: string | null = "synthetic-A", cursor = 0, dirty = true, mounted = true;
  let sdkRevision = 0;
  const stamps = new WeakMap<object, { actorId: string | null; revision: number }>();
  let snapshot!: Auth & { signOut(): Promise<void> };
  const storage = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) { values.set(key, value); }, removeItem(key: string) { values.delete(key); } };
  };
  const localStorage = storage(), sessionStorage = storage();
  const window = { localStorage, sessionStorage, location: { search: "", pathname: "/leads", origin: "https://example.invalid" } };
  const signOut = evaluate(signOutCode, {}, { window });
  function session() { return actor ? { user: { id: actor, email: "qa@example.invalid", user_metadata: {} } } : null; }
  function emit(next: string | null) {
    actor = next;
    sdkRevision++;
    for (const listener of listeners) listener(next ? "SIGNED_IN" : "SIGNED_OUT", session());
  }
  function effect(create: Effect["create"], deps?: unknown[]) {
    const index = cursor++;
    let item: Effect = slots[index];
    if (!item) { item = { create, deps, pending: true }; slots[index] = item; effects.push(item); }
    else {
      if (!deps || !item.deps || deps.length !== item.deps.length || deps.some((value, i) => !Object.is(value, item.deps![i]))) item.pending = true;
      item.create = create; item.deps = deps;
    }
  }
  const react = {
    createContext(initial: unknown) { const context: any = { current: initial }; context.Provider = { context }; return context; },
    useContext: (context: { current: unknown }) => context.current,
    useEffect: effect,
    useLayoutEffect: effect,
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const state = slots[index];
      return [state.value, (next: any) => {
        const value = typeof next === "function" ? next(state.value) : next;
        if (!Object.is(state.value, value)) { state.value = value; dirty = true; }
      }];
    },
  };
  const fail = (operation: string): never => { forbidden.push(operation); throw new Error(`Forbidden boundary: ${operation}`); };
  const jsx = (type: unknown, props: Props) => ({ type, props });
  const sdk = {
    onAuthStateChange(listener: Parameters<typeof listeners.add>[0]) {
      listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
    async getSession() { return { data: { session: session() }, error: null }; },
    async signOut() { signOutActors.push(actor); emit(null); return { error: null }; },
  };
  // Synthetic observer/dispatch contract, not native SDK persistence coverage.
  const sessionAuth = {
    onAuthStateChange: sdk.onAuthStateChange,
    capture() {
      const stamp = Object.freeze({ revision: String(sdkRevision), intent: String(sdkRevision) });
      stamps.set(stamp, { actorId: actor, revision: sdkRevision });
      return stamp;
    },
    isCurrent(stamp: unknown) {
      const saved = stamp && typeof stamp === "object" ? stamps.get(stamp) : undefined;
      return Boolean(saved && saved.actorId === actor && saved.revision === sdkRevision);
    },
    signOut(scope: { isCurrent(): boolean; signal?: AbortSignal; expected?: unknown; expectedUserId?: string | null }) {
      assert.equal(typeof scope?.isCurrent, "function", "sessionAuth requires a caller scope");
      assert.equal(scope.isCurrent(), true, "A retired sign-out must not dispatch");
      assert.notEqual(scope.signal?.aborted, true, "An aborted sign-out must not dispatch");
      if ((scope.expected && !sessionAuth.isCurrent(scope.expected))
        || (scope.expectedUserId !== undefined && scope.expectedUserId !== actor)) throw new StaleAuthIntentError();
      return sdk.signOut();
    },
  };
  const actual = evaluate(authCode, {
    react: { ...react, default: react }, "react/jsx-runtime": { jsx, jsxs: jsx },
    // This legacy scheduler is an explicit offline double, not real paint coverage.
    "@/lib/supabase": { supabase: { auth: sdk }, sessionAuth, hasSupabaseFrontendEnv: false },
    "@/lib/authSessionAuthority": { StaleAuthIntentError },
    "@/lib/authSignOut": signOut,
    "../../../../lib/vertical/terms": terms, "../../../../lib/crm/workspace-purpose": purposes,
    "@/lib/permissions": permissions,
    wouter: { useLocation: () => ["/leads", () => {}] }, sonner: { toast: { error() {}, success() {} } },
    "@/lib/demoStorage": { WORKSPACE_SELECTOR_KEY: "negis_workspace_selector", clearListReadCache() {},
      bindWorkspaceReadScope() {}, clearWorkspaceReadScope() {} },
    "@/lib/serverAuth": { async getSupabaseAccessToken(expected: string) { return actor === expected ? `synthetic:${expected}` : ""; } },
    "@/lib/api": { apiUrl: (url: string) => url, clearCrmCache() {},
      async crmFetch(url: string, init: { expectedUserId: string; dispatchGuard(): boolean }) {
        if (url !== "/api/crm/auth-context" || init.expectedUserId !== actor || !init.dispatchGuard()) return fail("unexpected auth-context dispatch");
        return Response.json({ success: true, data: { memberships: [{ workspaceId: "synthetic-workspace-A", role: "owner",
          permissions: [], vertical: "clinic", purpose: "clinic_services" }] } });
      },
    },
  }, { window, localStorage, sessionStorage, URLSearchParams, Response, fetch: () => fail("network") });
  function render() {
    if (!dirty || !mounted) return;
    dirty = false; cursor = 0;
    const node = actual.AuthProvider({ children: null });
    snapshot = node.props.value;
    node.type.context.current = snapshot;
    const pending = effects.filter(item => item.pending);
    for (const item of pending) item.cleanup?.();
    for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
  }
  async function settle(publish = true) {
    for (let pass = 0; pass < 80; pass++) { if (publish) render(); await Promise.resolve(); }
    if (publish) assert.equal(dirty, false, "Synthetic provider must settle");
    assert.deepEqual(forbidden, [], "No real SDK, HTTP, storage or environment is available");
  }
  t.after(() => {
    mounted = false;
    for (const item of effects) item.cleanup?.();
    assert.equal(listeners.size, 0, "Actual provider unsubscribes its fake SDK listener");
    assert.deepEqual(forbidden, []);
  });
  render();
  const module = { ...actual, onAuthStateChange(listener: Parameters<NonNullable<AuthModule["onAuthStateChange"]>>[0]) {
    listeners.add(listener);
    return { data: { subscription: { unsubscribe() { listeners.delete(listener); } } } };
  } } as AuthModule;
  return { module, emit, render, settle, signOutActors, snapshot: () => snapshot };
}

test("actual AuthProvider events: rendered A/B/A invalidates captured MobileNav callbacks", bounded, async t => {
  const auth = actualAuthProvider(t); await auth.settle();
  assert.equal(auth.snapshot().user?.id, "synthetic-A");
  const f = fixture(t, {}, auth.module); f.open();
  const old = [f.route("/leads"), f.button("Профиль и пароль"), f.button("Выйти")].map(node => node.props.onClick);
  auth.emit("synthetic-B"); await auth.settle(); f.render(); assert.equal(auth.snapshot().user?.id, "synthetic-B");
  auth.emit("synthetic-A"); await auth.settle(); f.render();
  for (const callback of old) callback(); f.render(); await auth.settle();
  assert.deepEqual(f.navigations, []); assert.deepEqual(auth.signOutActors, []); assert.equal(f.profile(), undefined);
  f.click(f.route("/leads")); assert.deepEqual(f.navigations, ["/leads"]);
  f.close();
});

test("actual AuthProvider: SDK B before any next render fences captured logout", bounded, async t => {
  const auth = actualAuthProvider(t); await auth.settle();
  const f = fixture(t, {}, auth.module); f.open(); const old = f.button("Выйти").props.onClick;
  auth.emit("synthetic-B"); await auth.settle(false);
  assert.equal(auth.snapshot().user?.id, "synthetic-A", "No new context was published to MobileNav");
  old(); await auth.settle(false);
  assert.deepEqual(auth.signOutActors, [], "Old A control must never log out B before the next render");
  f.close();
});

test("actual AuthProvider: unrendered SDK A/B/A cannot revive old navigation", bounded, async t => {
  const auth = actualAuthProvider(t); await auth.settle();
  const f = fixture(t, {}, auth.module); const old = f.route("/leads").props.onClick;
  auth.emit("synthetic-B"); auth.emit("synthetic-A"); await auth.settle(false);
  assert.equal(f.needsRender(), true, "Closed menu must request its own render even when auth state batches back to A");
  auth.render(); f.render();
  assert.equal(auth.snapshot().user?.id, "synthetic-A");
  old();
  assert.deepEqual(f.navigations, [], "A private SDK boundary must invalidate the original A callback");
  f.click(f.route("/leads"));
  assert.deepEqual(f.navigations, ["/leads"], "Fresh current controls remain usable");
  f.close();
});

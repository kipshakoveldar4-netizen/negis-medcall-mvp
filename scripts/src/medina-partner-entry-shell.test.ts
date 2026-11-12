import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Script } from "node:vm";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = await readFile(fileURLToPath(new URL("../../artifacts/negis/src/components/WorkspacePicker.tsx", import.meta.url)), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function picker(pathname: string, choices = true) {
  const exports: Record<string, any> = {}, effects: string[] = [];
  new Script(compiled).runInNewContext({ exports, require(name: string) {
    if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }),
      jsxs: (type: unknown, props: unknown) => ({ type, props }) };
    if (name === "wouter") return { useLocation: () => [pathname] };
    if (name === "@/contexts/AuthContext") return { useAuth: () => ({ clinicId: null, isLoading: false,
      isDemoMode: false, isImpersonation: false, availableWorkspaces: choices ? [
        { id: "owned-a", name: "Owned A", role: "owner", vertical: "clinic" },
        { id: "owned-b", name: "Owned B", role: "admin", vertical: "clinic" },
      ] : [], selectWorkspace: () => effects.push("selected"), signOut: () => effects.push("signed-out") }) };
    if (name === "@/lib/permissions") return { isStaffRole: () => true };
    if (name === "../../../../lib/vertical/terms") return { staffRoleLabels: () => ({ owner: "Владелец", admin: "Администратор" }) };
    throw Error("Unexpected shell fixture import " + name);
  }, fetch() { throw Error("Shell fixture cannot use network"); } });
  const value = exports.WorkspacePicker(); assert.deepEqual(effects, []);
  return value;
}

for (const route of ["/r/" + "A".repeat(32), "/r/invalid-code", "/r/" + "B".repeat(32) + "/", "/partner-company"]) {
  test(`public attribution ${route} is not covered by a workspace picker`, () => assert.equal(picker(route), null));
}
for (const route of ["/dashboard", "/appointments", "/admin", "/r/", "/r/code/extra", "/r/code?next=/admin", "/r/code\\extra"]) {
  test(`staff/non-entry route ${route} keeps the normal workspace choice`, () => {
    const view = picker(route); assert.equal(view?.props.role, "dialog"); assert.equal(view?.props["aria-label"], "Выбор клиники");
  });
}
test("anonymous and already-unselected visitors are not asked to choose unavailable memberships", () => {
  assert.equal(picker("/dashboard", false), null); assert.equal(picker("/r/" + "A".repeat(32), false), null);
});

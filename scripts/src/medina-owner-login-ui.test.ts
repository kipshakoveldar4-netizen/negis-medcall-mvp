import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Local component simulation only: no browser, real API, auth or password generation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const source = await readFile(path.join(root, "artifacts/medina-control/src/screens/Onboarding.tsx"), "utf8");

type UiNode = { type: unknown; props: Record<string, any> };
function jsx(type: unknown, props: UiNode["props"]): UiNode { return { type, props }; }
function nodes(value: any): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  return [value, ...nodes(value.props.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function evaluate(code: string, imports: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Script(compiled).runInNewContext({ exports, require(name: string) {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    assert.ok(name in imports, `Unmocked import: ${name}`);
    return imports[name];
  } });
  return exports;
}
const logins = evaluate(await readFile(path.join(root, "lib/auth/staff-logins.ts"), "utf8"));

function setup() {
  const slots: any[] = [];
  let cursor = 0;
  let tree: UiNode;
  const requests: { url: string; body: Record<string, unknown>; reply: (body: unknown, status?: number) => void }[] = [];
  const { Onboarding } = evaluate(source, {
    react: {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next: unknown) => { slots[index] = next; }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        return slots[index] ??= { current: initial };
      },
      useEffect() {},
    },
    "../../../../lib/auth/staff-logins": logins,
    "../lib/api": { controlFetch(url: string, init: RequestInit) {
      return new Promise((resolve) => requests.push({ url, body: JSON.parse(String(init.body)),
        reply(body, status = 200) { resolve({ ok: status >= 200 && status < 300, json: async () => body }); },
      }));
    } },
  });
  function render() { cursor = 0; tree = Onboarding({ onDone() {} }); }
  function find(predicate: (node: UiNode) => boolean) {
    const node = nodes(tree).find(predicate);
    assert.ok(node, "Expected UI element");
    return node;
  }
  const field = (id: string) => find((node) => node.props.id === id);
  const button = (label: string) => find((node) => node.type === "button" && text(node) === label);
  render();
  return {
    requests, field, button,
    list: () => nodes(tree), content: () => text(tree),
    change(id: string, value: string) { field(id).props.onChange({ target: { value } }); render(); },
    click(label: string) { button(label).props.onClick(); render(); },
    submit() { find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); render(); },
    async respond(body: unknown, status = 200) {
      assert.ok(requests.length > 0);
      requests.at(-1)!.reply(body, status);
      for (let pass = 0; pass < 12; pass++) await Promise.resolve();
      render();
    },
  };
}
type Ui = ReturnType<typeof setup>;
const fixturePassword = "local-test-password";
function fill(ui: Ui, login?: string) {
  ui.change("ob-name", "Local fixture");
  ui.change("ob-vertical", "beauty");
  if (login === undefined) ui.change("ob-email", "owner@example.test");
  else { ui.click("Логин"); ui.change("ob-login", login); }
  ui.change("ob-password", fixturePassword);
}
function success(loginOnly = false) {
  return { success: true, data: {
    workspaceId: "workspace-fixture", name: "Local fixture", purpose: "clinic_services", vertical: "beauty", timeZone: "Asia/Almaty",
    loginUrl: "https://example.test/login", ownerLoginOnly: loginOnly,
    ownerLogin: loginOnly ? "canonical.owner" : "owner@example.test",
    ownerEmail: loginOnly ? logins.emailFromLogin("canonical.owner") : "owner@example.test",
  } };
}
function conflict(code: string, existingWorkspaceId?: string) {
  return { success: false, error: "Local conflict", code, data: { existingWorkspaceId } };
}
function assertClean(ui: Ui) {
  assert.ok(!ui.list().some((node) => node.props.role === "alert"));
  assert.doesNotMatch(ui.content(), /Переключить на приглашение|Перевыпустить приглашение|Да, создать вторую/);
  if (ui.list().some((node) => node.props.id === "ob-password")) assert.equal(ui.field("ob-password").props.value, "");
}

test("Owner credentials retain email as the default and always submit purpose", async () => {
  const ui = setup();
  assert.equal(ui.button("Логин и пароль").props["aria-pressed"], true);
  assert.equal(ui.button("Почта").props["aria-pressed"], true);
  assert.equal(ui.field("ob-email").props.type, "email");
  fill(ui);
  ui.click("Почта");
  ui.click("Логин и пароль");
  assert.equal(ui.field("ob-password").props.value, fixturePassword);
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding-credentials");
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "beauty", ownerName: "",
    timeZone: "Asia/Almaty", purpose: "clinic_services", password: fixturePassword, ownerEmail: "owner@example.test" });
  await ui.respond(success());
  assert.match(ui.content(), /owner@example\.test/);
  assert.match(ui.content(), /Забыли пароль/);
});

test("Explicit username uses shared normalization, needs no email and displays the canonical result", async () => {
  const ui = setup();
  ui.change("ob-email", "unused@example.test");
  fill(ui, "Aigul_Botanova");
  const input = ui.field("ob-login");
  assert.equal(input.props.type, "text");
  assert.equal(input.props.minLength, 3);
  assert.equal(input.props.maxLength, 24);
  assert.equal(input.props.required, true);
  assert.equal(input.props.autoComplete, "username");
  assert.equal(input.props.autoCapitalize, "none");
  assert.ok(!ui.list().some((node) => node.props.id === "ob-email"));
  assert.ok(ui.list().some((node) => node.props.id === "ob-name"));
  assert.ok(ui.list().some((node) => node.props.id === "ob-vertical"));
  ui.submit();
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "beauty", ownerName: "",
    timeZone: "Asia/Almaty", purpose: "clinic_services", password: fixturePassword, ownerLogin: "aigul.botanova" });
  await ui.respond(success(true));
  assert.match(ui.content(), /canonical\.owner/);
  assert.doesNotMatch(ui.content(), /Aigul_Botanova|staff\.negis\.|Забыли пароль|администратор/);
  assert.match(ui.content(), /не восстанавливается по почте/);
  assert.match(ui.content(), /поддержку; не создавайте повторное пространство/);
});

test("Mortgage purpose clears the medical niche and submits username credentials without email", async () => {
  const ui = setup();
  const option = nodes(ui.field("ob-purpose")).find((node) => node.props.value === "mortgage_leads");
  assert.ok(option);
  assert.equal(text(option), "Ипотечные заявки");
  ui.change("ob-email", "unused@example.test");
  fill(ui, "Aigul_Botanova");
  ui.change("ob-purpose", "mortgage_leads");
  assert.ok(!ui.list().some((node) => node.props.id === "ob-vertical" || node.props.htmlFor === "ob-vertical"));
  assert.equal(ui.field("ob-password").props.value, "");
  assert.equal(ui.button("Логин и пароль").props.disabled, false);
  assert.equal(ui.button("Логин").props["aria-pressed"], true);
  ui.change("ob-password", fixturePassword);
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding-credentials");
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "", ownerName: "",
    timeZone: "Asia/Almaty", purpose: "mortgage_leads", password: fixturePassword, ownerLogin: "aigul.botanova" });
  assert.equal(ui.list().find((node) => node.type === "fieldset")!.props.disabled, true);
  ui.click("Почта");
  ui.click("Ссылка-приглашение");
  assert.equal(ui.button("Логин").props["aria-pressed"], true);
  assert.equal(ui.button("Логин и пароль").props["aria-pressed"], true);
  ui.change("ob-password", "changed-while-pending");
  const response = success(true);
  await ui.respond({ ...response, data: { ...response.data, purpose: "mortgage_leads", vertical: null } });
  assert.equal(text(ui.list().find((node) => node.type === "h1")), "Пространство подключено — вход по логину и паролю");
  assert.equal(text(ui.list().find((node) => node.props.className === "page-sub")), "«Local fixture» · ипотечные заявки · canonical.owner");
  assert.ok(ui.list().some((node) => node.type === "code" && text(node) === "canonical.owner"));
  assert.ok(ui.list().some((node) => node.type === "code" && text(node) === fixturePassword));
  assert.doesNotMatch(ui.content(), /staff\.negis\.|unused@example\.test|Aigul_Botanova|changed-while-pending|клиник|салон|стоматолог|тариф|реклам|оплат/i);
  ui.click("Подключить ещё одну");
  assert.equal(ui.field("ob-purpose").props.value, "clinic_services");
  assert.equal(ui.field("ob-vertical").props.value, "");
  assertClean(ui);
});

test("Mortgage credentials also retain the email identity path", async () => {
  const ui = setup();
  fill(ui);
  ui.change("ob-purpose", "mortgage_leads");
  assert.equal(ui.field("ob-email").props.type, "email");
  assert.ok(!ui.list().some((node) => node.props.id === "ob-vertical" || node.props.id === "ob-login"));
  ui.change("ob-password", fixturePassword);
  ui.submit();
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "", ownerName: "",
    timeZone: "Asia/Almaty", purpose: "mortgage_leads", password: fixturePassword, ownerEmail: "owner@example.test" });
  const response = success();
  await ui.respond({ ...response, data: { ...response.data, purpose: "mortgage_leads", vertical: null } });
  assert.match(ui.content(), /Пространство подключено — вход по логину и паролю/);
  assert.match(ui.content(), /ипотечные заявки · owner@example\.test/);
  assert.match(ui.content(), /Забыли пароль/);
  assert.doesNotMatch(ui.content(), /клиник|салон|стоматолог|тариф/i);
});

test("Mortgage invitation remains email-only with empty vertical and a neutral result", async () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.change("ob-purpose", "mortgage_leads");
  ui.click("Ссылка-приглашение");
  ui.change("ob-email", "owner@example.test");
  assert.ok(!ui.list().some((node) => ["ob-vertical", "ob-login", "ob-password", "ob-identity-label"].includes(node.props.id)));
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding");
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "", ownerEmail: "owner@example.test",
    ownerName: "", timeZone: "Asia/Almaty", purpose: "mortgage_leads" });
  await ui.respond({ success: true, data: { workspaceId: "workspace-fixture", name: "Local fixture",
    purpose: "mortgage_leads", vertical: null, ownerEmail: "owner@example.test",
    acceptUrl: "https://example.test/join#local", emailSent: true } });
  assert.equal(text(ui.list().find((node) => node.type === "h1")), "Пространство создано — ожидает владельца");
  assert.equal(text(ui.list().find((node) => node.props.className === "page-sub")), "«Local fixture» · ипотечные заявки · owner@example.test");
  assert.match(ui.content(), /Supabase отправил владельцу письмо/);
  assert.doesNotMatch(ui.content(), /клиник|салон|стоматолог|тариф|staff\.negis\./i);
});

test("Mortgage partial onboarding reissue stays neutral when the server does not return its profile", async () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.change("ob-purpose", "mortgage_leads");
  ui.change("ob-password", fixturePassword);
  ui.submit();
  await ui.respond(conflict("partial_credentials_onboarding", "existing-workspace"), 502);
  ui.click("Перевыпустить приглашение");
  assert.equal(ui.requests[1].url, "/api/crm/platform-invitation-reissue");
  assert.deepEqual(ui.requests[1].body, { workspaceId: "existing-workspace" });
  await ui.respond({ success: true, data: { workspaceId: "existing-workspace", name: "Local fixture",
    ownerLogin: "canonical.owner", ownerLoginOnly: true,
    ownerEmail: logins.emailFromLogin("canonical.owner"), acceptUrl: "https://example.test/join#local",
    emailSent: false, emailStatus: "login_only" } });
  assert.equal(text(ui.list().find((node) => node.type === "h1")), "Приглашение перевыпущено");
  assert.equal(text(ui.list().find((node) => node.props.className === "page-sub")), "«Local fixture» · новая ссылка приглашения · canonical.owner");
  assert.match(ui.content(), /Передайте ссылку владельцу лично/);
  assert.match(ui.content(), /поддержку; не создавайте повторное пространство/);
  assert.doesNotMatch(ui.content(), /staff\.negis\.|Выслать письмо|Забыли пароль|клиник|салон|стоматолог|тариф|ипотечные заявки/i);
});

test("Returning from mortgage preserves explicit medical niche selection and existing result labels", async () => {
  for (const [vertical, label] of [["beauty", "салон красоты"], ["dental", "стоматология"], ["clinic", "клиника"]]) {
    for (const invite of [false, true]) {
      const ui = setup();
      fill(ui);
      ui.change("ob-purpose", "mortgage_leads");
      ui.change("ob-purpose", "clinic_services");
      assert.equal(ui.field("ob-vertical").props.value, "");
      assert.deepEqual(nodes(ui.field("ob-vertical")).filter((node) => node.type === "option").map((node) => node.props.value), ["", "beauty", "dental", "clinic"]);
      ui.change("ob-vertical", vertical);
      if (invite) ui.click("Ссылка-приглашение");
      else ui.change("ob-password", fixturePassword);
      ui.submit();
      assert.equal(ui.requests[0].body.purpose, "clinic_services");
      assert.equal(ui.requests[0].body.vertical, vertical);
      const response = success();
      await ui.respond({ ...response, data: { ...response.data, vertical,
        acceptUrl: "https://example.test/join#local", emailSent: true } });
      assert.equal(text(ui.list().find((node) => node.type === "h1")), invite ? "Клиника подключена" : "Клиника подключена — вход по логину и паролю");
      assert.equal(text(ui.list().find((node) => node.props.className === "page-sub")), `«Local fixture» · ${label} · owner@example.test`);
      assert.match(ui.content(), /Назначьте тариф/);
      assert.doesNotMatch(ui.content(), /ипотечные заявки/);
    }
  }
});

test("Invalid usernames and explicit service emails never reach an API", () => {
  for (const login of ["", "ab", "!!!", "qa!owner", "qaвowner", "a".repeat(25), "aigul@example.test", logins.emailFromLogin("aigul")]) {
    const ui = setup();
    fill(ui, login);
    ui.submit();
    assert.equal(ui.requests.length, 0, login);
    assert.ok(ui.list().some((node) => node.props.role === "alert"));
  }
  for (const purpose of ["clinic_services", "mortgage_leads"]) {
    for (const invite of [false, true]) {
      for (const domain of logins.STAFF_LOGIN_DOMAINS) {
        const ui = setup();
        fill(ui);
        if (purpose === "mortgage_leads") ui.change("ob-purpose", purpose);
        if (invite) ui.click("Ссылка-приглашение");
        ui.change("ob-email", `aigul@${domain}`);
        ui.submit();
        assert.equal(ui.requests.length, 0);
        assert.match(ui.content(), /Служебный адрес нельзя использовать/);
      }
    }
  }
});

test("Username conflicts never offer email invitation fallback or duplicate creation", async () => {
  for (const code of ["owner_login_unavailable", "email_already_registered", "owner_already_has_workspace"]) {
    for (const workspaceId of [undefined, "existing-workspace"]) {
      const ui = setup();
      fill(ui, "aigul");
      ui.submit();
      await ui.respond(conflict(code, workspaceId), 409);
      assert.doesNotMatch(ui.content(), /Переключить на приглашение|Да, создать вторую/);
      assert.equal(ui.content().includes("Перевыпустить приглашение"), Boolean(workspaceId));
    }
  }
});

test("Login-only reissue targets the existing workspace and gives manual-link guidance without reset mail", async () => {
  for (const identity of [
    { ownerLogin: "canonical.owner", ownerLoginOnly: true, emailStatus: "login_only" },
    { emailStatus: "login_only" },
    { emailStatus: "already_registered" },
  ]) {
    const ui = setup();
    fill(ui, "aigul");
    ui.submit();
    await ui.respond(conflict("owner_login_unavailable", "existing-workspace"), 409);
    ui.click("Перевыпустить приглашение");
    assert.equal(ui.requests[1].url, "/api/crm/platform-invitation-reissue");
    assert.deepEqual(ui.requests[1].body, { workspaceId: "existing-workspace" });
    assert.equal(ui.list().find((node) => node.type === "fieldset")!.props.disabled, true);
    await ui.respond({ success: true, data: { workspaceId: "existing-workspace", name: "Local fixture",
      ownerEmail: logins.emailFromLogin("canonical.owner"), acceptUrl: "https://example.test/join#local",
      emailSent: false, ...identity } });
    assert.match(ui.content(), /canonical\.owner/);
    assert.match(ui.content(), /письмо не отправлялось/);
    assert.match(ui.content(), /Передайте ссылку владельцу лично/);
    assert.match(ui.content(), /поддержку; не создавайте повторное пространство/);
    assert.doesNotMatch(ui.content(), /staff\.negis\.|Выслать письмо|Забыли пароль|сначала регистрируется/);
  }
});

test("Identity edits and identity or mode switches clear errors, reissue, fallback and password", async () => {
  for (const action of ["email", "login", "identity", "mode"]) {
    for (const code of ["email_already_registered", "partial_credentials_onboarding"]) {
      const ui = setup();
      fill(ui, action === "login" ? "aigul" : undefined);
      ui.submit();
      await ui.respond(conflict(code, code.startsWith("partial") ? "existing-workspace" : undefined), 409);
      if (action === "email") ui.change("ob-email", "different@example.test");
      if (action === "login") ui.change("ob-login", "different.owner");
      if (action === "identity") ui.click("Логин");
      if (action === "mode") ui.click("Ссылка-приглашение");
      assertClean(ui);
      if (action === "mode") { ui.click("Логин и пароль"); assertClean(ui); }
    }
  }
  for (const action of ["email", "mode"]) {
    const ui = setup();
    fill(ui);
    ui.click("Ссылка-приглашение");
    ui.submit();
    await ui.respond(conflict("owner_already_has_workspace"), 409);
    assert.match(ui.content(), /Да, создать вторую/);
    if (action === "email") ui.change("ob-email", "different@example.test");
    else ui.click("Логин и пароль");
    assertClean(ui);
  }
});

test("Busy fieldset contains every control and the result password is the submitted snapshot", async () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.submit();
  const fieldset = ui.list().find((node) => node.type === "fieldset")!;
  assert.equal(fieldset.props.disabled, true);
  const isControl = (node: UiNode) => ["input", "select", "button"].includes(String(node.type));
  assert.equal(nodes(fieldset).filter(isControl).length, ui.list().filter(isControl).length);
  ui.click("Почта");
  ui.click("Ссылка-приглашение");
  assert.ok(ui.list().some((node) => node.props.id === "ob-login"));
  // Invoke the callback directly to model a stale/programmatic edit despite the disabled form.
  ui.change("ob-password", "changed-while-pending");
  assert.equal(ui.requests[0].body.password, fixturePassword);
  await ui.respond(success(true));
  assert.ok(ui.list().some((node) => node.type === "code" && text(node) === fixturePassword));
  assert.doesNotMatch(ui.content(), /changed-while-pending/);
  ui.click("Подключить ещё одну");
  assert.equal(ui.field("ob-email").props.value, "");
  assertClean(ui);
  assert.doesNotMatch(ui.content(), /canonical\.owner|local-test-password/);
});

test("Invitation remains email-only and preserves its existing JSON literal", () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.click("Ссылка-приглашение");
  ui.change("ob-email", "owner@example.test");
  assert.ok(!ui.list().some((node) => node.props.id === "ob-login" || node.props.id === "ob-password"));
  assert.ok(!ui.list().some((node) => node.props.id === "ob-identity-label"));
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding");
  assert.deepEqual(ui.requests[0].body, { name: "Local fixture", vertical: "beauty", ownerEmail: "owner@example.test",
    ownerName: "", timeZone: "Asia/Almaty", purpose: "clinic_services" });
  assert.ok(source.includes("body: JSON.stringify({ name, vertical, ownerEmail, ownerName, timeZone, purpose, ...(confirmAdditional ? { confirmAdditionalWorkspace: true } : {}) }),"));
});

test("Marketing remains invitation-only even after username credentials were selected", () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.change("ob-purpose", "marketing");
  assert.equal(ui.button("Логин и пароль").props.disabled, true);
  ui.click("Логин и пароль");
  assert.equal(ui.button("Ссылка-приглашение").props["aria-pressed"], true);
  assert.ok(!ui.list().some((node) => node.props.id === "ob-password" || node.props.id === "ob-login" || node.props.id === "ob-vertical"));
  ui.change("ob-email", "owner@example.test");
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding");
  assert.equal(ui.requests[0].body.purpose, "marketing");
  assert.equal(ui.requests[0].body.vertical, "");
  assert.ok(!("password" in ui.requests[0].body) && !("ownerLogin" in ui.requests[0].body));
});

test("Returning from marketing to mortgage permits explicit credentials again", async () => {
  const ui = setup();
  fill(ui, "aigul");
  ui.change("ob-purpose", "marketing");
  ui.change("ob-purpose", "mortgage_leads");
  assert.equal(ui.button("Логин и пароль").props.disabled, false);
  assert.equal(ui.button("Ссылка-приглашение").props["aria-pressed"], true);
  ui.click("Логин и пароль");
  assert.equal(ui.button("Логин").props["aria-pressed"], true);
  assert.ok(!ui.list().some((node) => node.props.id === "ob-vertical"));
  ui.change("ob-password", fixturePassword);
  ui.submit();
  assert.equal(ui.requests[0].url, "/api/crm/platform-onboarding-credentials");
  assert.equal(ui.requests[0].body.purpose, "mortgage_leads");
  assert.equal(ui.requests[0].body.vertical, "");
  assert.equal(ui.requests[0].body.ownerLogin, "aigul");
  assert.ok(!("ownerEmail" in ui.requests[0].body));
  const response = success(true);
  await ui.respond({ ...response, data: { ...response.data, purpose: "mortgage_leads", vertical: null } });
  assert.match(ui.content(), /ипотечные заявки/);
});

test("Mode controls wrap and result contracts distinguish login-only owners", () => {
  const ui = setup();
  for (const group of ui.list().filter((node) => node.props.role === "group")) {
    assert.equal(group.props.style.flexWrap, "wrap");
    assert.equal(group.props.style.minWidth, 0);
  }
  assert.equal(ui.list().find((node) => node.type === "fieldset")!.props.style.minWidth, 0);
  const credsType = source.slice(source.indexOf("type CredsResult"), source.indexOf("function ownerIdentity"));
  assert.match(credsType, /ownerLogin: string;/);
  assert.match(credsType, /ownerLoginOnly: boolean;/);
  assert.match(credsType, /purpose: string;/);
  assert.match(credsType, /vertical: string \| null;/);
  assert.doesNotMatch(source, /\bemailFromLogin\(|\{(?:credsResult|result)\.ownerEmail\}/);
});

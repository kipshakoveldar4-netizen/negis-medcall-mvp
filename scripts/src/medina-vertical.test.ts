import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";

// VT — ниша рабочего пространства проходит весь путь.
//
// Механизм считается работающим, только если он замкнут: значение можно
// записать, сервер его читает, применяет при отказе в запуске и отдаёт браузеру.
// Разорванная в любом звене цепочка выглядит как работающая, но не делает
// ничего — а именно так эта работа и начиналась: сервер уже отдавал нишу в
// контекст, браузер её выбрасывал, задать её было нечем, а правила рекламы о
// ней не знали вовсе.
//
// Отдельно проверяется умолчание. Оно несимметрично намеренно: неизвестное или
// непрочитанное значение — это клиника, потому что у клиники правила строже.
// Обратное умолчание означало бы, что сбой чтения настройки разрешает
// медицинской клинике то, что ей запрещено.
//
// Ничего здесь не обращается ни к базе, ни к сети.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const termsPath = path.join(repoRoot, "lib", "vertical", "terms.ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const compliancePath = path.join(repoRoot, "lib", "meta", "compliance.ts");
const improvePath = path.join(repoRoot, "lib", "meta", "improve.ts");
const authContextPath = path.join(repoRoot, "artifacts", "negis", "src", "contexts", "AuthContext.tsx");
const switchPath = path.join(repoRoot, "artifacts", "negis", "src", "components", "admin", "VerticalSwitch.tsx");

type TermsModule = {
  readVertical: (value: unknown) => string;
  termsFor: (vertical: string) => Record<string, string>;
  capitalize: (value: string) => string;
  DEFAULT_VERTICAL: string;
  VERTICAL_SETTINGS_KEY: string;
  VERTICALS: readonly string[];
};

const terms = (await import(pathToFileURL(termsPath).href)) as TermsModule;

async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => { result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}

function compile(source: string): Script {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return new Script(result.outputText);
}

function evaluate(code: Script, imports: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  code.runInNewContext({ ...globals, exports, require(name: string) {
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name === "react/jsx-runtime") {
      const jsx = (type: unknown, props: Record<string, any>) => ({ type, props });
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    }
    if (name === "lucide-react") return new Proxy({}, { get: (_target, name) => String(name) });
    throw new Error(`Unmocked import: ${name}`);
  } });
  return exports;
}

// Source mutants stay in memory; callers compile before asserting rejection.
function rewrite(source: string, edit: (node: ts.Node, ast: ts.SourceFile) => ts.Node | undefined) {
  const ast = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let changes = 0;
  const result = ts.transform(ast, [(context) => {
    const visit: ts.Visitor = (node) => {
      const changed = edit(node, ast);
      if (changed) { changes++; return changed; }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  assert.ok(changes > 0, "a local mutant must change actual source");
  const printed = ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();
  return printed;
}

test("VT1 умолчание — клиника, и оно несимметрично намеренно", () => {
  assert.equal(terms.DEFAULT_VERTICAL, "clinic");

  for (const junk of [undefined, null, "", "  ", "salon", "SALON", 42, {}, []]) {
    assert.equal(terms.readVertical(junk), "clinic", String(junk));
  }

  // У клиники правила строже. Умолчание в другую сторону означало бы, что сбой
  // чтения настройки снимает с медицинской клиники ограничения.
  assert.equal(terms.readVertical("beauty"), "beauty");
  assert.equal(terms.readVertical("clinic"), "clinic");
});

test("VT2 словарь покрывает обе ниши целиком", () => {
  const clinic = terms.termsFor("clinic");
  const beauty = terms.termsFor("beauty");

  assert.deepEqual(Object.keys(clinic).sort(), Object.keys(beauty).sort(), "наборы ключей совпадают");
  for (const key of Object.keys(clinic)) {
    assert.ok(clinic[key], `клиника: ${key} не пустой`);
    assert.ok(beauty[key], `салон: ${key} не пустой`);
  }

  assert.equal(clinic.specialist, "врач");
  assert.equal(beauty.specialist, "мастер");
  // «Клиент», а не «гость»: продукт уже везде говорит «клиенты», и второе слово
  // для той же сущности рассинхронизировало бы экраны.
  assert.equal(beauty.customer, "клиент");
});

test("VT3 нишу можно записать существующим маршрутом", async () => {
  const switcher = await codeOf(switchPath);

  assert.ok(switcher.includes("/api/crm/admin-settings"), "пишется через уже закрытый правами маршрут");
  assert.ok(switcher.includes("VERTICAL_SETTINGS_KEY"), "под тем же ключом, который читает сервер");
  // Заводить отдельный маршрут ради одного значения незачем: admin-settings
  // кладёт произвольный ключ и уже закрыт правом администратора.
  assert.equal(terms.VERTICAL_SETTINGS_KEY, "workspace_vertical");
});

test("VT4 сервер читает нишу и отдаёт её браузеру", async () => {
  const server = await codeOf(serverPath);

  assert.ok(/async function lookupWorkspaceVerticals/.test(server), "списочное чтение для контекста");
  assert.ok(/async function readWorkspaceVertical/.test(server), "одиночное — для проверок");
  assert.ok(/vertical: workspaceVerticals\[membership\.workspaceId\] \|\| DEFAULT_VERTICAL/.test(server), "ниша едет с членством");
  assert.ok(/\.eq\("key", VERTICAL_SETTINGS_KEY\)/.test(server), "по тому же ключу, что пишет интерфейс");
});

test("VT5 браузер нишу не выбрасывает", async () => {
  const auth = await codeOf(authContextPath);

  // Сервер уже отдавал нишу, а браузер её терял при разборе ответа: механизм
  // существовал и не делал ничего.
  assert.ok(/vertical: readVertical\(entry\.vertical\)/.test(auth), "разбирается из ответа");
  assert.ok(/setVertical\(selected\.vertical\)/.test(auth), "применяется при выборе клиники");
  assert.ok(/isStaffMode, impersonationClinicName, vertical,/.test(auth), "и отдаётся экранам");
});

test("VT6 отказ в запуске считается по нише этой клиники", async () => {
  const server = await codeOf(serverPath);

  // Без этого разделение жило бы только в браузере, а сервер — последняя
  // инстанция: именно он отдаёт 400 и не пускает текст в Meta.
  assert.ok(
    /const vertical = await readWorkspaceVertical\(workspaceId\);[\s\S]{0,400}checkMetaCompliance\(/.test(server),
    "ниша читается перед проверкой и передаётся в неё",
  );
});

test("VT7 правила и задание модели знают про нишу", async () => {
  const compliance = await codeOf(compliancePath);
  const improve = await codeOf(improvePath);

  assert.ok(/export function rulesFor\(vertical: Vertical\)/.test(compliance), "набор правил зависит от ниши");
  assert.ok(/vertical === "beauty" \? "block" : "review"/.test(compliance), "лечение: салону отказ, клинике замечание");
  assert.ok(/if \(vertical === "clinic"\) rules\.push\(AESTHETIC_CONDITION\)/.test(compliance), "состояние — только у клиники");
  assert.ok(/DISCLAIMERS: Readonly<Record<Vertical, string>>/.test(compliance), "оговорка тоже своя");

  assert.ok(/export function improveSystemPrompt\(vertical/.test(improve), "задание модели зависит от ниши");
  assert.ok(/BEAUTY_SYSTEM_PROMPT/.test(improve), "и у салона оно своё");
});

test("VT8 имена таблиц, ресурсов и ролей ниша не трогает", async () => {
  const server = await codeOf(serverPath);
  const registry = await codeOf(path.join(repoRoot, "lib", "crm", "authorization.ts"));
  const permissions = await codeOf(path.join(repoRoot, "lib", "auth", "permissions.ts"));

  // Меняются подписи, не имена. Переименование таблицы — правка применённой
  // миграции, переименование ключа ресурса — пять реестров и все проверки
  // разом; ради слова на кнопке ни то ни другое не нужно.
  assert.ok(server.includes("clinic_doctors"), "таблица врачей осталась собой");
  assert.ok(registry.includes('"doctor-schedule"'), "ключ ресурса не переименован");
  assert.ok(/"doctor"/.test(permissions), "роль тоже");
});

test("VT9 право на справочники отделено от права на секреты", async () => {
  const permissions = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "auth", "permissions.ts")).href
  )) as { permissionsForRole?: (role: string) => string[]; rolePermissions?: unknown } & Record<string, unknown>;
  const registry = await codeOf(path.join(repoRoot, "lib", "crm", "authorization.ts"));

  // Прайс и график правит тот, кто ведёт запись каждый день. Дать ему
  // view_admin значило бы открыть и ключи интеграций, и список сотрудников:
  // право на прайс не должно тянуть за собой право на секреты.
  const catalogue = await codeOf(path.join(repoRoot, "lib", "auth", "permissions.ts"));
  assert.ok(catalogue.includes('"manage_directory"'), "право существует");
  assert.ok(
    /receptionist: \[[\s\S]{0,200}"manage_directory"/.test(catalogue),
    "и есть у регистратора — администратора салона",
  );

  for (const resource of ["clinic-services", "clinic-doctors", "doctor-schedule"]) {
    const block = registry.slice(registry.indexOf(`"${resource}"`), registry.indexOf(`"${resource}"`) + 400);
    assert.ok(block.includes("manage_directory"), `${resource}: запись — по праву справочников`);
    assert.ok(!/POST: "view_admin"/.test(block), `${resource}: view_admin больше не требуется`);
  }
});

test("VT11 мобильное меню ведёт к справочнику и говорит словами ниши", async () => {
  const mobileNav = await readFile(path.join(repoRoot, "artifacts/negis/src/components/layout/MobileNav.tsx"), "utf8");
  const policy = evaluate(compile(await readFile(path.join(repoRoot, "artifacts/negis/src/lib/workspaceRoutes.ts"), "utf8")));
  type Element = { type: unknown; props: Record<string, any> };
  function elements(value: any): Element[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    return value && typeof value === "object" && "props" in value ? [value, ...elements(value.props.children)] : [];
  }
  function label(value: any): string {
    if (Array.isArray(value)) return value.map(label).join("");
    return value && typeof value === "object" ? label(value.props?.children) : typeof value === "string" ? value : "";
  }
  function drawer(code: Script, vertical: string, purpose: string | null, role: string, permissions: Record<string, boolean>) {
    const states: any[] = [], navigations: string[] = [];
    const body = {};
    let cursor = 0, mounting = true;
    const module = evaluate(code, {
      react: {
        useState(initial: any) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
          return [states[slot], (value: any) => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }];
        },
        useRef(initial: any) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = { current: initial };
          return states[slot];
        },
        useLayoutEffect(effect: () => void) { if (mounting) effect(); },
      },
      "react-dom": { createPortal(content: unknown, target: unknown) { assert.equal(target, body); return content; } },
      "@/lib/supabase": { hasSupabaseFrontendEnv: false, supabase: new Proxy({}, { get() { throw new Error("No SDK access in a directory-label fixture"); } }) },
      wouter: { useLocation: () => ["/leads", (href: string) => navigations.push(href)] },
      "@/contexts/AuthContext": { useAuth: () => ({ user: { id: "local-staff" }, clinicId: "local-workspace",
        userRole: role, vertical, workspacePurpose: purpose, rolePermissions: permissions, signOut() {} }) },
      "@/lib/workspaceRoutes": policy,
      "../../../../../lib/vertical/terms": terms,
      "./ProfileDialog": { ProfileDialog: "ProfileDialog" },
    }, { document: { body } });
    const closed = module.MobileNav(); mounting = false;
    const more = elements(closed).find((node) => node.type === "button" && label(node) === "Ещё");
    assert.ok(more, "the actual drawer is openable");
    more.props.onClick(); cursor = 0;
    const opened = module.MobileNav();
    assert.ok(elements(opened).some((node) => node.props.className === "mobile-nav-sheet"));
    const routes: { href: string; label: string }[] = [];
    for (const button of elements(opened).filter((node) => node.type === "button"
      && node.props.className?.split(" ").includes("mobile-nav-drawer-item") && label(node) !== "Профиль и пароль")) {
      const start = navigations.length;
      button.props.onClick();
      assert.equal(navigations.length, start + 1, "a drawer entry must navigate");
      routes.push({ href: navigations[start], label: label(button) });
    }
    return routes;
  }
  function assertDirectory(code: Script) {
    for (const [vertical, expected] of [["clinic", "Врачи и график"], ["beauty", "Мастера и график"], ["dental", "Стоматологи и график"]]) {
      for (const purpose of ["clinic_services", "marketing"]) {
        for (const role of ["owner", "admin", "manager", "receptionist", "doctor"]) {
          const menu = drawer(code, vertical, purpose, role, { directory: true, admin: false });
          assert.deepEqual(menu.filter((item) => item.href === "/staff-schedule"), [{ href: "/staff-schedule", label: expected }]);
        }
        for (const role of ["receptionist", "doctor", "lead_manager"]) {
          const permissions = { directory: role === "lead_manager", admin: true, booking: true, crm: true };
          assert.ok(!drawer(code, vertical, purpose, role, permissions).some((item) => item.href === "/staff-schedule"),
            "admin/booking permissions must not substitute for directory or override lead-manager restrictions");
        }
      }
      for (const purpose of ["mortgage_leads", null]) for (const role of ["owner", "admin", "lead_manager"]) {
        const menu = drawer(code, vertical, purpose, role, { directory: true, admin: true, crm: true });
        assert.ok(!menu.some((item) => item.href === "/staff-schedule"), "purpose denial wins over role and permissions");
        if (purpose === null) assert.deepEqual(menu, []);
      }
    }
  }
  assertDirectory(compile(mobileNav));

  const staticLabel = rewrite(mobileNav, (node) => {
    if (!ts.isJsxExpression(node) || !node.expression || !ts.isIdentifier(node.expression) || node.expression.text !== "label") return;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
        && ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === "visibleDrawer") {
        return ts.factory.updateJsxExpression(node, ts.factory.createIdentifier("staticLabel"));
      }
    }
    return undefined;
  });
  const missingEntry = rewrite(mobileNav, (node, ast) => {
    if (!ts.isArrayLiteralExpression(node)) return;
    const entries = node.elements.filter((entry) => !(ts.isObjectLiteralExpression(entry) && entry.properties.some((prop) =>
      ts.isPropertyAssignment(prop) && prop.name.getText(ast) === "href" && ts.isStringLiteral(prop.initializer) && prop.initializer.text === "/staff-schedule")));
    if (entries.length !== node.elements.length) return ts.factory.updateArrayLiteralExpression(node, entries);
    return undefined;
  });
  const unfiltered = rewrite(mobileNav, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "visibleDrawer"
      && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression)
      && node.initializer.expression.name.text === "filter") {
      return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, node.initializer.expression.expression);
    }
    return undefined;
  });
  for (const mutant of [staticLabel, missingEntry, unfiltered]) {
    const code = compile(mutant);
    assert.throws(() => assertDirectory(code), assert.AssertionError, "static, hidden or ungated directory entries must fail");
  }
});

test("VT12 экран справочника не говорит «врач» жёстко", async () => {
  const editor = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "components", "admin", "DoctorSchedule.tsx"));

  // Салон видел «Врачи», «Укажите имя врача», «Врач обновлён» — каждое слово
  // было зашито строкой. После перевода на словарь ни одной формы слова «врач»
  // в коде не остаётся: они существуют только в lib/vertical/terms.
  // Регистронезависимо: «ВРАЧИ» капсом проскочил бы мимо /[Вв]рач/.
  assert.ok(!/врач/i.test(editor), "жёстких «врачей» в коде экрана нет");
  assert.ok(/termsFor\(vertical\)/.test(editor), "словарь берётся по нише пространства");
  assert.ok(/detailTextFor\(terms\)/.test(editor), "переводы отказов сервера тоже по нише");

  const admin = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"));
  assert.ok(/tab\.id === "doctors"[\s\S]{0,120}specialistPlural/.test(admin), "вкладка админ-центра подписана по нише");
  // Определение хелпера — не доказательство: мутант, вернувший {tab.label} в
  // рендер, оставил бы tabLabel мёртвым кодом (noUnusedLocals выключен) и
  // прошёл бы пин выше. Держим обе точки вызова.
  // Якорь на блоках, а не на соседстве символов: рядом с подписью появился
  // счётчик ждущих заявок, и пин, требовавший `{tabLabel(tab)}</option>`
  // впритык, упал бы на любом таком добавлении, ничего не защитив.
  // Конец блока ищется ОТ его начала: в файле есть селекты ролей выше, и
  // первый в файле </option> закрывал бы чужой элемент — срез выходил пустым.
  const optionStart = admin.indexOf("<option key={tab.id}");
  const optionBlock = admin.slice(optionStart, admin.indexOf("</option>", optionStart));
  const navBlock = admin.slice(admin.indexOf("<nav className=\"hidden overflow-x-auto md:block\""), admin.indexOf("</nav>"));
  assert.ok(/tabLabel\(tab\)/.test(optionBlock), "мобильный селект зовёт tabLabel");
  assert.ok(/tabLabel\(tab\)/.test(navBlock), "десктопные вкладки зовут tabLabel");
  // Мутант, вернувший сырую подпись в рендер, оставил бы tabLabel мёртвым
  // кодом (noUnusedLocals выключен) и прошёл бы пины выше.
  assert.ok(!/\{tab\.label\}/.test(admin), "сырая подпись вкладки не рисуется нигде");
});

test("VT13 форма записи говорит словами ниши", async () => {
  const pagePath = path.join(repoRoot, "artifacts/negis/src/pages/AppointmentsPage.tsx");
  const source = await readFile(pagePath, "utf8");
  const appointments = await codeOf(pagePath);
  assert.ok(!/врач/i.test(appointments), "жёстких «врачей» в коде формы записи нет");

  function fixture(source: string) {
    const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const page = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "AppointmentsPage");
    assert.ok(page?.body);
    const dictionary = page.body.statements.find((node): node is ts.VariableStatement => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === "terms"));
    assert.ok(dictionary, "execute the page's actual niche selection");
    const names = ["SlotTakenError", "OutsideScheduleError", "describeConflict", "describeSchedule"];
    const helpers = names.map((name) => {
      const declaration = ast.statements.find((node) => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name);
      assert.ok(declaration, `${name} is an actual appointment helper`);
      return declaration.getText(ast);
    });
    const handlers = nodes(page).filter(ts.isIfStatement).filter((node) => ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(node.expression.right)
      && ["SlotTakenError", "OutsideScheduleError"].includes(node.expression.right.text));
    for (const kind of ["SlotTakenError", "OutsideScheduleError"]) {
      assert.equal(handlers.filter((node) => ts.isBinaryExpression(node.expression)
        && ts.isIdentifier(node.expression.right) && node.expression.right.text === kind).length, 2, `${kind}: create and edit handlers remain covered`);
    }
    const labels = nodes(page).filter(ts.isJsxAttribute).filter((node) => node.name.getText(ast) === "label")
      .flatMap((node) => node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression ? [node.initializer.expression] : [])
      .filter((node) => nodes(node).some((child) => ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)
        && child.expression.text === "terms" && ["specialist", "specialistPlural"].includes(child.name.text)));
    assert.ok(labels.length >= 3, "check actual form fields and the specialist filter, not an unused dictionary");
    const conflict: string[] = [], schedule: string[] = [], times: unknown[][] = [];
    const module = evaluate(compile(`${helpers.join("\n")}
      export { SlotTakenError, OutsideScheduleError };
      export function labels(vertical) { ${dictionary.getText(ast)} return [${labels.map((node) => node.getText(ast)).join(",")}]; }
      ${handlers.map((node, index) => `export function handle${index}(error, vertical, clinicTimeZone) { ${dictionary.getText(ast)} ${node.getText(ast)} }`).join("\n")}
    `), {}, { termsFor: terms.termsFor, capitalize: terms.capitalize,
      setConflictMessage: (message: string) => conflict.push(message), setScheduleMessage: (message: string) => schedule.push(message),
      // Observe formatter plumbing; the booking suite checks real time conversion.
      timeKeyFromStartsAt: (...args: unknown[]) => { times.push(args); return "15:30"; },
    });
    const kinds = handlers.map((node) => (node.expression as ts.BinaryExpression).right.getText(ast));
    return { module, kinds, conflict, schedule, times };
  }
  function assertNiche(app: ReturnType<typeof fixture>) {
    for (const vertical of ["clinic", "beauty", "dental"]) {
      const words = terms.termsFor(vertical);
      const labels = Array.from(app.module.labels(vertical));
      assert.ok(labels.includes(terms.capitalize(words.specialist)), `${vertical}: the form names the specialist`);
      assert.ok(labels.includes(`Все ${words.specialistPlural}`), `${vertical}: the filter names the specialists`);
      for (let index = 0; index < app.kinds.length; index++) {
        const handle = app.module[`handle${index}`];
        const conflictHandler = app.kinds[index] === "SlotTakenError";
        for (const named of [false, true]) {
          app.conflict.length = 0; app.schedule.length = 0; app.times.length = 0;
          const startsAt = named ? "2026-10-19T10:30:00Z" : "";
          handle(new app.module.SlotTakenError({ startsAt, clientName: named ? "Local client" : "", doctorName: "" }), vertical, "Asia/Qyzylorda");
          assert.deepEqual(app.conflict, conflictHandler
            ? [`У ${words.specialistGenitive} уже есть запись на это время: ${named ? "Local client, 15:30" : `другой ${words.customer}`}. Выберите другое время или другого ${words.specialistGenitive}.`] : []);
          assert.deepEqual(app.schedule, [], "an unrelated refusal must not set schedule text");
          assert.deepEqual(app.times, conflictHandler && named ? [[startsAt, "Asia/Qyzylorda"]] : [], "conflicts use clinic time, never an implicit device zone");
          app.conflict.length = 0; app.schedule.length = 0;
          handle(new app.module.OutsideScheduleError({ doctorName: named ? "Local specialist" : "", localTime: "15:30",
            weekdayLabel: "Понедельник", intervals: named ? ["09:00–17:00"] : [] }), vertical, "Asia/Qyzylorda");
          const hours = named ? `Часы ${words.dutyGenitive}: 09:00–17:00.` : `В этот день ${words.dutyGenitive} нет.`;
          assert.deepEqual(app.schedule, conflictHandler ? []
            : [`${named ? "Local specialist" : terms.capitalize(words.specialist)} не работает в это время (Понедельник, 15:30, время ${words.orgGenitive}). ${hours} Записать всё равно?`]);
          assert.deepEqual(app.conflict, [], "an unrelated refusal must not set conflict text");
        }
      }
    }
  }
  assertNiche(fixture(source));
  for (const helper of ["describeConflict", "describeSchedule"]) {
    const mutant = rewrite(source, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === helper) {
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, node.arguments.map((arg, index) => index === 1
          ? ts.factory.createCallExpression(ts.factory.createIdentifier("termsFor"), undefined, [ts.factory.createStringLiteral("clinic")]) : arg));
      }
      return undefined;
    });
    const app = fixture(mutant);
    assert.throws(() => assertNiche(app), assert.AssertionError, `${helper}: a clinic dictionary substituted for the workspace niche must fail`);
  }
  const deviceTime = rewrite(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "describeConflict") {
      return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, node.arguments.slice(0, 2));
    }
    return undefined;
  });
  const app = fixture(deviceTime);
  assert.throws(() => assertNiche(app), assert.AssertionError, "dropping the clinic time-zone argument must fail");
});

test("VT10 страница справочников доступна без админ-центра", async () => {
  const app = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "App.tsx"));
  const sidebar = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "components", "layout", "Sidebar.tsx"));

  assert.ok(/path="\/staff-schedule"/.test(app), "маршрут есть");
  assert.ok(/'\/staff-schedule': 'directory'/.test(app), "и закрыт правом справочников, а не админки");
  assert.ok(/'\/staff-schedule'[\s\S]{0,120}'receptionist'/.test(sidebar), "пункт меню виден регистратору");
  // Подпись пункта зависит от ниши: у клиники врачи, у салона мастера.
  assert.ok(/href === '\/staff-schedule'[\s\S]{0,120}terms\.specialistPlural/.test(sidebar), "подпись — из словаря вертикали");
});

test("VT14 подпись роли говорит словом ниши: в салоне мастер, а не врач", async () => {
  const terms = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "vertical", "terms.ts")).href
  )) as { staffRoleLabels: (vertical: string) => Record<string, string> };

  // Владелец салона: «нет должности мастеров». Роль в базе называется doctor и
  // переименованию не подлежит — на неё завязаны таблицы и ключи ресурсов, — а
  // подпись на экране обязана меняться вместе с нишей.
  assert.equal(terms.staffRoleLabels("clinic").doctor, "Врач");
  assert.equal(terms.staffRoleLabels("beauty").doctor, "Мастер");
  // Регистратор остаётся «Ресепшн» в обеих нишах: в салоне его зовут
  // администратором, но роль admin уже подписана «Администратор», и две
  // одинаковые подписи в одном селекте — это выбор наугад.
  assert.equal(terms.staffRoleLabels("beauty").receptionist, terms.staffRoleLabels("clinic").receptionist);
  assert.equal(terms.staffRoleLabels("beauty").admin, "Администратор");

  // Экраны берут подписи из словаря, а не из статической таблицы.
  const admin = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"));
  assert.ok(/staffRoleLabels\(vertical\)/.test(admin), "админ-центр берёт подписи по нише");
  assert.ok(!/roleLabels\[/.test(admin), "статической таблицы ролей на экране не осталось");

  const picker = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "components", "WorkspacePicker.tsx"));
  assert.ok(/staffRoleLabels\(workspace\.vertical\)/.test(picker), "в выборе клиники — ниша этой клиники");

  const journal = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "change-log-panel.tsx"));
  assert.ok(/staffRoleLabels\(vertical\)/.test(journal), "в журнале тоже");
});

test("VT15 стоматология — третья ниша: свои слова, медицинские правила", async () => {
  // Просьба владельца: «нужно ещё нишу добавить стоматологии, чтобы у нас было
  // уже клиники, салоны и стоматологии».
  assert.ok(terms.VERTICALS.includes("dental"), "ниша объявлена");
  const dental = terms.termsFor("dental");
  const clinic = terms.termsFor("clinic");
  assert.deepEqual(Object.keys(dental).sort(), Object.keys(clinic).sort(), "набор ключей тот же");
  for (const key of Object.keys(dental)) assert.ok(dental[key], `стоматология: ${key} не пустой`);

  assert.equal(dental.specialist, "стоматолог");
  assert.equal(dental.org, "стоматология");
  // Пациент остаётся пациентом: это медицина, а не салон.
  assert.equal(dental.customer, clinic.customer);
  assert.equal(dental.visit, clinic.visit);

  // Подпись роли тоже говорит словом ниши.
  const labels = (terms as unknown as { staffRoleLabels: (v: string) => Record<string, string> }).staffRoleLabels("dental");
  assert.equal(labels.doctor, "Стоматолог");

  // Реклама: ветки в lib/meta сравнивают с "beauty", поэтому стоматология идёт
  // по СТРОГОЙ медицинской ветке — как клиника. Проверяем это на дисклеймере:
  // он обязан быть медицинским, а не салонным.
  const compliance = await readFile(path.join(repoRoot, "lib", "meta", "compliance.ts"), "utf8");
  assert.ok(/dental: "Результаты индивидуальны/.test(compliance), "оговорка стоматологии — медицинская");

  // Экраны, где ниша перечисляется руками, знают про третью.
  const control = await readFile(path.join(repoRoot, "artifacts", "medina-control", "src", "screens", "Onboarding.tsx"), "utf8");
  assert.ok(/<option value="dental">Стоматология<\/option>/.test(control), "портал предлагает стоматологию");
  const switcher = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "components", "admin", "VerticalSwitch.tsx"), "utf8");
  assert.ok(/title: "Стоматология"/.test(switcher), "переключатель ниши подписан");
});

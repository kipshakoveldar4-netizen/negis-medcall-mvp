import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  readVertical: (value: unknown) => "clinic" | "beauty";
  termsFor: (vertical: "clinic" | "beauty") => Record<string, string>;
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

test("VT10 страница справочников доступна без админ-центра", async () => {
  const app = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "App.tsx"));
  const sidebar = await codeOf(path.join(repoRoot, "artifacts", "negis", "src", "components", "layout", "Sidebar.tsx"));

  assert.ok(/path="\/staff-schedule"/.test(app), "маршрут есть");
  assert.ok(/'\/staff-schedule': 'directory'/.test(app), "и закрыт правом справочников, а не админки");
  assert.ok(/'\/staff-schedule'[\s\S]{0,120}'receptionist'/.test(sidebar), "пункт меню виден регистратору");
  // Подпись пункта зависит от ниши: у клиники врачи, у салона мастера.
  assert.ok(/href === '\/staff-schedule'[\s\S]{0,120}terms\.specialistPlural/.test(sidebar), "подпись — из словаря вертикали");
});

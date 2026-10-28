import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Форма записи по образцу запись.кз: мастер первым, его услуги с ценами,
// цена записи как снимок договорённости, длительность любым числом минут.
//
// Первая версия этих пинов была вакуумной — противник показал, что все семь
// проходят при трёх критичных дефектах. Теперь каждый пин держит гарантию,
// падение которой было реальной находкой ревью.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function read(...parts: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...parts), "utf8");
}

test("BF1 мастер стоит в форме раньше услуги — по самим полям, не по комментариям", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // Ищем сами поля: селект специалиста ставит doctorId и имя, селект услуги —
  // serviceId. Комментарии можно переставить, не двигая JSX; поля — нельзя.
  const doctorSelectAt = page.indexOf("setForm((current) => ({ ...current, doctorId: doctor.id, doctor: doctor.fullName }))");
  const serviceSelectAt = page.indexOf('value={form.serviceId || OTHER_SERVICE_OPTION}');
  assert.ok(doctorSelectAt > 0 && serviceSelectAt > 0, "оба селекта существуют");
  assert.ok(doctorSelectAt < serviceSelectAt, "сначала «к кому», потом «на что» — как в запись.кз");
});

test("BF2 услуга в списке читается с ценой и длительностью, ноль остаётся нулём", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  assert.match(page, /formatArrivalPrice\(String\(service\.basePriceMinor\), "KZT"\)/);
  assert.match(page, /` · \$\{service\.durationMinutes\} мин`/);
  // «Бесплатная консультация» с ценой 0 — осознанный ноль, а не отсутствие
  // цены: readNumber(price, 0) || null ронял его в null.
  assert.ok(
    !page.includes('readNumber(price, 0) || null'),
    "ноль из прайса нельзя превращать в «цена не указана»",
  );
});

test("BF3 пустая цена — null на ОБОИХ слоях, и никакой слой не выдумывает ноль", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const server = await read("lib", "crm", "server.ts");

  // Пустая строка остаётся null; неверная цена теперь отклоняется общим валидатором.
  assert.match(page, /appointmentPriceFromInput\(form\.priceTenge\)/);
  const services = await read("lib", "crm", "appointment-services.ts");
  assert.match(services, /if \(!normalized\) return null/);
  assert.match(services, /items\.every\(\(item\) => item\.priceMinor !== null\)/);

  // Сервер: ключ price_minor попадает в insert только с названной ценой.
  // readNumber(null) === 0 — ровно так пустая цена становилась «бесплатно».
  assert.match(server, /function appointmentPriceColumn\(body: JsonRecord\)/);
  assert.match(server, /if \(!\("priceMinor" in body\) && !\("price_minor" in body\)\) return \{\};/);
  assert.match(server, /const raw = readNullableNumber\(body\.priceMinor \?\? body\.price_minor\);/);
  assert.ok(
    !/price_minor: readNumber\(/.test(server),
    "readNumber для цены запрещён: он превращает null в 0",
  );
  // Потолок — тот же, что у прайса: за пределом «цены нет», а не 502 от базы.
  assert.match(server, /raw > SERVICE_PRICE_MAX_MINOR\) return \{ price_minor: null \};/);
});

test("BF4 длительность — любое число минут каталога, и ввод не искажается", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // Пределы 1..600 совпадают с каталогом услуг: услуга на 47 минут легальна
  // и не должна блокировать отправку формы нативной валидацией.
  assert.match(page, /min=\{1\}\s+max=\{600\}\s+step=\{1\}/);
  assert.ok(!page.includes('<SelectField label="Длительность"'), "закрытый список длительностей ушёл");
  // Кламп — на blur, не на каждом нажатии: покстрочный кламп превращал «45»
  // в 55 («4» клампится в 5, потом дописывается «5»).
  assert.match(page, /onBlur=\{\(\) => \{[\s\S]{0,220}Math\.max\(1, Math\.min\(600/);
  // При отправке валидируется каждая строка и суммарное время, без усечения суммы.
  assert.match(page, /normalizeAppointmentServices\(formServiceItems\(form\)\)/);
  assert.match(page, /durationMinutes: total\.durationMinutes/);
  const services = await read("lib", "crm", "appointment-services.ts");
  assert.match(services, /minutes < 1/);
  assert.match(services, /total\.durationMinutes > 600/);
});

test("BF5 правка записи сохраняет цену — PATCH умеет её писать и чистить", async () => {
  const server = await read("lib", "crm", "server.ts");
  // Ревью: buildPatchRow не знал price_minor — «Сохранить» отвечал успехом,
  // а цена в базе не менялась и на экране откатывалась эхом.
  const patchBranch = server.slice(
    server.indexOf('setRaw("duration_minutes"'),
    server.indexOf('setRaw("duration_minutes"') + 700,
  );
  assert.ok(
    patchBranch.includes('hasAnyKey(body, ["priceMinor", "price_minor"])'),
    "PATCH принимает цену",
  );
  assert.ok(patchBranch.includes("appointmentPriceColumn(body)"), "тем же правилом, что и создание");
  // Чтение наружу — иначе первый же клик «Пришёл» затёр бы цену.
  assert.match(server, /priceMinor: row\.price_minor/);
  // Деградация и русское имя в списке несохранённого.
  assert.match(server, /\["045", \["price_minor"\]\]/);
  assert.match(server, /price_minor: "цена"/);
});

test("BF6 миграция 045: bigint, как у прайса, и безопасна к повтору", async () => {
  const migration = await read("migrations", "045_appointment_price.sql");
  // integer кончается на 21,5 млн тенге — дорогая процедура падала бы 502.
  assert.match(migration, /add column if not exists price_minor bigint/);
  assert.match(migration, /check \(price_minor is null or price_minor >= 0\)/);
  assert.match(migration, /notify pgrst, 'reload schema';/);
});

test("BF7 главный экран ведёт в календарь, и сетку видят все, кто читает всю клинику", async () => {
  const dashboard = await read("artifacts", "negis", "src", "pages", "AiControlCenter.tsx");
  assert.ok(dashboard.includes("Открыть календарь"), "кнопка существует");
  assert.match(dashboard, /rolePermissions\.booking \?/, "кнопка гейтится правом, а не ролью");
  assert.ok(!dashboard.includes("Сетка дня,"), "текст не обещает мастеру вид, которого у него нет");

  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // Ресепшн и управляющий читают все записи клиники тем же правом — сетка им
  // открыта, а не только owner/admin.
  assert.match(page, /const seesWholeClinic =\s*\n?\s*userRole === "owner" \|\| userRole === "admin" \|\| userRole === "manager" \|\| userRole === "receptionist"/);
  assert.match(page, /useState<CalendarView>\(\(\) =>[\s\S]{0,220}"grid"[\s\S]{0,40}"day"/);
});

test("BF8 пустой справочник уводит в день, а не в заглушку «Справочник пуст»", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  assert.match(page, /if \(!directory\.available\) return;/);
  assert.match(page, /setView\(\(current\) => \(current === "grid" \? "day" : current\)\)/);
  // Один раз на загрузке: эффект не спорит с человеком, выбравшим вид руками.
  assert.match(page, /emptyDirectoryHandled\.current = true;/);
});

test("BF9 сброс услуги уносит её цену, а согласованная цена доезжает до продажи", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const sales = await read("artifacts", "negis", "src", "pages", "SalesPage.tsx");

  // «Другая услуга…» и смена мастера снимают цену вместе с услугой: продать
  // «другую услугу» по чужому прайсу — находка ревью.
  assert.match(page, /serviceId: "", priceTenge: "" \}\)\);\s*\n\s*return;/);
  assert.match(page, /setForm\(\(current\) => \(\{ \.\.\.current, serviceId: "", priceTenge: "" \}\)\);/);

  // Продажа видит согласованную цену записи, а не полный прайс.
  assert.match(page, /priceMinor: appointment\.priceMinor,/);
  assert.match(sales, /prefill\.priceMinor \?\? prefill\.price_minor/);
});

test("BF10 архив клиента: проверенный фильтр без совпадения по имени или хвосту телефона", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // Просьба владельца дословно: «сбоку, когда записываешь, должен быть архив».
  assert.ok(page.includes("Архив клиента"), "панель существует и названа по-хозяйски");
  const memo = page.slice(page.indexOf("const visitHistory"), page.indexOf("const openCreate"));
  assert.match(memo, /return matchesAppointmentClientHistory\(form, appointment\);/);
  assert.doesNotMatch(memo, /nameKey|appointment\.client\.trim|\.slice\(-10\)/);
  // Правка не показывает саму себя как «прошлый визит».
  assert.match(memo, /editingId && appointment\.id === editingId\) return false/);
  assert.match(memo, /unique\.set\(appointment\.id, appointment\)/);
  assert.match(memo, /\.sort\(/);
  assert.match(memo, /\.slice\(0, 8\)/);
});

test("BF11 ритм 2/2: выходные пишутся явно, отказ сервера останавливает запись честно", async () => {
  const schedule = await read("artifacts", "negis", "src", "components", "admin", "DoctorSchedule.tsx");
  // Выходной блок — строка «закрыто», а не отсутствие строки: день, не
  // покрытый ничем, у мастера без недельного шаблона читается как «запись не
  // ограничена», и ритм молча превратился бы в «всегда можно».
  assert.match(schedule, /blocks\.push\(\{ from: [\s\S]{0,80}working: false \}\)/);
  // Рабочий блок несёт часы, выходной — нет.
  assert.match(schedule, /if \(block\.working\) \{\s*payload\.startMinute = startMinute;/);
  // Отказ на середине не притворяется успехом и называет счёт.
  assert.ok(schedule.includes("Записано ${written} из ${blocks.length} блоков"), "частичная запись названа вслух");
  assert.ok(schedule.includes("Ритм на период: 2/2, 5/2 или свой"), "секция видна в графике");
});

test("BF12 поиск по услугам в форме: та же подстановка, что и у селекта", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  assert.ok(page.includes("Поиск услуги"), "поле поиска существует");
  // Результаты ограничены и это видно по коду: длинный список — не подсказка.
  assert.match(page, /\.slice\(0, 12\)/);
  // Выбор из результатов заполняет ровно те же поля, что селект: связь, имя,
  // длительность и цену — расхождение путей дало бы записи без цены.
  const searchBlock = page.slice(page.indexOf("serviceMatches.map"), page.indexOf("serviceMatches.map") + 1600);
  for (const field of ["serviceId: service.id", "service: service.name", "durationMinutes: service.durationMinutes", "priceTenge: service.basePriceMinor"]) {
    assert.ok(searchBlock.includes(field), `подстановка поля: ${field}`);
  }
  // Поиск сбрасывается при открытии формы: вчерашний запрос не прячет список.
  assert.match(page, /setServiceSearch\(""\);\s*\n\s*setModalOpen\(true\)/);
});

test("BF13 пустой день мастера называет ближайшую запись, а не молчит", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // «Открыла — пусто» читается как «мои записи пропали»: живой случай Айданы
  // и Дильназ, у обеих ближайшая запись стояла назавтра.
  assert.ok(page.includes("Ближайшая запись —"), "ссылка на ближайшую существует");
  assert.match(page, /setSelectedDate\(dateKeyFromStartsAt\(nextAppointment\.startsAt, clinicTimeZone\)\)/, "и открывает её день в поясе клиники");
});

test("BF14 имя клиента ищется в базе, а выбранная карточка открывает полную историю", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  assert.ok(page.includes("/api/crm/clients?workspaceId="), "форма ищет существующего клиента на сервере");
  assert.ok(page.includes("&search=${encodeURIComponent(query)}"), "имя передаётся как безопасный query parameter");
  assert.ok(page.includes("Клиент найден. История визитов загружается по его карточке."));
  assert.ok(page.includes("&clientId=${encodeURIComponent(form.clientId)}"), "история запрашивается по стабильному client_id");
  assert.ok(page.includes("Загружаем историю клиента…"));
  assert.ok(page.includes("Прошлых визитов у этого клиента пока нет."));
});

test("BF15 новый клиент сохраняется вместе с записью и это сказано оператору", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const server = await read("lib", "crm", "server.ts");
  assert.ok(server.includes("resolveAppointmentClientForCreate"), "серверный write path создаёт или находит карточку");
  assert.ok(server.includes("appointmentClientResolution.clientId"), "client_id доезжает в appointment insert");
  assert.ok(page.includes("Новый клиент будет добавлен в базу после сохранения записи."));
  assert.ok(page.includes("Запись создана, клиент добавлен в базу"));
});

test("BF16 сначала выбирают мастера, затем видят только его прайс или ручную услугу", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const catalogStart = page.indexOf("const formCatalog");
  const catalog = page.slice(catalogStart, page.indexOf("const slots", catalogStart));
  assert.ok(catalog.includes("service.doctorId === selectedDoctorId"), "чужие и общие услуги не попадают в прайс выбранного мастера");
  assert.ok(page.includes("service.id === form.serviceId && service.doctorId === form.doctorId"), "при смене мастера старая общая или чужая услуга снимается");
  assert.ok(catalog.includes("mustChooseDoctorBeforeService"), "услуга заблокирована, пока мастер не выбран");
  assert.ok(page.includes('data-testid="appointment-service-waiting-for-doctor"'));
  assert.ok(page.includes("Сначала выберите ${terms.specialistGenitive} — появятся его услуги с ценами"));
  assert.ok(page.includes("Другая услуга…"), "после выбора мастера остаётся ручная услуга");
  assert.ok(page.includes('"Цена, ₸"') && page.includes('value={form.priceTenge}'), "у ручной услуги остаётся редактируемая цена");
});

test("BF17 все активные CRM-маршруты записи используют одну защищённую форму", async () => {
  const app = await read("artifacts", "negis", "src", "App.tsx");
  assert.match(app, /const AppointmentsRoute = \(\) => <PurposePage mortgage=\{MortgageCalendar\} clinic=\{AppointmentsPage\} permission="booking" \/>/);
  assert.match(app, /<Route path="\/booking" component=\{AppointmentsRoute\} \/>/);
  assert.match(app, /<Route path="\/appointments" component=\{AppointmentsRoute\} \/>/);
  assert.equal((app.match(/component=\{AppointmentsRoute\}/g) || []).length, 2);

  const purposePage = app.match(/function PurposePage\([\s\S]*?\n\}(?=\r?\n|$)/)?.[0];
  assert.ok(purposePage, "the shared booking route must delegate through PurposePage");
  assert.match(purposePage, /^function PurposePage\(\{ mortgage, clinic, permission \}:/);
  assert.match(purposePage, /const \{ workspacePurpose \} = useAuth\(\);\s*return <ProtectedPage component=\{workspacePurpose === 'mortgage_leads' \? mortgage : clinic\} permission=\{workspacePurpose === 'mortgage_leads' \? 'crm' : permission\} \/>;/);

  const protectedPage = app.match(/function ProtectedPage\([\s\S]*?\n\}(?=\r?\n|$)/)?.[0];
  assert.ok(protectedPage, "both booking branches must retain the underlying access guard");
  assert.match(protectedPage, /^function ProtectedPage\(\{\s*component: Component,\s*permission,/);
  assert.match(protectedPage, /const \{ isLoading, user, clinicId, userRole, rolePermissions,[^}]*\} = useAuth\(\);/);
  assert.match(protectedPage, /const \[location, setLocation\] = useLocation\(\);/);
  const roleAllowed = protectedPage.match(/const roleAllowed = ([\s\S]*?);/)?.[1].replace(/\s+/g, " ");
  assert.equal(roleAllowed,
    "userRole === 'lead_manager' ? permission === 'crm' && (location === '/leads' || (workspacePurpose === 'mortgage_leads' && workspaceAllowsRoute(workspacePurpose, userRole, location)))"
    + " : userRole === 'owner' || userRole === 'manager' || !!rolePermissions[permission]");
  assert.match(protectedPage, /const allowed = roleAllowed && workspaceAllowsRoute\(workspacePurpose, userRole, location\);/);
  assert.match(protectedPage, /if \(isLoading\) return null;[\s\S]*if \(!allowed\) return null;[\s\S]*return <Component key=/);
  assert.ok(protectedPage.includes("return <Component key={`${user?.id ?? ''}:${clinicId ?? ''}:${userRole ?? ''}:${workspacePurpose ?? ''}`} />;"),
    "a changed verified actor, company, role or purpose must remount the protected booking branch");
  assert.equal((protectedPage.match(/return <Component key=/g) || []).length, 1);
  assert.ok(!app.includes("DemoAppointments"), "демонстрационная форма не должна быть доступна из маршрутизатора");
});

test("BF18 форма, карточки и календарь передают один пояс клиники во все преобразования времени", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const zoneArgument = new Map([
    ["dateKeyFromStartsAt", 1], ["timeKeyFromStartsAt", 1], ["formFromAppointment", 1],
    ["formatVisitDay", 1], ["describeConflict", 2], ["appointmentFromForm", 2],
  ]);
  const scopes = new Set(["AppointmentsPage", "AppointmentCard", "formFromAppointment", "describeConflict"]);
  let checkedCalls = 0;
  let checkedCards = 0;
  function visit(node: ts.Node, scope = ""): void {
    if (ts.isFunctionDeclaration(node) && node.name) scope = node.name.text;
    if (scopes.has(scope) && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const index = zoneArgument.get(node.expression.text);
      if (index !== undefined) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        assert.equal(node.arguments[index]?.getText(ast), scope === "AppointmentsPage" ? "clinicTimeZone" : "timeZone",
          `${node.expression.text} at line ${line} must not use device-local time`);
        if (node.expression.text === "appointmentFromForm") {
          assert.ok(node.arguments[3], "edit conversion must receive the original instant to preserve a repeated DST minute");
        }
        checkedCalls += 1;
      }
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "AppointmentCard") {
      const zone = node.attributes.properties.find((property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(ast) === "timeZone");
      assert.ok(zone?.initializer && ts.isJsxExpression(zone.initializer));
      assert.equal(zone.initializer.expression?.getText(ast), "clinicTimeZone");
      checkedCards += 1;
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(ast);
  assert.ok(checkedCalls >= 10, "calendar, edit, restore, cards and history must retain their real time conversions");
  assert.equal(checkedCards, 2, "both day and list cards must receive clinic time");
});

test("BF19 разные пояса устройства и клиники не отключают подсказки свободного времени", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "formSlots"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, "the real free-slot calculation remains mounted");
  assert.doesNotMatch(callback, /clinicTimeZone\s*!==\s*deviceTimeZone/);
  assert.match(callback, /minuteOfClinicDay\(appointment\.startsAt, clinicTimeZone\)/);
  assert.match(callback, /isOnDay\(appointment, form\.date, clinicTimeZone\)/);
});

test("BF20 создание, правка, восстановление и отправка формы ждут известного пояса клиники", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const guardedActions = new Map<string, ts.ArrowFunction>();
  let restoreEffect: ts.ArrowFunction | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ["openCreate", "openEdit", "submitForm"].includes(node.name.text)
      && node.initializer && ts.isArrowFunction(node.initializer)) guardedActions.set(node.name.text, node.initializer);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && callback.getText(ast).includes("restoreAppointmentCreateAttempt(")) restoreEffect = callback;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(guardedActions.size, 3);
  assert.ok(restoreEffect);
  guardedActions.set("restore", restoreEffect);
  for (const [name, callback] of guardedActions) {
    assert.ok(ts.isBlock(callback.body));
    const guard = callback.body.statements.find((statement): statement is ts.IfStatement => ts.isIfStatement(statement)
      && statement.expression.getText(ast).includes("!clinicTimeZoneReady"));
    assert.ok(guard, `${name} must reject an unresolved clock before using device fallback`);
    let returns = false;
    function findReturn(node: ts.Node): void {
      if (ts.isReturnStatement(node)) returns = true;
      ts.forEachChild(node, findReturn);
    }
    findReturn(guard.thenStatement);
    assert.equal(returns, true, `${name} must actually stop, not only display a warning`);
    const firstConversion = callback.body.getText(ast).search(/(?:setForm|appointmentFromForm|restoreAppointmentCreateAttempt)\(/);
    assert.ok(firstConversion >= 0);
    assert.ok(guard.getStart(ast) - callback.body.getStart(ast) < firstConversion, `${name} guards the first conversion`);
  }
  assert.match(page, /const \[clinicTimeZoneReady, setClinicTimeZoneReady\] = useState\(\(\) => !isRealWorkspace\(\)\)/);
});

type PriceNode = { type: unknown; props: Record<string, unknown> };
type PriceChild = PriceNode | string | number | null | boolean | PriceChild[];

function priceJsx(type: unknown, props: Record<string, unknown> | null, ...children: PriceChild[]): PriceNode {
  return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
}

function priceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(priceText).join("");
  if (value && typeof value === "object" && "props" in value) return priceText((value as PriceNode).props.children);
  return "";
}

function compactPrice(value: unknown): string {
  return priceText(value).replace(/[\s\u00a0\u202f]+/g, "");
}

async function actualAppointmentPriceViews() {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helperNames = ["normalizeStatus", "pad", "toTimeKey", "timeKeyFromStartsAt", "getAppointmentStatusLabel",
    "getAppointmentStatusClass", "statusBadge", "Detail", "AppointmentCard"];
  const selected = helperNames.map((name) => {
    const node = ast.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `execute the real price component and helpers: missing ${name}`);
    return node.getText(ast);
  });
  for (const name of ["allowedStatusMoves", "statusButtonLabels"]) {
    let initializer: ts.Expression | undefined;
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const variable = statement.declarationList.declarations.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
      if (variable?.initializer) initializer = variable.initializer;
    }
    assert.ok(initializer, `actual card policy missing: ${name}`);
    selected.push(`const ${name} = ${initializer.getText(ast)};`);
  }
  let historyPrice: ts.ConditionalExpression | undefined;
  let totalPrice: ts.ConditionalExpression | undefined;
  const optionPrices: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isConditionalExpression(node) && node.condition.getText(ast).replace(/\s/g, "") === "visit.priceMinor!==null") historyPrice = node;
    if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)
      && node.expression.condition.getText(ast).includes("totalPriceMinor")) totalPrice = node.expression;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "price" && node.initializer
      && node.initializer.getText(ast).includes("service.basePriceMinor")) optionPrices.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(historyPrice, "execute the real history-price conditional, including its null branch");
  assert.ok(totalPrice, "execute the real booking-total conditional");
  assert.equal(optionPrices.length, 2, "both catalogue selectors retain their own real price label");
  const historyPriceExpression = historyPrice;
  const totalPriceExpression = totalPrice;
  const require = createRequire(import.meta.url);
  const bindings: Record<string, unknown> = {
    ...require(path.join(repoRoot, "lib/vertical/terms.ts")),
    ...require(path.join(repoRoot, "lib/crm/operator-contracts.ts")),
    ...require(path.join(repoRoot, "artifacts/negis/src/lib/clinicDateTime.ts")),
    ...require(path.join(repoRoot, "artifacts/negis/src/lib/phone.ts")),
    jsx: priceJsx, useAuth: () => ({ vertical: "clinic", userRole: "owner" }), MessageCircle: "MessageCircle", PhoneCall: "PhoneCall",
  };
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "jsx",
  };
  const cardCode = ts.transpileModule(`${selected.join("\n")}\nreturn AppointmentCard;`, { compilerOptions }).outputText;
  const card = new Function("exports", ...Object.keys(bindings), cardCode)({}, ...Object.values(bindings)) as (
    props: { appointment: Record<string, unknown>; timeZone: string; onEdit(): void; onStatus(): void; onSale(): void },
  ) => PriceNode;
  function expression(source: ts.Expression, values: Record<string, unknown>): unknown {
    const code = ts.transpileModule(`return (${source.getText(ast)});`, { compilerOptions }).outputText;
    const scope = { ...bindings, ...values };
    return new Function(...Object.keys(scope), code)(...Object.values(scope));
  }
  return {
    card(minor: number | null): PriceNode[] {
      const tree = card({
        appointment: {
          id: "local-price-display", client: "Local price fixture", phone: "", whatsapp: "", startsAt: "2026-10-19T04:10:00.000Z",
          service: "Local consultation", doctor: "Local specialist", durationMinutes: 45, status: "scheduled", priceMinor: minor,
        },
        timeZone: "Asia/Almaty", onEdit() {}, onStatus() {}, onSale() {},
      });
      const prices: PriceNode[] = [];
      function find(value: unknown): void {
        if (Array.isArray(value)) { value.forEach(find); return; }
        if (!value || typeof value !== "object" || !("props" in value)) return;
        const node = value as PriceNode;
        if (node.props.label === "Цена") prices.push(node);
        find(node.props.children);
      }
      find(tree);
      return prices;
    },
    history: (minor: number | null) => expression(historyPriceExpression, { visit: { priceMinor: minor } }),
    total: (minor: number | null) => expression(totalPriceExpression, { totalPriceMinor: minor }),
    options: (minor: number | null) => optionPrices.map((node) => expression(node, { service: { basePriceMinor: minor } })),
  };
}

const appointmentPriceViews = await actualAppointmentPriceViews();
const priceDisplayCases = [
  { minor: 10050, expected: "100,50₸" },
  { minor: 1, expected: "0,01₸" },
  { minor: 0, expected: "0₸" },
  { minor: 700050, expected: "7000,50₸" },
  { minor: Number.MAX_SAFE_INTEGER, expected: "90071992547409,91₸" },
];

for (const { minor, expected } of priceDisplayCases) {
  test(`BF-PRICE actual AppointmentCard displays exact ${minor} minor units`, () => {
    const cards = appointmentPriceViews.card(minor);
    assert.equal(cards.length, 1);
    assert.equal(compactPrice(cards[0]), expected);
  });
  test(`BF-PRICE actual visit-history JSX displays exact ${minor} minor units`, () => {
    assert.equal(compactPrice(appointmentPriceViews.history(minor)), `·${expected}`);
  });
  test(`BF-PRICE catalogue labels and total retain exact ${minor} minor units`, () => {
    assert.equal(compactPrice(appointmentPriceViews.total(minor)), expected);
    assert.deepEqual(appointmentPriceViews.options(minor).map(compactPrice), [`—${expected}`, `—${expected}`]);
  });
}

test("BF-PRICE null is unknown, never a fabricated free appointment", () => {
  assert.deepEqual(appointmentPriceViews.card(null), []);
  assert.equal(appointmentPriceViews.history(null), null);
  assert.equal(appointmentPriceViews.total(null), "цена не указана для всех услуг");
  assert.deepEqual(appointmentPriceViews.options(null), ["", ""]);
  assert.equal(compactPrice(appointmentPriceViews.card(0)[0]), "0₸");
});

test("BF-PRICE all five presentation points share the existing exact formatter without rounding", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expected = new Map([["appointment.priceMinor", 0], ["visit.priceMinor", 0], ["service.basePriceMinor", 0], ["totalPriceMinor", 0]]);
  const priceFields = /\b(?:appointment\.priceMinor|visit\.priceMinor|service\.basePriceMinor|totalPriceMinor)\b/;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const text = node.getText(ast);
      if (callee === "Math.round") assert.doesNotMatch(text, priceFields, "rounding minutes is allowed; rounding prices is not");
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toLocaleString") {
        assert.doesNotMatch(text, priceFields, "formatting a divided floating-point price loses exact minor units");
      }
      if (callee === "formatArrivalPrice") {
        const stringified = node.arguments[0];
        assert.ok(stringified && ts.isCallExpression(stringified) && stringified.expression.getText(ast) === "String");
        const field = stringified.arguments[0]?.getText(ast) ?? "";
        assert.ok(expected.has(field), `unexpected displayed price field ${field}`);
        assert.equal(node.arguments[1]?.getText(ast), '"KZT"');
        expected.set(field, expected.get(field)! + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.deepEqual([...expected], [["appointment.priceMinor", 1], ["visit.priceMinor", 1], ["service.basePriceMinor", 2], ["totalPriceMinor", 1]]);
});

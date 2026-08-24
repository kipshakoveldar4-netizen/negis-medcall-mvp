import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(page, /Math\.round\(service\.basePriceMinor \/ 100\)\.toLocaleString\("ru-RU"\)/);
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

  // Клиент: пустая строка, нечисло и минус — null.
  assert.match(page, /form\.priceTenge\.trim\(\) === "" \|\| !Number\.isFinite\(raw\) \|\| raw < 0\) return null/);

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
  // И при отправке — сервер не должен получать 0 от стёртого поля.
  assert.match(page, /durationMinutes: Math\.max\(1, Math\.min\(600, form\.durationMinutes \|\| 60\)\)/);
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

test("BF10 архив клиента в форме: история ищется по карточке, телефону и имени", async () => {
  const page = await read("artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
  // Просьба владельца дословно: «сбоку, когда записываешь, должен быть архив».
  assert.ok(page.includes("Архив клиента"), "панель существует и названа по-хозяйски");
  // Порядок ключей поиска: карточка сильнее телефона, телефон сильнее имени.
  const memo = page.slice(page.indexOf("const visitHistory"), page.indexOf("const openCreate"));
  assert.ok(memo.indexOf("appointment.clientId === form.clientId") < memo.indexOf("appointmentPhone === phoneKey"));
  assert.ok(memo.indexOf("appointmentPhone === phoneKey") < memo.indexOf("appointment.client.trim().toLowerCase() === nameKey"));
  // Правка не показывает саму себя как «прошлый визит».
  assert.match(memo, /editingId && appointment\.id === editingId\) return false/);
  // Телефон сравнивается последними десятью цифрами: +7 и 8 — один человек.
  assert.ok(memo.includes('.slice(-10)'), "телефон сравнивается последними десятью цифрами: +7 и 8 — один человек");
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

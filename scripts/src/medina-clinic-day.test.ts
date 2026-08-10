import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CD — «сегодня» это сутки клиники.
//
// На один вопрос в продукте было три ответа, и все три неверны. Сводка считала
// день через toISOString(), то есть в UTC, под комментарием «текущая локальная
// дата»: в UTC+5 она называла чужие сутки примерно пять часов каждую ночь, и
// «записей сегодня» вместе с «выручкой за сегодня» в это время были не про
// сегодня. Главный экран сравнивал getFullYear/getMonth/getDate — сутки
// ноутбука оператора. Экран записей замораживал «сегодня» в момент загрузки.
//
// Ошибка не требует большого объёма данных: при трёх записях в базе она ровно
// та же. Поэтому проверки ниже ставят время в вечер по Гринвичу — единственный
// диапазон, где разница между тремя ответами видна.
//
// Ничего здесь не обращается к production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = path.join(repoRoot, "artifacts", "negis", "src", "lib", "clinicDay.ts");
const dashboardPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "Dashboard.tsx");
const controlCenterPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AiControlCenter.tsx");
const appointmentsPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");

type ClinicDayModule = {
  dayKeyInZone: (instantMs: number, timeZone: string) => string;
  clinicToday: (timeZone: string, now?: number) => string;
  isOnClinicDay: (value: unknown, dayKey: string, timeZone: string) => boolean;
  deviceTimeZone: () => string;
};

const clinicDay = (await import(pathToFileURL(helperPath).href)) as ClinicDayModule;
const { dayKeyInZone, clinicToday, isOnClinicDay } = clinicDay;

/** 2026-09-07T20:00Z — вечер понедельника в Гринвиче, уже вторник в Алматы. */
const EVENING_UTC = Date.parse("2026-09-07T20:00:00.000Z");

test("CD1 вечер по Гринвичу — это уже следующий день клиники", () => {
  assert.equal(dayKeyInZone(EVENING_UTC, "Asia/Almaty"), "2026-09-08");
  assert.equal(dayKeyInZone(EVENING_UTC, "UTC"), "2026-09-07");
  // Именно эти пять часов каждую ночь сводка и называла чужими сутками.
  assert.notEqual(dayKeyInZone(EVENING_UTC, "Asia/Almaty"), dayKeyInZone(EVENING_UTC, "UTC"));
});

test("CD2 без пояса клиники считаем по устройству и не притворяемся Гринвичем", () => {
  // Молчаливый откат на UTC выглядит как часовой пояс, но им не является
  // нигде, кроме Гринвича. Ответ обязан совпасть с сутками машины.
  const local = new Date(EVENING_UTC);
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  assert.equal(dayKeyInZone(EVENING_UTC, ""), expected);
});

test("CD3 непонятный пояс не роняет экран", () => {
  assert.equal(dayKeyInZone(EVENING_UTC, "Не/Пояс"), dayKeyInZone(EVENING_UTC, ""));
});

test("CD4 голая дата не переводится между поясами", () => {
  // «2026-09-07» — это уже календарный день, а не мгновение. Сдвиг превратил
  // бы его в соседний, и запись уехала бы в другие сутки на ровном месте.
  assert.equal(isOnClinicDay("2026-09-07", "2026-09-07", "Asia/Almaty"), true);
  assert.equal(isOnClinicDay("2026-09-07", "2026-09-08", "Asia/Almaty"), false);
});

test("CD5 мгновение попадает в сутки клиники, а не в сутки Гринвича", () => {
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-08", "Asia/Almaty"), true);
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-07", "Asia/Almaty"), false);
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-07", "UTC"), true);
});

test("CD6 мусор и пустая дата — это «нет», а не «сегодня»", () => {
  for (const value of ["", "   ", "не дата", null, undefined, 42]) {
    assert.equal(isOnClinicDay(value, "2026-09-08", "Asia/Almaty"), false, String(value));
  }
});

test("CD7 clinicToday берёт переданное мгновение, а не только текущее", () => {
  assert.equal(clinicToday("Asia/Almaty", EVENING_UTC), "2026-09-08");
});

test("CD8 сводка больше не считает день в Гринвиче", async () => {
  const source = await readFile(dashboardPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(code),
    "toISOString — это Гринвич, а комментарий рядом обещал локальную дату",
  );
  assert.ok(code.includes("clinicToday("), "день берётся из общего помощника");
  assert.ok(code.includes("isOnClinicDay("), "и сравнивается им же");
});

test("CD9 главный экран больше не считает день по ноутбуку оператора", async () => {
  const source = await readFile(controlCenterPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/date\.getFullYear\(\) === now\.getFullYear\(\)/.test(code),
    "getFullYear/getMonth/getDate читают пояс машины, а не клиники",
  );
  assert.ok(code.includes("clinicToday("), "день берётся из общего помощника");

  // Счётчик, который считался на каждой загрузке и не выводился нигде.
  // Проверка идёт по самостоятельному имени: `unattributedLeads` содержит
  // ту же подстроку, живёт рядом и используется по-настоящему.
  assert.ok(
    !/(?<![A-Za-z])attributedLeads/.test(code),
    "мёртвый счётчик удалён вместе с его вычислением",
  );
});

test("CD10 «Сегодня записей» перестаёт быть замороженным при загрузке", async () => {
  const source = await readFile(appointmentsPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/todayAppointments = useMemo\(\s*\(\) => items\.filter\(\(appointment\) => isSameDate\(appointment, todayKeyAtLoad\)\), \[items\]\)/.test(code),
    "вкладка, оставленная на ночь, показывала вчерашние записи бесконечно",
  );
  assert.ok(/todayAppointments = useMemo\([\s\S]{0,200}todayKey/.test(code), "счёт идёт по текущему дню клиники");
  assert.ok(/setInterval\(tick, 60_000\)/.test(code), "и переводится в полночь клиники сам");
});

test("CD11 пояс клиники приезжает вместе со списком записей", async () => {
  const server = await readFile(serverPath, "utf8");
  // Настройки открыты только владельцу и администратору: экран, спросивший их
  // напрямую, получил бы отказ и сказал бы «пояс не задан» клинике, которая
  // его задала. Тот же приём уже применён к графику врача.
  assert.ok(
    /resource === "doctor-schedule" \|\| resource === "appointments"/.test(server),
    "пояс читается и для записей тоже",
  );
  assert.ok(
    /\.\.\.\(resource === "appointments" \? \{ timeZone: scheduleTimeZone \} : \{\}\)/.test(server),
    "и уезжает в ответе списка",
  );

  for (const [file, label] of [[dashboardPath, "сводка"], [controlCenterPath, "главный экран"]] as const) {
    const source = await readFile(file, "utf8");
    assert.ok(source.includes("timeZone"), `${label} обязан прочитать пояс из ответа`);
  }
});

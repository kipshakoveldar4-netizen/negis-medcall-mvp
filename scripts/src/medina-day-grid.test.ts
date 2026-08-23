import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Общий календарь дня: колонка на мастера.
//
// Владелец прислал снимок чужого календаря: «сделай такой, все записи всех
// мастеров, чтобы только владелец и админы видели общую информацию». Здесь
// проверяется арифметика сетки — минуты, наложения, закраска нерабочего
// времени и границы дня. Разметку проверять нечем, а вот эти четыре вещи
// ломаются молча и выглядят на экране правдоподобно.
//
// Ничто здесь не ходит в production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gridPath = path.join(repoRoot, "artifacts", "negis", "src", "lib", "dayGrid.ts");

// Тип описан здесь, а не через typeof import: набор компилируется своим
// tsconfig с rootDir = scripts/src, и ссылка на файл фронтенда его ломает.
// Модуль всё равно грузится настоящий — расхождение поймает первый же тест.
type Shift = {
  doctorId: string; weekday: number | null; onDate: string; onDateEnd: string;
  isWorking: boolean; startMinute: number | null; endMinute: number | null;
};
type Visit = { id: string; doctorId: string; doctor: string; startsAt: string; durationMinutes: number };
type Placed = { item: Visit; startMinute: number; endMinute: number; lane: number; lanes: number };
type GridModule = {
  minuteOfClinicDay: (startsAt: string, timeZone: string) => number | null;
  placeColumn: (items: readonly Visit[], timeZone: string) => { placed: Placed[]; unreadable: Visit[] };
  workingIntervals: (shifts: readonly Shift[], doctorId: string, dateKey: string, isoWeekday: number) => Array<[number, number]>;
  gridBounds: (starts: readonly number[], intervals: readonly (readonly [number, number])[]) => [number, number];
  freeSlots: (input: {
    intervals: ReadonlyArray<readonly [number, number]>;
    busy: ReadonlyArray<readonly [number, number]>;
    durationMinutes: number;
    nowMinute: number | null;
    stepMinutes?: number;
  }) => number[];
  groupSlots: (slots: readonly number[]) => Array<{ label: string; slots: number[] }>;
};
const grid: GridModule = (await import(pathToFileURL(gridPath).href)) as GridModule;

const visit = (id: string, startsAt: string, durationMinutes = 60) => ({
  id, doctorId: "d1", doctor: "Айдана", startsAt, durationMinutes,
});

/** Астана — UTC+5, перевода часов нет. 06:00Z = 11:00 по клинике. */
const ALMATY = "Asia/Almaty";

test("DG1 время записи читается в поясе клиники, а не устройства", () => {
  assert.equal(grid.minuteOfClinicDay("2026-08-20T06:00:00.000Z", ALMATY), 11 * 60);
  assert.equal(grid.minuteOfClinicDay("2026-08-20T19:30:00.000Z", ALMATY), 30, "полночь клиники — ноль минут");
});

test("DG2 нечитаемое время не превращается в девять утра", () => {
  assert.equal(grid.minuteOfClinicDay("не время", ALMATY), null);
  assert.equal(grid.minuteOfClinicDay("", ALMATY), null);
});

test("DG3 непересекающиеся записи занимают всю ширину колонки", () => {
  const { placed } = grid.placeColumn(
    [visit("a", "2026-08-20T04:00:00.000Z"), visit("b", "2026-08-20T06:00:00.000Z")],
    ALMATY,
  );
  assert.deepEqual(placed.map((entry) => entry.lanes), [1, 1]);
  assert.deepEqual(placed.map((entry) => entry.lane), [0, 0]);
});

test("DG4 наложение делит колонку, а не прячет второго клиента", () => {
  const { placed } = grid.placeColumn(
    [visit("a", "2026-08-20T04:00:00.000Z"), visit("b", "2026-08-20T04:30:00.000Z")],
    ALMATY,
  );
  assert.deepEqual(placed.map((entry) => entry.lanes), [2, 2]);
  assert.deepEqual(placed.map((entry) => entry.lane).sort(), [0, 1]);
});

test("DG5 цепочка пересечений делит ширину один раз, а не по числу записей", () => {
  // 10:00–11:00, 10:30–11:30, 11:00–12:00. Средняя связывает крайние в одну
  // группу, но первая и третья друг с другом НЕ пересекаются — третья встаёт
  // на освободившуюся дорожку первой. Делить колонку на три значило бы сузить
  // блоки втрое там, где двух хватает: на телефоне это разница между читаемым
  // именем клиента и полоской.
  const { placed } = grid.placeColumn([
    visit("a", "2026-08-20T04:00:00.000Z", 60),
    visit("b", "2026-08-20T04:30:00.000Z", 60),
    visit("c", "2026-08-20T05:00:00.000Z", 60),
  ], ALMATY);
  assert.deepEqual(placed.map((entry) => entry.lanes), [2, 2, 2]);
  assert.deepEqual(placed.map((entry) => entry.lane), [0, 1, 0], "третья занимает дорожку первой");
});

test("DG5b три записи в одном часе делят колонку на три", () => {
  const { placed } = grid.placeColumn([
    visit("a", "2026-08-20T04:00:00.000Z", 60),
    visit("b", "2026-08-20T04:10:00.000Z", 60),
    visit("c", "2026-08-20T04:20:00.000Z", 60),
  ], ALMATY);
  assert.deepEqual(placed.map((entry) => entry.lanes), [3, 3, 3]);
  assert.deepEqual(placed.map((entry) => entry.lane), [0, 1, 2]);
});

test("DG6 запись без длительности занимает час, а не ноль высоты", () => {
  const { placed } = grid.placeColumn([visit("a", "2026-08-20T04:00:00.000Z", 0)], ALMATY);
  assert.equal(placed[0].endMinute - placed[0].startMinute, 60);
});

test("DG7 запись с нечитаемым временем уходит в отдельный список, а не на сетку", () => {
  const { placed, unreadable } = grid.placeColumn(
    [visit("a", "2026-08-20T04:00:00.000Z"), visit("b", "мусор")],
    ALMATY,
  );
  assert.equal(placed.length, 1);
  assert.deepEqual(unreadable.map((item) => item.id), ["b"]);
});

const shift = (over: Partial<Shift> = {}) => ({
  doctorId: "d1", weekday: null as number | null, onDate: "", onDateEnd: "",
  isWorking: true, startMinute: 9 * 60, endMinute: 21 * 60, ...over,
});

test("DG8 недельная смена даёт часы приёма", () => {
  const intervals = grid.workingIntervals([shift({ weekday: 4 })], "d1", "2026-08-20", 4);
  assert.deepEqual(intervals, [[540, 1260]]);
});

test("DG9 закрытое окно вырезается из смены, а не отменяет день", () => {
  // Тот самый дефект, из-за которого «закрыть окно на дату» закрывало сутки.
  const intervals = grid.workingIntervals([
    shift({ weekday: 4 }),
    shift({ onDate: "2026-08-20", onDateEnd: "2026-08-20", isWorking: false, startMinute: 14 * 60, endMinute: 16 * 60 }),
  ], "d1", "2026-08-20", 4);
  assert.deepEqual(intervals, [[540, 840], [960, 1260]]);
});

test("DG10 особые часы на дату замещают недельный образец", () => {
  const intervals = grid.workingIntervals([
    shift({ weekday: 4 }),
    shift({ onDate: "2026-08-20", onDateEnd: "2026-08-20", startMinute: 10 * 60, endMinute: 15 * 60 }),
  ], "d1", "2026-08-20", 4);
  assert.deepEqual(intervals, [[600, 900]]);
});

test("DG11 выходной закрывает день целиком", () => {
  const intervals = grid.workingIntervals([
    shift({ weekday: 4 }),
    shift({ onDate: "2026-08-20", onDateEnd: "2026-08-20", isWorking: false, startMinute: null, endMinute: null }),
  ], "d1", "2026-08-20", 4);
  assert.deepEqual(intervals, []);
});

test("DG12 график чужого мастера в колонку не попадает", () => {
  const intervals = grid.workingIntervals([{ ...shift({ weekday: 4 }), doctorId: "d2" }], "d1", "2026-08-20", 4);
  assert.deepEqual(intervals, []);
});

test("DG13 сетка растягивается под ранние и поздние записи", () => {
  assert.deepEqual(grid.gridBounds([], []), [540, 1260], "по умолчанию рабочий день салона");
  assert.deepEqual(grid.gridBounds([8 * 60 + 40, 22 * 60 + 10], []), [480, 1380], "и округляется до часа");
});

test("DG14 общий календарь показывается владельцу и администратору, а мастеру — нет", async () => {
  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");
  assert.ok(
    /const seesWholeClinic = userRole === "owner" \|\| userRole === "admin";/.test(page),
    "право видеть весь день названо явно",
  );
  assert.ok(/view === "grid" && seesWholeClinic/.test(page), "и проверяется на самом виде, а не только на кнопке");
});

test("DG15 колонки — карточки справочника, а записи без карточки не пропадают", async () => {
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "master-day-grid.tsx"),
    "utf8",
  );
  assert.ok(/Без карточки/.test(source), "для записей со свободным именем есть своя колонка");
  assert.ok(/Вне сетки/.test(source), "а для нечитаемого времени — отдельный список");
});

test("DG16 в календарь можно писать: пустое место — это «записать сюда»", async () => {
  // Календарь, в который нельзя писать, заставляет держать в голове два
  // экрана: здесь смотрю, там завожу. Клик по пустому месту отдаёт мастера
  // колонки и время с округлением до получаса.
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "master-day-grid.tsx"),
    "utf8",
  );
  assert.ok(/onCreate: \(input: \{ doctorId: string; doctorName: string; time: string \}\) => void/.test(source));
  assert.ok(/Math\.floor\(\(event\.clientY - box\.top\) \/ MINUTE \/ 30\) \* 30/.test(source), "время округляется до получаса");
  assert.ok(/target\.closest\("\[data-appointment\]"\)\) return;/.test(source), "клик по самой записи открывает её, а не заводит новую");

  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");
  assert.ok(/onCreate=\{\(\{ doctorId, doctorName, time \}\)/.test(page), "экран принимает клик");
  assert.ok(/openCreate\(selectedDate, time\)/.test(page), "и открывает форму на выбранный день и час");
});

test("DG17 быстрые статусы на блоке не подменяют открытие карточки", async () => {
  // Три точки — пришёл, не пришёл, отмена — самая частая операция дня.
  // Клик по ним не должен проваливаться в открытие карточки, а сами точки
  // показываются только на живой записи: закрытой менять нечего.
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "master-day-grid.tsx"),
    "utf8",
  );
  assert.ok(/onQuickStatus: \(id: string, status: "arrived" \| "no_show" \| "cancelled"\) => void/.test(source));
  assert.ok(/onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(source), "клик по точкам не открывает карточку");
  assert.ok(
    /const quickable = entry\.item\.status === "scheduled" \|\| entry\.item\.status === "confirmed";/.test(source),
    "точки только на живой записи",
  );
  assert.ok(/entry\.item\.phone \?/.test(source), "телефон на блоке — позвонить, не открывая карточку");

  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");
  assert.ok(/void updateAppointmentStatus\(appointment, status\)/.test(page), "статус идёт тем же путём, что кнопки списка");
  assert.ok(/addDaysKey\(selectedDate, -1\)/.test(page) && /addDaysKey\(selectedDate, 1\)/.test(page), "стрелки по дням");
});

// ── Свободные слоты: сердце записи как в запись.кз ─────────────────────────

test("FS1 слот свободен, только если услуга помещается целиком", () => {
  // Окно 10:00–13:00, услуга 90 минут: последний честный слот — 11:30.
  const slots = grid.freeSlots({ intervals: [[600, 780]], busy: [], durationMinutes: 90, nowMinute: null });
  assert.deepEqual(slots, [600, 630, 660, 690]);
});

test("FS2 занятая запись выбивает все слоты, которые её задевают", () => {
  // Запись 12:00–13:00. Услуга 60 минут: слоты 11:30 и 12:30 исчезают тоже —
  // услуга, начатая в 11:30, наехала бы на клиента в 12:00.
  const slots = grid.freeSlots({ intervals: [[600, 840]], busy: [[720, 780]], durationMinutes: 60, nowMinute: null });
  assert.deepEqual(slots, [600, 630, 660, 780]);
});

test("FS3 сегодня прошедшее время не предлагается", () => {
  const slots = grid.freeSlots({ intervals: [[600, 720]], busy: [], durationMinutes: 30, nowMinute: 630 });
  assert.deepEqual(slots, [660, 690], "10:00 и 10:30 уже прошли — их нет");
});

test("FS4 окно, начатое не на границе шага, даёт слоты по сетке", () => {
  // Смена с 10:15: первый слот — 10:30, а не 10:15 и не 10:00.
  const slots = grid.freeSlots({ intervals: [[615, 720]], busy: [], durationMinutes: 30, nowMinute: null });
  assert.deepEqual(slots, [630, 660, 690]);
});

test("FS5 закрытое окно посреди дня режет слоты с обеих сторон", () => {
  // Рабочие куски 10:00–12:00 и 14:00–16:00 (обед закрыт). Услуга 60 минут.
  const slots = grid.freeSlots({
    intervals: [[600, 720], [840, 960]],
    busy: [],
    durationMinutes: 60,
    nowMinute: null,
  });
  assert.deepEqual(slots, [600, 630, 660, 840, 870, 900]);
});

test("FS6 группировка как у запись.кз: утро, день, вечер", () => {
  const groups = grid.groupSlots([600, 660, 750, 1080, 1140]);
  assert.deepEqual(
    groups.map((group) => `${group.label}:${group.slots.length}`),
    ["Утро:2", "День:1", "Вечер:2"],
  );
  assert.deepEqual(grid.groupSlots([]), [], "пустой список не рисует пустых групп");
});

test("FS7 нулевая и бессмысленная длительность не роняют расчёт", () => {
  assert.deepEqual(
    grid.freeSlots({ intervals: [[600, 690]], busy: [], durationMinutes: 0, nowMinute: null }),
    [600, 630],
    "нулевая длительность считается часом",
  );
  assert.deepEqual(grid.freeSlots({ intervals: [], busy: [], durationMinutes: 60, nowMinute: null }), []);
});

test("FS8 форма записей действительно пользуется движком слотов", async () => {
  // Слоты, посчитанные где-то сбоку и никуда не подключённые, — это то, что
  // сверка со спецификацией уже находила: код есть, пользователю недоступен.
  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");
  assert.match(page, /freeSlots\(\{/, "форма считает слоты движком, а не своей копией");
  assert.match(page, /groupSlots\(slots\)/, "группировка утро/день/вечер — как в запись.кз");
  assert.ok(page.includes("Свободное время"), "секция названа на экране");
  // Правка не считает саму себя занятостью — иначе перенос записи показывал
  // бы её старое время занятым.
  assert.match(page, /appointment\.id === editingId\) return false/);
  // График не задан — слоты по обычному дню, а не молчаливое исчезновение.
  assert.match(page, /\[\[9 \* 60, 21 \* 60\]\]/);
  // Месячный вид существует и открывает день по клику.
  assert.match(page, /"month"/);
  assert.ok(page.includes('month: "Месяц"'), "переключатель называет месяц");
});

test("FS9 ревью-находки закрыты и не вернутся", async () => {
  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");

  // День записи — по часам САЛОНА, обеими половинами расчёта: занятость через
  // isOnDay, месяц через dayKeyInZone. Смешение «день по устройству, минута по
  // салону» здесь уже ловили дважды.
  assert.match(page, /!isOnDay\(appointment, form\.date, clinicTimeZone\)\) return false/);
  const monthBlock = page.slice(page.indexOf("const countByDay"), page.indexOf("const cells:"));
  assert.ok(monthBlock.includes("dayKeyInZone(instant, clinicTimeZone)"), "месяц раскладывает дни по поясу салона");
  assert.ok(!monthBlock.includes("dateKeyFromStartsAt"), "день устройства в месяц не возвращается");
  assert.ok(monthBlock.includes("Number.isFinite(instant)"), "нечитаемая дата — «не знаю», а не «сегодня»");
  assert.ok(!monthBlock.includes("activeStatuses"), "фильтр «Отменено» не должен рисовать пустой месяц");

  // При несовпадении поясов подсказка прячется с объяснением, а не врёт.
  assert.match(page, /clinicTimeZone !== deviceTimeZone[\s\S]{0,120}другой пояс/);
  assert.ok(page.includes("часы устройства не совпадают с часами салона"), "причина названа человеку");

  // Пустота пустоте рознь: четыре причины, а не одно «всё занято».
  for (const phrase of [
    "Рабочий день уже закончился",
    "не помещается в рабочее окно",
    "всё занято записями",
    "День закрыт: выходной или закрытое окно",
  ]) {
    assert.ok(page.includes(phrase), `причина «${phrase}» названа своими словами`);
  }

  // Одна строка-отпуск на сентябрь не закрывает весь август: «график описывает
  // ЭТОТ день» проверяется по покрытию даты, а не по наличию любой строки.
  assert.match(page, /const definesThisDay = mine\.some/);

  // Мастер без селекта специалиста получает слоты через собственную карточку.
  assert.match(page, /userRole === "doctor" && !form\.doctorId/);
});

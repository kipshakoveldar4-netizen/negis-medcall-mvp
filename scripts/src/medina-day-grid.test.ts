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

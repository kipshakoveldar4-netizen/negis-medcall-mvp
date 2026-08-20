/**
 * Геометрия сетки дня: колонка на мастера, запись — прямоугольник.
 *
 * Владелец прислал снимок чужого календаря и попросил такой же: столбцы
 * мастеров, часы слева, блоки записей на своих местах. Считать это прямо в
 * разметке нельзя — арифметика минут и наложений проверяется тестами, а не
 * глазами по скриншоту.
 *
 * Всё здесь — чистые функции: ни времени устройства, ни DOM. Час клиники
 * приходит извне, потому что «сейчас» у салона в Астане и у ноутбука в другом
 * поясе — разные вещи, и один этот промах уже стоил продукту дня (см.
 * isOnClinicDay).
 */

export type GridAppointment = {
  id: string;
  doctorId: string;
  doctor: string;
  startsAt: string;
  durationMinutes: number;
};

export type GridShift = {
  doctorId: string;
  /** 1 — понедельник, 7 — воскресенье. Пусто, если строка привязана к дате. */
  weekday: number | null;
  onDate: string;
  onDateEnd: string;
  isWorking: boolean;
  startMinute: number | null;
  endMinute: number | null;
};

/** Прямоугольник записи внутри колонки мастера. */
export type PlacedAppointment<T> = {
  item: T;
  /** Минута начала от полуночи в поясе клиники. */
  startMinute: number;
  endMinute: number;
  /** Дорожка среди наложившихся записей и сколько их всего в этой группе. */
  lane: number;
  lanes: number;
};

const MINUTES_IN_DAY = 1440;

/**
 * Минута от полуночи в поясе клиники.
 *
 * Возвращает null для нечитаемого времени: такая запись не рисуется в сетке, а
 * попадает в отдельный список «вне сетки». Подставить ей девять утра значило бы
 * нарисовать визит, которого в это время нет.
 */
export function minuteOfClinicDay(startsAt: string, timeZone: string): number | null {
  const instant = Date.parse(startsAt);
  if (!Number.isFinite(instant)) return null;

  if (!timeZone) {
    const local = new Date(instant);
    return local.getHours() * 60 + local.getMinutes();
  }

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(instant));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    // 24:00 у полуночи в en-GB — законный ответ Intl, и это ноль минут.
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Раскладка наложившихся записей по дорожкам.
 *
 * У мастера с ёмкостью два визита идут параллельно, и один блок поверх другого
 * скрыл бы второго клиента целиком. Группой считается цепочка пересечений: три
 * записи 10:00–11:00, 10:30–11:30 и 11:00–12:00 делят ширину на три, потому что
 * средняя связывает крайние.
 */
export function placeColumn<T extends GridAppointment>(
  items: readonly T[],
  timeZone: string,
): { placed: Array<PlacedAppointment<T>>; unreadable: T[] } {
  const unreadable: T[] = [];
  const readable: Array<{ item: T; startMinute: number; endMinute: number }> = [];

  for (const item of items) {
    const startMinute = minuteOfClinicDay(item.startsAt, timeZone);
    if (startMinute === null) {
      unreadable.push(item);
      continue;
    }
    // Визит без длительности — час: столько же считает сервер, когда колонки
    // длительности нет. Ноль и отрицательное — тоже час: блок нулевой высоты
    // на экране равен отсутствию записи.
    const minutes = Number.isFinite(item.durationMinutes) && item.durationMinutes > 0
      ? item.durationMinutes
      : 60;
    readable.push({ item, startMinute, endMinute: Math.min(startMinute + minutes, MINUTES_IN_DAY) });
  }

  readable.sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);

  const placed: Array<PlacedAppointment<T>> = [];
  let group: Array<PlacedAppointment<T>> = [];
  let groupEnd = -1;

  const closeGroup = () => {
    const lanes = group.reduce((max, entry) => Math.max(max, entry.lane + 1), 0);
    for (const entry of group) entry.lanes = lanes;
    placed.push(...group);
    group = [];
    groupEnd = -1;
  };

  for (const entry of readable) {
    if (group.length > 0 && entry.startMinute >= groupEnd) closeGroup();

    // Первая свободная дорожка: занятой считается та, чья запись ещё не
    // кончилась к началу новой.
    const busy = new Set(group.filter((other) => other.endMinute > entry.startMinute).map((other) => other.lane));
    let lane = 0;
    while (busy.has(lane)) lane += 1;

    group.push({ item: entry.item, startMinute: entry.startMinute, endMinute: entry.endMinute, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, entry.endMinute);
  }
  if (group.length > 0) closeGroup();

  return { placed, unreadable };
}

/**
 * Рабочие интервалы мастера на этот день — те же правила, что и на сервере.
 *
 * Исключение на дату замещает недельный образец, закрытое окно вычитается.
 * Расхождение с сервером здесь было бы хуже отсутствия закраски: экран рисовал
 * бы приём там, где сервер отказывает записывать.
 */
export function workingIntervals(
  shifts: readonly GridShift[],
  doctorId: string,
  dateKey: string,
  isoWeekday: number,
): Array<[number, number]> {
  const mine = shifts.filter((shift) => shift.doctorId === doctorId);
  const covering = mine.filter((shift) => {
    const from = shift.onDate;
    const to = shift.onDateEnd || from;
    return Boolean(from) && from <= dateKey && dateKey <= to;
  });
  const weekly = mine.filter((shift) => shift.weekday === isoWeekday);

  const definesDay = (shift: GridShift) => shift.isWorking || shift.startMinute === null;
  const datedBase = covering.filter(definesDay);
  const baseRows = datedBase.length > 0 ? datedBase : weekly.filter(definesDay);
  const windowRows = datedBase.length > 0
    ? covering.filter((shift) => !definesDay(shift))
    : [...covering.filter((shift) => !definesDay(shift)), ...weekly.filter((shift) => !definesDay(shift))];

  if (baseRows.length === 0 && windowRows.length === 0) return [];
  // Выходной без часов закрывает день целиком — одной такой строки достаточно.
  if (baseRows.some((shift) => !shift.isWorking && shift.startMinute === null)) return [];

  const working = baseRows
    .filter((shift) => shift.isWorking && shift.startMinute !== null && shift.endMinute !== null)
    .map((shift) => [shift.startMinute as number, shift.endMinute as number] as [number, number]);

  const closed = windowRows
    .filter((shift) => shift.startMinute !== null && shift.endMinute !== null)
    .map((shift) => [shift.startMinute as number, shift.endMinute as number] as [number, number]);

  let pieces = working;
  for (const [closedStart, closedEnd] of closed) {
    const next: Array<[number, number]> = [];
    for (const [start, end] of pieces) {
      if (closedEnd <= start || closedStart >= end) { next.push([start, end]); continue; }
      if (closedStart > start) next.push([start, Math.min(closedStart, end)]);
      if (closedEnd < end) next.push([Math.max(closedEnd, start), end]);
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Границы сетки. Не жёсткие 09:00–21:00: салон с записью на 08:00 обязан её
 * видеть, а не читать в списке «вне сетки». Сетка растягивается по фактам —
 * по записям дня и по графику, — а стандартные часы служат минимумом.
 */
export function gridBounds(
  starts: readonly number[],
  intervals: readonly (readonly [number, number])[],
  fallback: readonly [number, number] = [9 * 60, 21 * 60],
): [number, number] {
  const points: number[] = [...starts, ...intervals.flatMap(([from, to]) => [from, to])];
  if (points.length === 0) return [fallback[0], fallback[1]];
  const min = Math.min(fallback[0], ...points);
  const max = Math.max(fallback[1], ...points);
  // Округление до часа: подписи слева стоят по часам, и полоса, начинающаяся с
  // 08:40, оставляла бы первую подпись висеть над пустотой.
  return [Math.floor(min / 60) * 60, Math.ceil(max / 60) * 60];
}

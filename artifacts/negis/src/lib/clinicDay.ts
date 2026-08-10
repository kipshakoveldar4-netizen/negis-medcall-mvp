// Какой сегодня день — в часах клиники, а не в часах того, кто смотрит.
//
// До этого модуля на один вопрос было три разных ответа, и все три неверны.
// Сводка считала `new Date().toISOString().slice(0, 10)` — то есть UTC — под
// комментарием «текущая локальная дата»: в UTC+5 она называла чужие сутки
// примерно пять часов каждую ночь, и «записей сегодня» вместе с «выручкой за
// сегодня» в это время показывали не тот день. Главный экран сравнивал
// getFullYear/getMonth/getDate — то есть пояс ноутбука оператора. Экран
// записей замораживал «сегодня» в момент загрузки, поэтому вкладка,
// оставленная на ночь, бесконечно показывала вчерашние «Сегодня записей».
//
// Для этого не нужны большие данные: при трёх записях в базе ошибка ровно та
// же. Правило графика врача уже решило эту задачу на сервере — пояс клиники
// лежит в настройках рабочего пространства и приезжает вместе со списком
// записей. Здесь тот же приём для браузера.
//
// Пояса нет — считаем по устройству и говорим об этом вслух (см. плашку на
// экране записей). Молчаливый откат на UTC был бы худшим из вариантов: он
// выглядит как «часовой пояс», но им не является нигде, кроме Гринвича.

/** Ключ дня в формате YYYY-MM-DD — то, чем этот продукт сравнивает даты. */
export type DayKey = string;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Мгновение → календарный день в заданном поясе.
 *
 * Через Intl, а не через getFullYear/getMonth/getDate: последние читают пояс
 * машины, поэтому один и тот же визит попадал бы в разные сутки на ноутбуке
 * регистратора и на сервере. Тот же приём, что и в правиле графика врача.
 */
export function dayKeyInZone(instantMs: number, timeZone: string): DayKey {
  if (!timeZone) {
    const local = new Date(instantMs);
    return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  }

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instantMs));
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Непонятный пояс — не повод показать пустой экран. Падаем на устройство,
    // ровно как при отсутствующем поясе.
  }

  const local = new Date(instantMs);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/** Сегодняшний день клиники. Без пояса — день устройства. */
export function clinicToday(timeZone: string, now: number = Date.now()): DayKey {
  return dayKeyInZone(now, timeZone);
}

/**
 * Попадает ли отметка времени в заданный день клиники.
 *
 * Принимает и полное мгновение, и голую дату «2026-09-07»: списки этого
 * продукта хранят и то и другое, а поле `date` у записи — уже день.
 */
export function isOnClinicDay(value: unknown, dayKey: DayKey, timeZone: string): boolean {
  if (typeof value !== "string" || !value.trim() || !dayKey) return false;

  // Голая дата — это уже календарный день, переводить его между поясами
  // нельзя: «2026-09-07» не мгновение, и сдвиг превратил бы его в соседний.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim() === dayKey;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return dayKeyInZone(timestamp, timeZone) === dayKey;
}

/** Пояс устройства — чтобы сказать оператору, что он расходится с клиникой. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

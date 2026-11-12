/**
 * Напоминание клиенту о записи: кому писать, когда и что.
 *
 * Владелец салона: «нужно оповещение клиентов до прихода — что у них
 * запланирована запись». Здесь только решение «кому и что», без отправки:
 * выбор адресатов ошибается молча и дорого — написать не тому, написать
 * дважды, написать про отменённый визит, — и это должно проверяться тестами,
 * а не наблюдением за живыми клиентами.
 *
 * Отправка живёт отдельно и требует того, чего у продукта пока нет: у Meta
 * сообщение, начатое бизнесом вне суточного окна переписки, отправляется
 * ТОЛЬКО одобренным шаблоном. Пока шаблона нет, цикл работает вхолостую и
 * говорит об этом вслух — это честнее, чем делать вид, что клиенты получают
 * напоминания.
 */

export type ReminderCandidate = {
  id: string;
  clientName: string;
  phone: string;
  whatsapp: string;
  service: string;
  doctorName: string;
  startsAt: string;
  status: string;
  reminderSentAt: string | null;
};

export type ReminderPlan = {
  candidate: ReminderCandidate;
  /** Куда писать: WhatsApp, если он задан, иначе телефон. */
  to: string;
  text: string;
};

/** Статусы, которые слот занимают. Отменённому визиту напоминать не о чем. */
const LIVE_STATUSES = new Set(["scheduled", "confirmed", "arrived"]);

/**
 * Окно отправки.
 *
 * Напоминание уместно за несколько часов до визита — и бессмысленно после
 * него. Нижняя граница закрывает второй случай: рабочий цикл, запущенный
 * вечером, не должен писать «завтра в десять» человеку, который уже ушёл.
 */
export function isDue(
  startsAt: string,
  nowMs: number,
  leadMinutes: number,
): boolean {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return false;
  const minutesUntil = (start - nowMs) / 60_000;
  return minutesUntil > 0 && minutesUntil <= leadMinutes;
}

/**
 * Время визита словами клиента — в поясе КЛИНИКИ.
 *
 * Пояс сервера здесь не годится: Vercel считает в UTC, и салон в Астане
 * писал бы клиенту время на пять часов раньше. Один этот промах превращает
 * напоминание из пользы в причину не прийти.
 */
export function clinicTimeLabel(startsAt: string, timeZone: string): string {
  const instant = Date.parse(startsAt);
  if (!Number.isFinite(instant)) return "";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timeZone || "UTC",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(instant));
  } catch {
    return "";
  }
}

/**
 * Текст напоминания.
 *
 * Ничего не выдумывает: имя салона приходит из настроек клиники, время — из
 * записи, услуга и мастер — из неё же и подставляются, только если заполнены.
 * Пустое имя салона не превращается в «наш салон»: сообщение от неизвестно
 * кого клиент читает как спам.
 */
export function reminderText(input: {
  clinicName: string;
  clientName: string;
  timeLabel: string;
  service: string;
  doctorName: string;
}): string {
  const lines: string[] = [];
  const greeting = input.clientName ? `Здравствуйте, ${input.clientName}!` : "Здравствуйте!";
  lines.push(greeting);
  lines.push(`Напоминаем о записи: ${input.timeLabel}${input.clinicName ? `, ${input.clinicName}` : ""}.`);
  const details = [input.service, input.doctorName].filter(Boolean).join(" · ");
  if (details) lines.push(details);
  lines.push("Если планы изменились — ответьте на это сообщение, перенесём.");
  return lines.join("\n");
}

/**
 * Кому писать прямо сейчас.
 *
 * Четыре причины пропустить, и каждая — отдельный способ навредить:
 * уже писали (второе сообщение раздражает сильнее, чем отсутствие первого),
 * визит отменён, время ещё не подошло или уже прошло, писать некуда.
 */
export function planReminders(
  candidates: readonly ReminderCandidate[],
  input: { nowMs: number; leadMinutes: number; timeZone: string; clinicName: string },
): { plans: ReminderPlan[]; skipped: Array<{ id: string; reason: string }> } {
  const plans: ReminderPlan[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.reminderSentAt) {
      skipped.push({ id: candidate.id, reason: "уже отправляли" });
      continue;
    }
    if (!LIVE_STATUSES.has(candidate.status)) {
      skipped.push({ id: candidate.id, reason: "визит отменён или закрыт" });
      continue;
    }
    if (!isDue(candidate.startsAt, input.nowMs, input.leadMinutes)) {
      skipped.push({ id: candidate.id, reason: "не время" });
      continue;
    }
    const to = candidate.whatsapp.trim() || candidate.phone.trim();
    if (!to) {
      skipped.push({ id: candidate.id, reason: "нет номера" });
      continue;
    }

    const timeLabel = clinicTimeLabel(candidate.startsAt, input.timeZone);
    if (!timeLabel) {
      skipped.push({ id: candidate.id, reason: "не читается время визита" });
      continue;
    }

    plans.push({
      candidate,
      to,
      text: reminderText({
        clinicName: input.clinicName,
        clientName: candidate.clientName,
        timeLabel,
        service: candidate.service,
        doctorName: candidate.doctorName,
      }),
    });
  }

  return { plans, skipped };
}

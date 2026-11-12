// Сигналы здоровья клиники — чистая функция над фактами.
//
// Портал Medina Control показывает владельцу платформы, где клинике нужна
// помощь. Правила намеренно живут отдельно от чтения базы: их можно проверить
// тестом без единого запроса, а обработчик отвечает только за честный сбор
// фактов.
//
// Два принципа.
//
// Первый: null — это «не смог посчитать», и по нему сигнал НЕ строится ни в
// какую сторону. Предупреждение «заявок нет», построенное на сбое чтения,
// отправило бы владельца чинить клинику, у которой всё в порядке.
//
// Второй: сигналы считаются из данных, которые уже есть. Ни одно правило не
// изобретает порогов сложнее «ноль за неделю» и «не у всех» — такие пороги
// объяснимы одной фразой, и владелец платформы может проверить каждый глазами.

export type ClinicFacts = {
  /** Действующая подписка: строка status или пустая, если строки нет. */
  subscriptionStatus: string;
  /** Часовой пояс задан — без него график при записи не применяется. */
  timeZoneSet: boolean;
  doctors: number | null;
  /** У скольких исполнителей есть хотя бы одна строка графика. */
  doctorsWithSchedule: number | null;
  services: number | null;
  whatsappChannels: number | null;
  /** Новых заявок и записей, заведённых за последние 7 дней. */
  leads7d: number | null;
  appointments7d: number | null;
};

export type ClinicSignal = {
  key: string;
  level: "ok" | "warn";
  /** Числа для подстановки в текст. Сам текст собирает портал — по нише. */
  data: Record<string, number>;
};

export function computeClinicSignals(facts: ClinicFacts): ClinicSignal[] {
  const signals: ClinicSignal[] = [];

  if (facts.appointments7d !== null) {
    signals.push(
      facts.appointments7d === 0
        ? { key: "no_appointments_7d", level: "warn", data: {} }
        : { key: "appointments_flowing", level: "ok", data: { count: facts.appointments7d } },
    );
  }

  if (facts.leads7d !== null) {
    signals.push(
      facts.leads7d === 0
        ? { key: "no_leads_7d", level: "warn", data: {} }
        : { key: "leads_flowing", level: "ok", data: { count: facts.leads7d } },
    );
  }

  if (!facts.timeZoneSet) {
    signals.push({ key: "timezone_missing", level: "warn", data: {} });
  }

  if (facts.doctors !== null) {
    if (facts.doctors === 0) {
      signals.push({ key: "no_specialists", level: "warn", data: {} });
    } else if (facts.doctorsWithSchedule !== null) {
      signals.push(
        facts.doctorsWithSchedule < facts.doctors
          ? {
              key: "schedule_incomplete",
              level: "warn",
              data: { have: facts.doctorsWithSchedule, total: facts.doctors },
            }
          : { key: "schedule_complete", level: "ok", data: { total: facts.doctors } },
      );
    }
  }

  if (facts.services !== null && facts.services === 0) {
    signals.push({ key: "no_services", level: "warn", data: {} });
  }

  if (facts.subscriptionStatus !== "active") {
    signals.push({ key: "no_subscription", level: "warn", data: {} });
  }

  if (facts.whatsappChannels !== null) {
    signals.push(
      facts.whatsappChannels === 0
        ? { key: "whatsapp_disconnected", level: "warn", data: {} }
        : { key: "whatsapp_connected", level: "ok", data: {} },
    );
  }

  // Предупреждения — вперёд: владелец платформы открывает карточку ради них.
  return signals.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
}

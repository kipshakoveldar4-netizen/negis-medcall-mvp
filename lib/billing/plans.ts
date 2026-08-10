// Тарифы Medina: что входит и сколько стоит.
//
// Цены здесь — ПОДСКАЗКА для панели владельца, а не источник правды. Правда
// живёт в строке platform_subscriptions.price_minor у конкретной клиники, и
// панель считает выручку только по ней. Разница важна: клиника может сидеть на
// особых условиях, и тогда её счёт не равен цене из этого файла, а выручка
// обязана сойтись с тем, что ей выставлено, а не с прайсом.
//
// Цены назначены владельцем 10.08.2026 по разбору рынка. Опорные точки на ту
// дату, в тенге за месяц: MedElement 9 900 за рабочее место (19 900 ≈ два
// места, 39 900 ≈ четыре, 79 900 ≈ восемь), CRMedical 29 750 / 37 900 / 60 000
// при годовой оплате, Битрикс24 Казахстан 13 000 / 38 000 / 76 000,
// DIKIDI VIP 19 140. Цена за клинику, а не за пользователя: на amoCRM шесть
// ролей этого продукта стоили бы 6 × 5 199 = 31 194 в месяц, и рынок за
// административный персонал платить не приучен.
//
// Границы тарифов проведены по себестоимости, а не по красоте сетки. Видео
// через OpenAI на 10.08.2026 стоило 0,10 USD за секунду в 720p — при курсе
// НБРК 469,93 это 47 тенге. Сорок роликов по пятнадцать секунд съедают 71%
// выручки standard, поэтому видео там нет вообще, а в pro лимит задан в
// СЕКУНДАХ: провайдер считает посекундно, и «двенадцать роликов» — это не
// ограничение, если ролик может быть минутным.

/** Ключи тарифов. Совпадают с колонкой plan в platform_subscriptions. */
export type PlanKey = "basic" | "standard" | "pro";

export const PLAN_KEYS: readonly PlanKey[] = ["basic", "standard", "pro"];

export type PlanLimits = {
  /** Изображений в месяц. 0 — генерации нет на этом тарифе. */
  images: number;
  /** Секунд видео в месяц. 0 — видео нет. */
  videoSeconds: number;
  /** Разрешён ли запуск кампаний Meta из интерфейса. */
  metaLaunch: boolean;
};

export type PlanDefinition = {
  key: PlanKey;
  title: string;
  summary: string;
  /** Подсказка для панели: цена в тиынах за месяц. */
  suggestedMonthlyMinor: number;
  currency: string;
  limits: PlanLimits;
  includes: readonly string[];
};

export const PLANS: Readonly<Record<PlanKey, PlanDefinition>> = {
  basic: {
    key: "basic",
    title: "Базовый",
    summary: "Клиника без рекламы: заявки, записи, врачи и смены.",
    suggestedMonthlyMinor: 1_990_000,
    currency: "KZT",
    limits: { images: 0, videoSeconds: 0, metaLaunch: false },
    includes: [
      "Заявки, воронка, клиенты",
      "Записи с проверкой пересечений",
      "Продажи и чеки, задачи, журнал изменений",
      "Справочник услуг, врачи и график смен",
      "Все роли без доплаты за пользователя",
      "WhatsApp: входящие становятся заявками",
    ],
  },
  standard: {
    key: "standard",
    title: "Стандарт",
    summary: "Всё из базового плюс реклама Meta и ИИ-креативы.",
    suggestedMonthlyMinor: 3_990_000,
    currency: "KZT",
    limits: { images: 60, videoSeconds: 0, metaLaunch: true },
    includes: [
      "Всё из базового",
      "Запуск кампаний Meta из интерфейса",
      "Статистика кампаний, города Казахстана",
      "ИИ-тексты и проверка формулировок",
      "60 изображений в месяц",
    ],
  },
  pro: {
    key: "pro",
    title: "Про",
    summary: "Всё из стандарта плюс видео и расширенные лимиты.",
    suggestedMonthlyMinor: 7_990_000,
    currency: "KZT",
    limits: { images: 150, videoSeconds: 180, metaLaunch: true },
    includes: [
      "Всё из стандарта",
      "150 изображений в месяц",
      "180 секунд видео в месяц",
    ],
  },
};

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && (PLAN_KEYS as readonly string[]).includes(value);
}

export function planOf(value: unknown): PlanDefinition | null {
  return isPlanKey(value) ? PLANS[value] : null;
}

/**
 * Сумма из тиынов в строку с валютой.
 *
 * Отдельной функцией, потому что число без валюты на экране про деньги —
 * это половина сведений. Разделитель разрядов — неразрывный пробел: перенос
 * строки посреди суммы читается как две суммы.
 */
export function formatMinor(minor: number, currency = "KZT"): string {
  const whole = Math.trunc(Math.abs(minor) / 100);
  const sign = minor < 0 ? "−" : "";
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const suffix = currency === "KZT" ? " ₸" : ` ${currency}`;
  return `${sign}${grouped}${suffix}`;
}

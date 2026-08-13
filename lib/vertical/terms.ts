// Вертикаль рабочего пространства: клиника или салон.
//
// Продукт написан для медицинских клиник, и это видно в каждой подписи: «врач»,
// «пациент», «приём». Салону красоты те же экраны нужны целиком — заявки,
// записи, мастера, смены, продажи, — но словами своей профессии.
//
// Решение здесь — НАСТРОЙКА, а не форк. Форк означал бы две кодовые базы, две
// цепочки миграций и два места, где чинить один и тот же дефект; при этом сами
// сущности совпадают: у мастера, как и у врача, есть график и записи, которые
// не должны пересекаться.
//
// Что меняется и что не меняется. Меняются ПОДПИСИ на экране. Не меняются имена
// таблиц, ключи ресурсов и значения ролей: `clinic_doctors`, `doctor-schedule`,
// роль `doctor` остаются как есть. Переименование имени таблицы — это миграция
// применённого файла, чего в этом репозитории не делают; переименование ключа
// ресурса — это пять реестров и все проверки разом. Ни то ни другое не нужно
// ради слова на кнопке, а путаницу «в базе doctor, на экране мастер» снимает
// один этот файл: он единственное место, где перевод существует.

export type Vertical = "clinic" | "beauty";

export const VERTICALS: readonly Vertical[] = ["clinic", "beauty"];

export const DEFAULT_VERTICAL: Vertical = "clinic";

/**
 * Ключ настройки в workspace_settings.
 *
 * Рядом с `clinic_schedule`, который уже там живёт и хранит часовой пояс, — тем
 * же способом и тем же путём чтения.
 */
export const VERTICAL_SETTINGS_KEY = "workspace_vertical";

export function isVertical(value: unknown): value is Vertical {
  return typeof value === "string" && (VERTICALS as readonly string[]).includes(value);
}

export function readVertical(value: unknown): Vertical {
  // Неизвестное значение — это клиника, а не отказ.
  //
  // Умолчание здесь безопасно в обе стороны: медицинские подписи у салона
  // выглядят чужеродно, но ничего не ломают и ни о чём не врут, а вот обратное
  // умолчание сняло бы с медицинской клиники строгие правила рекламы — то есть
  // сбой настройки стоил бы ей отклонённого объявления или хуже.
  return isVertical(value) ? value : DEFAULT_VERTICAL;
}

/** Слова, которыми продукт называет одни и те же сущности в разных нишах. */
export type Terms = {
  /** Само заведение. */
  org: string;
  orgGenitive: string;
  /** Тот, кто оказывает услугу. */
  specialist: string;
  specialistPlural: string;
  specialistGenitive: string;
  /** Тот, кто её получает. */
  customer: string;
  customerPlural: string;
  /** Событие в календаре. */
  visit: string;
  visitPlural: string;
  /** Справочник того, что оказывают. */
  serviceList: string;
  /** Подпись роли, которая ведёт запись. */
  frontDesk: string;
};

const TERMS: Readonly<Record<Vertical, Terms>> = {
  clinic: {
    org: "клиника",
    orgGenitive: "клиники",
    specialist: "врач",
    specialistPlural: "врачи",
    specialistGenitive: "врача",
    customer: "пациент",
    customerPlural: "пациенты",
    visit: "приём",
    visitPlural: "приёмы",
    serviceList: "услуги клиники",
    frontDesk: "регистратор",
  },
  beauty: {
    org: "салон",
    orgGenitive: "салона",
    specialist: "мастер",
    specialistPlural: "мастера",
    specialistGenitive: "мастера",
    // «Клиент», а не «гость»: продукт уже везде говорит «клиенты», и вводить
    // второе слово для той же сущности значит рассинхронизировать экраны.
    customer: "клиент",
    customerPlural: "клиенты",
    visit: "запись",
    visitPlural: "записи",
    serviceList: "услуги салона",
    frontDesk: "администратор",
  },
};

export function termsFor(vertical: Vertical): Terms {
  return TERMS[vertical];
}

/** С заглавной — для заголовков. Отдельной функцией, чтобы не плодить пары. */
export function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

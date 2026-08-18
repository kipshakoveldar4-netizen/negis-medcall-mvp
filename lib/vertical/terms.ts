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

export type Vertical = "clinic" | "beauty" | "dental";

export const VERTICALS: readonly Vertical[] = ["clinic", "beauty", "dental"];

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
  /** «В клинике» или «в салоне». */
  orgPrepositional: string;
  /** Чем занят график, в родительном падеже: часы «приёма» или «работы». */
  dutyGenitive: string;
  /** Тот, кто оказывает услугу. */
  specialist: string;
  specialistPlural: string;
  specialistGenitive: string;
  /** «Запись к этому …» — врачу или мастеру. */
  specialistDative: string;
  /** «Справочник …» — врачей или мастеров. */
  specialistGenitivePlural: string;
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
    orgPrepositional: "клинике",
    dutyGenitive: "приёма",
    specialist: "врач",
    specialistPlural: "врачи",
    specialistGenitive: "врача",
    specialistDative: "врачу",
    specialistGenitivePlural: "врачей",
    customer: "пациент",
    customerPlural: "пациенты",
    visit: "приём",
    visitPlural: "приёмы",
    serviceList: "услуги клиники",
    frontDesk: "регистратор",
  },
  // Стоматология — третья ниша (просьба владельца). От клиники её отличают
  // слова, а не правила: пациент остаётся пациентом, приём приёмом, а вот
  // специалист — стоматолог, и справочник называется «услуги стоматологии».
  // Медицинские ограничения рекламы к ней применяются те же, что к клинике:
  // ветки в lib/meta/* сравнивают с "beauty", поэтому стоматология идёт по
  // строгой, медицинской ветке — это правильно и проверено пином.
  dental: {
    org: "стоматология",
    orgGenitive: "стоматологии",
    orgPrepositional: "стоматологии",
    dutyGenitive: "приёма",
    specialist: "стоматолог",
    specialistPlural: "стоматологи",
    specialistGenitive: "стоматолога",
    specialistDative: "стоматологу",
    specialistGenitivePlural: "стоматологов",
    customer: "пациент",
    customerPlural: "пациенты",
    visit: "приём",
    visitPlural: "приёмы",
    serviceList: "услуги стоматологии",
    frontDesk: "администратор",
  },
  beauty: {
    org: "салон",
    orgGenitive: "салона",
    orgPrepositional: "салоне",
    dutyGenitive: "работы",
    specialist: "мастер",
    specialistPlural: "мастера",
    specialistGenitive: "мастера",
    specialistDative: "мастеру",
    specialistGenitivePlural: "мастеров",
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

/**
 * Подписи ролей зависят от ниши.
 *
 * Владелец салона: «нет должности мастеров». Роль в базе называется `doctor` и
 * переименованию не подлежит — на неё завязаны таблицы, ключи ресурсов и
 * значения в staff_users. А вот подпись на экране обязана говорить словом ниши:
 * в клинике «Врач», в салоне «Мастер». Ровно так же уже устроен пункт меню
 * «Специалисты и график».
 *
 * `receptionist` намеренно остаётся «Ресепшн» в обеих нишах: в салоне этого
 * человека зовут администратором, но роль `admin` уже подписана «Администратор»,
 * и две одинаковые подписи в одном селекте — это выбор наугад.
 */
export function staffRoleLabels(vertical: Vertical): Record<string, string> {
  const terms = termsFor(vertical);
  return {
    owner: "Владелец",
    admin: "Администратор",
    receptionist: "Ресепшн",
    marketer: "Маркетолог",
    doctor: capitalize(terms.specialist),
    manager: "Менеджер",
  };
}

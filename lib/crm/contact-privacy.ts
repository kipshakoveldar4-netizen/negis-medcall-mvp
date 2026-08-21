/**
 * Мастер видит имя и время — и не видит контактов.
 *
 * Владелец: «мастера не должны видеть контактные данные клиентов, только имя и
 * время записи без контактных данных. очень будь аккуратен».
 *
 * Почему это отдельный модуль, а не проверка в одном месте: карта утечки
 * показала ПЯТЬ независимых путей к телефону — список клиентов, обратный поиск
 * по номеру, список записей, эхо ответа на POST/PATCH записи и журнал
 * изменений. Право `view_clients` у роли снимается (это закрывает клиентов,
 * обратный поиск и сделки), но записи мастеру нужны по работе, а в них телефон
 * лежит колонкой. Значит нужен слой, который срезает поля на выходе, и он
 * обязан применяться в КАЖДОЙ ветке ответа, а не только в списке.
 *
 * Правило простое и намеренно тупое: перечислены поля, которые уходят, а не
 * поля, которые остаются. Новая колонка с контактом появится — и она НЕ
 * попадёт в список разрешённых, потому что списка разрешённых нет; поэтому
 * рядом стоит второй слой — маскирование длинных цифровых цепочек в свободном
 * тексте, куда номер попадает руками администратора («перезвонить на +7…»).
 */

/** Роли, которым контакты клиента не показываются. */
const CONTACT_FREE_ROLES = new Set(["doctor"]);

/** Поля-контакты. Список ЗАПРЕЩЁННОГО, а не разрешённого — см. шапку. */
const CONTACT_FIELDS = [
  "phone",
  "whatsapp",
  "email",
  "clientPhone",
  "client_phone",
  "clientWhatsapp",
  "client_whatsapp",
  "contact",
  "contactPhone",
  "telegram",
  "instagram",
] as const;

/**
 * Свободный текст, куда номер попадает руками. Заметку не выбрасываем целиком:
 * там же лежит «аллергия на анестетик», без которой мастеру работать нельзя.
 */
const FREE_TEXT_FIELDS = [
  "notes",
  "comment",
  "description",
  "title",
  "text",
  // time и startsAt выглядят датой, но у старых и импортированных записей
  // starts_at пуст, и сервер кладёт туда СЫРУЮ заметку — с телефоном внутри.
  // Настоящую метку времени маска не портит: в ней цифры разделены «T» и «:»,
  // и цепочка не набирает десяти цифр подряд.
  "time",
  "startsAt",
] as const;

export function hidesClientContacts(role: unknown): boolean {
  return typeof role === "string" && CONTACT_FREE_ROLES.has(role);
}

/**
 * Своего клиента мастер видит целиком, чужого — без телефона.
 *
 * Владелец уточнил правило: «мастера могут записывать своих клиентов и видеть
 * их номера, но в записях, которые заводят админы, номера им не видно».
 * Значит решает не только роль смотрящего, но и АВТОР строки: номер, который
 * мастер вписал сам, прятать от него бессмысленно, а телефон клиента клиники
 * остаётся у тех, кто отвечает за звонки.
 *
 * Автор неизвестен — прячем. Вся история до 043 без автора, и трактовать
 * «не знаю» как «свой» значило бы открыть телефоны всей накопленной базы.
 */
export function keepsContactsForOwnRecord(
  role: unknown,
  createdByStaffUserId: unknown,
  actorStaffUserId: unknown,
): boolean {
  if (!hidesClientContacts(role)) return true;
  const author = typeof createdByStaffUserId === "string" ? createdByStaffUserId : "";
  const actor = typeof actorStaffUserId === "string" ? actorStaffUserId : "";
  return Boolean(author) && author === actor;
}

/**
 * Маскирует то, что является КОНТАКТОМ, и не трогает то, что им не является.
 *
 * Первая версия считала номером любую цепочку от семи символов с пробелами и
 * дефисами — и съедала даты («перенос на 2026-08-19»), суммы («курс 1 200 000
 * тг») и номер кабинета, то есть ровно то, ради чего заметку и оставили
 * читаемой. При этом номер через точки («701.234.56.78») проходил насквозь.
 *
 * Теперь решает КОЛИЧЕСТВО ЦИФР, а не длина строки: телефон в Казахстане — это
 * 10–11 цифр, дата — восемь, сумма «1 200 000» — семь. Разделителем считается и
 * точка. Ник мессенджера — отдельное правило: настоящий канал связи чаще
 * приходит именно так («только телеграм @masha_beauty»).
 */
const PHONE_MIN_DIGITS = 10;

export function maskContactsInText(value: string): string {
  return value
    // Цепочка цифр с любыми разделителями; решение принимает счётчик цифр.
    .replace(/\+?\d[\d()\-.\s]{6,}\d/g, (match) => {
      const digits = (match.match(/\d/g) ?? []).length;
      return digits >= PHONE_MIN_DIGITS ? "(номер скрыт)" : match;
    })
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "(почта скрыта)")
    // Ник мессенджера: @masha_beauty. Одиночная «собака» и адреса выше уже
    // обработаны, поэтому здесь остаётся именно ник.
    .replace(/(^|\s)@[A-Za-z0-9._]{3,}/g, "$1(контакт скрыт)");
}

/**
 * Убирает контакты из одной отдаваемой записи. Возвращает НОВЫЙ объект: править
 * входной значило бы испортить строку, которую вызывающий может использовать
 * дальше (например, для журнала).
 */
export function redactContacts<T extends Record<string, unknown>>(
  item: T,
  role: unknown,
  actorStaffUserId?: unknown,
): T {
  if (!hidesClientContacts(role)) return item;
  // Запись, которую завёл сам мастер, остаётся при своём телефоне.
  if (keepsContactsForOwnRecord(role, item.createdByStaffUserId ?? item.created_by_staff_user_id, actorStaffUserId)) {
    return item;
  }
  const out: Record<string, unknown> = { ...item };

  for (const field of CONTACT_FIELDS) {
    if (field in out) delete out[field];
  }
  for (const field of FREE_TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string" && value) out[field] = maskContactsInText(value);
  }

  // Идентификатор карточки клиента остаётся: он не контакт, а ключ, и по нему
  // экран мастера не откроет ничего — маршрут клиентов ему закрыт правом.
  return out as T;
}

/** То же для списка. */
export function redactContactsList<T extends Record<string, unknown>>(
  items: T[],
  role: unknown,
  actorStaffUserId?: unknown,
): T[] {
  if (!hidesClientContacts(role)) return items;
  return items.map((item) => redactContacts(item, role, actorStaffUserId));
}

/**
 * Поля, которые роль без контактов не имеет права ЗАПИСАТЬ. Читать телефон
 * нельзя, а переписать — тем более: это была бы правка вслепую поверх того,
 * чего человек не видит.
 */
export function stripContactWrites<T extends Record<string, unknown>>(row: T, role: unknown): T {
  if (!hidesClientContacts(role)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const field of ["client_phone", "whatsapp", "phone", "email"]) {
    if (field in out) delete out[field];
  }
  return out as T;
}

/**
 * Логин вместо почты.
 *
 * Владелец: «сделай так чтобы могли по именам делать логин, а то с почтами
 * много мороки». У мастера в салоне почты может не быть вовсе, а если есть — он
 * путает её на слух и набирает с ошибками. Логин «aigul.botanova» короче,
 * произносится и набирается с телефона.
 *
 * Supabase Auth умеет вход только по адресу, поэтому нику сопоставляется
 * СЛУЖЕБНЫЙ адрес `<login>@staff.negis.online`. Поддомен нашего домена, а не
 * `.local` и не `.invalid`: адрес обязан пережить любые проверки формата и
 * существования домена на стороне GoTrue, а `.local` вдобавок зона mDNS —
 * в сети клиники такое имя может разрешиться в устройство в кабинете.
 *
 * ДЛЯ ВЛАДЕЛЬЦА, ОДНА СТРОКА В DNS: `staff.negis.online. IN MX 0 "."` (RFC 7505,
 * null MX) — «этот домен почту не принимает». Без записи домен и так
 * недоставляем (у поддомена нет ни MX, ни A), но null MX закрывает случай, когда
 * на основной домен однажды повесят wildcard.
 *
 * Отсюда следствие, которое обязано быть сказано на экране: у человека с логином
 * НЕТ пути «Забыли пароль?». Пароль ему задаёт администратор кнопкой «Новый
 * пароль», либо он меняет его сам в профиле, зная текущий. Это осознанный
 * размен: почты нет — нет и доказательства владения почтой.
 *
 * Колонки в базе не появляется: логин выводится из staff_users.email
 * отбрасыванием домена, а глобальную уникальность даёт сам Auth. Отдельная
 * колонка завела бы второе место истины, и при расхождении экран показывал бы
 * логин, которым нельзя войти, — худший класс отказа, потому что выглядит
 * правильным.
 *
 * Модуль чистый: ни базы, ни сети.
 */

/** Чем выписываются НОВЫЕ логины. */
export const STAFF_LOGIN_MINT_DOMAIN = "staff.negis.online";

/**
 * Что считается нашим служебным адресом при разборе и показе. Список, а не
 * одна константа, намеренно: в день смены домена ранее выданные логины обязаны
 * продолжать опознаваться, иначе на экранах вылезет сырой адрес, а вход по нику
 * сломается — склеится с новым доменом, которого у аккаунта нет.
 */
export const STAFF_LOGIN_DOMAINS: readonly string[] = [STAFF_LOGIN_MINT_DOMAIN, "staff.negis.local"];

const MIN_LOGIN_LENGTH = 3;
const MAX_LOGIN_LENGTH = 24;
/** Хвост для занятого логина: без спутываемых знаков — его диктуют голосом. */
const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * Кириллица → латиница. Таблица под казахстанские имена: сюда входят казахские
 * буквы (қ, ғ, ң, ө, ұ, ү, һ, і, ә), иначе «Ұлжан» превратилась бы в «лжан».
 */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
  қ: "q", ғ: "g", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i", ә: "a",
};

/**
 * Нормализация введённого логина.
 *
 * Дефис и подчёркивание приводятся к точке НАМЕРЕННО: «aigul-botanova» и
 * «aigul.botanova» должны вести в один аккаунт, иначе человек, набравший
 * разделитель иначе, получит «неверный логин или пароль» и будет искать ошибку
 * в пароле. Заодно это закрывает «_» — символ LIKE-шаблона, из-за которого в
 * этом проекте уже был баг совпадения чужих адресов.
 */
export function normalizeLogin(raw: unknown): string {
  const source = typeof raw === "string" ? raw : "";
  return source
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, MAX_LOGIN_LENGTH)
    // Обрезка по длине могла оставить точку на конце — тогда логин не прошёл бы
    // собственную проверку формы, и законное длинное ФИО оказалось бы
    // невыдаваемым.
    .replace(/\.+$/g, "");
}

/** Латиница, цифры и точка; 3–24 знака. Такой логин диктуют голосом. */
export function isLoginShape(value: string): boolean {
  if (value.length < MIN_LOGIN_LENGTH || value.length > MAX_LOGIN_LENGTH) return false;
  return /^[a-z0-9][a-z0-9.]*[a-z0-9]$/.test(value) && !value.includes("..");
}

/**
 * Логин из имени: «Айгуль Ботанова» → «aigul.botanova».
 *
 * Длинное ФИО не обрезается посередине, а сокращается по-человечески: имя плюс
 * первая буква фамилии («Мухаметкалиевагульнурсултанк Айгуль» → «aigul.m»).
 * Обрезка давала «…nursultank.aygu» — обрубленное ИМЯ, которое невозможно
 * продиктовать, хотя человек представляется именно именем.
 */
export function loginFromFullName(fullName: unknown): string {
  const source = typeof fullName === "string" ? fullName : "";
  const words: string[] = [];
  for (const rawWord of source.split(/[\s,]+/)) {
    let word = "";
    const lower = rawWord.toLowerCase();
    for (let i = 0; i < lower.length; i += 1) {
      const char = lower[i];
      if (/[a-z0-9]/.test(char)) { word += char; continue; }
      if (TRANSLIT[char] !== undefined) word += TRANSLIT[char];
    }
    if (word) words.push(word);
  }
  if (words.length === 0) return "";

  // В карточке сотрудника имя пишут по-разному — «Айгуль Ботанова» и
  // «Ботанова Айгуль». Первым словом называют себя чаще, его и берём основой.
  const [first, ...rest] = words;
  const full = normalizeLogin([first, ...rest].join("."));
  if (isLoginShape(full)) return full;

  const short = normalizeLogin(rest.length > 0 ? `${first}.${rest[0][0]}` : first);
  if (isLoginShape(short)) return short;
  return normalizeLogin(first.slice(0, MAX_LOGIN_LENGTH));
}

/** Служебный адрес, которым логин представляется Supabase Auth. */
export function emailFromLogin(login: string): string {
  return `${login}@${STAFF_LOGIN_MINT_DOMAIN}`;
}

/** Это наш служебный адрес, а не настоящая почта человека? */
export function isSyntheticEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const value = email.toLowerCase().trim();
  return STAFF_LOGIN_DOMAINS.some((domain) => value.endsWith(`@${domain}`));
}

/**
 * Что показывать человеку вместо адреса. Служебный адрес в списке сотрудников
 * выглядел бы мусором, а на бумажке с паролем — прямой ошибкой: человек набрал
 * бы его целиком и не вошёл.
 */
export function loginFromEmail(email: unknown): string {
  const value = typeof email === "string" ? email : "";
  return isSyntheticEmail(value) ? value.slice(0, value.lastIndexOf("@")) : value;
}

/**
 * Вход принимает одно поле. С «@» — почта, без — логин. Обращаться к базе здесь
 * недопустимо: это был бы запрос ДО авторизации и оракул «кто есть на
 * платформе», поэтому преобразование чисто арифметическое — и оно ОБЯЗАНО быть
 * побайтово тем же, что применил сервер при заведении.
 */
export function loginOrEmailToAuthEmail(raw: unknown): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (source.includes("@")) return source.toLowerCase();
  const login = normalizeLogin(source);
  return login ? emailFromLogin(login) : "";
}

/**
 * Логин занят — берём следующий. Хвост СЛУЧАЙНЫЙ, а не счётчик: «aigul47»
 * сообщал бы, сколько на платформе Айгуль, то есть измерял бы клиентскую базу —
 * ровно то, ради закрытия чего список клиник не показывается нигде.
 */
export function loginWithSuffix(base: string, attempt: number, randomByte?: () => number): string {
  if (attempt <= 0) return base;
  const pick = randomByte ?? (() => Math.floor(Math.random() * 256));
  let suffix = "";
  for (let i = 0; i < 2; i += 1) suffix += SUFFIX_ALPHABET[pick() % SUFFIX_ALPHABET.length];
  const room = MAX_LOGIN_LENGTH - suffix.length - 1;
  return normalizeLogin(`${base.slice(0, room)}.${suffix}`);
}

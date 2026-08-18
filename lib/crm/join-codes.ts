/**
 * Код клиники: его формат, генерация и нормализация ввода.
 *
 * Код диктуют голосом на планёрке и набирают руками с бумажки — из этого
 * следует всё остальное. Алфавит без спутываемых символов (нет O и 0, I и 1,
 * L), потому что «ноль или буква О» по телефону — главный источник неверных
 * кодов. Префикс из названия клиники — чтобы человек узнавал свой код на слух.
 *
 * Секретная часть — 8 символов из алфавита в 31 знак, это ≈40 бит. Пример из
 * разговора, «MEDI-7431», — 10 000 вариантов, то есть перебирается за минуты, а
 * каждое попадание называет клинику; список клиник платформы — её клиентская
 * база, и раздавать его перебором нельзя.
 *
 * Модуль чистый: ни базы, ни сети — чтобы тесты шли без обоих, как у
 * validateInvitationRequest и validateStaffCredentialsRequest.
 */

/** Без I, L, O, 0 и 1 — их путают на слух и на бумаге. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SECRET_LENGTH = 8;
const PREFIX_LENGTH = 4;
const FALLBACK_PREFIX = "MEDI";

/** Кириллица → латиница, только чтобы префикс читался: «Медина» → MEDI. */
const TRANSLIT: Record<string, string> = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "Z", З: "Z", И: "I",
  Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "C", Ш: "S", Щ: "S", Ъ: "", Ы: "Y", Ь: "",
  Э: "E", Ю: "U", Я: "A", Қ: "Q", Ғ: "G", Ң: "N", Ө: "O", Ұ: "U", Ү: "U", Һ: "H", І: "I",
};

/**
 * Префикс из названия. Буквы I, L, O в префиксе допустимы: он несекретный и
 * набирается по подсказке на экране, а вот в секретной части их нет.
 */
export function joinCodePrefix(workspaceName: unknown): string {
  const source = typeof workspaceName === "string" ? workspaceName : "";
  let out = "";
  const upper = source.toUpperCase();
  for (let i = 0; i < upper.length && out.length < PREFIX_LENGTH; i += 1) {
    const mapped = TRANSLIT[upper[i]] ?? upper[i];
    if (/^[A-Z]$/.test(mapped)) out += mapped;
  }
  return out.length === PREFIX_LENGTH ? out : FALLBACK_PREFIX;
}

/**
 * Секретная часть — только из криптостойкого источника: счётчик или
 * Math.random дают предсказуемый код, то есть оракул «какие клиники есть».
 *
 * Web Crypto, а не node:crypto, намеренно: этот модуль читает и браузер (маска
 * ввода и показ кода), а импорт node:crypto уронил бы сборку фронта. Отбраковка
 * значений от 248 и выше убирает перекос: 256 не делится на 31 нацело, и без
 * неё первые семь букв алфавита выпадали бы чаще прочих.
 */
function secretPart(): string {
  const size = CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  // Индексный обход, а не for..of по Uint8Array: этот модуль читают и наш
  // серверный бандл, и Vite, а перебор типизированного массива через итератор
  // требует downlevelIteration в сборках со старым target.
  let out = "";
  while (out.length < SECRET_LENGTH) {
    const chunk = new Uint8Array(SECRET_LENGTH);
    globalThis.crypto.getRandomValues(chunk);
    for (let i = 0; i < chunk.length && out.length < SECRET_LENGTH; i += 1) {
      const byte = chunk[i];
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % size];
    }
  }
  return out;
}

/** Хранимый вид: без дефисов, в верхнем регистре. Например MEDI7K3NQ82R. */
export function generateJoinCode(workspaceName: unknown): string {
  return `${joinCodePrefix(workspaceName)}${secretPart()}`;
}

/**
 * Нормализация ввода: код набирают с дефисами, без них, строчными и с
 * пробелами — всё это один и тот же код.
 *
 * Спутываемые символы НЕ подменяются (I→1, O→0 и подобное): подмена превратила
 * бы «не найдено» в «нашлась чужая клиника», а это ровно та утечка, ради
 * которой список клиник закрыт. Набранная I просто не найдётся, и человек
 * перенаберёт.
 */
export function normalizeJoinCode(raw: unknown): string {
  const source = typeof raw === "string" ? raw : "";
  return source.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Форма кода: 4 буквы префикса + 8 знаков алфавита. */
export function isJoinCodeShape(value: string): boolean {
  return new RegExp(`^[A-Z]{${PREFIX_LENGTH}}[${CODE_ALPHABET}]{${SECRET_LENGTH}}$`).test(value);
}

/**
 * Показ человеку: MEDI-7K3N-Q82R — так его удобнее диктовать и сверять.
 * Годится и как маска ввода: группы появляются по мере набора, а лишнее
 * обрезается, поэтому в поле нельзя набрать больше кода.
 */
export function formatJoinCode(stored: unknown): string {
  const code = normalizeJoinCode(stored).slice(0, PREFIX_LENGTH + SECRET_LENGTH);
  return [code.slice(0, 4), code.slice(4, 8), code.slice(8)].filter(Boolean).join("-");
}

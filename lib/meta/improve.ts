import { checkMetaCompliance, type MetaComplianceResult, type MetaComplianceStatus } from "./compliance";
import { DEFAULT_VERTICAL, type Vertical } from "../vertical/terms";
import { isRealProvider } from "../ai/text-provider";

// Платформа чинит текст, а не запирает дверь.
//
// Проверка формулировок отвечает на вопрос «что здесь нельзя», и до этого
// модуля весь ответ продукта на него состоял из таблицы замен: «лечение» →
// «консультация», «навсегда» → пусто. Замены не согласуют падеж и не знают, о
// чём объявление, поэтому «лечение без риска» превращалось в «консультация
// после консультации». Такой текст клиника в Meta не отправит.
//
// Здесь то же самое делает модель, а её ответ не принимается на слово: он
// прогоняется теми же правилами. Не сошлось — вторая попытка с перечнем
// оставшегося. Дальше выбирается лучший вариант, и исходный текст участвует в
// выборе наравне с ответами модели: улучшение обязано уметь проиграть, иначе
// «улучшением» называется любой ответ, включая тот, что хуже начального.
//
// Ничего не применяется само: решение остаётся за оператором.

/** Поля объявления — ровно те, что проверяет checkMetaCompliance. */
export type AdFields = {
  headline: string;
  text: string;
  description: string;
};

/** Как получен результат. `rules` — таблица замен, когда модели нет. */
export type ImproveMode = "model" | "rules";

export type ImproveIssue = {
  code: string;
  severity: "review" | "block";
  message: string;
  match?: string;
};

export type ImproveCandidate = {
  /** Откуда взят вариант. `original` — исходный текст, он всегда в списке. */
  source: "original" | "model" | "rules";
  fields: AdFields;
  status: MetaComplianceStatus;
  issues: ImproveIssue[];
  /**
   * Коммерческие обещания, которых не было в исходнике: «скидка», «акция»,
   * процент, цена. Такой вариант не выигрывает никогда, даже если правила о
   * формулировках к нему не придрались: цену и скидку объявляет клиника, а не
   * модель.
   */
  invented: string[];
};

export type ImproveResult = {
  mode: ImproveMode;
  /** Лучший вариант. Может оказаться исходным — тогда changed === false. */
  fields: AdFields;
  status: MetaComplianceStatus;
  issues: ImproveIssue[];
  /** Отличается ли результат от исходного текста. */
  changed: boolean;
  /** Все рассмотренные варианты, включая исходный, в порядке появления. */
  candidates: ImproveCandidate[];
  /** Вердикт по исходному тексту: с чего начали. */
  before: { status: MetaComplianceStatus; issues: ImproveIssue[] };
  /**
   * Почему улучшение не состоялось. Пусто, когда провайдер ответил.
   * Отдельно от issues: «провайдер не ответил» и «модель не справилась» — это
   * разные новости, и путать их нельзя.
   */
  refusal: string;
};

/**
 * Обращение к модели. Внедряется снаружи, а не импортируется:
 * так этот модуль проверяется без сети и без ключа.
 */
export type AdTextGenerator = (input: {
  system: string;
  user: unknown;
}) => Promise<{ mode: string; data: unknown }>;

const MAX_ATTEMPTS = 2;

/**
 * Задание модели зависит от ниши.
 *
 * Прежний текст был один на всех и требовал «упомянуть консультацию
 * специалиста». Для салона это принудительная медицинская оговорка в каждом
 * объявлении: он рекламирует окрашивание, а получает фразу про специалиста,
 * которой сам не делал. И наоборот — прежний текст называл нежелательным
 * упоминание «морщин» и «пигментации», то есть просил салон вычеркнуть
 * название собственной услуги.
 */
export function improveSystemPrompt(vertical: Vertical = DEFAULT_VERTICAL): string {
  return vertical === "beauty" ? BEAUTY_SYSTEM_PROMPT : IMPROVE_SYSTEM_PROMPT;
}

export const IMPROVE_SYSTEM_PROMPT = [
  "Ты пишешь рекламные объявления для медицинских и косметологических клиник на русском языке.",
  "Отвечай только валидным JSON с полями headline, text, description. Без markdown, без пояснений.",
  "",
  "Задача: переписать объявление так, чтобы оно прошло модерацию Meta, сохранив смысл предложения.",
  "",
  "Запрещено:",
  "— обращаться к состоянию читателя («у вас», «страдаете», «болеете», «хотите избавиться»);",
  "— обещать результат, гарантию, «навсегда», «100%», «без риска», «точный результат»;",
  "— формулировки в духе «до и после», «до/после», «before & after»;",
  "— давление: «срочно», «только сегодня», «последний шанс», «успейте», «лучший», «самый эффективный».",
  "",
  "Нежелательно, но допустимо, если без этого теряется смысл объявления:",
  "— называть состояние («акне», «морщины», «пигментация», «лечение») — лучше писать об услуге клиники:",
  "  не «Избавим от акне», а «Программы по коже лица»;",
  "— обращаться на «ваши/твои» рядом с названием состояния.",
  "",
  "Обязательно:",
  "— писать об услуге клиники, а не о теле читателя;",
  "— упомянуть консультацию специалиста;",
  "— сохранить длину полей примерно как в исходнике.",
  "",
  "Ничего не выдумывать: не добавлять цен, скидок, акций, подарков, промокодов, рассрочки, сроков,",
  "процентов, названий процедур, лицензий и любых чисел, которых нет в исходном тексте.",
  "Если в исходнике скидки не было, её не должно быть и в ответе — ни цифрой, ни прописью.",
].join("\n");

/**
 * То же для салона.
 *
 * Отличий три, и все три существенны. Салону разрешено называть услугу своим
 * именем — «работа с пигментацией» это описание услуги, а не диагноз. Салону
 * запрещено говорить про лечение — он его не оказывает. И оговорка у него своя,
 * без «консультации специалиста».
 */
const BEAUTY_SYSTEM_PROMPT = [
  "\u0422\u044b \u043f\u0438\u0448\u0435\u0448\u044c \u0440\u0435\u043a\u043b\u0430\u043c\u043d\u044b\u0435 \u043e\u0431\u044a\u044f\u0432\u043b\u0435\u043d\u0438\u044f \u0434\u043b\u044f \u0441\u0430\u043b\u043e\u043d\u043e\u0432 \u043a\u0440\u0430\u0441\u043e\u0442\u044b \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c \u044f\u0437\u044b\u043a\u0435.",
  "\u041e\u0442\u0432\u0435\u0447\u0430\u0439 \u0442\u043e\u043b\u044c\u043a\u043e \u0432\u0430\u043b\u0438\u0434\u043d\u044b\u043c JSON \u0441 \u043f\u043e\u043b\u044f\u043c\u0438 headline, text, description. \u0411\u0435\u0437 markdown, \u0431\u0435\u0437 \u043f\u043e\u044f\u0441\u043d\u0435\u043d\u0438\u0439.",
  "",
  "\u0417\u0430\u0434\u0430\u0447\u0430: \u043f\u0435\u0440\u0435\u043f\u0438\u0441\u0430\u0442\u044c \u043e\u0431\u044a\u044f\u0432\u043b\u0435\u043d\u0438\u0435 \u0442\u0430\u043a, \u0447\u0442\u043e\u0431\u044b \u043e\u043d\u043e \u043f\u0440\u043e\u0448\u043b\u043e \u043c\u043e\u0434\u0435\u0440\u0430\u0446\u0438\u044e Meta, \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0432 \u0441\u043c\u044b\u0441\u043b \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f.",
  "",
  "\u0417\u0430\u043f\u0440\u0435\u0449\u0435\u043d\u043e:",
  "\u2014 \u043e\u0431\u0440\u0430\u0449\u0430\u0442\u044c\u0441\u044f \u043a \u0432\u043d\u0435\u0448\u043d\u043e\u0441\u0442\u0438 \u0447\u0438\u0442\u0430\u0442\u0435\u043b\u044f (\u00ab\u0443 \u0432\u0430\u0441 \u0442\u0443\u0441\u043a\u043b\u0430\u044f \u043a\u043e\u0436\u0430\u00bb, \u00ab\u0441\u0442\u0440\u0430\u0434\u0430\u0435\u0442\u0435\u00bb, \u00ab\u0445\u043e\u0442\u0438\u0442\u0435 \u0438\u0437\u0431\u0430\u0432\u0438\u0442\u044c\u0441\u044f\u00bb);",
  "\u2014 \u043e\u0431\u0435\u0449\u0430\u0442\u044c \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442, \u0433\u0430\u0440\u0430\u043d\u0442\u0438\u044e, \u00ab\u043d\u0430\u0432\u0441\u0435\u0433\u0434\u0430\u00bb, \u00ab100%\u00bb, \u00ab\u0431\u0435\u0437 \u0440\u0438\u0441\u043a\u0430\u00bb;",
  "\u2014 \u0444\u043e\u0440\u043c\u0443\u043b\u0438\u0440\u043e\u0432\u043a\u0438 \u0432 \u0434\u0443\u0445\u0435 \u00ab\u0434\u043e \u0438 \u043f\u043e\u0441\u043b\u0435\u00bb, \u00ab\u0434\u043e/\u043f\u043e\u0441\u043b\u0435\u00bb, \u00abbefore & after\u00bb;",
  "\u2014 \u0434\u0430\u0432\u043b\u0435\u043d\u0438\u0435: \u00ab\u0441\u0440\u043e\u0447\u043d\u043e\u00bb, \u00ab\u0442\u043e\u043b\u044c\u043a\u043e \u0441\u0435\u0433\u043e\u0434\u043d\u044f\u00bb, \u00ab\u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0439 \u0448\u0430\u043d\u0441\u00bb, \u00ab\u0443\u0441\u043f\u0435\u0439\u0442\u0435\u00bb, \u00ab\u043b\u0443\u0447\u0448\u0438\u0439\u00bb;",
  "\u2014 \u0441\u043b\u043e\u0432\u0430 \u043f\u0440\u043e \u043b\u0435\u0447\u0435\u043d\u0438\u0435, \u0434\u0438\u0430\u0433\u043d\u043e\u0437 \u0438 \u0437\u0430\u0431\u043e\u043b\u0435\u0432\u0430\u043d\u0438\u044f: \u0441\u0430\u043b\u043e\u043d \u043d\u0435 \u043b\u0435\u0447\u0438\u0442, \u0438 \u0437\u0430\u044f\u0432\u043b\u044f\u0442\u044c \u044d\u0442\u043e \u043d\u0435\u043b\u044c\u0437\u044f.",
  "",
  "\u041e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u043e:",
  "\u2014 \u043f\u0438\u0441\u0430\u0442\u044c \u043e\u0431 \u0443\u0441\u043b\u0443\u0433\u0435 \u0441\u0430\u043b\u043e\u043d\u0430, \u0430 \u043d\u0435 \u043e \u0442\u0435\u043b\u0435 \u0447\u0438\u0442\u0430\u0442\u0435\u043b\u044f;",
  "\u2014 \u0443\u043f\u043e\u043c\u044f\u043d\u0443\u0442\u044c, \u0447\u0442\u043e \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u043f\u043e\u0434\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044f \u043d\u0430 \u043a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u0438 \u0441 \u043c\u0430\u0441\u0442\u0435\u0440\u043e\u043c;",
  "\u2014 \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0434\u043b\u0438\u043d\u0443 \u043f\u043e\u043b\u0435\u0439 \u043f\u0440\u0438\u043c\u0435\u0440\u043d\u043e \u043a\u0430\u043a \u0432 \u0438\u0441\u0445\u043e\u0434\u043d\u0438\u043a\u0435.",
  "",
  "\u041d\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u0443\u0441\u043b\u0443\u0433\u0443 \u0441\u0432\u043e\u0438\u043c \u0438\u043c\u0435\u043d\u0435\u043c \u041c\u041e\u0416\u041d\u041e \u0438 \u043d\u0443\u0436\u043d\u043e: \u00ab\u0443\u0445\u043e\u0434 \u0437\u0430 \u043a\u043e\u0436\u0435\u0439\u00bb, \u00ab\u0440\u0430\u0431\u043e\u0442\u0430 \u0441 \u043f\u0438\u0433\u043c\u0435\u043d\u0442\u0430\u0446\u0438\u0435\u0439\u00bb,",
  "\u00ab\u043a\u043e\u0440\u0440\u0435\u043a\u0446\u0438\u044f \u043c\u043e\u0440\u0449\u0438\u043d\u00bb \u2014 \u044d\u0442\u043e \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u0443\u0441\u043b\u0443\u0433\u0438 \u0441\u0430\u043b\u043e\u043d\u0430, \u0430 \u043d\u0435 \u0434\u0438\u0430\u0433\u043d\u043e\u0437.",
  "",
  "\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0432\u044b\u0434\u0443\u043c\u044b\u0432\u0430\u0442\u044c: \u043d\u0435 \u0434\u043e\u0431\u0430\u0432\u043b\u044f\u0442\u044c \u0446\u0435\u043d, \u0441\u043a\u0438\u0434\u043e\u043a, \u0430\u043a\u0446\u0438\u0439, \u043f\u043e\u0434\u0430\u0440\u043a\u043e\u0432, \u043f\u0440\u043e\u043c\u043e\u043a\u043e\u0434\u043e\u0432,",
  "\u0440\u0430\u0441\u0441\u0440\u043e\u0447\u043a\u0438, \u0441\u0440\u043e\u043a\u043e\u0432, \u043f\u0440\u043e\u0446\u0435\u043d\u0442\u043e\u0432 \u0438 \u043b\u044e\u0431\u044b\u0445 \u0447\u0438\u0441\u0435\u043b, \u043a\u043e\u0442\u043e\u0440\u044b\u0445 \u043d\u0435\u0442 \u0432 \u0438\u0441\u0445\u043e\u0434\u043d\u043e\u043c \u0442\u0435\u043a\u0441\u0442\u0435.",
].join("\n");

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Ответ модели — данные, а не команда: читаем три поля и игнорируем остальное. */
export function readAdFields(value: unknown, fallback: AdFields): AdFields {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    headline: asString(record.headline) || fallback.headline,
    text: asString(record.text) || fallback.text,
    description: asString(record.description) || fallback.description,
  };
}

function joined(fields: AdFields): string {
  return `${fields.headline}\n${fields.text}\n${fields.description}`;
}

function sameFields(left: AdFields, right: AdFields): boolean {
  return left.headline === right.headline && left.text === right.text && left.description === right.description;
}

function verdictOf(fields: AdFields, vertical: Vertical): MetaComplianceResult {
  return checkMetaCompliance(
    { headline: fields.headline, text: fields.text, description: fields.description },
    vertical,
  );
}

function issuesOf(result: MetaComplianceResult): ImproveIssue[] {
  return result.issues.map((issue) => ({
    code: issue.code,
    // Severity едет наружу, потому что по ней выбирается лучший вариант.
    // Пока замечания считались штуками, один блокирующий вариант выигрывал у
    // двух с замечаниями уровня review — то есть цикл выбрасывал единственный
    // запускаемый текст, который сам же и получил.
    severity: issue.severity,
    message: issue.message,
    match: issue.match,
  }));
}

function blockingCount(issues: ImproveIssue[]): number {
  return issues.filter((issue) => issue.severity === "block").length;
}

/**
 * Слова, которыми объявляют коммерческое предложение.
 *
 * Модель не вправе их сочинить: скидку, акцию и рассрочку объявляет клиника.
 * Проверка идёт по словам, а не только по цифрам, потому что «скидка пятьдесят
 * процентов» цифр не содержит вовсе.
 */
const OFFER_MARKERS = [
  "скидк",
  "акци",
  "бесплатн",
  "подар",
  "промокод",
  "рассрочк",
  "бонус",
  "розыгрыш",
  "дарим",
];

/**
 * Числа, привязанные к деньгам или процентам.
 *
 * Сравнивать все цепочки цифр подряд нельзя: «15000» и «15 000» — одно и то же
 * число, «с 9 до 21» и «с 09:00 до 21:00» — одно и то же время, а телефон,
 * записанный иначе, вообще не имеет отношения к обещаниям. Такая проверка
 * объявляла чистый переписанный текст заблокированным на ровном месте.
 * Здесь берутся только те числа, рядом с которыми стоит процент или валюта,
 * то есть те, что и составляют цену или скидку.
 */
function priceLikeNumbers(text: string): string[] {
  // Пробелы внутри разрядов убираются: «15 000» — это «15000».
  const normalized = text.replace(/(\d)[   ](?=\d{3}(?![\d]))/g, "$1");
  const found = normalized.match(/\d[\d.,]*\s*(?:%|процент\p{L}*|₸|₽|тг\b|руб\p{L}*|тенге)/giu) || [];
  return [...new Set(found.map((item) => item.replace(/\s+/g, " ").trim().toLowerCase()))];
}

function offerMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  return OFFER_MARKERS.filter((marker) => lower.includes(marker));
}

/** Что модель добавила от себя: обещание, которого клиника не делала. */
export function inventedOffers(before: AdFields, after: AdFields): string[] {
  const source = joined(before);
  const result = joined(after);

  const knownMarkers = new Set(offerMarkers(source));
  const knownPrices = new Set(priceLikeNumbers(source));

  return [
    ...offerMarkers(result).filter((marker) => !knownMarkers.has(marker)),
    ...priceLikeNumbers(result).filter((price) => !knownPrices.has(price)),
  ];
}

function candidateOf(
  source: ImproveCandidate["source"],
  fields: AdFields,
  original: AdFields,
  vertical: Vertical,
): ImproveCandidate {
  const result = verdictOf(fields, vertical);
  return {
    source,
    fields,
    status: result.status,
    issues: issuesOf(result),
    invented: source === "original" ? [] : inventedOffers(original, fields),
  };
}

/**
 * Лучший вариант из рассмотренных.
 *
 * Порядок сравнения: сперва отсутствие выдуманных обещаний, затем число
 * блокирующих замечаний, затем общее число замечаний. При равенстве побеждает
 * тот, кто раньше в списке, а первым всегда идёт исходный текст — то есть
 * замена происходит, только если вариант строго лучше.
 */
function bestOf(candidates: ImproveCandidate[]): ImproveCandidate {
  return candidates.reduce((winner, current) => {
    const rank = (item: ImproveCandidate) => [item.invented.length ? 1 : 0, blockingCount(item.issues), item.issues.length];
    const [wInvented, wBlocking, wIssues] = rank(winner);
    const [cInvented, cBlocking, cIssues] = rank(current);

    if (cInvented !== wInvented) return cInvented < wInvented ? current : winner;
    if (cBlocking !== wBlocking) return cBlocking < wBlocking ? current : winner;
    return cIssues < wIssues ? current : winner;
  }, candidates[0]);
}

/** Достаточно ли хорош вариант, чтобы прекратить попытки. */
function goodEnough(candidate: ImproveCandidate): boolean {
  // Не «safe», а «нет блокирующих замечаний».
  //
  // Замечания уровня review — это «посмотрите глазами», и часть из них модель
  // убрать не может в принципе: объявление про акне обязано назвать акне.
  // Требуя «safe», цикл сжигал обе попытки всегда и возвращал вариант, который
  // от первого отличался только формулировкой.
  return blockingCount(candidate.issues) === 0 && candidate.invented.length === 0;
}

/**
 * Переписать объявление и проверить, что получилось.
 *
 * Без генератора (нет ключа провайдера) остаётся таблица замен из
 * checkMetaCompliance: она хуже, но это честный запасной вариант, и режим
 * возвращается наружу, чтобы экран не выдавал одно за другое.
 */
export async function improveAdText(input: {
  fields: AdFields;
  generate?: AdTextGenerator | null;
  /** Ниша решает и правила, и задание модели, и текст оговорки. */
  vertical?: Vertical;
}): Promise<ImproveResult> {
  const vertical = input.vertical || DEFAULT_VERTICAL;
  const original: AdFields = {
    headline: asString(input.fields.headline),
    text: asString(input.fields.text),
    description: asString(input.fields.description),
  };
  const originalCandidate = candidateOf("original", original, original, vertical);
  const before = { status: originalCandidate.status, issues: originalCandidate.issues };

  function finish(mode: ImproveMode, candidates: ImproveCandidate[], refusal: string): ImproveResult {
    const best = bestOf(candidates);
    return {
      mode,
      fields: best.fields,
      status: best.status,
      issues: best.issues,
      changed: !sameFields(best.fields, original),
      candidates,
      before,
      refusal,
    };
  }

  /** Таблица замен. Пустое поле не публикуется: оно исчезло бы из объявления. */
  function rulesCandidate(): ImproveCandidate {
    const parts = verdictOf(original, vertical).safeParts;
    const fields: AdFields = {
      headline: parts.headline || original.headline,
      text: parts.text || original.text,
      description: parts.description || original.description,
    };
    // Вердикт считается по тем полям, которые реально уедут в объявление, а не
    // по огрызку без исчезнувшего заголовка.
    return candidateOf("rules", fields, original, vertical);
  }

  if (!input.generate) {
    return finish("rules", [originalCandidate, rulesCandidate()], "");
  }

  const candidates: ImproveCandidate[] = [originalCandidate];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const previous = candidates[candidates.length - 1];

    let generated: { mode: string; data: unknown };
    try {
      generated = await input.generate({
        system: improveSystemPrompt(vertical),
        user: {
          original,
          previousAttempt: previous.source === "original" ? null : previous.fields,
          // Модель видит, что именно сработало и на какой фразе: без этого
          // вторая попытка повторяет первую. `found` подрезается — у правила
          // про дисклеймер совпадением является весь текст объявления.
          mustFix: previous.issues.map((issue) => ({
            rule: issue.code,
            severity: issue.severity,
            why: issue.message,
            found: (issue.match || "").slice(0, 60),
          })),
          doNotInvent: previous.invented,
          attempt: attempt + 1,
        },
      });
    } catch (error) {
      // Сбой провайдера на второй попытке не отменяет первую: уже полученный
      // вариант остаётся в списке и участвует в выборе наравне с исходником.
      return finish("model", candidates, error instanceof Error ? error.message : "Провайдер не ответил");
    }

    // Ключа нет — генератор отвечает demo (а «mock» и «telegram» моделью не
    // являются тем более). Выдавать это за работу модели нельзя.
    //
    // Проверяется ПРИНАДЛЕЖНОСТЬ множеству живых провайдеров, а не равенство
    // «openai»: с появлением Claude равенство выбрасывало настоящий, уже
    // оплаченный ответ модели и сообщало оператору «ИИ-провайдер не подключён».
    if (!isRealProvider(generated.mode)) {
      return finish("rules", [originalCandidate, rulesCandidate()], "");
    }

    const candidate = candidateOf("model", readAdFields(generated.data, original), original, vertical);
    candidates.push(candidate);

    if (goodEnough(candidate)) break;
  }

  return finish("model", candidates, "");
}

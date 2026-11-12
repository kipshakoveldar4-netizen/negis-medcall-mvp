import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// AI — платформа переписывает объявление, а не запирает дверь.
//
// До этого весь ответ продукта на «текст нельзя запускать» состоял из таблицы
// замен: «лечение» → «консультация», «навсегда» → пусто. Замены не согласуют
// падеж и не знают, о чём объявление, поэтому «лечение без риска» превращалось
// в «консультация после консультации» — текст, который клиника в Meta не
// отправит, и правильно сделает.
//
// Ключевое свойство нового пути — не в том, что зовётся модель, а в том, что
// её ответ не принимается на слово: он прогоняется теми же правилами, и в
// выборе участвует исходный текст. Улучшение обязано уметь проиграть, иначе
// «улучшением» называется любой ответ, включая тот, что хуже начального.
//
// Генератор здесь подставной: ни сети, ни ключа, ни production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const improvePath = path.join(repoRoot, "lib", "meta", "improve.ts");
const compliancePath = path.join(repoRoot, "lib", "meta", "compliance.ts");
const routePath = path.join(repoRoot, "api", "content-studio", "[...path].ts");
const adsPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");

type AdFields = { headline: string; text: string; description: string };
type Issue = { code: string; severity: "review" | "block"; message: string; match?: string };
type Candidate = { source: string; fields: AdFields; status: string; issues: Issue[]; invented: string[] };
type ImproveResult = {
  mode: "model" | "rules";
  fields: AdFields;
  status: "safe" | "needs_review" | "blocked";
  issues: Issue[];
  changed: boolean;
  candidates: Candidate[];
  before: { status: string; issues: Issue[] };
  refusal: string;
};
type ImproveModule = {
  improveAdText: (input: {
    fields: AdFields;
    generate?: ((input: { system: string; user: unknown }) => Promise<{ mode: string; data: unknown }>) | null;
  }) => Promise<ImproveResult>;
  readAdFields: (value: unknown, fallback: AdFields) => AdFields;
  inventedOffers: (before: AdFields, after: AdFields) => string[];
  IMPROVE_SYSTEM_PROMPT: string;
};

const { improveAdText, readAdFields, inventedOffers, IMPROVE_SYSTEM_PROMPT } = (await import(
  pathToFileURL(improvePath).href
)) as ImproveModule;

const { checkMetaCompliance } = (await import(pathToFileURL(compliancePath).href)) as {
  checkMetaCompliance: (input: Record<string, string>) => { status: string; issues: Array<{ code: string }> };
};

/** Объявление, которое Meta не примет: обращение, гарантия, before/after. */
const BAD: AdFields = {
  headline: "У вас акне?",
  text: "Гарантируем 100% результат навсегда.",
  description: "До и после.",
};

/** Чистая переписанная версия — то, что должна вернуть работающая модель. */
const CLEAN: AdFields = {
  headline: "Программы по коже лица",
  text: "Подберём план после консультации специалиста.",
  description: "Записаться на приём.",
};

/** Подставной генератор: отдаёт заготовленные ответы по очереди. */
function generatorOf(...responses: Array<unknown>) {
  const calls: Array<{ system: string; user: unknown }> = [];
  let index = 0;
  const generate = async (input: { system: string; user: unknown }) => {
    calls.push(input);
    const data = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { mode: "openai", data };
  };
  return { generate, calls };
}

async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

test("AI1 чистый ответ модели принимается и объявляется чистым", async () => {
  const { generate, calls } = generatorOf(CLEAN);
  const result = await improveAdText({ fields: BAD, generate });

  assert.equal(result.mode, "model");
  assert.equal(result.status, "safe");
  assert.equal(result.changed, true);
  assert.deepEqual(result.fields, CLEAN);
  assert.equal(calls.length, 1, "одной попытки достаточно");
  assert.equal(result.before.status, "blocked", "с чего начали — тоже видно");
});

test("AI2 ответ модели не принимается на слово: он проверяется теми же правилами", async () => {
  const stillBad: AdFields = {
    headline: "Гарантируем результат",
    text: "Записывайтесь.",
    description: "Консультация специалиста.",
  };
  const { generate } = generatorOf(stillBad);
  const result = await improveAdText({ fields: BAD, generate });

  assert.notEqual(result.status, "safe", "непроверенный ответ модели не может быть объявлен безопасным");
  assert.ok(result.issues.some((issue) => issue.code === "guarantee"));
});

test("AI3 улучшение умеет проиграть исходному тексту", async () => {
  // Исходник — с замечанием, но запускаемый. Модель обеими попытками делает
  // хуже. Пока исходный текст не участвовал в выборе, наружу уходил
  // блокирующий вариант, и кнопка предлагала заменить им живой текст.
  const source: AdFields = {
    headline: "Лечение акне в клинике",
    text: "Консультация специалиста.",
    description: "Записаться.",
  };
  const worse: AdFields = { headline: "У вас акне?", text: "Консультация специалиста.", description: "Записаться." };
  const { generate } = generatorOf(worse);
  const result = await improveAdText({ fields: source, generate });

  assert.equal(result.changed, false, "хуже исходного наружу не уходит");
  assert.deepEqual(result.fields, source);
  assert.ok(result.candidates.some((candidate) => candidate.source === "original"), "исходник — тоже кандидат");
});

test("AI4 вес важнее количества: один блокирующий хуже двух замечаний", async () => {
  const oneBlocking: AdFields = { headline: "Гарантия результата", text: "Записывайтесь.", description: "Консультация." };
  const twoReview: AdFields = { headline: "Ваши морщины", text: "Записывайтесь.", description: "Консультация." };
  const { generate } = generatorOf(oneBlocking, twoReview);
  const result = await improveAdText({ fields: BAD, generate });

  assert.notEqual(result.status, "blocked", "запускаемый вариант не выбрасывается ради меньшего числа замечаний");
  assert.deepEqual(result.fields, twoReview);
});

test("AI5 вторая попытка получает перечень оставшегося, а не повтор задания", async () => {
  const stillBad: AdFields = { headline: "Навсегда с вами", text: "Записывайтесь.", description: "Консультация." };
  const { generate, calls } = generatorOf(stillBad, CLEAN);
  const result = await improveAdText({ fields: BAD, generate });

  assert.equal(calls.length, 2, "после неудачи делается ещё одна попытка");
  assert.equal(result.status, "safe");

  const second = calls[1].user as Record<string, unknown>;
  const mustFix = second.mustFix as Array<{ rule: string; found: string }>;
  assert.ok(mustFix.some((item) => item.rule === "guarantee"), "модель видит, что именно осталось");
  assert.ok(second.previousAttempt, "и свой прошлый ответ");
  for (const item of mustFix) {
    assert.ok(item.found.length <= 60, "найденная фраза подрезана: у правила про дисклеймер это весь текст");
  }
});

test("AI6 попытки прекращаются, когда блокирующих замечаний не осталось", async () => {
  // Замечание уровня review модель убрать не может в принципе: объявление про
  // акне обязано назвать акне. Требуя «safe», цикл сжигал обе попытки всегда.
  const reviewOnly: AdFields = {
    headline: "Лечение акне",
    text: "Подберём план после консультации специалиста.",
    description: "Записаться.",
  };
  const { generate, calls } = generatorOf(reviewOnly);
  const result = await improveAdText({ fields: BAD, generate });

  assert.equal(calls.length, 1, "вторая попытка не тратится впустую");
  assert.equal(result.status, "needs_review");
  assert.equal(result.changed, true);
});

test("AI7 бесконечных попыток нет", async () => {
  const stillBad: AdFields = { headline: "Навсегда", text: "Гарантируем.", description: "До и после." };
  const { generate, calls } = generatorOf(stillBad);
  const result = await improveAdText({ fields: BAD, generate });

  assert.equal(calls.length, 2, "две попытки — потолок");
  assert.equal(result.candidates.filter((candidate) => candidate.source === "model").length, 2);
});

test("AI8 выдуманное коммерческое обещание не выигрывает никогда", async () => {
  // Скидка, акция, рассрочка — это обещание клиники. Модель не вправе его
  // сочинить, а правила про формулировки таких слов не ловят.
  const invented: AdFields = {
    headline: "Программы по коже",
    text: "Скидка 30% на первый визит.",
    description: "Консультация специалиста.",
  };
  const { generate } = generatorOf(invented);
  const result = await improveAdText({ fields: BAD, generate });

  assert.notDeepEqual(result.fields, invented, "вариант с выдуманной скидкой не предлагается");
  assert.ok(result.candidates.some((candidate) => candidate.invented.length > 0), "и причина видна");
});

test("AI9 выдуманное ловится и словом, и цифрой — и не ловится там, где его нет", () => {
  const source: AdFields = { headline: "Клиника косметологии 10 лет", text: "Приходите.", description: "" };

  // Совпавшая цифра в другом поле не делает скидку своей.
  assert.ok(
    inventedOffers(source, { ...source, text: "Скидка 10% на первый визит." }).length > 0,
    "скидка выдумана, даже если цифра 10 где-то встречалась",
  );
  // Пропись цифр не содержит вовсе.
  assert.ok(
    inventedOffers(source, { ...source, text: "Скидка пятьдесят процентов." }).length > 0,
    "скидка прописью — тоже скидка",
  );

  // А переформатирование своего же числа обещанием не является.
  const price: AdFields = { headline: "Чистка лица", text: "Цена 15000 тг.", description: "" };
  assert.deepEqual(inventedOffers(price, { ...price, text: "Цена 15 000 тг." }), [], "15000 и 15 000 — одно число");

  const hours: AdFields = { headline: "Клиника", text: "Работаем с 9 до 21.", description: "" };
  assert.deepEqual(inventedOffers(hours, { ...hours, text: "Работаем с 09:00 до 21:00." }), [], "часы приёма — не скидка");

  const phone: AdFields = { headline: "Клиника", text: "+7 495 120-30-40", description: "" };
  assert.deepEqual(inventedOffers(phone, { ...phone, text: "+74951203040" }), [], "телефон — не скидка");
});

test("AI10 сбой провайдера на второй попытке не выбрасывает первую", async () => {
  const better: AdFields = { headline: "Программы по коже", text: "Записывайтесь.", description: "Навсегда." };
  let call = 0;
  const result = await improveAdText({
    fields: BAD,
    generate: async () => {
      call += 1;
      if (call === 1) return { mode: "openai", data: better };
      throw new Error("HTTP 429");
    },
  });

  assert.ok(result.refusal.includes("429"), "причина отказа доезжает наружу");
  assert.equal(result.candidates.filter((candidate) => candidate.source === "model").length, 1, "первая попытка цела");
  assert.equal(result.changed, true, "и участвует в выборе");
});

test("AI11 отказ провайдера на первой попытке оставляет исходный текст", async () => {
  const result = await improveAdText({
    fields: BAD,
    generate: async () => {
      throw new Error("HTTP 500");
    },
  });

  assert.ok(result.refusal.includes("500"));
  assert.deepEqual(result.fields, BAD, "исходный текст не подменяется");
  assert.equal(result.changed, false);
});

test("AI12 без провайдера честно возвращается режим таблицы замен", async () => {
  const withoutGenerator = await improveAdText({ fields: BAD, generate: null });
  assert.equal(withoutGenerator.mode, "rules", "подстановка по словарю не выдаётся за работу модели");

  const demo = await improveAdText({ fields: BAD, generate: async () => ({ mode: "demo", data: CLEAN }) });
  assert.equal(demo.mode, "rules");
  assert.notDeepEqual(demo.fields, CLEAN, "ответ demo-режима не подставляется как переписанный текст");
});

test("AI13 таблица замен не публикует пустое поле", async () => {
  // «Навсегда» заменяется на пустую строку. Публиковать объявление без
  // заголовка нельзя, а считать вердикт без него — тем более: экран подставил
  // бы обратно исходный текст, о котором вердикт ничего не говорит.
  const source: AdFields = { headline: "Навсегда", text: "Гарантируем результат.", description: "Консультация." };
  const result = await improveAdText({ fields: source, generate: null });

  const rules = result.candidates.find((candidate) => candidate.source === "rules");
  assert.ok(rules, "вариант по словарю есть");
  assert.ok(rules!.fields.headline.trim().length > 0, "заголовок не исчезает");
  assert.ok(rules!.fields.text.trim().length > 0);
});

test("AI14 мусор от модели не стирает поля объявления", () => {
  const fallback: AdFields = { headline: "Заголовок", text: "Текст", description: "Описание" };

  assert.deepEqual(readAdFields(null, fallback), fallback);
  assert.deepEqual(readAdFields("не объект", fallback), fallback);
  assert.deepEqual(readAdFields({ headline: "   " }, fallback), fallback, "пустое поле не затирает исходное");
  assert.equal(readAdFields({ headline: "Новый", extra: "лишнее" }, fallback).headline, "Новый");
});

test("AI15 ответ, равный исходнику, не объявляется переписанным", async () => {
  const { generate } = generatorOf({});
  const result = await improveAdText({ fields: BAD, generate });

  assert.equal(result.changed, false, "модель ничего не изменила — так и надо сказать");
  assert.deepEqual(result.fields, BAD);
});

test("AI16 задание модели запрещает выдумывать факты и называет правила", () => {
  for (const forbidden of ["цен", "скидок", "акций", "сроков", "процентов"]) {
    assert.ok(IMPROVE_SYSTEM_PROMPT.includes(forbidden), `в задании обязан быть запрет на ${forbidden}`);
  }
  assert.ok(IMPROVE_SYSTEM_PROMPT.includes("консультацию специалиста"));
  // Правила уровня review тоже названы: без этого модель их не учитывает,
  // и «нежелательно» превращается в «неизвестно».
  assert.ok(IMPROVE_SYSTEM_PROMPT.includes("акне"), "называние состояния описано");
  assert.ok(IMPROVE_SYSTEM_PROMPT.includes("ваши/твои"), "и обращение на «вы/ты»");
});

test("AI17 маршрут закрыт тем же правом, что и остальная генерация", async () => {
  const route = await codeOf(routePath);

  assert.ok(/"improve-ad-text": \{[\s\S]{0,200}manage_ai_content/.test(route), "маршрут в реестре авторизации");
  assert.ok(/"improve-ad-text": \{[\s\S]{0,200}methods: \["POST"\]/.test(route), "и только POST");
  assert.ok(/if \(resource === "improve-ad-text"\) return handleImproveAdText/.test(route), "обработчик подключён");
  assert.ok(/changed: result\.changed/.test(route), "и changed доезжает до экрана");
});

test("AI18 экран показывает вердикт по переписанному тексту и не предлагает то же самое", async () => {
  const code = await codeOf(adsPath);

  assert.ok(code.includes("improve-ad-text"), "кнопка зовёт маршрут переписывания");
  assert.ok(code.includes("Улучшить текст"));
  assert.ok(/improved\.status === "safe"/.test(code), "цвет берётся из вердикта по переписанному тексту");
  assert.ok(/improved\.mode === "rules"/.test(code), "режим словаря называется вслух");
  assert.ok(/improved\.changed === false/.test(code), "и «лучше не вышло» — тоже");

  // Кнопка принятия не показывается, когда принимать нечего.
  const acceptBlock = code.slice(code.indexOf("Взять этот вариант") - 1400, code.indexOf("Взять этот вариант"));
  assert.ok(/improved\.changed === false \? null :/.test(acceptBlock), "кнопка скрыта, когда вариант равен исходному");
  assert.ok(acceptBlock.includes("setCompliance(null)"), "принятый вариант сбрасывает прошлую проверку");
});

test("AI19 запуск больше не подменяет основной текст склейкой всех полей", async () => {
  const code = await codeOf(adsPath);

  // compliance.safeText — это переписанная склейка трёх полей. Пока она
  // подставлялась в основной текст при любом статусе кроме «safe», объявление
  // уезжало в Meta с заголовком, напечатанным дважды.
  assert.ok(
    !/adTextForLaunch = compliance\?\.safeText/.test(code),
    "скрытая подмена текста при запуске убрана",
  );
  assert.ok(/const adTextForLaunch = aiPackage\?\.primaryText/.test(code), "в Meta уезжает то, что в пакете");
});

test("AI20 мёртвой ветки needs_review на сервере больше нет", async () => {
  const server = await codeOf(serverPath);

  // `manualApprovalConfirmed` проверяется безусловно двадцатью строками выше,
  // поэтому эта ветка не могла добавить ничего нового ни при каком входе.
  assert.ok(
    !/compliance\.status === "needs_review" && !readBoolean\(body\.manualApprovalConfirmed\)/.test(server),
    "мёртвая ветка удалена, а не оставлена изображать проверку",
  );
  assert.ok(/compliance\.status === "blocked"/.test(server), "а настоящий отказ на месте");
});

test("AI21 названо состояние — это замечание, а не запрет", () => {
  // Meta запрещает не называние услуги, а обращение к состоянию читателя.
  const naming = checkMetaCompliance({ text: "Лечение акне в клинике. Консультация специалиста." });
  assert.equal(naming.status, "needs_review", "клиника вправе назвать свою услугу");

  const addressing = checkMetaCompliance({ text: "У вас акне? Консультация специалиста." });
  assert.equal(addressing.status, "blocked", "а обращаться к состоянию читателя — нет");
});

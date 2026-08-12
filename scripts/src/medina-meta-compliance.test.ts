import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// MC — проверка формулировок рекламы работает на русском языке.
//
// До этого набора она не работала вообще. Все шесть правил были написаны через
// `\b`, а `\b` в JavaScript определена через `\w`, то есть [A-Za-z0-9_]: между
// пробелом и «у» перехода нет, обе стороны — не-слово, значит границы нет,
// значит правило не срабатывает никогда. Флаг `u` этого не меняет.
//
// Практический итог: единственный вход, который мог дать «blocked», — латинское
// «before/after». Текст «У вас акне? Гарантируем 100% результат навсегда. До и
// после.» проходил все четыре блокирующих правила и объявлялся безопасным.
// Тем же дефектом было сломано переписывание: «безопасная версия» была точной
// копией исходного текста, а экран запуска рекламы предлагал её кнопкой и красил
// в зелёный, ничего не перепроверив.
//
// Это единственный комплаенс-актив продукта, и он стоит между медицинской
// клиникой и модерацией Meta. Ничего здесь не обращается ни к Meta, ни к
// production — только чистая функция и исходники.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const compliancePath = path.join(repoRoot, "lib", "meta", "compliance.ts");
const adsPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx");
const studioPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");

type ComplianceIssue = { code: string; severity: "review" | "block"; message: string; match?: string };
type ComplianceResult = {
  status: "safe" | "needs_review" | "blocked";
  issues: ComplianceIssue[];
  safeText: string;
  safeTextStatus: "safe" | "needs_review" | "blocked";
  safeTextIssues: ComplianceIssue[];
  safeParts: { headline: string; text: string; description: string };
  disclaimer: string;
};
type ComplianceModule = {
  checkMetaCompliance: (input: { text?: string; headline?: string; description?: string }) => ComplianceResult;
};

const { checkMetaCompliance } = (await import(pathToFileURL(compliancePath).href)) as ComplianceModule;

/** Коды сработавших правил — по ним читаются почти все проверки ниже. */
function codes(result: ComplianceResult): string[] {
  return result.issues.map((issue) => issue.code).sort();
}

/**
 * Исходник без комментариев.
 *
 * Резать нужно все три вида, а не только строки, начинающиеся с `//`.
 * Хвостовой комментарий на одной строке с кодом и тело JSX-комментария
 * `{/* … *\/}` иначе засчитываются за код — и в обе стороны: цитата старого
 * дефекта в пояснении красит набор без единой правки поведения, а живой
 * литерал, спрятанный за `//`, наоборот проходит за работающий код.
 */
async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    // Строчные — первыми, и это не вкусовщина. В AdsAutomation.tsx есть строка
    // `// Security-2B: /api/crm/* is authenticated server-side`, где `/*` —
    // часть пути, а не начало блока. Сняв сперва блоки, регулярка находила
    // закрывающую `*/` через сто десять тысяч символов и вырезала половину
    // файла: проверки по исходнику после этого падали на живом коде.
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

/** Текст, который клиника вполне могла написать и который обязан быть отклонён. */
const CANONICAL_BAD = {
  headline: "У вас акне?",
  text: "Гарантируем 100% результат навсегда.",
  description: "До и после.",
};

/** Дисклеймер в хвосте — иначе missing_disclaimer маскирует вердикт. */
const WITH_DISCLAIMER = " Запишитесь на консультацию.";

function codesOfPhrase(text: string): string[] {
  return codes(checkMetaCompliance({ text: text + WITH_DISCLAIMER }));
}

test("MC1 канонический плохой текст блокируется всеми четырьмя правилами", () => {
  const result = checkMetaCompliance(CANONICAL_BAD);

  assert.equal(result.status, "blocked");
  for (const code of ["personal_attribute_question", "medical_condition_claim", "guarantee", "before_after"]) {
    assert.ok(codes(result).includes(code), `правило ${code} обязано сработать`);
  }
});

test("MC2 в правилах не осталось \\b — на кириллице это тождественный ноль", async () => {
  const code = await codeOf(compliancePath);

  assert.ok(!/\\b/.test(code), "\\b определена через ASCII \\w и на русском тексте не даёт границы слова");
  assert.ok(code.includes("\\p{L}"), "границы слова считаются по буквам Unicode");
  assert.ok(/"iu"|'iu'|\/iu/.test(code), "и с флагом u, иначе \\p{L} — это литерал");
});

test("MC3 границы обходятся без lookbehind — этот файл уезжает в браузер", async () => {
  const code = await codeOf(compliancePath);

  // ContentStudio.tsx импортирует checkMetaCompliance напрямую, значит правила
  // собираются в браузере, на верхнем уровне модуля. Safari понимает \p{L} с
  // 11.1, а lookbehind — только с 16.4: на iPhone 7 (потолок — iOS 15.8) new
  // RegExp бросил бы SyntaxError и «Контент-студия» открылась бы белым экраном.
  assert.ok(!code.includes("(?<"), "lookbehind ронял бы весь чанк, а не одно правило");
  assert.ok(code.includes("(^|[^"), "левая граница берётся группой");
});

test("MC4 граница слова настоящая: «лучший» не находится внутри «наилучший»", () => {
  assert.ok(!codesOfPhrase("Наилучший подход подберём вместе.").includes("aggressive_claim"));
  assert.ok(codesOfPhrase("Лучший подход в городе.").includes("aggressive_claim"));
});

test("MC5 ложных срабатываний нет на обычном тексте клиники", () => {
  const clean = [
    "Получше узнаем задачу.",
    "Лучше записаться заранее.",
    "Безболезненная процедура.",
    "Гарантийный талон на аппарат.",
    "Сто процентов ясно.",
    "Вылечиться помогает режим.",
  ];
  for (const text of clean) {
    assert.deepEqual(codesOfPhrase(text), [], `${text} — здесь запрещённых формулировок нет`);
  }
});

test("MC6 обещание результата ловится во всех ходовых написаниях", () => {
  // «гарантиру» расходится с «гарантия» на девятой букве, поэтому самый
  // частый способ пообещать результат по-русски проходил зелёным.
  for (const text of [
    "Гарантия результата.",
    "Гарантированный результат.",
    "Даём гарантию на результат.",
    "Гарантируете ли вы срок?",
    "Скидка 100 % на первый визит.",
    "Скидка 100%результат.",
  ]) {
    assert.ok(codesOfPhrase(text).includes("guarantee"), `${text} → guarantee`);
  }
});

test("MC7 before/after ловится не только через слэш", () => {
  for (const text of ["До/после.", "До и после.", "До — после.", "До-после.", "Before/after.", "Before & after."]) {
    assert.ok(codesOfPhrase(text).includes("before_after"), `${text} → before_after`);
  }
});

test("MC8 основы слов и приставочные формы", () => {
  const cases: Array<[string, string]> = [
    ["Морщинами занимается косметолог.", "medical_condition_claim"],
    ["Курс лечения подбирается врачом.", "medical_condition_claim"],
    ["Пигментация — частый запрос.", "medical_condition_claim"],
    ["Полное излечение.", "medical_condition_claim"],
    ["Постакне уходит.", "medical_condition_claim"],
    ["Лучшая клиника города.", "aggressive_claim"],
    ["Самая эффективная методика.", "aggressive_claim"],
  ];
  for (const [text, code] of cases) {
    assert.ok(codesOfPhrase(text).includes(code), `${text} → ${code}`);
  }
});

test("MC9 напоминание о дисклеймере переживает перевод строки между полями", () => {
  // Прежний шаблон `^((?!…).)*$` не мог совпасть с многострочным текстом:
  // точка не переходит через \n, а три поля объявления склеиваются именно им.
  const threeFields = checkMetaCompliance({ headline: "Клиника", text: "Приходите", description: "Ждём" });
  assert.ok(codes(threeFields).includes("missing_disclaimer"), "дисклеймера нет — напоминание обязано появиться");

  const withDisclaimer = checkMetaCompliance({
    headline: "Клиника",
    text: "Приходите",
    description: "Нужна консультация специалиста",
  });
  assert.ok(!codes(withDisclaimer).includes("missing_disclaimer"), "дисклеймер есть — напоминание лишнее");
});

test("MC10 needs_review остаётся needs_review, а не превращается в отказ", () => {
  // Severity этих правил — переключатель «продукт работает / продукт отказывает
  // на всём»: сервер отдаёт 400 ровно при blocked. missing_disclaimer
  // срабатывает почти на любом объявлении, поэтому его повышение до block
  // остановило бы запуск любой рекламы без слова «консультация».
  const noDisclaimer = checkMetaCompliance({ headline: "Клиника", text: "Приходите", description: "Ждём" });
  assert.deepEqual(codes(noDisclaimer), ["missing_disclaimer"]);
  assert.equal(noDisclaimer.status, "needs_review", "отсутствие дисклеймера не блокирует запуск");

  const pushy = checkMetaCompliance({ text: "Только сегодня." + WITH_DISCLAIMER });
  assert.deepEqual(codes(pushy), ["aggressive_claim"]);
  assert.equal(pushy.status, "needs_review", "давление в тексте не блокирует запуск");
});

test("MC11 сработавший фрагмент возвращается наружу: экран показывает именно его", () => {
  const result = checkMetaCompliance(CANONICAL_BAD);
  const personal = result.issues.find((issue) => issue.code === "personal_attribute_question");

  assert.ok(personal?.match, "без match оператор не поймёт, какое слово менять");
  assert.equal(personal?.match?.toLowerCase(), "у вас");
});

test("MC12 переписывание действительно меняет текст, а не приклеивает дисклеймер", () => {
  const result = checkMetaCompliance(CANONICAL_BAD);

  assert.ok(!result.safeText.includes("У вас"), "личное обращение обязано уйти");
  assert.ok(!result.safeText.includes("Гарантируем"), "обещание обязано уйти");
  assert.ok(!result.safeText.includes("100%"), "процент обязан уйти");
  assert.ok(!result.safeText.includes("До и после"), "before/after обязан уйти");
});

test("MC13 регистр первой буквы сохраняется", () => {
  const result = checkMetaCompliance({ text: "Гарантируем результат. Мы гарантируем результат." });

  assert.ok(result.safeText.includes("Помогаем подобрать"), "с прописной там, где было с прописной");
  assert.ok(result.safeText.includes("помогаем подобрать"), "и со строчной там, где было со строчной");
});

test("MC14 вычеркнутое слово не оставляет за собой мусорную пунктуацию", () => {
  // Часть замен пустые. Раньше подчищались только пробелы, и «Быстро,
  // навсегда, дёшево.» превращалось в «Быстро,, дёшево.» — а вердикт по этому
  // обрубку был «safe», потому что запрещённых слов в нём, разумеется, нет.
  const cases: Array<[string, string]> = [
    ["Быстро, навсегда, дёшево.", "Быстро, дёшево."],
    ["Результат — навсегда — гарантируем.", "Результат — помогаем подобрать."],
  ];
  for (const [input, expected] of cases) {
    const first = checkMetaCompliance({ text: input }).safeText.split("\n")[0];
    assert.equal(first, expected, input);
  }

  for (const empty of ["Навсегда!", "Навсегда навсегда навсегда."]) {
    const safeText = checkMetaCompliance({ text: empty }).safeText;
    assert.ok(
      safeText.startsWith("Консультация специалиста"),
      `${empty}: текст из одних знаков препинания — это не текст объявления`,
    );
  }
});

test("MC15 в переписанном тексте нет висящих пробелов", () => {
  const result = checkMetaCompliance({ headline: "Гарантируем навсегда", text: "Клиника рядом", description: "Ждём" });

  assert.ok(!/ \n/.test(result.safeText), "пробел перед переводом строки уехал бы в Meta вместе с текстом");
  assert.ok(!/\n /.test(result.safeText), "и пробел после него тоже");
  assert.ok(!/ {2}/.test(result.safeText), "двойных пробелов не остаётся");

  // Отдельным входом: у первого текста знаков препинания нет вообще, поэтому
  // снятие пробела перед знаком он бы не проверил — «Гарантируем навсегда.»
  // без этой уборки даёт «Помогаем подобрать .» и уезжает в объявление.
  const punctuated = checkMetaCompliance({ text: "Гарантируем навсегда. Ждём вас, навсегда!" });
  assert.ok(!/ [.,!?;:]/.test(punctuated.safeText), "пробела перед знаком препинания не остаётся");
});

test("MC16 safeTextStatus — это настоящий вердикт по переписанному тексту", () => {
  const inputs = [CANONICAL_BAD, { text: "Хотите избавиться от пятен? Гарантируем результат навсегда." }, { text: "Клиника ждёт." }];
  for (const input of inputs) {
    const result = checkMetaCompliance(input);
    const recheck = checkMetaCompliance({ text: result.safeText });
    assert.equal(result.safeTextStatus, recheck.status, "вердикт обязан совпадать с прямой перепроверкой");
  }
});

test("MC17 переписывание не притворяется безопасным, когда убрало не всё", () => {
  // «акне» — медицинское состояние, нейтрального эквивалента у него нет, и
  // придумывать его за клинику таблица замен не должна. Само по себе называние
  // состояния запуск не блокирует (это делает обращение к читателю), но и
  // объявлять такой текст безопасным нельзя: замечание остаётся.
  const stillBad = checkMetaCompliance(CANONICAL_BAD);
  assert.notEqual(stillBad.safeTextStatus, "safe", "убрано не всё — значит не безопасно");
  assert.ok(stillBad.safeTextIssues.some((issue) => issue.code === "medical_condition_claim"));

  const fullyRewritten = checkMetaCompliance({
    headline: "Хотите избавиться от пятен?",
    text: "Гарантируем результат навсегда, без риска.",
    description: "До/после.",
  });
  assert.equal(fullyRewritten.status, "blocked", "исходник блокируется");
  assert.equal(fullyRewritten.safeTextStatus, "safe", "а смягчённая версия — уже нет");
});

test("MC18 поля переписываются по отдельности, а не одной склейкой", () => {
  // safeText — это переписанная склейка трёх полей. Экран клал её целиком в
  // основной текст: объявление уезжало в Meta с заголовком, напечатанным
  // дважды, а сам заголовок оставался непереписанным.
  const result = checkMetaCompliance({
    headline: "Гарантируем результат",
    text: "Клиника рядом",
    description: "Навсегда с вами",
  });

  assert.equal(result.safeParts.headline, "Помогаем подобрать результат");
  assert.equal(result.safeParts.text, "Клиника рядом");
  assert.ok(!result.safeParts.headline.includes("Клиника рядом"), "поле не тащит в себя соседние");
  assert.ok(!result.safeParts.text.includes(result.disclaimer), "дисклеймер не дублируется в каждое поле");
});

test("MC19 пустой ввод не роняет проверку", () => {
  const result = checkMetaCompliance({});

  assert.ok(result.safeText.length > 0, "подставляется нейтральный текст, а не пустая строка");
  assert.ok(result.safeText.includes(result.disclaimer));
});

test("MC20 экран запуска не красит в зелёный то, что зелёным не стало", async () => {
  const code = await codeOf(adsPath);

  // Проверяется сам рендер, а не объявление типа: до этого набор искал
  // подстроки safeTextStatus/safeTextIssues, а они живут в типе ComplianceResult
  // и остаются на месте, даже если блок вернуть к постоянному зелёному.
  assert.ok(!code.includes('status: "safe"'), "кнопка выставляла безопасный статус, не перепроверив текст");
  assert.ok(code.includes("Смягчённая версия — этого мало"), "у небезопасной версии свой заголовок");
  assert.ok(
    /safeTextStatus === "blocked"[\s\S]{0,120}border-rose-200/.test(code),
    "и свой цвет, выбранный по вердикту, а не постоянный",
  );
  assert.ok(
    /safeTextStatus === "needs_review"[\s\S]{0,120}border-amber-200/.test(code),
    "промежуточный вердикт тоже не зелёный",
  );
  assert.ok(code.includes("Автозамена убрала не всё"), "оставшиеся замечания показываются оператору");
  assert.ok(/status: current\.safeTextStatus/.test(code), "кнопка переносит вердикт, а не назначает его");

  // И переносит поля по отдельности. Проверка функции (MC18) этого не ловит:
  // safeParts может считаться правильно, а кнопка по-прежнему класть в
  // основной текст склейку всех трёх полей.
  assert.ok(/headline: parts\?\.headline/.test(code), "заголовок берётся из своего поля");
  assert.ok(/primaryText: parts\?\.text/.test(code), "основной текст — из своего");
  assert.ok(/description: parts\?\.description/.test(code), "описание — из своего");
  assert.ok(!/primaryText: compliance\.safeText/.test(code), "склейка трёх полей в основной текст не возвращается");
});

test("MC21 отказ сервера доезжает до экрана вместе с разбором", async () => {
  const code = await codeOf(adsPath);

  // Сервер при blocked кладёт в 400 сработавшие правила и смягчённую версию.
  // CrmError это тело нёс, но catch его не читал: setCompliance вызывался
  // только на успешном пути, и оператор видел красную строку без единого
  // замечания, а рядом — прошлый зелёный вердикт, который никто не сбросил.
  assert.ok(/catch \(error\)[\s\S]{0,900}error instanceof CrmError/.test(code), "разбор отказа берётся из ошибки");
  assert.ok(/catch \(error\)[\s\S]{0,900}setCompliance\(/.test(code), "и попадает на экран");
});

test("MC22 экран не обещает редактирование там, где его нет", async () => {
  const code = await codeOf(adsPath);

  // Поля пакета на шаге проверки выводятся через <p>, а не через поле ввода.
  assert.ok(!code.includes("Взять смягчённую версию и дописать"), "дописать здесь нечем");
  assert.ok(code.includes("Текст здесь не редактируется"), "экран говорит, что делать вместо этого");
});

test("MC23 предпросмотр показывает ровно тот текст, который уедет в Meta", async () => {
  const code = await codeOf(adsPath);

  assert.ok(
    !/previewAdText = firstString\(compliance\?\.safeText/.test(code),
    "предпросмотр не имеет права выбирать текст сам",
  );
  assert.ok(code.includes("const adTextForLaunch"), "выбор текста живёт в одном месте");
  assert.ok((code.match(/adTextForLaunch/g) || []).length >= 3, "и его используют оба — предпросмотр и запуск");
});

test("MC24 Контент-студия проверяет весь текст, который попадёт на макет", async () => {
  const code = await codeOf(studioPath);

  // Дисклеймер печатается на картинке, но в проверку не отдавался — и правило
  // требовало добавить то, что уже стоит на макете.
  assert.ok(
    /checkMetaCompliance\(\{[\s\S]{0,320}photoTexts\.disclaimer/.test(code),
    "поле дисклеймера обязано попадать в проверку",
  );
  assert.ok(
    code.includes('issue.code !== "missing_disclaimer"'),
    "и отсутствие дисклеймера не называется рискованной формулировкой",
  );
});

test("MC25 сервер по-прежнему отказывает в запуске при blocked", async () => {
  // Через codeOf: иначе гейт можно заменить на `if (false)`, оставив литерал
  // в комментарии рядом, и проверка этого не заметит.
  const server = await codeOf(serverPath);

  assert.ok(/compliance\.status === "blocked"/.test(server), "заблокированный текст не уходит в Meta");
  assert.ok(/checkMetaCompliance\(/.test(server), "и проверяется на сервере, а не только в браузере");
});

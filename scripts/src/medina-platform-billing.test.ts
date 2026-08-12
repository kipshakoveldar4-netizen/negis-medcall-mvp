import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// PB — арифметика денег на панели платформы.
//
// Всё здесь про одно: число на экране владельца должно совпадать с тем, что
// клинике выставлено. Разбор нашёл четыре места, где не совпадало, и все четыре
// одного класса — молчаливая подстановка вместо отказа.
//
// Годовая подписка при правке тарифа превращалась в месячную по годовой цене:
// форма всегда отправляла monthly, а price_minor у такой строки — сумма за год.
// Выручка платформы вырастала в двенадцать раз одним нажатием.
//
// Пустое поле цены сохранялось как ноль с зелёным сообщением об успехе:
// Number("") равен нулю. Бесплатный доступ существует, но его назначают, а не
// получают по недосмотру.
//
// Отказ чтения подписок давал «выручка 0 ₸», а отказ счётчика — «в клинике ноль
// заявок». По обоим числам владелец сделал бы вывод о своём же бизнесе.
//
// Ничего здесь не обращается к базе: проверяются чистая функция приведения к
// месяцу и исходники обработчика и экрана.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const handlerPath = path.join(repoRoot, "lib", "crm", "platform.ts");
const panelPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "PlatformOwnerPage.tsx");
const plansPath = path.join(repoRoot, "lib", "billing", "plans.ts");

async function codeOf(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return source
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ");
}

const { formatMinor, PLANS } = (await import(pathToFileURL(plansPath).href)) as {
  formatMinor: (minor: number, currency?: string) => string;
  PLANS: Record<string, { suggestedMonthlyMinor: number; currency: string }>;
};

test("PB1 период подписки не назначается формой, а берётся у самой подписки", async () => {
  const panel = await codeOf(panelPath);

  assert.ok(!/billingPeriod: "monthly"/.test(panel), "форма не имеет права объявлять период сама");
  assert.ok(/billingPeriod: period/.test(panel), "период уходит на сервер как есть");
  assert.ok(/clinic\.billingPeriod === "yearly"/.test(panel), "и подставляется из подписки при открытии");
});

test("PB2 пустая цена — отказ, а не ноль", async () => {
  const handler = await codeOf(handlerPath);
  const panel = await codeOf(panelPath);

  assert.ok(/code: "price_required"/.test(handler), "сервер отказывает без цены");
  assert.ok(/readString\(rawPrice\) === ""/.test(handler), "и пустую строку отличает от нуля");
  assert.ok(/if \(!typed\)/.test(panel), "экран тоже не отправляет пустое поле");
});

test("PB3 назначенный ноль не заменяется прайсом", async () => {
  const panel = await codeOf(panelPath);

  // `clinic.priceMinor || suggested` подставлял прайс поверх бесплатного
  // доступа: ноль ложен, и подсказка выигрывала у назначенной цены.
  assert.ok(!/clinic\.priceMinor \|\| PLANS/.test(panel), "ноль — назначенная цена, а не пустое место");
  assert.ok(/clinic\.plan \? clinic\.priceMinor :/.test(panel), "подсказка берётся только когда подписки нет");
});

test("PB4 отказ чтения не превращается в число", async () => {
  const handler = await codeOf(handlerPath);

  assert.ok(/subscriptionError/.test(handler), "ошибка чтения подписок замечена");
  assert.ok(/code: "subscriptions_unavailable"/.test(handler), "и приводит к отказу, а не к нулю");
  assert.ok(/Promise<number \| null>/.test(handler), "счётчик умеет сказать «не знаю»");
  assert.ok(!/if \(error\) return 0;/.test(handler), "ноль от сбоя выглядит как мёртвая клиника");
});

test("PB5 паузу можно поставить, не называя тариф и цену", async () => {
  const handler = await codeOf(handlerPath);

  // Ветка PATCH стоит ДО проверок тарифа и цены: этих величин у запроса,
  // меняющего статус, нет по смыслу, и раньше отказ приходил до статуса.
  const patchIndex = handler.indexOf('method === "PATCH"');
  const planIndex = handler.indexOf('const plan = readString(body.plan)');
  assert.ok(patchIndex > 0 && planIndex > 0, "обе ветки на месте");
  assert.ok(patchIndex < planIndex, "статус проверяется раньше тарифа");
  assert.ok(/\["active", "paused", "cancelled"\]/.test(handler), "пауза — законный статус");
});

test("PB6 отказ отмены прежней подписки не проглатывается", async () => {
  const handler = await codeOf(handlerPath);

  // Следом идёт вставка, а частичный уникальный индекс не даст существовать
  // двум действующим подпискам: проглоченный отказ дал бы непонятную ошибку
  // базы вместо внятной причины.
  assert.ok(/const \{ error: cancelError \}/.test(handler), "результат отмены читается");
  assert.ok(/if \(cancelError\)/.test(handler), "и проверяется");
});

test("PB7 годовая сумма приводится к месяцу, а не складывается как есть", async () => {
  const handler = await codeOf(handlerPath);

  assert.ok(/period === "yearly"/.test(handler));
  assert.ok(/Math\.trunc\(priceMinor \/ 12\)/.test(handler), "деление целочисленное и вниз");
  // Клиника на годовом тарифе иначе выглядела бы в двенадцать раз доходнее.
  assert.ok(/mixedCurrencies/.test(handler), "и валюты не складываются молча");
});

test("PB8 счётчики всех клиник считаются одной волной", async () => {
  const handler = await codeOf(handlerPath);

  // Прежний цикл ждал три запроса на клинику последовательно: пятьдесят клиник
  // — пятьдесят волн.
  assert.ok(!/for \(const workspace of workspaces\)[\s\S]{0,400}await Promise\.all/.test(handler), "не по клинике за раз");
  assert.ok(/known\.map\(async \(workspace\)/.test(handler), "все клиники запрашиваются вместе");
});

test("PB9 суммы показываются с валютой и без разрыва разрядов", () => {
  // Разделитель здесь неразрывный (U+00A0) и записан escape-последовательностью
  // нарочно: обычный пробел в исходнике проверки выглядит точно так же, и сравнение
  // падало бы на невидимой глазу разнице.
  const NB = " ";

  assert.equal(formatMinor(1_990_000), `19${NB}900${NB}₸`);
  assert.equal(formatMinor(0), `0${NB}₸`);
  assert.equal(formatMinor(7_990_000), `79${NB}900${NB}₸`);
  // Разряды режутся и у не тенге: формат числа от валюты не зависит.
  assert.equal(formatMinor(100_000, "USD"), `1${NB}000${NB}USD`);

  // Перенос строки посреди суммы читается как две суммы.
  assert.ok(!/ /.test(formatMinor(1_990_000)), "обычных пробелов в сумме нет");
  assert.equal(formatMinor(1_234_567_800), `12${NB}345${NB}678${NB}₸`, "разряды режутся по три");
});

test("PB10 цены тарифов — те, что назначил владелец", () => {
  // Подсказка для панели, а не источник правды: правда живёт в строке
  // подписки конкретной клиники. Но подсказка обязана совпадать с прайсом.
  assert.equal(PLANS.basic.suggestedMonthlyMinor, 1_990_000);
  assert.equal(PLANS.standard.suggestedMonthlyMinor, 3_990_000);
  assert.equal(PLANS.pro.suggestedMonthlyMinor, 7_990_000);
  for (const key of ["basic", "standard", "pro"]) {
    assert.equal(PLANS[key].currency, "KZT");
  }
});

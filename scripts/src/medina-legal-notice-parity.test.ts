import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof TypeScript;
const frontend = path.join(root, "artifacts/negis");
const contact = "kipshakoveldar4@gmail.com";
type Fact = readonly [string, RegExp];

// Inspect displayed JSX/HTML text only, without mounting the app or loading providers.
function noticeText(source: string, component: string, html: boolean): string {
  const main = html ? source.match(/<main>[\s\S]*?<\/main>/)?.[0] : undefined;
  if (html) assert.ok(main, `${component}: static main content exists`);
  const ast = ts.createSourceFile(`${component}.tsx`, html ? `const notice = (${main});` : source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let notice: TypeScript.JsxElement | undefined;
  function find(node: TypeScript.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === (html ? "main" : "LegalPage")) notice = node;
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(notice, `${component}: notice content exists`);
  const parts: string[] = [];
  function collect(node: TypeScript.Node) {
    if (ts.isJsxText(node)) parts.push(node.text);
    if (ts.isJsxAttribute(node) && ["title", "heading", "updated"].includes(node.name.getText(ast))
      && node.initializer && ts.isStringLiteral(node.initializer)) parts.push(node.initializer.text);
    if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)) parts.push(node.expression.text);
    ts.forEachChild(node, collect);
  }
  collect(notice);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function facts(text: string, expected: readonly Fact[]) {
  for (const [label, pattern] of expected) assert.match(text, pattern, label);
}

const privacyFacts: Record<"ru" | "en", Fact[]> = {
  ru: [
    ["business, clinic, salon and mortgage scope", /для бизнеса, включая клиники, салоны и ипотечные команды/],
    ["conditional direct website intake", /Если включена форма прямой заявки с сайта/],
    ["intake fields", /имя, название бизнеса, телефон.*выбранные услуги, путь страницы и версию согласия/],
    ["server inquiry and consent record", /На сервере сохраняется запись приёма заявки и согласия.*обратной связи/],
    ["no retrospective consent assertion", /не подтверждает, что согласия существующих клиентов уже получены/],
    ["necessary auth, preferences and draft storage", /localStorage и sessionStorage.*необходимых данных авторизации.*настроек интерфейса.*черновиков/],
    ["conditional Wazzup incoming messages", /Если подключён приём входящих сообщений через Wazzup.*содержимое сообщений, контакты отправителей/],
    ["optional Telegram disclosure", /Telegram используется опционально: при включённой интеграции.*содержимое выбранного уведомления/],
    ["conditional Turnstile before checkbox", /Если включена защита формы Cloudflare Turnstile.*до установки флажка согласия/],
    ["no blanket provider consent", /не является общим согласием на обработку данных всеми провайдерами/],
    ["provider processing and locations need verification", /условия обработки данных внешними провайдерами, места хранения и передачи данных требуют отдельной проверки/],
    ["no Kazakhstan hosting or compliance assurance", /не подтверждает размещение данных в Казахстане или соответствие законодательству Казахстана/],
    ["purpose and law-dependent retention", /срок хранения зависят от цели обработки.*требований закона/],
    ["no bank or medical decisions", /не принимают банковских решений, не одобряют ипотеку и не заменяют медицинскую диагностику/],
    ["existing analytics minimization", /без параметров ссылок и фрагментов адреса.*в аналитику не передаются/],
  ],
  en: [
    ["business, clinic, salon and mortgage scope", /business CRM.*clinic, salon and mortgage team workflows/],
    ["conditional direct website intake", /If the direct website inquiry form is enabled/],
    ["intake fields", /a name, business name, phone.*selected services, page path and consent version/],
    ["server inquiry and consent record", /A server record of the inquiry and consent is stored.*provide a callback/],
    ["no retrospective consent assertion", /does not establish that existing customers have already consented/],
    ["necessary auth, preferences and draft storage", /localStorage and sessionStorage hold necessary authentication data.*interface preferences.*drafts/],
    ["conditional Wazzup incoming messages", /If Wazzup incoming messages are connected.*message content, sender contacts/],
    ["optional Telegram disclosure", /Telegram is optional: when its integration is enabled.*notification or material content/],
    ["conditional Turnstile before checkbox", /If Cloudflare Turnstile form protection is enabled.*before the form consent checkbox is selected/],
    ["no blanket provider consent", /not blanket consent to processing by every provider/],
    ["provider processing and locations need verification", /processing arrangements with external providers and data storage and transfer locations require verification/],
    ["no Kazakhstan hosting or compliance assurance", /does not establish Kazakhstan hosting or compliance with Kazakhstan law/],
    ["purpose and law-dependent retention", /retention depend on the processing purpose.*applicable law/],
    ["no bank or medical decisions", /do not make bank decisions, approve mortgages or replace medical diagnosis/],
    ["existing analytics minimization", /stripped of query parameters and fragments.*are not sent by this integration/],
  ],
};

const deletionFacts: Record<"ru" | "en", Fact[]> = {
  ru: [
    ["minimal record identification", /минимальные сведения.*имя или контакт и способ обратной связи/],
    ["workspace only if known", /организации или рабочего пространства, если известно/],
    ["no identity documents or credentials requested", /Не отправляйте документы, удостоверяющие личность, пароли, коды входа или токены доступа/],
    ["verified request and authority", /с проверкой его принадлежности и полномочий заявителя/],
    ["purpose, law and retention determine action", /Допустимый объём действий определяется после проверки цели обработки, применимых требований закона и оснований дальнейшего хранения/],
    ["applicable statutory deadlines govern", /При рассмотрении запроса и выполнении необходимых действий применяются установленные законом сроки/],
    ["conditional authorized tool", /если он включён для сайта и доступен уполномоченному владельцу или администратору/],
    ["one inquiry and its consent copies", /только для выбранной заявки с сайта и её копий согласия/],
    ["linked-record review", /При связях с рабочими данными удаление может быть заблокировано до отдельного разбора/],
    ["tool is not email handling", /не замена рассмотрению запроса по email/],
    ["external providers and backups require review", /не очищает другие обращения, данные внешних провайдеров или резервные копии; их обработка требует отдельной проверки/],
    ["no other client or workspace erasure", /не даёт права удалять данные других клиентов или рабочих пространств/],
    ["Meta scope reviewed rather than blanket erasure", /Facebook или Instagram Lead Ads.*Допустимый объём удаления определяется после проверки.*не означает удаления всех рекламных данных/],
  ],
  en: [
    ["minimal record identification", /(?:only the|The) name or contact already used in the service.*(?:a reply contact|reply contact)/],
    ["workspace only if known", /organization or workspace[,]? if known/],
    ["no identity documents or credentials requested", /Do not send identity documents, passwords, login codes or access tokens/],
    ["verified request and authority", /verification of ownership and the requester's authority/],
    ["purpose, law and retention determine action", /lawful scope of action is determined after reviewing the processing purpose, applicable law and grounds for further retention/],
    ["applicable statutory deadlines govern", /Applicable statutory deadlines govern request handling and any required action/],
    ["one inquiry and its consent copies", /limited to one selected (?:website )?inquiry and its consent copies/],
    ["linked-record review", /(?:may be blocked by linked records|Linked work records may block deletion pending separate review)/],
    ["tool is not email handling", /does not replace email request handling/],
    ["external providers and backups require review", /external providers (?:and|or) backups.*require separate review/],
    ["no other client or workspace erasure", /(?:does not authorize erasure|not authorize erasure) of other clients or workspaces/],
  ],
};

for (const [component, route] of [["Privacy", "privacy"], ["Terms", "terms"], ["DataDeletion", "data-deletion"]]) {
  for (const language of ["ru", "en"] as const) {
    const html = language === "en";
    const relative = html ? `public/${route}/index.html` : `src/pages/${component}.tsx`;
    const text = noticeText(await readFile(path.join(frontend, relative), "utf8"), component, html);
    test(`${relative}: synchronized date, unchanged contact and no invented deletion SLA`, () => {
      assert.match(text, html ? /Last updated: October 24, 2026/ : /24 октября 2026/);
      assert.deepEqual([...new Set(text.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi))], [contact]);
      assert.doesNotMatch(text, /(?:30|thirty)[\s-]*(?:calendar[\s-]*)?days?|(?:30|тридцат[а-яё]*)[\s-]*(?:календарн[а-яё]*[\s-]*)?(?:дн[а-яё]*|сут[а-яё]*)/iu);
    });
    if (component === "Privacy") test(`${relative}: privacy facts remain aligned`, () => {
      facts(text, privacyFacts[language]);
      assert.doesNotMatch(text, /Оператором сервиса[^.]*является Medina OS|(?:legal entity|(?:service|data) operator)\s+(?:is|:)\s+Medina OS/iu);
    });
    if (component === "Terms") test(`${relative}: manual launch and separate ACTIVE safety remain explicit`, () => {
      facts(text, language === "ru" ? [
        ["manual confirmation", /Запуск рекламы требует ручного подтверждения пользователем/],
        ["separate ACTIVE confirmation", /ACTIVE запуск рекламы требует отдельного явного подтверждения/],
        ["no retrospective consent", /не подтверждает наличие согласий существующих клиентов/],
        ["no blanket responsibility transfer", /не переносит всю ответственность платформы на пользователя/],
        ["no bank or medical decisions", /не принимают банковских решений, не одобряют ипотеку и не ставят медицинских диагнозов/],
      ] : [
        ["manual confirmation", /Launching advertising requires manual confirmation by the user/],
        ["separate ACTIVE confirmation", /An ACTIVE advertising launch requires separate explicit confirmation/],
        ["no retrospective consent or blanket responsibility transfer", /does not establish consent from existing customers or transfer all platform responsibility to the user/],
        ["no bank or medical decisions", /do not replace.*make bank decisions, approve mortgages or provide medical diagnoses/],
      ]);
      assert.doesNotMatch(text, /Pricing and Trial|free trial|subscription plans|refund|возврат средств/iu);
    });
    if (component === "DataDeletion") test(`${relative}: lawful request scope and limited tool remain aligned`, () => {
      facts(text, deletionFacts[language]);
      if (!html) facts(text, deletionFacts.en);
      assert.doesNotMatch(text, /не устанавливает[^.]*срок|(?:sets no|not a) fixed deletion deadline/iu);
      assert.doesNotMatch(text, /Мы удалим связанные лиды и рекламные данные|we will delete the related lead or advertising data/iu);
      if (html) assert.match(text, /Facebook or Instagram Lead Ads.*lawful scope of deletion.*does not mean deletion of all account advertising data/);
    });
  }
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// FD — день регистратора без лишних кликов.
//
// Аудит удобства подтвердил: цепочка «заявка → запись → пришёл → продажа»
// рвалась на каждом стыке, и регистратор чинил разрывы руками — искал заявку,
// чтобы переключить стадию; выбирал клиента из всей базы, чтобы оформить
// продажу; попадал на общий список вместо карточки. Набор закрепляет стыки.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const leads = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");
const appointments = await readFile(path.join(negisSrc, "pages", "AppointmentsPage.tsx"), "utf8");
const clients = await readFile(path.join(negisSrc, "pages", "ClientsPage.tsx"), "utf8");
const sales = await readFile(path.join(negisSrc, "pages", "SalesPage.tsx"), "utf8");

test("FD1 запись, созданная из заявки, сама переводит заявку в «Записана»", () => {
  assert.ok(/leadId: lead\.id/.test(leads), "заявка передаёт свой id в префилл записи");
  assert.ok(/prefillLeadRef\.current = readString\(prefill\.leadId\)/.test(appointments), "запись запоминает, из какой заявки пришла");
  function confirmedHandoff(source: string) {
    const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
    visit(ast);
    const submit = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "submitForm");
    assert.ok(submit);
    const local = nodes.filter(node => node.pos >= submit.pos && node.end <= submit.end);
    const calls = (name: string) => local.filter((node): node is ts.CallExpression => ts.isCallExpression(node)
      && ts.isIdentifier(node.expression) && node.expression.text === name);
    const [created] = calls("createAppointment"), [marked] = calls("markLeadBooked");
    assert.equal(calls("createAppointment").length, 1); assert.equal(calls("markLeadBooked").length, 1);
    assert.ok(ts.isAwaitExpression(created.parent), "creation must be awaited before a handoff");
    const result = created.parent.parent;
    assert.ok(ts.isVariableDeclaration(result) && result.name.getText(ast) === "result");
    assert.ok(marked.getStart(ast) > created.end, "handoff must follow the confirmed result");
    assert.equal(marked.arguments[0].getText(ast), "result.leadId", "use the confirmed captured lead, not the mutable prefill");
    assert.ok(local.some(node => ts.isIfStatement(node) && node.expression.getText(ast) === "activeStatuses.includes(result.status)"
      && marked.pos >= node.thenStatement.pos && marked.end <= node.thenStatement.end), "cancelled recovery must not mark a lead booked");
    assert.ok(local.some(node => ts.isIfStatement(node) && node.expression.getText(ast) === "!isCurrentMutationScope()"
      && node.getStart(ast) > created.end && node.end < marked.getStart(ast)
      && ts.isReturnStatement(node.thenStatement)), "a changed account must stop the handoff");
  }
  confirmedHandoff(appointments);
  for (const mutant of [appointments.replace("const result = await createAppointment(", "const result = createAppointment("),
    appointments.replace("if (activeStatuses.includes(result.status)) void markLeadBooked(result.leadId);", "void markLeadBooked(result.leadId);")]) {
    assert.notEqual(mutant, appointments); assert.throws(() => confirmedHandoff(mutant));
  }
  assert.ok(/semanticGroup === "booked"/.test(appointments), "стадия берётся из пайплайна клиники");
  assert.ok(/заявка не переведена/.test(appointments), "отказ перевода не молчит");
});

test("FD2 «Пришёл» ведёт к продаже с данными записи", () => {
  assert.ok(/appointment\.status === "arrived"[\s\S]{0,200}Оформить продажу/.test(appointments), "кнопка — у пришедшего визита");
  assert.ok(/appointmentId: appointment\.id/.test(appointments) && /serviceId: appointment\.serviceId/.test(appointments), "продажа получает запись и услугу справочника");
  assert.ok(/serviceId: str\(prefill\.serviceId\)/.test(sales), "форма продажи услугу принимает");
  assert.ok(/form\.serviceId, formOpen\]/.test(sales), "и подставляет цену из прайса, когда справочник догрузился");
});

test("FD3 карточка записи предлагает только осмысленные переходы", () => {
  assert.ok(/allowedStatusMoves/.test(appointments), "карта переходов существует");
  assert.ok(/arrived: \[\]/.test(appointments), "пришедшему не предлагают «Подтвердить»");
  assert.ok(/no_show: \["arrived"\]/.test(appointments), "опоздавший клиент — обратимый случай");
  assert.ok(/\.filter\(\(\{ status \}\) => moves\.includes\(status\)\)/.test(appointments), "и карта действительно фильтрует кнопки");
});

test("FD4 «Открыть клиента» открывает карточку, а не общий список", () => {
  const writes = leads.match(/rememberOpenClient\(/g) || [];
  assert.ok(writes.length >= 3, "обе кнопки заявок пишут ключ (плюс объявление)");
  assert.ok(/CLIENT_OPEN_KEY = "negis_client_open"/.test(clients), "клиенты знают тот же ключ");
  assert.ok(/setDetailId\(wanted\)/.test(clients), "и открывают карточку, когда клиент в списке");
  assert.ok(/workspaceScopedKey\(CLIENT_OPEN_KEY\), deal\.clientId\)/.test(sales), "имя клиента в продаже ведёт туда же");
});

test("FD5 пустые слоты дня схлопываются", () => {
  assert.ok(/kind: "free"/.test(appointments) && /previous\.kind === "free"\) previous\.last = slot/.test(appointments), "подряд идущие свободные получасовки складываются");
  assert.ok(/Свободно \{segment\.first === segment\.last/.test(appointments), "и подписываются диапазоном");
  assert.ok(/kind: "occupied"/.test(appointments) && /dayBuckets\.occupied\.has\(slot\)/.test(appointments), "продолжение длинного визита разрывает свободный диапазон");
});

test("FD6 выбранный клиент сужает список записей в форме продажи", () => {
  assert.ok(
    /appointment\.clientId === form\.clientId/.test(sales),
    "селект записей фильтруется по клиенту",
  );
  assert.ok(/!appointment\.clientId \|\|/.test(sales), "записи без связи с карточкой остаются видны");
});

test("FD7 выбор записи переносит в продажу клиента, услугу и согласованную цену", () => {
  const handler = sales.slice(sales.indexOf("function handleAppointmentSelection"), sales.indexOf("function submitForm"));
  assert.ok(handler.includes("clientId: appointment.clientId"), "продажа получает клиента записи");
  assert.ok(handler.includes("serviceId: appointment.serviceId"), "продажа получает услугу справочника");
  assert.ok(handler.includes("appointment.priceMinor === null"), "отсутствие цены не превращается в ноль");
  assert.ok(handler.includes("amountMinorToTengeInput(appointment.priceMinor)"), "согласованная цена записи становится суммой продажи");
  assert.ok(/onChange=\{\(event\) => handleAppointmentSelection\(event\.target\.value\)\}/.test(sales));
});

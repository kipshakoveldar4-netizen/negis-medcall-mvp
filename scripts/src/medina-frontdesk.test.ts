import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  // Перевод — только после успешного создания, и отказ говорится вслух.
  assert.ok(
    /await createAppointment\(appointment, allowConflict[\s\S]{0,400}markLeadBooked\(/.test(appointments),
    "стадия меняется после успеха, не до",
  );
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
});

test("FD6 выбранный клиент сужает список записей в форме продажи", () => {
  assert.ok(
    /appointment\.clientId === form\.clientId/.test(sales),
    "селект записей фильтруется по клиенту",
  );
  assert.ok(/!appointment\.clientId \|\|/.test(sales), "записи без связи с карточкой остаются видны");
});

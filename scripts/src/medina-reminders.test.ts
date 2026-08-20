import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Напоминание клиенту о записи: кому писать, когда и что.
//
// Владелец салона: «нужно оповещение клиентов до прихода». Отправка ошибается
// молча и дорого — написать дважды, написать про отменённый визит, написать
// время на пять часов раньше, — поэтому решение «кому и что» вынесено в чистый
// модуль и проверяется здесь, а не наблюдением за живыми клиентами.
//
// Ничто здесь никому не пишет и не ходит в production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "crm", "reminders.ts");

type Candidate = {
  id: string; clientName: string; phone: string; whatsapp: string; service: string;
  doctorName: string; startsAt: string; status: string; reminderSentAt: string | null;
};
type Plan = { candidate: Candidate; to: string; text: string };
type Module = {
  isDue: (startsAt: string, nowMs: number, leadMinutes: number) => boolean;
  clinicTimeLabel: (startsAt: string, timeZone: string) => string;
  reminderText: (input: { clinicName: string; clientName: string; timeLabel: string; service: string; doctorName: string }) => string;
  planReminders: (
    candidates: readonly Candidate[],
    input: { nowMs: number; leadMinutes: number; timeZone: string; clinicName: string },
  ) => { plans: Plan[]; skipped: Array<{ id: string; reason: string }> };
};

const mod: Module = (await import(pathToFileURL(modulePath).href)) as Module;

const ALMATY = "Asia/Almaty";
/** Четверг, 20 августа 2026, 09:00 по Астане. */
const NOW = Date.parse("2026-08-20T04:00:00.000Z");
const at = (hour: number) => `2026-08-20T${String(hour - 5).padStart(2, "0")}:00:00.000Z`;

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "a1",
  clientName: "Айгерим",
  phone: "+7 701 245 18 44",
  whatsapp: "",
  service: "Маникюр",
  doctorName: "Дильназ",
  startsAt: at(15),
  status: "scheduled",
  reminderSentAt: null,
  ...over,
});

const plan = (over: Partial<Candidate> = {}, leadMinutes = 8 * 60) =>
  mod.planReminders([candidate(over)], { nowMs: NOW, leadMinutes, timeZone: ALMATY, clinicName: "Салон Negis" });

test("RM1 визит через шесть часов при окне в восемь — пишем", () => {
  const { plans } = plan();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].to, "+7 701 245 18 44");
});

test("RM2 визит за пределами окна ещё ждёт", () => {
  const { plans, skipped } = plan({ startsAt: at(20) });
  assert.equal(plans.length, 0);
  assert.equal(skipped[0].reason, "не время");
});

test("RM3 визит, который уже начался, напоминания не получает", () => {
  // Иначе вечерний запуск цикла пишет «сегодня в десять» тому, кто уже ушёл.
  const { plans, skipped } = plan({ startsAt: at(8) });
  assert.equal(plans.length, 0);
  assert.equal(skipped[0].reason, "не время");
});

test("RM4 второй раз одному человеку не пишем", () => {
  const { plans, skipped } = plan({ reminderSentAt: "2026-08-20T03:00:00.000Z" });
  assert.equal(plans.length, 0);
  assert.equal(skipped[0].reason, "уже отправляли");
});

test("RM5 отменённому визиту напоминать не о чем", () => {
  for (const status of ["cancelled", "no_show", "done"]) {
    const { plans, skipped } = plan({ status });
    assert.equal(plans.length, 0, status);
    assert.equal(skipped[0].reason, "визит отменён или закрыт");
  }
});

test("RM6 без номера писать некуда, и это видно в отчёте", () => {
  const { plans, skipped } = plan({ phone: "", whatsapp: "" });
  assert.equal(plans.length, 0);
  assert.equal(skipped[0].reason, "нет номера");
});

test("RM7 WhatsApp предпочтительнее телефона, если он задан", () => {
  const { plans } = plan({ whatsapp: "+7 705 999 00 11" });
  assert.equal(plans[0].to, "+7 705 999 00 11");
});

test("RM8 время в сообщении — по часам клиники, а не сервера", () => {
  // Сервер считает в UTC. Без пояса клиники салон в Астане написал бы клиенту
  // время на пять часов раньше — и это причина не прийти, а не польза.
  const label = mod.clinicTimeLabel(at(15), ALMATY);
  assert.ok(label.includes("15:00"), label);
  assert.ok(!mod.clinicTimeLabel(at(15), "UTC").includes("15:00"), "в UTC это другое время");
});

test("RM9 текст называет салон, время, услугу и мастера — и ничего не выдумывает", () => {
  const { plans } = plan();
  const text = plans[0].text;
  assert.ok(text.includes("Айгерим"), text);
  assert.ok(text.includes("Салон Negis"), text);
  assert.ok(text.includes("15:00"), text);
  assert.ok(text.includes("Маникюр") && text.includes("Дильназ"), text);
});

test("RM10 без имени салона сообщение не превращается в «наш салон»", () => {
  // Сообщение от неизвестно кого клиент читает как спам. Пустое название —
  // повод не называть отправителя, а не повод его придумать.
  const { plans } = mod.planReminders(
    [candidate()],
    { nowMs: NOW, leadMinutes: 8 * 60, timeZone: ALMATY, clinicName: "" },
  );
  assert.ok(!/наш салон|нашей клиник/i.test(plans[0].text), plans[0].text);
});

test("RM11 нечитаемое время визита не превращается в бессмысленное сообщение", () => {
  const { plans, skipped } = plan({ startsAt: "не время" });
  assert.equal(plans.length, 0);
  assert.equal(skipped[0].reason, "не время", "нечитаемая дата не проходит окно отправки");
});

test("RM12 список разбирается целиком: часть пишем, часть пропускаем с причиной", () => {
  const { plans, skipped } = mod.planReminders(
    [
      candidate({ id: "ok" }),
      candidate({ id: "sent", reminderSentAt: "2026-08-20T03:00:00.000Z" }),
      candidate({ id: "late", startsAt: at(21) }),
      candidate({ id: "nophone", phone: "", whatsapp: "" }),
    ],
    { nowMs: NOW, leadMinutes: 8 * 60, timeZone: ALMATY, clinicName: "Салон Negis" },
  );
  assert.deepEqual(plans.map((entry) => entry.candidate.id), ["ok"]);
  assert.deepEqual(skipped.map((entry) => entry.id).sort(), ["late", "nophone", "sent"]);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Статистика владельца. Каждое правило здесь — денежное или репутационное:
// выручка, средний чек, загрузка мастера. Ошибка не роняет экран — она врёт
// владельцу, и заметить это можно только сверкой руками. Поэтому расчёт
// вынесен в чистую функцию и держится тестом.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = async (file: string) => import(pathToFileURL(path.join(repoRoot, "lib", "crm", file)).href);

type Appointment = {
  status: string; startsAt: string; durationMinutes: number; priceMinor: number | null;
  doctorId: string; doctorName: string; service: string; clientId: string;
};
type Deal = { status: string; amountMinor: number };
const stats = (await load("salon-stats.ts")) as {
  computeSalonStats: (input: {
    appointments: readonly Appointment[];
    deals: readonly Deal[];
    clientsSeenBefore: ReadonlySet<string>;
    scheduledMinutesByDoctor: ReadonlyMap<string, number>;
    doctorNames: ReadonlyMap<string, string>;
    truncated: boolean;
  }) => Record<string, any>;
  daysBetween: (from: string, to: string) => string[];
};

const visit = (over: Partial<Appointment> = {}): Appointment => ({
  status: "arrived",
  startsAt: "2026-08-20T10:00:00+05:00",
  durationMinutes: 60,
  priceMinor: 500000,
  doctorId: "d1",
  doctorName: "Диана",
  service: "Маникюр",
  clientId: "c1",
  ...over,
});

function compute(appointments: Appointment[], deals: Deal[] = [], over: Record<string, unknown> = {}) {
  return stats.computeSalonStats({
    appointments,
    deals,
    clientsSeenBefore: new Set(),
    scheduledMinutesByDoctor: new Map(),
    doctorNames: new Map([["d1", "Диана"]]),
    truncated: false,
    ...(over as object),
  });
}

test("SS1 касса — только оплаченные продажи: pending не выручка, refunded тем более", () => {
  const result = compute([], [
    { status: "paid", amountMinor: 600000 },
    { status: "paid", amountMinor: 400000 },
    { status: "pending", amountMinor: 900000 },
    { status: "refunded", amountMinor: 500000 },
    { status: "cancelled", amountMinor: 100000 },
  ]);
  assert.equal(result.money.paidMinor, 1000000);
  assert.equal(result.money.paidCount, 2);
  assert.equal(result.money.averageTicketMinor, 500000, "средний чек — по оплаченным, не по всем");
});

test("SS2 продаж не было — средний чек null, а не ноль и не NaN", () => {
  const result = compute([visit()]);
  assert.equal(result.money.averageTicketMinor, null);
});

test("SS3 цены записей — отдельное число, и «без цены» посчитаны рядом", () => {
  const result = compute([
    visit({ priceMinor: 500000 }),
    visit({ priceMinor: null, clientId: "c2" }),
    visit({ priceMinor: 300000, status: "scheduled" }),
    visit({ priceMinor: 700000, status: "cancelled" }),
  ]);
  // Только пришедшие: запланированная и отменённая не заработали ничего.
  assert.equal(result.money.arrivedPricedMinor, 500000);
  assert.equal(result.money.arrivedWithoutPrice, 1, "нижняя граница не притворяется выручкой");
});

test("SS4 отмены и неявки — доля от всех записей периода", () => {
  const result = compute([
    visit(), visit({ status: "cancelled" }), visit({ status: "no_show" }), visit({ status: "scheduled" }),
  ]);
  assert.equal(result.appointments.total, 4);
  assert.equal(result.appointments.lostSharePercent, 50);
});

test("SS5 загрузка мастера — от графика, и без графика процент не выдумывается", () => {
  const result = compute(
    [visit({ durationMinutes: 120 }), visit({ durationMinutes: 60, status: "scheduled" })],
    [],
    { scheduledMinutesByDoctor: new Map([["d1", 360]]) },
  );
  const master = result.masters[0];
  assert.equal(master.busyMinutes, 180);
  assert.equal(master.loadPercent, 50);

  const noSchedule = compute([visit()]).masters[0];
  assert.equal(noSchedule.loadPercent, null, "занятые часы без знаменателя честнее выдуманной сотни");
});

test("SS6 история до справочника не выпадает: мастер по имени попадает в таблицу", () => {
  const result = compute([
    visit({ doctorId: "", doctorName: "Венера" }),
    visit({ doctorId: "", doctorName: "венера", clientId: "c3" }),
  ]);
  assert.equal(result.masters.length, 1, "регистр имени не раздваивает мастера");
  assert.equal(result.masters[0].appointments, 2);
  assert.equal(result.masters[0].loadPercent, null, "без ссылки на карточку график не приписывается");
});

test("SS7 новые и постоянные — по визитам до периода, безкарточные названы отдельно", () => {
  const result = compute(
    [visit({ clientId: "c1" }), visit({ clientId: "c2" }), visit({ clientId: "" })],
    [],
    { clientsSeenBefore: new Set(["c1"]) },
  );
  assert.equal(result.clients.returning, 1);
  assert.equal(result.clients.newClients, 1);
  assert.equal(result.clients.withoutCard, 1, "записи без карточки не выдаются ни за новых, ни за старых");
});

test("SS8 отменённая запись не занимает время мастера", () => {
  const result = compute([visit({ status: "cancelled", durationMinutes: 90 })]);
  assert.equal(result.masters[0].busyMinutes, 0);
});

test("SS9 период: включительно, не длиннее 92 дней, мусор — пустой список", () => {
  assert.equal(stats.daysBetween("2026-08-01", "2026-08-03").length, 3);
  assert.equal(stats.daysBetween("2026-08-03", "2026-08-01").length, 0, "перевёрнутый период не считается");
  assert.equal(stats.daysBetween("не дата", "2026-08-01").length, 0);
  assert.equal(stats.daysBetween("2026-01-01", "2026-12-31").length, 92, "потолок — квартал с запасом");
});

test("SS10 зарплата: процентная часть от цен записей, незаданные условия — null", () => {
  const result = compute(
    [visit({ priceMinor: 1000000 }), visit({ priceMinor: 500000, clientId: "c2" })],
    [],
    { salaryByDoctor: new Map([["d1", { fixedMinor: 20000000, percent: 40 }]]) },
  );
  const master = result.masters[0];
  assert.equal(master.salaryPercent, 40);
  // 40% от 15 000 ₸ по ценам пришедших записей.
  assert.equal(master.salaryPercentMinor, 600000);
  assert.equal(master.salaryFixedMonthlyMinor, 20000000, "фикс — в месяц, справочно");

  const bare = compute([visit()]).masters[0];
  assert.equal(bare.salaryPercentMinor, null, "«условия не заданы» отличается от нуля");
  assert.equal(bare.salaryFixedMonthlyMinor, null);
});

test("SS11 отменённые записи не кормят процент мастера", () => {
  const result = compute(
    [visit({ priceMinor: 1000000, status: "cancelled" })],
    [],
    { salaryByDoctor: new Map([["d1", { fixedMinor: null, percent: 50 }]]) },
  );
  assert.equal(result.masters[0].salaryPercentMinor, 0, "отменённый визит не заработал ничего");
});

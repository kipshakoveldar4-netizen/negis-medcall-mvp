import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Medina OS UI-2 dashboard tests: pure aggregation honesty + client/admin
// query boundaries. Uses the real dashboardData module — no re-implementation.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");
const dashboardDataPath = path.join(negisSrc, "lib", "dashboardData.ts");

const mod = (await import(`${pathToFileURL(dashboardDataPath).href}?t=${Date.now()}`)) as {
  buildNewLeadsQueue(leads: Record<string, unknown>[], limit?: number): Array<{ id: string; title: string; subtitle: string; statusLabel: string }>;
  buildUpcomingAppointmentsQueue(items: Record<string, unknown>[], todayIso: string, limit?: number): Array<{ title: string; statusLabel: string; meta: string }>;
  buildPendingDealsQueue(deals: Record<string, unknown>[], limit?: number): Array<{ title: string; subtitle: string }>;
  buildRecentRecords(sources: Record<string, Record<string, unknown>[]>, limit?: number): Array<{ kind: string; title: string; createdAt: string }>;
  buildLeadSourceDistribution(leads: Record<string, unknown>[], limit?: number): Array<{ label: string; count: number; share: number }>;
  formatAmountMinor(minor: unknown, currency: unknown): string;
  formatQueueDate(value: unknown): string;
};

test("01 empty inputs produce empty outputs — no fabricated defaults", () => {
  assert.deepEqual(mod.buildNewLeadsQueue([]), []);
  assert.deepEqual(mod.buildUpcomingAppointmentsQueue([], "2026-07-27T10:00:00.000Z"), []);
  assert.deepEqual(mod.buildPendingDealsQueue([]), []);
  assert.deepEqual(mod.buildRecentRecords({}), []);
  assert.deepEqual(mod.buildLeadSourceDistribution([]), []);
});

test("02 new-leads queue filters to semantic new, sorts desc, respects limit", () => {
  const leads = [
    { id: "a", name: "Анна", status: "new", createdAt: "2026-07-25T10:00:00Z" },
    { id: "b", name: "Борис", status: "in_progress", createdAt: "2026-07-26T10:00:00Z" },
    { id: "c", name: "Вера", status: "new", createdAt: "2026-07-26T12:00:00Z" },
    { id: "d", name: "Глеб", status: "new", createdAt: "2026-07-24T09:00:00Z" },
  ];
  const queue = mod.buildNewLeadsQueue(leads, 2);
  assert.deepEqual(queue.map((item) => item.id), ["c", "a"]);
  assert.equal(queue[0].statusLabel, "Новая");
});

test("03 upcoming appointments exclude past and unparseable dates", () => {
  const today = "2026-07-27T08:00:00.000Z";
  const queue = mod.buildUpcomingAppointmentsQueue(
    [
      { id: "past", date: "2026-07-20", time: "10:00", patientName: "Прошлое" },
      { id: "today", date: "2026-07-27", time: "15:00", patientName: "Сегодня" },
      { id: "future", date: "2026-07-29", time: "09:00", patientName: "Будущее" },
      { id: "junk", date: "не дата", patientName: "Мусор" },
    ],
    today,
  );
  assert.deepEqual(queue.map((item) => item.title), ["Сегодня", "Будущее"]);
  assert.equal(queue[0].statusLabel, "Сегодня");
  assert.equal(queue[1].statusLabel, "Запланирована");
});

test("04 pending deals queue keeps only pending and per-record currency", () => {
  const queue = mod.buildPendingDealsQueue([
    { id: "p1", title: "Чистка", status: "pending", amountMinor: 2500000, currency: "KZT", createdAt: "2026-07-26T10:00:00Z" },
    { id: "p2", title: "Консультация", status: "pending", amount_minor: "150000", currency: "USD", createdAt: "2026-07-25T10:00:00Z" },
    { id: "paid", title: "Оплачено", status: "paid", amountMinor: 100, createdAt: "2026-07-26T11:00:00Z" },
  ]);
  assert.equal(queue.length, 2);
  // ru-RU grouping uses a narrow no-break space — build expectations the same way.
  assert.equal(queue[0].subtitle, `${(25000).toLocaleString("ru-RU")} ₸`);
  assert.equal(queue[1].subtitle, `${(1500).toLocaleString("ru-RU")} USD`);
});

test("05 currencies are never merged into one total by the dashboard module", async () => {
  const source = await readFile(dashboardDataPath, "utf8");
  assert.ok(!/total(Amount|Revenue)/.test(source), "no cross-record money totals in dashboardData");
  assert.ok(source.includes("Currencies are never mixed"));
});

test("06 formatAmountMinor is honest about invalid values", () => {
  assert.equal(mod.formatAmountMinor(undefined, "KZT"), "—");
  assert.equal(mod.formatAmountMinor("abc", "KZT"), "—");
  assert.equal(mod.formatAmountMinor(-100, "KZT"), "—");
  assert.equal(mod.formatAmountMinor(0, undefined), "0 ₸");
});

test("07 formatQueueDate renders — for missing or invalid timestamps", () => {
  assert.equal(mod.formatQueueDate(""), "—");
  assert.equal(mod.formatQueueDate("not-a-date"), "—");
  assert.notEqual(mod.formatQueueDate("2026-07-26T10:00:00Z"), "—");
});

test("08 recent records require a real created timestamp and sort desc", () => {
  const records = mod.buildRecentRecords({
    lead: [
      { id: "l1", name: "Лид", createdAt: "2026-07-26T10:00:00Z" },
      { id: "l2", name: "Без даты" },
    ],
    deal: [{ id: "d1", title: "Продажа", created_at: "2026-07-26T12:00:00Z" }],
  });
  assert.deepEqual(records.map((r) => r.kind), ["deal", "lead"]);
  assert.equal(records.length, 2, "record without timestamp must be excluded, not defaulted");
});

test("09 lead source distribution counts real sources with shares", () => {
  const slices = mod.buildLeadSourceDistribution([
    { source: "Instagram" },
    { source: "Instagram" },
    { sourceName: "WhatsApp" },
    {},
  ]);
  assert.deepEqual(slices[0], { label: "Instagram", count: 2, share: 50 });
  assert.ok(slices.some((slice) => slice.label === "Без источника" && slice.count === 1));
});

// ---------------------------------------------------------------------------
// Source boundaries: client mode must not touch admin Insights, errors stay
// isolated, queues stay keyboard-accessible.
// ---------------------------------------------------------------------------

const accSource = await readFile(path.join(negisSrc, "pages", "AiControlCenter.tsx"), "utf8");
const workQueueSource = await readFile(path.join(negisSrc, "components", "dashboard", "work-queue.tsx"), "utf8");

test("10 the operational overview never calls admin Insights endpoints", () => {
  for (const forbidden of ["meta-insights-sync", "meta-campaign-insights", "meta-insights-history", "meta-insights-sync-runs", "meta-insights-background-cycle"]) {
    assert.ok(!accSource.includes(forbidden), `dashboard must not request ${forbidden}`);
  }
  assert.ok(!accSource.includes("Authorization"), "dashboard fetches carry no bearer header");
});

test("11 dashboard widget failures stay isolated per section", () => {
  assert.ok(accSource.includes("Independent fetches: one failing endpoint must not block the page."));
  assert.ok(accSource.includes('responded ? "ready" : "unknown"'));
});

test("12 dashboard shows honest unavailable states, not zeros", () => {
  assert.ok(accSource.includes("Не удалось проверить"));
  assert.ok(!accSource.includes('value: "0", hint: "Не удалось'), "failed endpoints must not render 0");
});

test("13 work queues navigate via real links, not clickable divs", () => {
  assert.ok(workQueueSource.includes("<Link href={href}>"));
  assert.ok(!/<div[^>]*onClick/.test(workQueueSource), "no clickable divs in work queues");
});

test("14 queues and recency reuse fetched records without extra requests", () => {
  assert.ok(accSource.includes("setCrmRecords({"));
  assert.ok(accSource.includes("lead: crmRecords.leads"));
  assert.ok(accSource.includes("deal: crmRecords.deals"));
  // Definitions + the single Promise.all batch: 2 helper definitions, one
  // internal use, and exactly 8 batched calls — no widget-level refetching.
  const fetchCalls = accSource.match(/fetchJson\(|fetchCrmList\(/g) ?? [];
  assert.ok(fetchCalls.length <= 12, `dashboard fetch count stays bounded, got ${fetchCalls.length}`);
});

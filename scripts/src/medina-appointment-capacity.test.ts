import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Interval<T> = { start: number; end: number; value: T };
type CapacityModule = {
  findAppointmentCapacityConflict<T>(candidate: { start: number; end: number }, intervals: Array<Interval<T>>, capacity: number): T | null;
};
const { findAppointmentCapacityConflict: conflict } = await import(pathToFileURL(path.join(root, "lib/crm/appointment-capacity.ts")).href) as CapacityModule;
const candidate = { start: 10, end: 20 };

for (const capacity of [1, 2, 3]) {
  test(`capacity ${capacity} permits remaining places and refuses the next one`, () => {
    const rows = Array.from({ length: capacity }, (_, value) => ({ start: 5, end: 25, value }));
    assert.equal(conflict(candidate, rows.slice(0, -1), capacity), null);
    assert.notEqual(conflict(candidate, rows, capacity), null);
  });
}

test("adjacent visits bridging a candidate never count as simultaneous", () => {
  assert.equal(conflict({ start: 0, end: 30 }, [
    { start: 0, end: 10, value: "first" },
    { start: 10, end: 20, value: "second" },
    { start: 20, end: 30, value: "third" },
  ], 2), null);
});

test("nested and partially overlapping visits fill only their shared portion", () => {
  const rows = [
    { start: 0, end: 12, value: "left" },
    { start: 15, end: 30, value: "right" },
    { start: 11, end: 16, value: "bridge" },
  ];
  assert.notEqual(conflict(candidate, rows, 2), null);
  assert.equal(conflict(candidate, rows, 3), null);
  assert.notEqual(conflict(candidate, [...rows, { start: 11, end: 12, value: "nested" }], 3), null);
});

test("candidate and visit boundaries are half open, with ends before starts", () => {
  assert.equal(conflict(candidate, [
    { start: 0, end: 10, value: "before" },
    { start: 20, end: 30, value: "after" },
  ], 1), null);
  assert.equal(conflict(candidate, [
    { start: 0, end: 15, value: "ending" },
    { start: 15, end: 30, value: "starting" },
  ], 2), null);
});

test("occupancy outside the candidate is clipped away", () => {
  const rows = [
    { start: 0, end: 11, value: "left" },
    { start: 0, end: 9, value: "outside-left" },
    { start: 19, end: 30, value: "right" },
    { start: 21, end: 30, value: "outside-right" },
  ];
  assert.equal(conflict(candidate, rows, 2), null);
});

test("invalid and empty numeric intervals are skipped without inventing durations", () => {
  const rows = [
    { start: NaN, end: 30, value: "nan" },
    { start: 0, end: Infinity, value: "infinite" },
    { start: 15, end: 15, value: "empty" },
    { start: 20, end: 10, value: "reversed" },
  ];
  assert.equal(conflict(candidate, rows, 1), null);
  for (const invalid of [{ start: NaN, end: 20 }, { start: 10, end: Infinity }, { start: 20, end: 10 }, { start: 10, end: 10 }]) {
    assert.equal(conflict(invalid, [{ start: 0, end: 30, value: "valid" }], 1), null);
  }
});

test("bad capacity falls back to one and positive fractional capacity is truncated", () => {
  const rows = [{ start: 0, end: 30, value: "occupied" }];
  for (const capacity of [NaN, Infinity, -Infinity, 0, -1, 0.5, 1.9]) {
    assert.equal(conflict(candidate, rows, capacity), "occupied");
  }
  assert.equal(conflict(candidate, rows, 2.9), null);
});

test("duplicate values remain separate intervals through starts and ends", () => {
  const shared = { id: "same-reference" };
  assert.equal(conflict(candidate, [
    { start: 0, end: 25, value: shared },
    { start: 5, end: 30, value: shared },
  ], 2), shared);
  assert.equal(conflict({ start: 0, end: 30 }, [
    { start: 0, end: 5, value: "same" },
    { start: 0, end: 25, value: "same" },
    { start: 10, end: 20, value: "later" },
  ], 2), "same");
  assert.equal(conflict({ start: 0, end: 30 }, [
    { start: 0, end: 5, value: "same" },
    { start: 0, end: 25, value: "same" },
    { start: 10, end: 20, value: "later" },
    { start: 12, end: 20, value: "full" },
  ], 3), "full");
});

test("returned value is active at the first full point, not an earlier overlapping row", () => {
  const departed = { id: "departed" };
  const active = [{ id: "long" }, { id: "short" }];
  const result = conflict({ start: 0, end: 30 }, [
    { start: 0, end: 5, value: departed },
    { start: 10, end: 25, value: active[0] },
    { start: 15, end: 20, value: active[1] },
  ], 2);
  assert.ok(active.includes(result!));
  assert.notEqual(result, departed);
});

test("sweep matches first-full occupancy across deterministic interval fixtures without mutation", () => {
  let seed = 71;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let fixture = 0; fixture < 100; fixture += 1) {
    const rows = Array.from({ length: 8 }, (_, value) => {
      const start = next() % 40;
      return { start, end: start + next() % 15, value };
    });
    const before = structuredClone(rows);
    for (const capacity of [1, 2, 3]) {
      const times = [candidate.start, ...rows.map(row => row.start)]
        .filter(time => time >= candidate.start && time < candidate.end).sort((a, b) => a - b);
      const fullAt = times.find(time => rows.filter(row => row.start <= time && time < row.end).length >= capacity);
      const result = conflict(candidate, rows, capacity);
      if (fullAt === undefined) assert.equal(result, null);
      else {
        assert.notEqual(result, null);
        assert.ok(rows.some(row => row.value === result && row.start <= fullAt && fullAt < row.end));
      }
    }
    assert.deepEqual(rows, before);
  }
});

// Execute the page's actual prefilter with local fixtures, without mounting its network effects.
type Visit = { id: string; doctorId: string; doctor: string; startsAt: string; durationMinutes: number; status: string };
type Doctor = { id: string; fullName: string; capacity: number; isActive?: boolean };
const page = await readFile(path.join(root, "artifacts/negis/src/pages/AppointmentsPage.tsx"), "utf8");
const ast = ts.createSourceFile("AppointmentsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = new Set(["normalizeStatus", "appointmentInterval", "directoryDoctorFromApi", "readNumber", "readString"]);
const extracted: string[] = [];
let findConflictSource = "";
let formSlotsSource = "";
function visitNode(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && helpers.has(node.name.text)) extracted.push(node.getText(ast));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (node.name.text === "findConflict") findConflictSource = `const findConflict = ${node.initializer.getText(ast)};`;
    if (node.name.text === "formSlots" && ts.isCallExpression(node.initializer)) formSlotsSource = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visitNode);
}
visitNode(ast);
assert.ok(findConflictSource && formSlotsSource);
const js = ts.transpileModule([...extracted, findConflictSource].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const buildPrefilter = new Function("items", "directory", "activeStatuses", "findAppointmentCapacityConflict", `${js}\nreturn { findConflict, directoryDoctorFromApi };`) as (
  items: Visit[], directory: { items: Doctor[] }, statuses: string[], helper: typeof conflict,
) => { findConflict: (candidate: Visit) => Visit | null; directoryDoctorFromApi: (record: Record<string, unknown>) => Doctor };
const statuses = ["scheduled", "confirmed", "arrived"];
const doctorId = "abcdef00-0000-4000-8000-000000000001";
function booking(id: string, overrides: Partial<Visit> = {}): Visit {
  return { id, doctorId, doctor: "Doctor", startsAt: "2026-10-20T10:00:00Z", durationMinutes: 60, status: "scheduled", ...overrides };
}
function prefilter(items: Visit[], capacity = 1, doctors: Doctor[] = [{ id: doctorId, fullName: "Doctor", capacity }]) {
  return buildPrefilter(items, { items: doctors }, statuses, conflict).findConflict;
}

test("UI directory maps capacity and uses linked ID before a name match, including archived cards", () => {
  const runtime = buildPrefilter([], { items: [] }, statuses, conflict);
  assert.equal(runtime.directoryDoctorFromApi({ id: doctorId, full_name: "Doctor", capacity: 3 }).capacity, 3);
  assert.equal(runtime.directoryDoctorFromApi({ id: doctorId, full_name: "Doctor" }).capacity, 1);
  const existing = booking("existing");
  assert.equal(prefilter([existing], 2, [{ id: doctorId.toUpperCase(), fullName: "Renamed", capacity: 2, isActive: false }])(booking("new")), null);
  assert.equal(prefilter([existing], 2)(booking("new", { doctorId: "" })), null);
  assert.equal(prefilter([existing], 1, [])(booking("new")), existing);
});

test("UI permits a second group place but refuses a full group and adjacent bridging stays available", () => {
  const first = booking("first");
  const second = booking("second");
  assert.equal(prefilter([first], 2)(booking("new")), null);
  assert.ok([first, second].includes(prefilter([first, second], 2)(booking("new"))!));
  assert.equal(prefilter([first, booking("later", { startsAt: "2026-10-20T11:00:00Z" })], 2)(booking("new", { durationMinutes: 120 })), null);
});

test("UI excludes its own UUID case-insensitively and normalizes unknown existing statuses", () => {
  const existing = booking(doctorId);
  assert.equal(prefilter([existing])(booking(doctorId.toUpperCase(), { durationMinutes: 90 })), null);
  assert.equal(prefilter([booking("unknown", { status: "legacy" })])(booking("new"))?.id, "unknown");
  const renamed = booking("renamed", { doctorId: doctorId.toUpperCase(), doctor: "Another" });
  assert.equal(prefilter([renamed])(booking("new")), renamed);
  assert.equal(prefilter([booking("other", { doctorId: "another-doctor" })])(booking("new")), null);
  assert.equal(prefilter([booking("legacy-other", { doctorId: "", doctor: "Another" })])(booking("new")), null);
});

for (const status of ["cancelled", "no_show"]) {
  test(`UI ${status} candidates and existing rows consume no place`, () => {
    assert.equal(prefilter([booking("existing")])(booking("new", { status })), null);
    assert.equal(prefilter([booking("existing", { status })])(booking("new")), null);
  });
}

test("UI handles invalid durations outside the shared helper with a sixty-minute fallback", () => {
  for (const durationMinutes of [0, -1, NaN, Infinity]) {
    const existing = booking("existing", { durationMinutes });
    assert.equal(prefilter([existing])(booking("new", { startsAt: "2026-10-20T10:30:00Z" })), existing);
    assert.equal(prefilter([booking("later", { startsAt: "2026-10-20T10:30:00Z" })])(booking("new", { durationMinutes }))?.id, "later");
  }
  assert.equal(prefilter([booking("invalid", { startsAt: "not-a-date" })])(booking("new")), null);
});

test("UI retains and shrinks occupied legacy-overcapacity visits, including status-only edits", () => {
  const original = booking(doctorId);
  const check = prefilter([original, booking("overbooked")]);
  for (const status of ["scheduled", "confirmed", "arrived"]) {
    assert.equal(check({ ...original, status }), null);
    assert.equal(check({ ...original, startsAt: "2026-10-20T10:15:00Z", durationMinutes: 30, status }), null);
  }
  assert.equal(check({ ...original, durationMinutes: 90 })?.id, "overbooked");
  assert.equal(check({ ...original, startsAt: "2026-10-20T09:45:00Z" })?.id, "overbooked");
  assert.equal(prefilter([booking(doctorId, { status: "no_show" }), booking("overbooked")])({ ...original, status: "arrived" })?.id, "overbooked");
  const moved = { ...original, doctorId: "another-doctor" };
  assert.equal(check(moved), null);
  const destination = booking("destination", { doctorId: moved.doctorId });
  assert.equal(prefilter([original, destination])(moved), destination);
});

type GridModule = {
  freeSlots: (input: { intervals: number[][]; busy: number[][]; durationMinutes: number; nowMinute: number | null; capacity?: number }) => number[];
  groupSlots: (slots: number[]) => Array<{ label: string; slots: number[] }>;
};
const grid = createRequire(import.meta.url)(path.join(root, "artifacts/negis/src/lib/dayGrid.ts")) as GridModule;
const slotsJs = ts.transpileModule(`const calculate = ${formSlotsSource};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const calculateSlots = new Function("scope", `with (scope) { ${slotsJs}\nreturn calculate(); }`) as (scope: Record<string, unknown>) => { groups: Array<{ slots: number[] }>; reason: string | null };
function formSlots(items: Visit[], capacity: number, extra: Record<string, unknown> = {}) {
  return calculateSlots({
    form: { date: "2026-10-20", doctorId: doctorId.toUpperCase() }, userRole: "receptionist", items,
    directory: { items: [{ id: doctorId, fullName: "Doctor", capacity }] },
    clinicTimeZone: "UTC", deviceTimeZone: "UTC", shifts: [], editingId: "", todayKey: "2026-10-19",
    totalDurationMinutes: 60, activeStatuses: statuses, normalizeStatus: (status: string) => statuses.includes(status) || ["cancelled", "no_show"].includes(status) ? status : "scheduled",
    isOnDay: () => true, minuteOfClinicDay: (startsAt: string) => {
      const date = new Date(startsAt);
      return Number.isFinite(date.getTime()) ? date.getUTCHours() * 60 + date.getUTCMinutes() : null;
    }, freeSlots: grid.freeSlots, groupSlots: grid.groupSlots, ...extra,
  });
}

test("UI free-time suggestions retain remaining group places and exclude a full group", () => {
  assert.ok(formSlots([booking("one")], 2).groups.flatMap(group => group.slots).includes(600));
  assert.ok(!formSlots([booking("one"), booking("two")], 2).groups.flatMap(group => group.slots).includes(600));
  assert.ok(formSlots([booking(doctorId), booking("two")], 2, { editingId: doctorId.toUpperCase() }).groups.flatMap(group => group.slots).includes(600));
  assert.ok(formSlots([booking("one", { status: "no_show" }), booking("two", { status: "cancelled" })], 1).groups.flatMap(group => group.slots).includes(600));
  assert.ok(!formSlots([booking("one", { status: "legacy", durationMinutes: -1 })], 1).groups.flatMap(group => group.slots).includes(630));
});

test("UI empty-state reason uses capacity when checking whether today's places have passed", () => {
  const fullDay = booking("one", { startsAt: "2026-10-20T09:00:00Z", durationMinutes: 720 });
  const extra = { todayKey: "2026-10-20", minuteOfClinicDay: (startsAt: string) => startsAt === fullDay.startsAt ? 540 : 1260 };
  assert.equal(formSlots([fullDay], 2, extra).reason, "день кончился");
  assert.equal(formSlots([fullDay, { ...fullDay, id: "two" }], 2, extra).reason, "занято");
});

test("UI legacy name-only doctor visits retain the second group place without linking old rows", () => {
  const own = booking("legacy", { doctorId: "", doctor: " Doctor " });
  const extra = { userRole: "doctor", form: { date: "2026-10-20", doctorId: "", doctor: "" }, editingId: null };
  assert.ok(formSlots([own], 2, extra).groups.flatMap(group => group.slots).includes(600));
  assert.ok(!formSlots([own], 1, extra).groups.flatMap(group => group.slots).includes(600));
  assert.ok(!formSlots([own], 2, { ...extra, directory: { items: [] } }).groups.flatMap(group => group.slots).includes(600));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// CD — «сегодня» это сутки клиники.
//
// На один вопрос в продукте было три ответа, и все три неверны. Сводка считала
// день через toISOString(), то есть в UTC, под комментарием «текущая локальная
// дата»: в UTC+5 она называла чужие сутки примерно пять часов каждую ночь, и
// «записей сегодня» вместе с «выручкой за сегодня» в это время были не про
// сегодня. Главный экран сравнивал getFullYear/getMonth/getDate — сутки
// ноутбука оператора. Экран записей замораживал «сегодня» в момент загрузки.
//
// Ошибка не требует большого объёма данных: при трёх записях в базе она ровно
// та же. Поэтому проверки ниже ставят время в вечер по Гринвичу — единственный
// диапазон, где разница между тремя ответами видна.
//
// Ничего здесь не обращается к production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = path.join(repoRoot, "artifacts", "negis", "src", "lib", "clinicDay.ts");
const dashboardPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "Dashboard.tsx");
const controlCenterPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AiControlCenter.tsx");
const appointmentsPath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");

type ClinicDayModule = {
  dayKeyInZone: (instantMs: number, timeZone: string) => string;
  clinicToday: (timeZone: string, now?: number) => string;
  isOnClinicDay: (value: unknown, dayKey: string, timeZone: string) => boolean;
  deviceTimeZone: () => string;
};

const clinicDay = (await import(pathToFileURL(helperPath).href)) as ClinicDayModule;
const { dayKeyInZone, clinicToday, isOnClinicDay } = clinicDay;

/** 2026-09-07T20:00Z — вечер понедельника в Гринвиче, уже вторник в Алматы. */
const EVENING_UTC = Date.parse("2026-09-07T20:00:00.000Z");

test("CD1 вечер по Гринвичу — это уже следующий день клиники", () => {
  assert.equal(dayKeyInZone(EVENING_UTC, "Asia/Almaty"), "2026-09-08");
  assert.equal(dayKeyInZone(EVENING_UTC, "UTC"), "2026-09-07");
  // Именно эти пять часов каждую ночь сводка и называла чужими сутками.
  assert.notEqual(dayKeyInZone(EVENING_UTC, "Asia/Almaty"), dayKeyInZone(EVENING_UTC, "UTC"));
});

test("CD2 без пояса клиники считаем по устройству и не притворяемся Гринвичем", () => {
  // Молчаливый откат на UTC выглядит как часовой пояс, но им не является
  // нигде, кроме Гринвича. Ответ обязан совпасть с сутками машины.
  const local = new Date(EVENING_UTC);
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  assert.equal(dayKeyInZone(EVENING_UTC, ""), expected);
});

test("CD3 непонятный пояс не роняет экран", () => {
  assert.equal(dayKeyInZone(EVENING_UTC, "Не/Пояс"), dayKeyInZone(EVENING_UTC, ""));
});

test("CD4 голая дата не переводится между поясами", () => {
  // «2026-09-07» — это уже календарный день, а не мгновение. Сдвиг превратил
  // бы его в соседний, и запись уехала бы в другие сутки на ровном месте.
  assert.equal(isOnClinicDay("2026-09-07", "2026-09-07", "Asia/Almaty"), true);
  assert.equal(isOnClinicDay("2026-09-07", "2026-09-08", "Asia/Almaty"), false);
});

test("CD5 мгновение попадает в сутки клиники, а не в сутки Гринвича", () => {
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-08", "Asia/Almaty"), true);
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-07", "Asia/Almaty"), false);
  assert.equal(isOnClinicDay("2026-09-07T20:00:00.000Z", "2026-09-07", "UTC"), true);
});

test("CD6 мусор и пустая дата — это «нет», а не «сегодня»", () => {
  for (const value of ["", "   ", "не дата", null, undefined, 42]) {
    assert.equal(isOnClinicDay(value, "2026-09-08", "Asia/Almaty"), false, String(value));
  }
});

test("CD7 clinicToday берёт переданное мгновение, а не только текущее", () => {
  assert.equal(clinicToday("Asia/Almaty", EVENING_UTC), "2026-09-08");
});

test("CD8 сводка больше не считает день в Гринвиче", async () => {
  const source = await readFile(dashboardPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(code),
    "toISOString — это Гринвич, а комментарий рядом обещал локальную дату",
  );
  assert.ok(code.includes("clinicToday("), "день берётся из общего помощника");
  assert.ok(code.includes("isOnClinicDay("), "и сравнивается им же");
});

test("CD9 главный экран больше не считает день по ноутбуку оператора", async () => {
  const source = await readFile(controlCenterPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/date\.getFullYear\(\) === now\.getFullYear\(\)/.test(code),
    "getFullYear/getMonth/getDate читают пояс машины, а не клиники",
  );
  assert.ok(code.includes("clinicToday("), "день берётся из общего помощника");

  // Счётчик, который считался на каждой загрузке и не выводился нигде.
  // Проверка идёт по самостоятельному имени: `unattributedLeads` содержит
  // ту же подстроку, живёт рядом и используется по-настоящему.
  assert.ok(
    !/(?<![A-Za-z])attributedLeads/.test(code),
    "мёртвый счётчик удалён вместе с его вычислением",
  );
});

test("CD10 «Сегодня записей» перестаёт быть замороженным при загрузке", async () => {
  const source = await readFile(appointmentsPath, "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  assert.ok(
    !/todayAppointments = useMemo\(\s*\(\) => items\.filter\(\(appointment\) => isSameDate\(appointment, todayKeyAtLoad\)\), \[items\]\)/.test(code),
    "вкладка, оставленная на ночь, показывала вчерашние записи бесконечно",
  );
  assert.ok(/todayAppointments = useMemo\([\s\S]{0,200}todayKey/.test(code), "счёт идёт по текущему дню клиники");
  assert.ok(/setInterval\(tick, 60_000\)/.test(code), "и переводится в полночь клиники сам");
});

test("CD11 пояс клиники приезжает вместе со списком записей", async () => {
  const server = await readFile(serverPath, "utf8");
  // Настройки открыты только владельцу и администратору: экран, спросивший их
  // напрямую, получил бы отказ и сказал бы «пояс не задан» клинике, которая
  // его задала. Тот же приём уже применён к графику врача.
  assert.ok(
    /resource === "doctor-schedule" \|\| resource === "appointments"/.test(server),
    "пояс читается и для записей тоже",
  );
  assert.ok(
    /\.\.\.\(resource === "appointments" \? \{ timeZone: scheduleTimeZone \} : \{\}\)/.test(server),
    "и уезжает в ответе списка",
  );

  for (const [file, label] of [[dashboardPath, "сводка"], [controlCenterPath, "главный экран"]] as const) {
    const source = await readFile(file, "utf8");
    assert.ok(source.includes("timeZone"), `${label} обязан прочитать пояс из ответа`);
  }
});

type BookingForm = {
  date: string; time: string; notes: string; [key: string]: unknown;
};
type Booking = {
  id: string; startsAt: string; durationMinutes: number; priceMinor: number | null;
  [key: string]: unknown;
};
type PageClock = {
  readString(value: unknown): string;
  defaultForm(date: string, time?: string): BookingForm;
  toStartsAt(date: string, time: string, zone?: string, unchangedIso?: string): string;
  dateKeyFromStartsAt(iso: string, zone?: string): string;
  timeKeyFromStartsAt(iso: string, zone?: string): string;
  formFromAppointment(item: Booking, zone?: string): BookingForm;
  appointmentFromForm(form: BookingForm, id?: string, zone?: string, unchangedIso?: string): Booking;
  appointmentToApi(item: Booking): Record<string, unknown>;
  appointmentFromApi(item: unknown): Booking;
  isOnDay(item: Booking, day: string, zone: string): boolean;
};

async function actualPageClock(): Promise<PageClock> {
  const source = await readFile(appointmentsPath, "utf8");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["pad", "toDateKey", "toTimeKey", "toLocalDate", "toStartsAt", "dateKeyFromStartsAt", "timeKeyFromStartsAt",
    "normalizeStatus", "readString", "readNumber", "asRecord", "defaultForm", "formServiceItems", "formFromAppointment",
    "appointmentFromForm", "appointmentToApi", "appointmentFromApi", "isOnDay"];
  const declarations = names.map((name) => {
    const node = ast.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `actual page definition missing: ${name}`);
    return node.getText(ast);
  });
  const services = createRequire(import.meta.url)(path.join(repoRoot, "lib/crm/appointment-services.ts")) as Record<string, unknown>;
  const bindings: Record<string, unknown> = { ...services, ...clinicDay };
  // Imports are evaluated only if the actual page uses them, so this also runs against the unfixed page.
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.includes("clinicDateTime")) continue;
    const imported = createRequire(import.meta.url)(path.join(repoRoot, "artifacts/negis/src/lib/clinicDateTime.ts")) as Record<string, unknown>;
    const named = statement.importClause?.namedBindings;
    assert.ok(named && ts.isNamedImports(named));
    for (const element of named.elements) bindings[element.name.text] = imported[element.propertyName?.text ?? element.name.text];
  }
  const code = ts.transpileModule([
    ...declarations, "const todayKeyAtLoad = toDateKey(new Date());",
    `return { ${names.join(",")} };`,
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as PageClock;
}

const pageClock = await actualPageClock();
const { minuteOfClinicDay } = createRequire(import.meta.url)(path.join(repoRoot, "artifacts/negis/src/lib/dayGrid.ts")) as {
  minuteOfClinicDay(instant: string, zone: string): number | null;
};

function inDeviceZone<T>(timeZone: string, check: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, timeZone, "fixture must actually change the process clock");
    return check();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function localBooking(date: string, time = "00:10"): BookingForm {
  return {
    ...pageClock.defaultForm(date, time), client: "Local timezone fixture", clientId: "local-client", doctor: "Local doctor",
    doctorId: "local-doctor", service: "Local consultation", durationMinutes: 45, priceTenge: "100.25",
    additionalServices: [{ serviceId: "", name: "Local follow-up", durationMinutes: 30, priceMinor: 0 }],
  };
}

const boundaryCases = [
  { zone: "Asia/Almaty", day: "2026-09-08", iso: "2026-09-07T19:10:00.000Z" },
  { zone: "Pacific/Chatham", day: "2026-07-07", iso: "2026-07-06T11:25:00.000Z" },
  { zone: "Pacific/Chatham", day: "2026-10-06", iso: "2026-10-05T10:25:00.000Z" },
];

for (const device of ["UTC", "America/New_York"]) {
  for (const boundary of boundaryCases) {
    test(`CD-TZ create/API/read/edit/calendar ${device} device -> ${boundary.zone} ${boundary.day} 00:10`, () => inDeviceZone(device, () => {
      const form = localBooking(boundary.day);
      const created = pageClock.appointmentFromForm(form, undefined, boundary.zone);
      assert.equal(created.startsAt, boundary.iso, "clinic midnight must not be saved as device midnight");
      assert.equal(created.durationMinutes, 75);
      assert.equal(created.priceMinor, 10025);
      const payload = pageClock.appointmentToApi(created);
      assert.equal(payload.starts_at, boundary.iso);
      assert.equal(payload.startsAt, boundary.iso);
      const loaded = pageClock.appointmentFromApi({ ...payload, startsAt: undefined });
      assert.equal(loaded.startsAt, boundary.iso, "snake_case API read must retain the exact instant");
      const reopened = pageClock.formFromAppointment(loaded, boundary.zone);
      assert.equal(reopened.date, boundary.day);
      assert.equal(reopened.time, "00:10");
      const edited = pageClock.appointmentFromForm({ ...reopened, notes: "edited locally" }, loaded.id, boundary.zone, loaded.startsAt);
      assert.equal(edited.id, loaded.id);
      assert.equal(edited.startsAt, boundary.iso);
      assert.equal(edited.durationMinutes, 75);
      assert.equal(edited.priceMinor, 10025);
      assert.equal(pageClock.dateKeyFromStartsAt(edited.startsAt, boundary.zone), boundary.day);
      assert.equal(pageClock.timeKeyFromStartsAt(edited.startsAt, boundary.zone), "00:10");
      assert.equal(pageClock.isOnDay(edited, boundary.day, boundary.zone), true);
      assert.equal(pageClock.isOnDay(edited, boundary.iso.slice(0, 10), boundary.zone), false);
      assert.equal(minuteOfClinicDay(edited.startsAt, boundary.zone), 10);
    }));

    test(`CD-TZ persisted API row opens on clinic day ${device} device -> ${boundary.zone} ${boundary.day}`, () => inDeviceZone(device, () => {
      const loaded = pageClock.appointmentFromApi({
        id: "persisted-local-appointment", client_name: "Local client", starts_at: boundary.iso,
        duration_minutes: 45, service: "Local consultation", price_minor: null,
      });
      const form = pageClock.formFromAppointment(loaded, boundary.zone);
      assert.equal(form.date, boundary.day);
      assert.equal(form.time, "00:10");
      assert.equal(pageClock.dateKeyFromStartsAt(loaded.startsAt, boundary.zone), boundary.day);
      assert.equal(pageClock.timeKeyFromStartsAt(loaded.startsAt, boundary.zone), "00:10");
      assert.equal(minuteOfClinicDay(loaded.startsAt, boundary.zone), 10);
    }));
  }
}

for (const zone of ["Asia/Almaty", "America/New_York"]) {
  test(`CD-TZ same-zone ${zone} and legacy empty zone preserve device-local booking`, () => inDeviceZone(zone, () => {
    const form = localBooking("2026-09-08");
    const expected = new Date(2026, 8, 8, 0, 10, 0, 0).toISOString();
    for (const clinicZone of [zone, ""]) {
      const created = pageClock.appointmentFromForm(form, undefined, clinicZone);
      assert.equal(created.startsAt, expected);
      const loaded = pageClock.appointmentFromApi(pageClock.appointmentToApi(created));
      const reopened = pageClock.formFromAppointment(loaded, clinicZone);
      assert.equal(reopened.date, form.date);
      assert.equal(reopened.time, form.time);
      assert.equal(minuteOfClinicDay(loaded.startsAt, clinicZone), 10);
      assert.equal(pageClock.isOnDay(loaded, form.date, clinicZone), true);
    }
  }));
}

for (const device of ["UTC", "America/New_York"]) {
  for (const [day, time, reason] of [
    ["2026-03-08", "02:30", "DST gap"],
    ["2026-11-01", "01:30", "DST repeated minute"],
  ]) {
    test(`CD-TZ ${reason} rejects a new false write on ${device} device`, () => inDeviceZone(device, () => {
      assert.throws(() => pageClock.toStartsAt(day, time, "America/New_York"), /.+/);
      assert.throws(() => pageClock.appointmentFromForm(localBooking(day, time), undefined, "America/New_York"), /.+/);
    }));
  }

  for (const instant of ["2026-11-01T05:30:45.123Z", "2026-11-01T06:30:17.456Z"]) {
    test(`CD-TZ unchanged repeated minute preserves precise ${instant} on ${device} device`, () => inDeviceZone(device, () => {
      const loaded = pageClock.appointmentFromApi({
        id: "repeated-local-appointment", starts_at: instant, service: "Local consultation", duration_minutes: 45,
      });
      const form = pageClock.formFromAppointment(loaded, "America/New_York");
      assert.equal(form.date, "2026-11-01");
      assert.equal(form.time, "01:30");
      const edited = pageClock.appointmentFromForm({ ...form, notes: "note only" }, loaded.id, "America/New_York", loaded.startsAt);
      assert.equal(edited.startsAt, instant, "unchanged wall time must not choose the other offset or lose seconds");
      assert.equal(pageClock.appointmentToApi(edited).starts_at, instant);
      assert.throws(() => pageClock.appointmentFromForm({ ...form, time: "01:45" }, loaded.id, "America/New_York", instant), /.+/,
        "an existing instant cannot authorize a different ambiguous minute");
    }));
  }
}

for (const [day, time, zone] of [
  ["2026-02-30", "00:10", "Asia/Almaty"],
  ["2026-13-01", "00:10", "Asia/Almaty"],
  ["2026-09-08", "24:00", "Asia/Almaty"],
  ["2026-09-08", "12:60", "Asia/Almaty"],
  ["not-a-day", "00:10", "Asia/Almaty"],
  ["2026-09-08", "00:10", "Not/A_Clinic_Zone"],
]) {
  test(`CD-TZ invalid local clock ${day} ${time} ${zone} cannot produce an API write`, () => inDeviceZone("UTC", () => {
    let writes = 0;
    assert.throws(() => {
      const item = pageClock.appointmentFromForm(localBooking(day, time), undefined, zone);
      pageClock.appointmentToApi(item);
      writes += 1;
    }, /.+/);
    assert.equal(writes, 0);
    assert.throws(() => pageClock.toStartsAt(day, time, zone), /.+/);
  }));
}

test("CD-TZ retry uses the exact persisted API payload without reinterpreting a device-local form", async () => {
  const source = await readFile(appointmentsPath, "utf8");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let retryExpression: ts.ConditionalExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isConditionalExpression(node) && node.condition.getText(ast) === "retrying"
      && ts.isCallExpression(node.whenTrue) && node.whenTrue.expression.getText(ast) === "appointmentFromApi"
      && ts.isCallExpression(node.whenFalse) && node.whenFalse.expression.getText(ast) === "appointmentFromForm") retryExpression = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(retryExpression, "execute the actual submit branch rather than a copied retry implementation");
  const code = ts.transpileModule(`return (${retryExpression.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  for (const device of ["UTC", "America/New_York"]) inDeviceZone(device, () => {
    const preciseIso = "2026-09-07T19:10:45.123Z";
    const item = pageClock.appointmentFromForm(localBooking("2026-09-08"), undefined, "Asia/Almaty");
    const payload = pageClock.appointmentToApi({ ...item, startsAt: preciseIso });
    const snapshot = structuredClone(payload);
    const bindings = {
      retrying: true, createAttempt: { current: { payload } },
      appointmentFromApi: pageClock.appointmentFromApi, appointmentFromForm: pageClock.appointmentFromForm,
      form: localBooking("not-a-day", "not-a-time"), editingId: null,
      clinicTimeZone: "Not/A_Clinic_Zone", resolvedDoctorId: "", resolvedServiceId: "",
    };
    const retried = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as Booking;
    assert.equal(retried.id, item.id);
    assert.equal(retried.startsAt, preciseIso);
    assert.equal(pageClock.appointmentToApi(retried).starts_at, preciseIso);
    assert.deepEqual(payload, snapshot, "retry does not rewrite the persisted create attempt");
  });
});

async function actualPrefillEffects() {
  const source = await readFile(appointmentsPath, "utf8");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let prefill: ts.ArrowFunction | undefined;
  let calendar: ts.ArrowFunction | undefined;
  let dependencies = "";
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback)) {
        const text = callback.getText(ast);
        if (text.includes("workspaceScopedKey(APPOINTMENT_PREFILL_KEY)")) {
          prefill = callback;
          dependencies = node.arguments[1]?.getText(ast) ?? "";
        }
        if (text.includes("setSelectedDate(") && text.includes("todayKeyAtLoad") && text.includes("clinicToday(")) calendar = callback;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(prefill && calendar, "execute the real prefill and clock-correction effects");
  assert.match(dependencies, /\bclinicTimeZone\b/, "a changed zone must reconsider a retained handoff");
  assert.match(dependencies, /\bclinicTimeZoneReady\b/, "a resolved clock must reconsider a retained handoff");
  const code = ts.transpileModule(`return { prefill: ${prefill.getText(ast)}, calendar: ${calendar.getText(ast)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return (options: { selectedDate: string; ready: boolean; zone: string; attempt?: { payload: Record<string, unknown> } }) => {
    const key = "local-workspace:negis_appointment_prefill";
    const raw = JSON.stringify({ leadId: "local-lead", clientId: "local-client", clientName: "Local handoff", phone: "+70000000000" });
    const storage = new Map([[key, raw]]);
    let reads = 0;
    let removals = 0;
    const forms: BookingForm[] = [];
    const editingIds: Array<string | null> = [];
    const modalStates: boolean[] = [];
    let selectedDay = options.selectedDate;
    const queuedStateUpdates: Array<() => void> = [];
    const prefillLeadRef = { current: "" };
    const createAttempt = { current: options.attempt ?? null };
    const bindings = {
      window: { localStorage: {
        getItem(storageKey: string) { reads += 1; return storage.get(storageKey) ?? null; },
        removeItem(storageKey: string) { removals += 1; storage.delete(storageKey); },
      } },
      APPOINTMENT_PREFILL_KEY: "negis_appointment_prefill",
      workspaceScopedKey: (storageKey: string) => `local-workspace:${storageKey}`,
      todayKeyAtLoad: "2026-10-18", selectedDate: options.selectedDate,
      clinicTimeZoneReady: options.ready, clinicTimeZone: options.zone,
      clinicToday, defaultForm: pageClock.defaultForm, readString: pageClock.readString,
      createAttempt, prefillLeadRef,
      setSelectedDate(update: string | ((current: string) => string)) {
        queuedStateUpdates.push(() => { selectedDay = typeof update === "function" ? update(selectedDay) : update; });
      },
      setForm: (form: BookingForm) => forms.push(form),
      setEditingId: (id: string | null) => editingIds.push(id),
      setModalOpen: (open: boolean) => modalStates.push(open),
    };
    const effects = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as {
      prefill(): void; calendar(): void;
    };
    return {
      effects, storage, key, raw, forms, editingIds, modalStates, prefillLeadRef, createAttempt,
      reads: () => reads, removals: () => removals, selectedDay: () => selectedDay,
      applyQueuedState() { for (const update of queuedStateUpdates.splice(0)) update(); },
    };
  };
}

const prefillFixture = await actualPrefillEffects();
const PREFILL_BOUNDARY_NOW = Date.parse("2026-10-18T20:30:00.000Z");

test("CD-TZ an existing restored create attempt prevents both automatic day correction and prefill replacement", (context) => inDeviceZone("UTC", () => {
  context.mock.method(Date, "now", () => PREFILL_BOUNDARY_NOW);
  const attempt = { payload: { starts_at: "2026-10-18T19:10:45.123Z", clientId: "restored-local-client" } };
  const snapshot = structuredClone(attempt);
  const fixture = prefillFixture({ selectedDate: "2026-10-18", ready: true, zone: "Asia/Almaty", attempt });
  fixture.effects.calendar();
  fixture.effects.prefill();
  fixture.applyQueuedState();
  assert.equal(fixture.selectedDay(), "2026-10-18");
  assert.equal(fixture.reads(), 0);
  assert.equal(fixture.removals(), 0);
  assert.equal(fixture.storage.get(fixture.key), fixture.raw);
  assert.deepEqual(fixture.forms, []);
  assert.deepEqual(fixture.modalStates, []);
  assert.equal(fixture.createAttempt.current, attempt);
  assert.deepEqual(fixture.createAttempt.current, snapshot);
}));

async function actualScheduleLoader() {
  const source = await readFile(appointmentsPath, "utf8");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["loadDirectory", "readString", "asRecord"];
  const declarations = names.map((name) => {
    const node = ast.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `actual directory definition missing: ${name}`);
    return node.getText(ast);
  });
  const { requireWorkspaceTimeZone } = createRequire(import.meta.url)(path.join(repoRoot, "artifacts/negis/src/lib/clinicDateTime.ts")) as {
    requireWorkspaceTimeZone(zone: string): string;
  };
  const code = ts.transpileModule(`${declarations.join("\n")}\nreturn loadDirectory;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return async (data: Record<string, unknown>) => {
    const requests: string[] = [];
    const mapped: Record<string, unknown>[] = [];
    const bindings = {
      isRealWorkspace: () => true, readCurrentWorkspaceId: () => "local-workspace", requireWorkspaceTimeZone,
      crmFetch: async (url: string) => {
        requests.push(url);
        return new Response(JSON.stringify({ success: true, mode: "supabase", data }), { status: 200 });
      },
    };
    const load = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as (
      route: string, listKey: string, availableKey: string, map: (row: Record<string, unknown>) => Record<string, unknown>,
    ) => Promise<{ items: Record<string, unknown>[]; available: boolean; timeZone: string; resolved: boolean }>;
    const result = await load("/api/crm/doctor-schedule", "shifts", "scheduleAvailable", (row) => { mapped.push(row); return row; });
    assert.deepEqual(requests, ["/api/crm/doctor-schedule?workspaceId=local-workspace"]);
    return { result, mapped };
  };
}

const scheduleLoader = await actualScheduleLoader();
for (const scenario of [
  { label: "missing", zone: undefined, confirmed: false },
  { label: "null", zone: null, confirmed: false },
  { label: "number", zone: 5, confirmed: false },
  { label: "invalid zone", zone: "Not/A_Clinic_Zone", confirmed: false },
  { label: "confirmed empty", zone: "", confirmed: true },
  { label: "confirmed Almaty", zone: "Asia/Almaty", confirmed: true },
]) {
  test(`CD-TZ actual schedule loader distinguishes ${scenario.label} timeZone from an unknown clock`, async () => {
    const row = { doctorId: "local-doctor", weekday: 1, startMinute: 0, endMinute: 60 };
    const { result, mapped } = await scheduleLoader({
      scheduleAvailable: true, shifts: [row], ...(scenario.zone === undefined ? {} : { timeZone: scenario.zone }),
    });
    assert.equal(result.resolved, scenario.confirmed);
    if (scenario.confirmed) {
      assert.equal(result.timeZone, scenario.zone);
      assert.equal(result.available, true);
      assert.deepEqual(result.items, [row]);
      assert.deepEqual(mapped, [row]);
    } else {
      assert.deepEqual(result, { items: [], available: false, timeZone: "", resolved: false });
      assert.deepEqual(mapped, [], "unconfirmed schedule data must not appear loaded");
      const fixture = prefillFixture({ selectedDate: "2026-10-18", ready: result.resolved, zone: result.timeZone });
      fixture.effects.prefill();
      assert.equal(fixture.reads(), 0);
      assert.equal(fixture.removals(), 0);
      assert.equal(fixture.storage.get(fixture.key), fixture.raw);
      assert.deepEqual(fixture.forms, []);
    }
  });
}

for (const device of ["UTC", "America/New_York"]) {
  for (const selectedDate of ["2026-10-18", "2026-10-22"]) {
    test(`CD-TZ prefill shares clinic/calendar day during the ready commit on ${device}, selected ${selectedDate}`, (context) => inDeviceZone(device, () => {
      context.mock.method(Date, "now", () => PREFILL_BOUNDARY_NOW);
      assert.equal(clinicToday(""), "2026-10-18");
      assert.equal(clinicToday("Asia/Almaty"), "2026-10-19");
      const fixture = prefillFixture({ selectedDate, ready: true, zone: "Asia/Almaty" });
      // React queues the earlier calendar update; the later effect still closes over this render's old date.
      fixture.effects.calendar();
      assert.equal(fixture.selectedDay(), selectedDate);
      fixture.effects.prefill();
      fixture.applyQueuedState();
      const expectedDay = selectedDate === "2026-10-18" ? "2026-10-19" : selectedDate;
      assert.equal(fixture.forms.length, 1);
      assert.equal(fixture.forms[0].date, expectedDay);
      assert.equal(fixture.selectedDay(), expectedDay, "form and calendar must agree after queued updates commit");
      assert.equal(fixture.forms[0].clientId, "local-client");
      assert.equal(fixture.forms[0].client, "Local handoff");
      assert.equal(fixture.prefillLeadRef.current, "local-lead");
      assert.deepEqual(fixture.editingIds, [null]);
      assert.deepEqual(fixture.modalStates, [true]);
      assert.equal(fixture.storage.has(fixture.key), false);
      assert.equal(fixture.removals(), 1);
    }));
  }

  test(`CD-TZ unresolved prefill clock on ${device} retains the handoff without reading or consuming it`, () => inDeviceZone(device, () => {
    const fixture = prefillFixture({ selectedDate: "2026-10-18", ready: false, zone: "" });
    fixture.effects.calendar();
    fixture.effects.prefill();
    fixture.applyQueuedState();
    assert.equal(fixture.reads(), 0);
    assert.equal(fixture.removals(), 0);
    assert.equal(fixture.storage.get(fixture.key), fixture.raw);
    assert.deepEqual(fixture.forms, []);
    assert.deepEqual(fixture.modalStates, []);
    assert.deepEqual(fixture.editingIds, []);
    assert.equal(fixture.prefillLeadRef.current, "");
    assert.equal(fixture.selectedDay(), "2026-10-18");
  }));

  test(`CD-TZ resolved legacy empty-zone prefill on ${device} preserves its selected device day`, (context) => inDeviceZone(device, () => {
    context.mock.method(Date, "now", () => PREFILL_BOUNDARY_NOW);
    const fixture = prefillFixture({ selectedDate: "2026-10-18", ready: true, zone: "" });
    fixture.effects.calendar();
    fixture.effects.prefill();
    fixture.applyQueuedState();
    assert.equal(fixture.forms.length, 1);
    assert.equal(fixture.forms[0].date, "2026-10-18");
    assert.equal(fixture.selectedDay(), "2026-10-18");
    assert.equal(fixture.removals(), 1);
  }));
}

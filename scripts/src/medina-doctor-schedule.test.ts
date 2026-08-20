import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// DS — справочник врачей и график приёма.
//
// «Врач» записью не был: он жил свободным текстом в appointments.doctor_name, а
// выбирали его из четырёх выдуманных имён в коде экрана. Расписания не было ни
// в каком виде — дневная сетка захардкожена 09:00–21:00 одинаково для каждого
// врача и каждого дня.
//
// Что здесь закрепляется, помимо обычной регистрации ресурса:
//
//   * правило считается во времени КЛИНИКИ. Все проверки ниже ставят визиты в
//     разных поясах именно потому, что ошибка «посчитали в поясе машины»
//     невидима на 10:00Z и вылезает у клиники в UTC+5;
//   * семь выходов «пропустить молча» — каждый намеренный. Правило,
//     отказывающее при любой неопределённости, закрыло бы регистратуру в
//     первый же день у клиники, которая график не заполняла;
//   * гейт на правке. Проверка на каждом PATCH уже ломала «Подтвердить» и
//     «Пришёл» однажды, и записей вне часов приёма в истории заведомо больше,
//     чем наложений;
//   * обход графика — свой флаг, отдельный от обхода пересечений: один клик не
//     имеет права снимать два разных правила.
//
// Ничего здесь не обращается к production: клиент базы — заглушка.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const journalPath = path.join(repoRoot, "lib", "crm", "change-journal.ts");
const authorizationPath = path.join(repoRoot, "lib", "crm", "authorization.ts");
const migrationPath = path.join(repoRoot, "migrations", "033_doctor_directory_and_schedule.sql");
const pagePath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");
const editorPath = path.join(repoRoot, "artifacts", "negis", "src", "components", "admin", "DoctorSchedule.tsx");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOCTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HIDDEN_DOCTOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_DOCTOR_ID = "99999999-9999-4999-8999-999999999999";
const APPOINTMENT_ID = "abababab-abab-4bab-8bab-abababababab";
const SHIFT_ID = "fafafafa-fafa-4afa-8afa-fafafafafafa";
const TOKEN = "header.payload.signature";

type QueryLog = { table: string; op: string; filters: Record<string, unknown> };
type Filter = { column: string; op: "eq" | "gte" | "lte"; value: unknown };
type InjectedError = { table: string; op: "select" | "insert" | "update"; code: string; message: string };

function spyClient(
  rows: Record<string, unknown[]>,
  log: QueryLog[],
  injected: InjectedError[],
  missingColumns: Set<string>,
) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const applied: Filter[] = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      let single = false;
      let maybe = false;

      const matching = () =>
        (rows[table] ?? [])
          .map((row) => row as Record<string, unknown>)
          .filter((row) => applied.every((filter) => {
            const value = row[filter.column];
            if (filter.op === "eq") return value === filter.value;
            // NULL в сравнениях Postgres отсеивает строку — заглушка обязана
            // вести себя так же, иначе недельные и датированные строки
            // перемешались бы и правило проверялось бы не на том наборе.
            if (value === null || value === undefined) return false;
            if (filter.op === "gte") return String(value) >= String(filter.value ?? "");
            return String(value) <= String(filter.value ?? "");
          }));

      const missingInRow = (row: unknown) =>
        Object.keys(row && typeof row === "object" ? (row as Record<string, unknown>) : {})
          .find((column) => missingColumns.has(column));

      const failure = () => injected.find((item) => item.table === table && item.op === entry.op) ?? null;

      const settle = (resolve: (value: { data: unknown; error: unknown }) => void) => {
        const missing = entry.filters.__missing;
        if (typeof missing === "string") {
          resolve({ data: null, error: { message: `column ${table}.${missing} does not exist`, code: "PGRST204" } });
          return;
        }
        const fail = failure();
        if (fail) {
          resolve({ data: null, error: { message: fail.message, code: fail.code } });
          return;
        }
        const found = matching();
        if (single) {
          const written = entry.filters.__row;
          resolve({
            data: written && typeof written === "object"
              ? { id: DOCTOR_ID, ...(written as Record<string, unknown>) }
              : found[0] ?? null,
            error: null,
          });
          return;
        }
        if (maybe) {
          resolve({ data: found[0] ?? null, error: null });
          return;
        }
        resolve({ data: found, error: null });
      };

      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; entry.filters.__missing = missingInRow(row); return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; entry.filters.__missing = missingInRow(row); return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => { single = true; return chain(); },
        maybeSingle: () => new Promise((resolve) => { maybe = true; settle(resolve as never); }),
        eq(column: string, value: unknown) {
          if (missingColumns.has(column)) entry.filters.__missing = column;
          applied.push({ column, op: "eq", value });
          entry.filters[column] = value;
          return chain();
        },
        gte(column: string, value: unknown) { applied.push({ column, op: "gte", value }); entry.filters[`${column}__gte`] = value; return chain(); },
        lte(column: string, value: unknown) { applied.push({ column, op: "lte", value }); entry.filters[`${column}__lte`] = value; return chain(); },
        lt(column: string, value: unknown) { entry.filters[`${column}__lt`] = value; return chain(); },
        in(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        then(resolve: (value: { data: unknown; error: unknown }) => void) { settle(resolve); },
      });
      return builder;
    },
  };
}

type MockResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  status: (code: number) => MockResponse;
  setHeader: () => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: {},
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
    json(payload) { res.body = (payload ?? {}) as Record<string, unknown>; return res; },
  };
  return res;
}

const warnings: string[] = [];
const originalWarn = console.warn;

/** Часовой пояс клиники живёт строкой в workspace_settings. */
function scheduleSetting(timeZone: string) {
  return { workspace_id: WORKSPACE_A, key: "clinic_schedule", value: { timeZone } };
}

async function loadRouter(options: {
  rows?: Record<string, unknown[]>;
  role?: string;
  injected?: InjectedError[];
  missingColumns?: string[];
} = {}) {
  const log: QueryLog[] = [];
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER_A, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  const clientRows: Record<string, unknown[]> = {
    staff_users: [
      { id: STAFF_A, auth_user_id: USER_A, workspace_id: WORKSPACE_A, role: options.role ?? "owner", status: "active", full_name: "Айгерим" },
    ],
    ...(options.rows ?? {}),
  };

  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    spyClient(clientRows, log, options.injected ?? [], new Set(options.missingColumns ?? [])));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: { resource?: string; method?: string; body?: unknown; query?: Record<string, unknown> }) => {
    log.length = 0;
    warnings.length = 0;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    const res = mockResponse();
    try {
      await routerModule.default(
        {
          method: input.method ?? "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          query: { path: [input.resource ?? "clinic-doctors"], workspaceId: WORKSPACE_A, ...(input.query ?? {}) },
          body: input.body,
        },
        res,
      );
    } finally {
      console.warn = originalWarn;
    }
    return { res, log: [...log], warnings: [...warnings] };
  };
}

const writtenTo = (log: QueryLog[], table: string) =>
  (log.find((entry) => entry.table === table && (entry.op === "insert" || entry.op === "update"))?.filters.__row ?? null) as
    | Record<string, unknown>
    | null;

const activeDoctor = { id: DOCTOR_ID, workspace_id: WORKSPACE_A, full_name: "Сауле Ахметова", is_active: true };
const hiddenDoctor = { id: HIDDEN_DOCTOR_ID, workspace_id: WORKSPACE_A, full_name: "Бывший врач", is_active: false };

/** Понедельник 09:00–14:00 по времени клиники. */
const mondayShift = {
  id: SHIFT_ID,
  workspace_id: WORKSPACE_A,
  doctor_id: DOCTOR_ID,
  weekday: 1,
  on_date: null,
  on_date_end: null,
  is_working: true,
  start_minute: 540,
  end_minute: 840,
};

/** 2026-09-07 — понедельник. 06:00Z = 11:00 в Алматы (UTC+5). */
const MONDAY_INSIDE = "2026-09-07T06:00:00.000Z";
/** 15:00Z = 20:00 в Алматы — за пределами 09:00–14:00. */
const MONDAY_OUTSIDE = "2026-09-07T15:00:00.000Z";

/* ── Права и регистрация ── */

test("DS1 справочник читает тот, кто записывает, и он же его правит", async () => {
  // Политика изменена сознательно: исполнителей и смены правит тот, кто ведёт
  // запись каждый день, — у салона это администратор (роль receptionist).
  // Право отдельное (manage_directory), а не view_admin: право на график не
  // должно тянуть за собой ключи интеграций и список сотрудников. Роли без
  // этого права — врач, маркетолог — по-прежнему получают отказ.
  const reception = await loadRouter({ role: "receptionist", rows: { clinic_doctors: [activeDoctor] } });
  const read = await reception({ method: "GET" });
  assert.equal(read.res.statusCode, 200, JSON.stringify(read.res.body));

  const written = await reception({ method: "POST", body: { fullName: "Новый врач" } });
  assert.equal(written.res.statusCode, 201, JSON.stringify(written.res.body));

  const doctor = await loadRouter({ role: "doctor", rows: { clinic_doctors: [activeDoctor] } });
  const refused = await doctor({ method: "POST", body: { fullName: "Новый врач" } });
  assert.equal(refused.res.statusCode, 403, JSON.stringify(refused.res.body));

  const owner = await loadRouter();
  const allowed = await owner({ method: "POST", body: { fullName: "Новый врач" } });
  assert.equal(allowed.res.statusCode, 201, JSON.stringify(allowed.res.body));
});

test("DS2 оба ресурса зарегистрированы во всех реестрах сразу", async () => {
  const server = await readFile(serverPath, "utf8");
  const router = await readFile(routerPath, "utf8");
  const authorization = await readFile(authorizationPath, "utf8");
  const journal = await readFile(journalPath, "utf8");

  for (const resource of ["clinic-doctors", "doctor-schedule"]) {
    assert.ok(server.includes(`| "${resource}"`), `${resource}: тип ресурса`);
    assert.ok(server.includes(`"${resource}": {`), `${resource}: конфигурация`);
    assert.ok(router.includes(`"${resource}",`), `${resource}: список маршрутов`);
    assert.ok(authorization.includes(`"${resource}": {`), `${resource}: реестр прав`);
    assert.ok(journal.includes(`"${resource}":`), `${resource}: карта журнала`);
  }
});

/* ── Связь записи с врачом ── */

test("DS3 связь возвращается наружу, а не только записывается", async () => {
  // Урок услуги, применённый заранее: браузер шлёт объект целиком на каждом
  // сохранении, и колонка, которую он не может прочитать, приходит назад
  // пустой строкой — следующий клик «Пришёл» затирает связь в null.
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_INSIDE },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const item = (res.body.data as Record<string, Record<string, unknown>>).item;
  assert.equal(item.doctorId, DOCTOR_ID, "иначе браузеру нечего эхом отправить назад");
});

test("DS4 врач чужой клиники не становится связью", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [
        activeDoctor,
        { id: FOREIGN_DOCTOR_ID, workspace_id: WORKSPACE_B, full_name: "Чужой врач", is_active: true },
      ],
    },
  });
  const { res, log } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: FOREIGN_DOCTOR_ID, startsAt: MONDAY_INSIDE },
  });

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(writtenTo(log, "appointments"), null);
});

test("DS5 скрытый врач не попадает в новую запись, но правку прошлой не ломает", async () => {
  const create = await loadRouter({ rows: { clinic_doctors: [activeDoctor, hiddenDoctor] } });
  const refused = await create({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: HIDDEN_DOCTOR_ID, startsAt: MONDAY_INSIDE },
  });
  assert.equal(refused.res.statusCode, 400, "иначе «скрыт» не значит ничего");

  const patch = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor, hiddenDoctor],
      appointments: [{ id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, client_name: "Пациент", doctor_name: "Бывший врач" }],
    },
  });
  const allowed = await patch({
    resource: "appointments",
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { doctorId: HIDDEN_DOCTOR_ID, notes: "перенос" } },
  });
  assert.equal(allowed.res.statusCode, 200, JSON.stringify(allowed.res.body));
  assert.equal(writtenTo(allowed.log, "appointments")?.doctor_id, HIDDEN_DOCTOR_ID);
});

test("DS6 запись создаётся и до применения миграции, теряя только связь", async () => {
  const call = await loadRouter({
    rows: { clinic_doctors: [activeDoctor] },
    missingColumns: ["doctor_id"],
  });
  const { res, log, warnings: warned } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_INSIDE },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const inserts = log.filter((entry) => entry.table === "appointments" && entry.op === "insert");
  // Заходов три, и это осознанно. Отказ PostgREST про кэш схемы (PGRST204) не
  // отличим от «колонки нет вовсе», а кэш отстаёт от базы на секунды после
  // ALTER TABLE. Поэтому вторая попытка — ДОСЛОВНАЯ: если колонка уже
  // появилась, связь сохраняется целой, а не срезается молча. И только третья
  // идёт без колонки. Ожидание «ровно две» здесь стояло до того, как это окно
  // разобрали, — см. набор test:column-lag, CL9.
  assert.equal(inserts.length, 3, "отказ, дословный повтор на случай устаревшего кэша, и заход без колонки");
  assert.equal((inserts[1].filters.__row as Record<string, unknown>).doctor_id, DOCTOR_ID, "повтор идёт целым");
  assert.equal((inserts[2].filters.__row as Record<string, unknown>).doctor_id, undefined);
  assert.ok(warned.some((line) => line.includes("033") && line.includes("doctor_id")));
  // Снимается ровно та колонка, которой нет, и называется её миграция. Снимать
  // разом все связи значило бы терять связь с услугой в окне, когда не хватает
  // только связи с врачом: одна применённая миграция молча отменялась бы
  // другой, ещё не применённой.
  assert.ok(
    !warned.some((line) => line.includes("032")),
    "миграция 032 применена — её колонку снимать не за что",
  );
});

/* ── Правило графика ── */

test("DS7 без часового пояса клиники правило молчит", async () => {
  // Пояс по умолчанию был бы фактом о клинике, которого никто не вводил, а
  // «закрыто по умолчанию» остановило бы регистратуру в первый же день.
  const call = await loadRouter({
    rows: { clinic_doctors: [activeDoctor], clinic_doctor_shifts: [mondayShift], workspace_settings: [] },
  });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: MONDAY_OUTSIDE },
  });

  assert.equal(res.statusCode, 201, "нет пояса — нет правила");
});

test("DS8 визит внутри часов приёма проходит, вне — отвергается", async () => {
  const rows = {
    clinic_doctors: [activeDoctor],
    clinic_doctor_shifts: [mondayShift],
    workspace_settings: [scheduleSetting("Asia/Almaty")],
  };

  const inside = await loadRouter({ rows });
  const ok = await inside({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: MONDAY_INSIDE },
  });
  assert.equal(ok.res.statusCode, 201, JSON.stringify(ok.res.body));

  const outside = await loadRouter({ rows });
  const refused = await outside({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: MONDAY_OUTSIDE },
  });
  assert.equal(refused.res.statusCode, 409, JSON.stringify(refused.res.body));
  assert.equal(refused.res.body.code, "outside_doctor_schedule");
});

test("DS9 правило считается во времени клиники, а не машины", async () => {
  // 2026-09-07T20:00Z — это 01:00 вторника в Алматы, то есть НЕ понедельник и
  // не 09:00–14:00. В UTC это всё ещё понедельник 20:00 — тоже вне часов, но
  // по другой причине. Решающая проверка: 2026-09-07T23:30Z = 04:30 вторника,
  // и в поясе UTC это понедельник, где у врача приём есть.
  const rows = {
    clinic_doctors: [activeDoctor],
    clinic_doctor_shifts: [{ ...mondayShift, start_minute: 0, end_minute: 1439 }],
    workspace_settings: [scheduleSetting("Asia/Almaty")],
  };
  const call = await loadRouter({ rows });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: "2026-09-07T23:30:00.000Z" },
  });

  assert.equal(
    res.statusCode,
    409,
    "в поясе клиники это уже вторник — правило, считающее в UTC, пропустило бы запись",
  );
});

test("DS10 отказ несёт часы приёма, уже переведённые во время клиники", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: MONDAY_OUTSIDE },
  });

  const schedule = res.body.schedule as Record<string, unknown>;
  assert.deepEqual(schedule.intervals, ["09:00–14:00"], "браузер печатает их как есть, а не пересчитывает");
  assert.equal(schedule.localTime, "20:00", "время визита — тоже в поясе клиники");
  assert.equal(schedule.weekdayLabel, "понедельник");
});

test("DS11 обход графика — свой флаг, отдельный от обхода пересечений", async () => {
  const rows = {
    clinic_doctors: [activeDoctor],
    clinic_doctor_shifts: [mondayShift],
    workspace_settings: [scheduleSetting("Asia/Almaty")],
  };

  const withConflictOverride = await loadRouter({ rows });
  const stillRefused = await withConflictOverride({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE, allowConflict: true },
  });
  assert.equal(stillRefused.res.statusCode, 409, "один клик не снимает два разных правила");

  const withScheduleOverride = await loadRouter({ rows });
  const allowed = await withScheduleOverride({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE, allowOutsideSchedule: true },
  });
  assert.equal(allowed.res.statusCode, 201, JSON.stringify(allowed.res.body));
});

test("DS12 запись без связи с врачом правилу не подчиняется", async () => {
  // Свободный ввод врача и вся накопленная история: doctor_id пуст, судить
  // не о чем. Иначе правило закрыло бы регистратуру на всей старой базе.
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctor: "Кто-то другой", startsAt: MONDAY_OUTSIDE },
  });
  assert.equal(res.statusCode, 201);
});

test("DS13 у врача без графика правила нет", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE },
  });
  assert.equal(res.statusCode, 201, "пустой график — это отсутствие правила, а не «закрыто»");
});

test("DS14 отказ чтения графика пропускает запись и не печатает пациента", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
    injected: [{ table: "clinic_doctor_shifts", op: "select", code: "42501", message: "permission denied" }],
  });
  const { res, warnings: warned } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Лаура Ким", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE },
  });

  assert.equal(res.statusCode, 201, "график не должен становиться новым способом сломать запись");
  assert.ok(warned.length > 0, "но и молчать о сбое нельзя");
  assert.ok(!warned.join(" ").includes("Лаура"), "в логе нет имени пациента");
});

test("DS15 отменённая запись графику не подчиняется", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE, status: "cancelled" },
  });
  assert.equal(res.statusCode, 201, "отменённая запись слот не занимает");
});

test("DS16 правка, не двигающая запись, правилу не подвергается", async () => {
  // Ровно тот дефект, который проверка пересечений уже проходила: «Подтвердить»
  // и «Пришёл» ловили отказ от правила, которого прошлая запись не проходила.
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
      appointments: [{
        id: APPOINTMENT_ID,
        workspace_id: WORKSPACE_A,
        client_name: "Пациент",
        doctor_id: DOCTOR_ID,
        doctor_name: "Сауле Ахметова",
        starts_at: MONDAY_OUTSIDE,
        status: "scheduled",
      }],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { notes: "позвонить заранее" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test("DS17 перенос записи вне графика отвергается", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
      appointments: [{
        id: APPOINTMENT_ID,
        workspace_id: WORKSPACE_A,
        client_name: "Пациент",
        doctor_id: DOCTOR_ID,
        doctor_name: "Сауле Ахметова",
        starts_at: MONDAY_INSIDE,
        status: "scheduled",
      }],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { startsAt: MONDAY_OUTSIDE } },
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "outside_doctor_schedule");
});

/* ── Строки графика ── */

test("DS18 строка графика — либо день недели, либо дата, но не оба", async () => {
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });

  const both = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 1, onDate: "2026-09-07", isWorking: true, startMinute: 540, endMinute: 840 },
  });
  assert.equal(both.res.statusCode, 400, JSON.stringify(both.res.body));

  const neither = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, isWorking: true, startMinute: 540, endMinute: 840 },
  });
  assert.equal(neither.res.statusCode, 400, JSON.stringify(neither.res.body));
});

test("DS19 выходной без часов, закрытое окно с часами, рабочая строка с обоими концами", async () => {
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });

  // Пин обновлён осознанно. Раньше строка «не работает» с часами отвергалась:
  // считалось, что она одновременно говорит «не работает» и «с девяти».
  // Владелец салона попросил обратное — «если мастер отдыхает, закрыть окно
  // или целый день», — и 040 сделала эту форму законной: часы у нерабочей
  // строки читаются как ЗАКРЫТОЕ ОКНО и вычитаются из смены (test:master-prices,
  // MP10–MP14). Выходной на весь день остался строкой без часов.
  const closedWindow = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 3, isWorking: false, startMinute: 540, endMinute: 840 },
  });
  assert.equal(closedWindow.res.statusCode, 201, JSON.stringify(closedWindow.res.body));

  const workingWithoutHours = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 3, isWorking: true },
  });
  assert.equal(workingWithoutHours.res.statusCode, 400);

  const good = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 3, isWorking: false },
  });
  assert.equal(good.res.statusCode, 201, JSON.stringify(good.res.body));
  assert.equal(writtenTo(good.log, "clinic_doctor_shifts")?.start_minute, null);
});

test("DS20 полночь — законная минута начала, а не «не задано»", async () => {
  // readNumber(null) даёт ноль, и ноль здесь означает 00:00. Урок цены услуги,
  // применённый к минутам.
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });
  const { res, log } = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 6, isWorking: true, startMinute: 0, endMinute: 480 },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writtenTo(log, "clinic_doctor_shifts")?.start_minute, 0);
});

test("DS21 ночная смена принимается, смена длиннее суток — нет", async () => {
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });

  const overnight = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 5, isWorking: true, startMinute: 1320, endMinute: 1560 },
  });
  assert.equal(overnight.res.statusCode, 201, "22:00–02:00 существует");

  const tooLong = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, weekday: 5, isWorking: true, startMinute: 0, endMinute: 2000 },
  });
  assert.equal(tooLong.res.statusCode, 400, "смена длиннее суток сменой не является");
});

test("DS22 конец периода проставляется сам, если его не прислали", async () => {
  // Иначе фильтр перекрытия перестал бы быть честным сравнением двух дат.
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });
  const { res, log } = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { doctorId: DOCTOR_ID, onDate: "2026-09-07", isWorking: false },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writtenTo(log, "clinic_doctor_shifts")?.on_date_end, "2026-09-07");
});

test("DS23 строка графика без врача отвергается", async () => {
  const call = await loadRouter({ rows: { clinic_doctors: [activeDoctor] } });
  const { res } = await call({
    resource: "doctor-schedule",
    method: "POST",
    body: { weekday: 2, isWorking: false },
  });
  assert.equal(res.statusCode, 400, "график без врача — строка ни о чём");
});

/* ── Отказы и состояния ── */

test("DS24 однофамилец — четырёхсотка с человеческим текстом, прочий отказ базы — сбой", async () => {
  const duplicate = await loadRouter({
    injected: [{ table: "clinic_doctors", op: "insert", code: "23505", message: "duplicate key value violates unique constraint" }],
  });
  const conflict = await duplicate({ method: "POST", body: { fullName: "Сауле Ахметова" } });
  assert.equal(conflict.res.statusCode, 400, JSON.stringify(conflict.res.body));
  assert.ok(JSON.stringify(conflict.res.body).includes("Врач с таким именем уже есть"));
  assert.ok(!JSON.stringify(conflict.res.body).includes("constraint"));

  const denied = await loadRouter({
    injected: [{ table: "clinic_doctors", op: "insert", code: "42501", message: "permission denied for table clinic_doctors" }],
  });
  const failed = await denied({ method: "POST", body: { fullName: "Сауле Ахметова" } });
  assert.equal(failed.res.statusCode, 502);
});

test("DS25 «справочник не включён» отличается от «не удалось прочитать»", async () => {
  const notMigrated = await loadRouter({
    injected: [{ table: "clinic_doctors", op: "select", code: "PGRST205", message: "Could not find the table in the schema cache" }],
  });
  const unavailable = await notMigrated({ method: "GET" });
  assert.equal(unavailable.res.statusCode, 200, JSON.stringify(unavailable.res.body));
  assert.equal((unavailable.res.body.data as Record<string, unknown>).directoryAvailable, false);

  const broken = await loadRouter({
    injected: [{ table: "clinic_doctors", op: "select", code: "42501", message: "permission denied" }],
  });
  const failure = await broken({ method: "GET" });
  assert.equal(failure.res.statusCode, 502);
});

test("DS26 часовой пояс едет вместе с графиком, а не отдельным запросом к настройкам", async () => {
  // Настройки доступны только владельцу и администратору: регистратор,
  // читая их, получил бы отказ — и экран сказал бы «пояс не задан» клинике,
  // которая его задала.
  const call = await loadRouter({
    role: "receptionist",
    rows: { clinic_doctor_shifts: [mondayShift], workspace_settings: [scheduleSetting("Asia/Almaty")] },
  });
  const { res } = await call({ resource: "doctor-schedule", method: "GET" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal((res.body.data as Record<string, unknown>).timeZone, "Asia/Almaty");
});

test("DS31 повторное сохранение той же записи не подпадает под правило", async () => {
  // Самая дорогая находка ревью: row.starts_at нормализуется в …T15:00:00.000Z,
  // а прочитанное «до» приходит из базы как …T15:00:00+00:00. Это ОДИН момент
  // в двух записях, и сравнение строк объявляло его изменившимся всегда —
  // то есть «Подтвердить» и «Пришёл» отказывали навсегда на любой записи вне
  // часов приёма, где кнопки обхода на карточке нет.
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
      appointments: [{
        id: APPOINTMENT_ID,
        workspace_id: WORKSPACE_A,
        client_name: "Пациент",
        doctor_id: DOCTOR_ID,
        doctor_name: "Сауле Ахметова",
        // Ровно так это печатает PostgREST для timestamptz.
        starts_at: "2026-09-07T15:00:00+00:00",
        status: "scheduled",
      }],
    },
  });
  const { res } = await call({
    resource: "appointments",
    method: "PATCH",
    body: {
      id: APPOINTMENT_ID,
      updates: {
        // Браузер шлёт объект целиком на каждом нажатии статуса.
        startsAt: "2026-09-07T15:00:00.000Z",
        starts_at: "2026-09-07T15:00:00.000Z",
        doctorId: DOCTOR_ID,
        status: "confirmed",
      },
    },
  });

  assert.equal(res.statusCode, 200, `запись не двигали — судить её повторно не за что: ${JSON.stringify(res.body)}`);
});

test("DS32 у врача с графиком правило действует во все дни, а не через день", async () => {
  // «Есть ли график» — свойство врача, а не конкретного дня. Прежняя версия
  // спрашивала про сегодня и вчера: у врача Пн–Пт суббота отвергалась (у
  // пятницы строка есть), а воскресенье проходило (у субботы нет).
  const weekdays = [1, 2, 3, 4, 5].map((iso) => ({
    ...mondayShift,
    id: `${SHIFT_ID}-${iso}`,
    weekday: iso,
  }));
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: weekdays,
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });

  // 2026-09-12 — суббота, 2026-09-13 — воскресенье. Обе в 06:00Z = 11:00 Алматы.
  for (const [day, startsAt] of [["суббота", "2026-09-12T06:00:00.000Z"], ["воскресенье", "2026-09-13T06:00:00.000Z"]] as const) {
    const { res } = await call({
      resource: "appointments",
      method: "POST",
      body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt },
    });
    assert.equal(res.statusCode, 409, `${day} обязана отвергаться так же, как и соседний день`);
  }
});

test("DS33 исключение на дату замещает недельный образец", async () => {
  const rows = {
    clinic_doctors: [activeDoctor],
    clinic_doctor_shifts: [
      mondayShift,
      {
        ...mondayShift,
        id: `${SHIFT_ID}-vacation`,
        weekday: null,
        on_date: "2026-09-01",
        on_date_end: "2026-09-14",
        is_working: false,
        start_minute: null,
        end_minute: null,
      },
    ],
    workspace_settings: [scheduleSetting("Asia/Almaty")],
  };

  // 06:00Z в понедельник 2026-09-07 = 11:00 Алматы — внутри недельных часов,
  // но внутри отпуска. Отпуск сильнее образца.
  const call = await loadRouter({ rows });
  const { res } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, doctor: "Сауле Ахметова", startsAt: MONDAY_INSIDE },
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.deepEqual((res.body.schedule as Record<string, unknown>).intervals, [], "в отпуске часов приёма нет");
});

test("DS34 ночная смена доживает до утра следующего дня", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      // Пятница 22:00 — 02:00 субботы.
      clinic_doctor_shifts: [{ ...mondayShift, weekday: 5, start_minute: 1320, end_minute: 1560 }],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });

  // 2026-09-11 — пятница. 20:00Z = 01:00 субботы в Алматы: внутри хвоста.
  const inside = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: "2026-09-11T20:00:00.000Z" },
  });
  assert.equal(inside.res.statusCode, 201, `хвост ночной смены обязан считаться: ${JSON.stringify(inside.res.body)}`);

  // 22:00Z = 03:00 субботы — хвост уже кончился.
  const outside = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: "2026-09-11T22:00:00.000Z" },
  });
  assert.equal(outside.res.statusCode, 409, "после конца смены — отказ");
});

test("DS35 откат снимает только отсутствующую колонку, сохраняя связь с услугой", async () => {
  const call = await loadRouter({
    rows: { clinic_doctors: [activeDoctor], clinic_services: [{ id: SHIFT_ID, workspace_id: WORKSPACE_A, name: "Ботокс", is_active: true }] },
    missingColumns: ["doctor_id"],
  });
  const { res, log } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, serviceId: SHIFT_ID, startsAt: MONDAY_INSIDE },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const inserts = log.filter((entry) => entry.table === "appointments" && entry.op === "insert");
  const second = inserts[inserts.length - 1].filters.__row as Record<string, unknown>;
  assert.equal(second.doctor_id, undefined, "отсутствующая колонка снята");
  assert.equal(second.service_id, SHIFT_ID, "применённая миграция не отменяется ещё не применённой");
});

test("DS36 обход графика оставляет след в журнале", async () => {
  const call = await loadRouter({
    rows: {
      clinic_doctors: [activeDoctor],
      clinic_doctor_shifts: [mondayShift],
      workspace_settings: [scheduleSetting("Asia/Almaty")],
    },
  });
  const { res, log } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", doctorId: DOCTOR_ID, startsAt: MONDAY_OUTSIDE, allowOutsideSchedule: true },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const journal = log.filter((entry) => entry.table === "audit_logs" && entry.op === "insert");
  assert.ok(
    journal.some((entry) => (entry.filters.__row as Record<string, unknown>).action === "booked_outside_schedule"),
    "запись вне графика, которую нельзя потом найти, — это и есть то, ради чего журнал заводили",
  );
});

/* ── Источники ── */

test("DS27 миграция создаёт ровно то, на что рассчитывает сервер", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const required of [
    "create table if not exists public.clinic_doctors",
    "create table if not exists public.clinic_doctor_shifts",
    "clinic_doctors_workspace_active_name_idx",
    "clinic_doctor_shifts_one_key",
    "clinic_doctor_shifts_minutes",
    "alter table public.clinic_doctors enable row level security",
    "alter table public.clinic_doctor_shifts enable row level security",
    "alter table public.appointments enable row level security",
    "on table public.appointments",
  ]) {
    assert.ok(sql.includes(required), `миграция обязана содержать: ${required}`);
  }
  for (const forbidden of ["drop column", "drop table", "delete from", "update public.appointments"]) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `миграция не имеет права содержать: ${forbidden}`);
  }
});

test("DS28 комментарии миграции не содержат слов, которые читает набор цепочки", async () => {
  // Ловушка без другого сторожа: readChain применяет регулярные выражения к
  // СЫРОМУ тексту и комментарии не вырезает.
  const sql = await readFile(migrationPath, "utf8");
  const comments = sql.split("\n").filter((line) => line.trim().startsWith("--")).join("\n").toLowerCase();
  for (const phrase of ["create table", "alter table", "references "]) {
    assert.ok(!comments.includes(phrase), `фраза «${phrase}» в комментарии ломает разбор цепочки`);
  }
});

test("DS29 экран записи больше не придумывает врачей", async () => {
  const page = await readFile(pagePath, "utf8");
  const code = page.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)).join("\n");

  assert.ok(!/const defaultDoctors/.test(code), "четыре выдуманных имени были всем справочником врачей продукта");
  assert.ok(
    !/readString\(record\.doctorName\) \|\| "д-р Сауле"/.test(code),
    "запись без врача рисовалась именем, которого нет в базе",
  );
  // Отказ графика печатает интервалы сервера как есть.
  assert.ok(code.includes("describeSchedule"), "у отказа графика свой текст");
  assert.ok(!/describeSchedule[\s\S]{0,400}timeKeyFromStartsAt/.test(code), "интервалы не пересчитываются в поясе устройства");
});

test("DS30 редактор графика называет вещи своими именами", async () => {
  const editor = await readFile(editorPath, "utf8");
  // «Заполнен только понедельник» молча значит «отказ во вторник–воскресенье»,
  // а пустой график — «правила нет». Ни то ни другое не очевидно.
  assert.ok(editor.includes("В остальные дни запись будет предупреждать"));
  assert.ok(editor.includes("График не задан"));
  assert.ok(editor.includes("следующий день"), "ночная смена объясняется словами");
});

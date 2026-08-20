import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Прайс принадлежит мастеру, а график умеет закрытые окна.
//
// Владелец салона: «Услуги мастера по отдельности… Дильназ чисто чтобы у неё
// были её услуги» — и следом список на 129 услуг, где одно и то же стоит
// по-разному: глубокое бикини у Айданы 5 000, у Аружан 6 000; ламинирование
// бровей у Айданы 6 000, у Амины 10 000. Общий прайс на клинику здесь не
// упрощение, а неправда в чеке клиента.
//
// Вторая половина — «если мастер отдыхает, закрыть окно или целый день».
// Целый день график умел с 033; окно внутри дня запрещал CHECK, и обед
// приходилось изображать разрывом смены.
//
// Ничто здесь не ходит в production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const STAFF = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AIDANA = "d1111111-1111-4111-8111-111111111111";
const ARUZHAN = "d2222222-2222-4222-8222-222222222222";
const FOREIGN_DOCTOR = "d3333333-3333-4333-8333-333333333333";
const SVC_AIDANA = "50000000-0000-4000-8000-000000000001";
const SVC_ARUZHAN = "50000000-0000-4000-8000-000000000002";
const SVC_COMMON = "50000000-0000-4000-8000-000000000003";
const TOKEN = "header.payload.signature";

type Query = { table: string; op: string; filters: Record<string, unknown>; row?: Record<string, unknown> };

function spyClient(rows: Record<string, unknown[]>, log: Query[]) {
  return {
    from(table: string) {
      const entry: Query = { table, op: "select", filters: {} };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const eqs: Array<[string, unknown]> = [];
      let orFilter = "";
      let isNullColumn = "";

      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) => {
          if (!eqs.every(([column, value]) => row[column] === value)) return false;
          if (isNullColumn && row[isNullColumn] != null) return false;
          if (!orFilter) return true;
          // or=(doctor_id.eq.X,doctor_id.is.null) — ровно та форма, которую
          // строит сервер; двойник разбирает её, а не игнорирует.
          return orFilter.split(",").some((part) => {
            const [column, op, value] = part.split(".");
            if (op === "is" && value === "null") return row[column] == null;
            if (op === "eq") return row[column] === value;
            return false;
          });
        });

      Object.assign(builder, {
        select: () => chain(),
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        in: () => chain(),
        gte: () => chain(),
        lte: () => chain(),
        lt: () => chain(),
        or(filter: string) { orFilter = filter; entry.filters.__or = filter; return chain(); },
        is(column: string, value: unknown) { if (value === null) { isNullColumn = column; entry.filters[`${column}__is`] = "null"; } return chain(); },
        insert: (row: unknown) => { entry.op = "insert"; entry.row = row as Record<string, unknown>; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.row = row as Record<string, unknown>; return chain(); },
        upsert: (row: unknown) => { entry.op = "insert"; entry.row = row as Record<string, unknown>; return chain(); },
        eq(column: string, value: unknown) { eqs.push([column, value]); entry.filters[column] = value; return chain(); },
        ilike(column: string, value: string) { eqs.push([column, value]); return chain(); },
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (entry.op === "select") { resolve({ data: matching(), error: null }); return; }
          resolve({ data: { id: SVC_AIDANA, ...(entry.row ?? {}) }, error: null });
        },
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

async function callRouter(options: {
  role?: string;
  method?: string;
  resource?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  shifts?: Array<Record<string, unknown>>;
  staffDoctorId?: string;
}) {
  const log: Query[] = [];
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const rows: Record<string, unknown[]> = {
    staff_users: [{ id: STAFF, auth_user_id: USER, workspace_id: WORKSPACE, role: options.role ?? "owner", status: "active", full_name: "Айдана" }],
    clinic_doctors: [
      { id: AIDANA, workspace_id: WORKSPACE, full_name: "Айдана", staff_user_id: options.staffDoctorId === AIDANA ? STAFF : null, is_active: true, capacity: 1 },
      { id: ARUZHAN, workspace_id: WORKSPACE, full_name: "Аружан", staff_user_id: null, is_active: true, capacity: 1 },
    ],
    clinic_services: [
      { id: SVC_AIDANA, workspace_id: WORKSPACE, doctor_id: AIDANA, name: "Шугаринг глубокое бикини", base_price_minor: 5000, duration_minutes: null, is_active: true, sort_order: 1 },
      { id: SVC_ARUZHAN, workspace_id: WORKSPACE, doctor_id: ARUZHAN, name: "Шугаринг глубокое бикини", base_price_minor: 6000, duration_minutes: null, is_active: true, sort_order: 1 },
      { id: SVC_COMMON, workspace_id: WORKSPACE, doctor_id: null, name: "Консультация", base_price_minor: 0, duration_minutes: 20, is_active: true, sort_order: 0 },
    ],
    clinic_doctor_shifts: options.shifts ?? [],
    workspace_settings: [{ workspace_id: WORKSPACE, key: "clinic_schedule", value: { timeZone: "Asia/Almaty" } }],
    appointments: [],
    audit_logs: [],
  };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => spyClient(rows, log));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const res = mockResponse();
  await routerModule.default(
    {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
      query: { path: [options.resource ?? "clinic-services"], workspaceId: WORKSPACE, ...(options.query ?? {}) },
      body: options.body,
    },
    res,
  );
  return { res, log };
}

const listed = (res: MockResponse) =>
  ((res.body.data as Record<string, unknown>).services as Array<Record<string, unknown>>) ?? [];

test("MP1 у услуги есть хозяин, и он доезжает до экрана", async () => {
  const { res } = await callRouter({});
  const mine = listed(res).find((s) => s.id === SVC_AIDANA);
  assert.equal(mine?.doctorId, AIDANA, JSON.stringify(res.body));
});

test("MP2 одна услуга у двух мастеров стоит по-разному — и обе цены сохранены", async () => {
  const { res } = await callRouter({});
  const prices = listed(res)
    .filter((s) => s.name === "Шугаринг глубокое бикини")
    .map((s) => s.basePriceMinor)
    .sort();
  assert.deepEqual(prices, [5000, 6000], JSON.stringify(res.body));
});

test("MP3 прайс мастера — это его услуги плюс общие клиники", async () => {
  const { res } = await callRouter({ query: { doctorId: AIDANA } });
  const ids = listed(res).map((s) => s.id).sort();
  assert.deepEqual(ids, [SVC_AIDANA, SVC_COMMON].sort(), JSON.stringify(res.body));
});

test("MP4 мусор вместо идентификатора мастера отвергается до базы", async () => {
  const { res, log } = await callRouter({ query: { doctorId: "не-uuid" } });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "clinic_services").length, 0);
});

test("MP5 услугу нельзя завести на карточку другой клиники", async () => {
  const { res, log } = await callRouter({
    method: "POST",
    body: { name: "Наращивание ресниц 2D", basePriceMinor: 7000, doctorId: FOREIGN_DOCTOR },
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "clinic_services" && q.op === "insert").length, 0);
});

test("MP6 услуга заводится на мастера, цена и длительность правятся", async () => {
  const created = await callRouter({
    method: "POST",
    body: { name: "Наращивание ресниц 2D", basePriceMinor: 7000, durationMinutes: 120, doctorId: AIDANA },
  });
  assert.equal(created.res.statusCode, 201, JSON.stringify(created.res.body));
  const insert = created.log.find((q) => q.table === "clinic_services" && q.op === "insert");
  assert.equal(insert?.row?.doctor_id, AIDANA);
  assert.equal(insert?.row?.base_price_minor, 7000);
  assert.equal(insert?.row?.duration_minutes, 120);

  const patched = await callRouter({
    method: "PATCH",
    body: { id: SVC_AIDANA, updates: { basePriceMinor: 5500, durationMinutes: 90 } },
  });
  assert.equal(patched.res.statusCode, 200, JSON.stringify(patched.res.body));
  const update = patched.log.find((q) => q.table === "clinic_services" && q.op === "update");
  assert.equal(update?.row?.base_price_minor, 5500);
  assert.equal(update?.row?.duration_minutes, 90);
});

test("MP7 услугу можно вернуть в общий прайс клиники", async () => {
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: SVC_AIDANA, updates: { doctorId: "" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = log.find((q) => q.table === "clinic_services" && q.op === "update");
  assert.equal(update?.row?.doctor_id, null, "пустая строка снимает хозяина");
});

test("MP8 мастер видит свой прайс и общие услуги, но не цену коллеги", async () => {
  const { res } = await callRouter({ role: "doctor", staffDoctorId: AIDANA });
  const ids = listed(res).map((s) => s.id).sort();
  assert.deepEqual(ids, [SVC_AIDANA, SVC_COMMON].sort(), JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes("6000"), "цена коллеги в ответе");
});

test("MP9 мастер не может подсмотреть чужой прайс параметром запроса", async () => {
  const { res } = await callRouter({ role: "doctor", staffDoctorId: AIDANA, query: { doctorId: ARUZHAN } });
  const ids = listed(res).map((s) => s.id);
  assert.ok(!ids.includes(SVC_ARUZHAN), `чужой прайс отдан: ${JSON.stringify(res.body)}`);
});

/* ── Закрытые окна в графике ── */

const workingDay = (over: Record<string, unknown> = {}) => ({
  workspace_id: WORKSPACE, doctor_id: AIDANA, weekday: 4, on_date: null, on_date_end: null,
  is_working: true, start_minute: 9 * 60, end_minute: 21 * 60, ...over,
});
/** Четверг, 20 августа 2026 года, время Алматы. */
const at = (hour: number) => `2026-08-20T${String(hour - 5).padStart(2, "0")}:00:00.000Z`;

const book = (hour: number, shifts: Array<Record<string, unknown>>) => callRouter({
  method: "POST",
  resource: "appointments",
  shifts,
  body: { client: "Клиент", doctorId: AIDANA, doctor: "Айдана", startsAt: at(hour) },
});

test("MP10 закрытое окно внутри дня не пускает запись", async () => {
  const { res } = await book(15, [
    workingDay(),
    workingDay({ is_working: false, start_minute: 14 * 60, end_minute: 16 * 60, note: "уехала" }),
  ]);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "outside_doctor_schedule");
});

test("MP11 за пределами окна тот же день работает", async () => {
  const { res } = await book(17, [
    workingDay(),
    workingDay({ is_working: false, start_minute: 14 * 60, end_minute: 16 * 60 }),
  ]);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test("MP12 окно режет смену, а не отменяет её — до окна тоже принимаем", async () => {
  const { res } = await book(11, [
    workingDay(),
    workingDay({ is_working: false, start_minute: 14 * 60, end_minute: 16 * 60 }),
  ]);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test("MP13 целый день закрыт — по-прежнему выходной, а не «окно с 0 до 0»", async () => {
  const { res } = await book(11, [
    workingDay(),
    workingDay({ is_working: false, start_minute: null, end_minute: null }),
  ]);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.deepEqual((res.body.schedule as Record<string, unknown>).intervals, [], "у выходного часов приёма нет");
});

test("MP14 отказ показывает часы приёма уже без закрытого окна", async () => {
  const { res } = await book(15, [
    workingDay(),
    workingDay({ is_working: false, start_minute: 14 * 60, end_minute: 16 * 60 }),
  ]);
  const intervals = (res.body.schedule as Record<string, unknown>).intervals as string[];
  assert.deepEqual(intervals, ["09:00–14:00", "16:00–21:00"], JSON.stringify(intervals));
});

test("MP15 сервер принимает закрытое окно как строку графика", async () => {
  const { res, log } = await callRouter({
    method: "POST",
    resource: "doctor-schedule",
    body: { doctorId: AIDANA, onDate: "2026-08-21", isWorking: false, startMinute: 840, endMinute: 960, note: "обед" },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const insert = log.find((q) => q.table === "clinic_doctor_shifts" && q.op === "insert");
  assert.equal(insert?.row?.is_working, false);
  assert.equal(insert?.row?.start_minute, 840);
});

test("MP16 бессмысленное окно отвергается так же, как бессмысленная смена", async () => {
  const { res } = await callRouter({
    method: "POST",
    resource: "doctor-schedule",
    body: { doctorId: AIDANA, onDate: "2026-08-21", isWorking: false, startMinute: 960, endMinute: 840 },
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("MP17 миграция 040 заводит хозяина услуги и разрешает часы у нерабочей строки", async () => {
  const sql = await readFile(
    path.join(repoRoot, "migrations", "040_services_per_master_and_schedule_windows.sql"),
    "utf8",
  );
  assert.ok(/add column if not exists doctor_id uuid references public\.clinic_doctors\(id\)/.test(sql));
  assert.ok(/drop index if exists public\.clinic_services_workspace_active_name_idx/.test(sql), "старая уникальность имени снята");
  assert.ok(/clinic_services_workspace_owner_name_idx/.test(sql), "и заменена уникальностью внутри прайса мастера");
  assert.ok(/coalesce\(doctor_id, '00000000-0000-0000-0000-000000000000'::uuid\)/.test(sql), "две общие услуги с одним именем по-прежнему невозможны");
  assert.ok(/drop constraint if exists clinic_doctor_shifts_minutes/.test(sql));
  // Снять старый CHECK и не поставить новый — это база без единой проверки часов.
  assert.ok(/add constraint clinic_doctor_shifts_minutes check/.test(sql), "новый CHECK добавлен");
  assert.ok(/create unique index if not exists clinic_services_workspace_owner_name_idx/.test(sql));
  assert.ok(/create index if not exists clinic_services_workspace_doctor_idx/.test(sql));
  assert.ok(sql.includes("begin;") && sql.includes("commit;"));
});

test("MP18 скрипт заливки прайса не отдаёт услуги наугад при двух одинаковых именах", async () => {
  // Двух Дильназ различает только специальность. Совпадение по имени дало бы
  // найл-услуги визажисту — поэтому такие строки скрипт пропускает и говорит
  // об этом вслух.
  const sql = await readFile(path.join(repoRoot, "migrations", "data", "salon-prices-2026-08-20.sql"), "utf8");
  assert.ok(/select count\(\*\) from public\.clinic_doctors d2[\s\S]*?\) = 1;/.test(sql), "заливка идёт только при единственной живой карточке");
  assert.ok(/and d2\.is_active/.test(sql), "архивная карточка не считается вторым мастером");
  assert.ok(/price_tenge::bigint \* 100/.test(sql), "тенге переводятся в тиыны — иначе прайс в сто раз дешевле");
  assert.ok(/base_price_minor\) \/ 100 as "от, ₸"/.test(sql), "и отчёт печатает тенге, а не тиыны");
  assert.ok(/ДВЕ карточки с этим именем/.test(sql), "и владелец узнаёт, кого пропустили");
  assert.ok(!/duration_minutes/.test(sql), "длительность не выдумывается");
  assert.ok(/on conflict do nothing/.test(sql), "повторный запуск не плодит дублей");
});

/* ── Окна на дату: то, из-за чего «закрыть окно» закрывало весь день ── */

test("MP19 окно на дату вырезается из недельной смены, а не отменяет её", async () => {
  // Кнопка «Закрыть окно» шлёт ОДНУ строку на дату. Пока исключение на дату
  // замещало недельный образец целиком, эта строка закрывала мастеру день:
  // рабочих часов на дату не было ни одной.
  const { res } = await book(11, [
    workingDay(),
    { workspace_id: WORKSPACE, doctor_id: AIDANA, weekday: null, on_date: "2026-08-20", on_date_end: "2026-08-20", is_working: false, start_minute: 14 * 60, end_minute: 16 * 60 },
  ]);
  assert.equal(res.statusCode, 201, `день закрыт целиком: ${JSON.stringify(res.body)}`);
});

test("MP20 то же окно на дату всё-таки закрывает свои часы", async () => {
  const { res } = await book(15, [
    workingDay(),
    { workspace_id: WORKSPACE, doctor_id: AIDANA, weekday: null, on_date: "2026-08-20", on_date_end: "2026-08-20", is_working: false, start_minute: 14 * 60, end_minute: 16 * 60 },
  ]);
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  const intervals = (res.body.schedule as Record<string, unknown>).intervals as string[];
  assert.deepEqual(intervals, ["09:00–14:00", "16:00–21:00"], "часы приёма показаны без окна");
});

test("MP21 особые часы на дату по-прежнему замещают недельный образец", async () => {
  // Окно вычитается, а рабочее исключение — замещает. Если перепутать, «в эту
  // субботу с 10 до 15» перестанет что-либо значить.
  const { res } = await book(9, [
    workingDay(),
    { workspace_id: WORKSPACE, doctor_id: AIDANA, weekday: null, on_date: "2026-08-20", on_date_end: "2026-08-20", is_working: true, start_minute: 10 * 60, end_minute: 15 * 60 },
  ]);
  assert.equal(res.statusCode, 409, `особые часы не применились: ${JSON.stringify(res.body)}`);
});

test("MP22 услугу чужого мастера нельзя привязать к записи", async () => {
  // Та же услуга у Аружан стоит 6 000 вместо 5 000 — и уехала бы в чек клиента.
  const { res, log } = await callRouter({
    method: "POST",
    resource: "appointments",
    body: { client: "Клиент", doctorId: AIDANA, doctor: "Айдана", startsAt: at(11), serviceId: SVC_ARUZHAN },
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "insert").length, 0);
});

test("MP23 общая услуга клиники подходит любому мастеру", async () => {
  const { res } = await callRouter({
    method: "POST",
    resource: "appointments",
    body: { client: "Клиент", doctorId: AIDANA, doctor: "Айдана", startsAt: at(11), serviceId: SVC_COMMON },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test("MP24 doctorId не строкой — отказ, а не тихое снятие хозяина", async () => {
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: SVC_AIDANA, updates: { doctorId: 42 } },
  });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "clinic_services" && q.op === "update").length, 0);
});

test("MP25 мастер без карточки справочника видит только общие услуги", async () => {
  // Сотрудник заведён, карточки в справочнике ещё нет. Прайса у него нет —
  // но и чужого он не получает.
  const { res } = await callRouter({ role: "doctor" });
  const ids = listed(res).map((s) => s.id);
  assert.deepEqual(ids, [SVC_COMMON], `отдан чужой прайс: ${JSON.stringify(res.body)}`);
});

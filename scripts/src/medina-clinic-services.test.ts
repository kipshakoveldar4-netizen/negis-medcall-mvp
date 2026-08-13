import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CS — справочник услуг клиники.
//
// «Услуга» жила в этом продукте несколькими несвязанными свободными строками:
// её набирали руками на каждой записи, поэтому «Ботокс», «ботокс» и «Ботокс
// лба» были тремя разными услугами в любом подсчёте; прайса, который клиника
// могла бы править, не было вовсе; а выручку по услуге нельзя было вычислить —
// сумма продажи висела на свободном заголовке.
//
// Что здесь закрепляется:
//
//   * право читать и право править разные. Форма записи без прайса
//     бесполезна, поэтому читают все, кто записывает; правит тот, кто отвечает
//     за цены. Ни один другой набор этого разделения не проверяет;
//   * NULL и 0 у цены — разные факты. «Цена не указана» и «бесплатно» обязаны
//     доходить до базы каждый своим значением;
//   * дубль названия — четырёхсотка с человеческим текстом, а отказ базы по
//     любой другой причине остаётся сбоем. Обе половины, иначе ветка слишком
//     широка и наборы про честность отказов перестают что-либо значить;
//   * отсутствие таблицы до применения 032 — это «справочник не включён», а не
//     «услуг нет» и не «не удалось загрузить»;
//   * связь записи с услугой требует активной услуги при СОЗДАНИИ и не требует
//     при правке: карточка продажи шлёт объект целиком на каждом сохранении.
//
// Ничего здесь не обращается к production: клиент базы — заглушка.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const journalPath = path.join(repoRoot, "lib", "crm", "change-journal.ts");
const authorizationPath = path.join(repoRoot, "lib", "crm", "authorization.ts");
const migrationPath = path.join(repoRoot, "migrations", "032_clinic_services_directory.sql");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SERVICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HIDDEN_SERVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_SERVICE_ID = "99999999-9999-4999-8999-999999999999";
const APPOINTMENT_ID = "abababab-abab-4bab-8bab-abababababab";
const TOKEN = "header.payload.signature";

type QueryLog = { table: string; op: string; filters: Record<string, unknown> };
type Filter = { column: string; op: "eq"; value: unknown };
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
          .filter((row) => applied.every((filter) => row[filter.column] === filter.value));

      const missingInRow = (row: unknown) =>
        Object.keys(row && typeof row === "object" ? (row as Record<string, unknown>) : {})
          .find((column) => missingColumns.has(column));

      const failure = () => injected.find((item) => item.table === table && item.op === entry.op) ?? null;

      const settle = (resolve: (value: { data: unknown; error: unknown }) => void) => {
        const missing = entry.filters.__missing;
        if (typeof missing === "string") {
          resolve({ data: null, error: { message: `column ${table}.${missing} does not exist`, code: "42703" } });
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
              ? { id: SERVICE_ID, ...(written as Record<string, unknown>) }
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
        insert: (row: unknown) => {
          entry.op = "insert";
          entry.filters.__row = row;
          entry.filters.__missing = missingInRow(row);
          return chain();
        },
        update: (row: unknown) => {
          entry.op = "update";
          entry.filters.__row = row;
          entry.filters.__missing = missingInRow(row);
          return chain();
        },
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
        lt(column: string, value: unknown) { entry.filters[`${column}__lt`] = value; return chain(); },
        gte(column: string, value: unknown) { entry.filters[`${column}__gte`] = value; return chain(); },
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
      {
        id: STAFF_A,
        auth_user_id: USER_A,
        workspace_id: WORKSPACE_A,
        role: options.role ?? "owner",
        status: "active",
        full_name: "Айгерим",
      },
    ],
    ...(options.rows ?? {}),
  };

  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    spyClient(clientRows, log, options.injected ?? [], new Set(options.missingColumns ?? [])));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: {
    resource?: string;
    method?: string;
    body?: unknown;
    query?: Record<string, unknown>;
  }) => {
    log.length = 0;
    warnings.length = 0;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    const res = mockResponse();
    try {
      await routerModule.default(
        {
          method: input.method ?? "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          query: {
            path: [input.resource ?? "clinic-services"],
            workspaceId: WORKSPACE_A,
            ...(input.query ?? {}),
          },
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

const activeService = {
  id: SERVICE_ID,
  workspace_id: WORKSPACE_A,
  name: "Консультация",
  duration_minutes: 45,
  is_active: true,
};

const hiddenService = {
  id: HIDDEN_SERVICE_ID,
  workspace_id: WORKSPACE_A,
  name: "Старая процедура",
  duration_minutes: null,
  is_active: false,
};

/* ── Права ── */

test("CS1 список услуг читается в пределах проверенного рабочего пространства", async () => {
  const call = await loadRouter({
    role: "receptionist",
    rows: { clinic_services: [activeService] },
  });
  const { res, log } = await call({ method: "GET" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const read = log.find((entry) => entry.table === "clinic_services");
  assert.equal(read?.filters.workspace_id, WORKSPACE_A, "чтение обязано быть сужено рабочим пространством");
});

test("CS2 регистратор правит прайс, врач и маркетолог — нет", async () => {
  // Политика изменена сознательно: прайс и справочники правит тот, кто ведёт
  // запись каждый день, — в салоне это администратор, в клинике старший
  // регистратор. Право отдельное (manage_directory), а не view_admin: право на
  // прайс не должно тянуть за собой ключи интеграций и список сотрудников.
  const reception = await loadRouter({ role: "receptionist" });
  const allowed = await reception({ method: "POST", body: { name: "Новая услуга" } });
  assert.equal(allowed.res.statusCode, 201, JSON.stringify(allowed.res.body));

  const owner = await loadRouter();
  const ownerToo = await owner({ method: "POST", body: { name: "Новая услуга" } });
  assert.equal(ownerToo.res.statusCode, 201, JSON.stringify(ownerToo.res.body));

  // А у ролей, которые записью не занимаются, права нет по-прежнему.
  const marketer = await loadRouter({ role: "marketer" });
  const refused = await marketer({ method: "POST", body: { name: "Новая услуга" } });
  assert.equal(refused.res.statusCode, 403, JSON.stringify(refused.res.body));
});

test("CS3 врач не правит прайс, администратор клиники правит", async () => {
  const doctor = await loadRouter({ role: "doctor", rows: { clinic_services: [activeService] } });
  const refused = await doctor({ method: "PATCH", body: { id: SERVICE_ID, updates: { name: "Другое" } } });
  assert.equal(refused.res.statusCode, 403, JSON.stringify(refused.res.body));

  const manager = await loadRouter({ role: "manager", rows: { clinic_services: [activeService] } });
  const allowed = await manager({ method: "PATCH", body: { id: SERVICE_ID, updates: { name: "Другое" } } });
  assert.equal(allowed.res.statusCode, 200, JSON.stringify(allowed.res.body));
});

/* ── Запись ── */

test("CS4 правка услуги действительно доходит до базы", async () => {
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });

  // Пустой патч не пишет ничего — и не должен: иначе updated_at двигался бы
  // на каждом открытии карточки.
  const untouched = await call({ method: "PATCH", body: { id: SERVICE_ID, updates: {} } });
  assert.equal(untouched.res.statusCode, 200, JSON.stringify(untouched.res.body));
  assert.equal(writtenTo(untouched.log, "clinic_services"), null, "пустой патч не должен писать");

  // А непустой обязан. Без блока в buildPatchRow ресурс отвечал бы 200 и
  // молча ничего не менял — самый дорогой вид тишины.
  const changed = await call({ method: "PATCH", body: { id: SERVICE_ID, updates: { name: "Первичная консультация" } } });
  assert.equal(changed.res.statusCode, 200, JSON.stringify(changed.res.body));
  const row = writtenTo(changed.log, "clinic_services");
  assert.equal(row?.name, "Первичная консультация");
  assert.ok(row?.updated_at, "правка обязана двигать updated_at");
});

test("CS5 пустое название и невозможная длительность отвергаются на обоих путях", async () => {
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });

  const noName = await call({ method: "POST", body: { name: "   " } });
  assert.equal(noName.res.statusCode, 400, JSON.stringify(noName.res.body));
  assert.ok(
    (noName.res.body.details as string[] | undefined)?.includes("name is required"),
    "оператор должен узнать, какое поле не так",
  );

  const longCreate = await call({ method: "POST", body: { name: "Марафон", durationMinutes: 900 } });
  assert.equal(longCreate.res.statusCode, 400, JSON.stringify(longCreate.res.body));

  // Правка обязана отвергать то же самое. Молчаливая 200 здесь означала бы
  // длительность, которая шире окна поиска пересечений, — и проверка занятости
  // слота начала бы пропускать наложения.
  const longPatch = await call({ method: "PATCH", body: { id: SERVICE_ID, updates: { durationMinutes: 900 } } });
  assert.equal(longPatch.res.statusCode, 400, JSON.stringify(longPatch.res.body));
});

test("CS6 «бесплатно» и «цена не указана» доходят до базы разными значениями", async () => {
  const call = await loadRouter();

  const free = await call({ method: "POST", body: { name: "Первичная консультация", basePriceMinor: 0 } });
  assert.equal(free.res.statusCode, 201, JSON.stringify(free.res.body));
  assert.equal(writtenTo(free.log, "clinic_services")?.base_price_minor, 0, "ноль — это цена, а не отсутствие цены");

  const unpriced = await call({ method: "POST", body: { name: "Комплекс" } });
  assert.equal(unpriced.res.statusCode, 201, JSON.stringify(unpriced.res.body));
  assert.equal(
    writtenTo(unpriced.log, "clinic_services")?.base_price_minor,
    null,
    "неуказанная цена не имеет права превратиться в 0 ₸ на экране",
  );
});

/* ── Отказы ── */

test("CS7 дубль названия — четырёхсотка, отказ прав — по-прежнему сбой", async () => {
  const duplicate = await loadRouter({
    injected: [{ table: "clinic_services", op: "insert", code: "23505", message: "duplicate key value violates unique constraint" }],
  });
  const conflict = await duplicate({ method: "POST", body: { name: "Консультация" } });
  assert.equal(conflict.res.statusCode, 400, JSON.stringify(conflict.res.body));
  const text = JSON.stringify(conflict.res.body);
  assert.ok(text.includes("Услуга с таким названием уже есть"));
  assert.ok(!text.includes("constraint"), "текста Postgres в ответе быть не должно");
  assert.ok(!text.includes("23505"));

  const denied = await loadRouter({
    injected: [{ table: "clinic_services", op: "insert", code: "42501", message: "permission denied for table clinic_services" }],
  });
  const failed = await denied({ method: "POST", body: { name: "Консультация" } });
  assert.equal(failed.res.statusCode, 502, "ветка обязана быть узкой по коду, иначе любой отказ станет 400");
  assert.ok(!JSON.stringify(failed.res.body).includes("permission denied"), "текст Postgres наружу не идёт");
});

test("CS8 «справочник не включён» отличается от «не удалось прочитать»", async () => {
  const notMigrated = await loadRouter({
    injected: [{ table: "clinic_services", op: "select", code: "PGRST205", message: "Could not find the table in the schema cache" }],
  });
  const unavailable = await notMigrated({ method: "GET" });
  assert.equal(unavailable.res.statusCode, 200, JSON.stringify(unavailable.res.body));
  const data = unavailable.res.body.data as Record<string, unknown>;
  assert.equal(data.catalogAvailable, false, "экран обязан отличить «ещё не включён» от «услуг нет»");
  assert.deepEqual(data.services, []);

  const broken = await loadRouter({
    injected: [{ table: "clinic_services", op: "select", code: "42501", message: "permission denied for table clinic_services" }],
  });
  const failure = await broken({ method: "GET" });
  assert.equal(failure.res.statusCode, 502, "отозванный грант — это сбой, а не пустой справочник");
});

/* ── Связь записи и продажи с услугой ── */

test("CS9 услуга чужой клиники не становится связью", async () => {
  // Чужая строка обязана существовать в заглушке. Без неё отказ приходил бы из
  // «такой строки нет», и проверка на принадлежность клинике не выполнялась бы
  // вовсе — тест был бы зелёным, ничего не проверив.
  const call = await loadRouter({
    rows: {
      clinic_services: [
        activeService,
        { id: FOREIGN_SERVICE_ID, workspace_id: WORKSPACE_B, name: "Чужая услуга", duration_minutes: 30, is_active: true },
      ],
      appointments: [],
    },
  });
  const { res, log } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: FOREIGN_SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(writtenTo(log, "appointments"), null, "чужой идентификатор не имеет права дойти до записи");
});

test("CS10 скрытая услуга не попадает в новую запись, но правку прошлой не ломает", async () => {
  const create = await loadRouter({ rows: { clinic_services: [activeService, hiddenService] } });
  const refused = await create({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: HIDDEN_SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });
  assert.equal(refused.res.statusCode, 400, "иначе «Скрыть» не значит ничего");

  const patch = await loadRouter({
    rows: {
      clinic_services: [activeService, hiddenService],
      appointments: [{ id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, client_name: "Пациент", service: "Старая процедура" }],
    },
  });
  const allowed = await patch({
    resource: "appointments",
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { serviceId: HIDDEN_SERVICE_ID, notes: "перенос" } },
  });
  assert.equal(allowed.res.statusCode, 200, JSON.stringify(allowed.res.body));
  assert.equal(
    writtenTo(allowed.log, "appointments")?.service_id,
    HIDDEN_SERVICE_ID,
    "карточка шлёт объект целиком: отказ на правке был бы четырёхсоткой без причины",
  );
});

test("CS11 длительность берётся из услуги, но введённая руками её перебивает", async () => {
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });

  const fromCatalog = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });
  assert.equal(fromCatalog.res.statusCode, 201, JSON.stringify(fromCatalog.res.body));
  assert.equal(writtenTo(fromCatalog.log, "appointments")?.duration_minutes, 45);

  const explicit = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: SERVICE_ID, durationMinutes: 90, startsAt: "2026-09-01T11:00:00.000Z" },
  });
  assert.equal(explicit.res.statusCode, 201, JSON.stringify(explicit.res.body));
  assert.equal(writtenTo(explicit.log, "appointments")?.duration_minutes, 90, "тело всегда сильнее каталога");
});

test("CS12 запись создаётся и до применения миграции, теряя только связь", async () => {
  const call = await loadRouter({
    rows: { clinic_services: [activeService] },
    missingColumns: ["service_id"],
  });
  const { res, log, warnings: warned } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const rows = log.filter((entry) => entry.table === "appointments" && entry.op === "insert");
  assert.equal(rows.length, 2, "первая попытка отвергается, вторая идёт без колонки");
  assert.equal((rows[1].filters.__row as Record<string, unknown>).service_id, undefined);
  assert.ok(
    warned.some((line) => line.includes("032") && line.includes("service_id")),
    "оператор обязан узнать из лога, какой миграции не хватает и что именно потеряно",
  );
});

/* ── Журнал ── */

test("CS13 правка услуги попадает в журнал изменений", async () => {
  const call = await loadRouter({
    rows: { clinic_services: [{ ...activeService, name: "Консультация" }] },
  });
  const { res, log } = await call({
    method: "PATCH",
    body: { id: SERVICE_ID, updates: { name: "Первичная консультация" } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const journal = log.find((entry) => entry.table === "audit_logs" && entry.op === "insert");
  assert.ok(journal, "справочник цен без истории — это «кто поднял цену» без ответа");
  assert.equal((journal?.filters.__row as Record<string, unknown>).entity_type, "service");
});

test("CS18 связь возвращается наружу, а не только записывается", async () => {
  // Браузер отправляет объект целиком на каждом сохранении. Колонка, которую
  // он не может прочитать, приходит назад пустой строкой — и следующая правка
  // затирает связь в null. Проверялась только запись, поэтому дефект и дожил.
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });

  const created = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });
  assert.equal(created.res.statusCode, 201, JSON.stringify(created.res.body));
  const item = (created.res.body.data as Record<string, Record<string, unknown>>).item;
  assert.equal(item.serviceId, SERVICE_ID, "запись обязана вернуть связь, иначе браузеру нечего эхом отправить назад");

  const deal = await call({
    resource: "deals",
    method: "POST",
    body: { title: "Ботокс", amountMinor: 1000, serviceId: SERVICE_ID },
  });
  assert.equal(deal.res.statusCode, 201, JSON.stringify(deal.res.body));
  assert.equal((deal.res.body.data as Record<string, Record<string, unknown>>).item.serviceId, SERVICE_ID);
});

test("CS19 продажа связывается с услугой и на правке, а не только при создании", async () => {
  const call = await loadRouter({
    rows: {
      clinic_services: [activeService],
      deals: [{ id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, title: "Ботокс", amount_minor: 1000 }],
    },
  });
  const { res, log } = await call({
    resource: "deals",
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { serviceId: SERVICE_ID } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(
    writtenTo(log, "deals")?.service_id,
    SERVICE_ID,
    "иначе выбор услуги в карточке продажи отвечает «обновлено» и не делает ничего",
  );
});

test("CS20 запись создаётся и когда отсутствие колонки приходит из кэша схемы", async () => {
  // PostgREST отвергает запись в неизвестную колонку кодом PGRST204, не доходя
  // до Postgres. Откат, знающий только 42703, не сработал бы ни разу на hosted
  // Supabase — и всё окно между деплоем и миграцией запись не создавалась бы.
  const call = await loadRouter({
    rows: { clinic_services: [activeService] },
    injected: [{
      table: "appointments",
      op: "insert",
      code: "PGRST204",
      message: "Could not find the 'service_id' column of 'appointments' in the schema cache",
    }],
  });
  const { res, warnings: warned } = await call({
    resource: "appointments",
    method: "POST",
    body: { client: "Пациент", serviceId: SERVICE_ID, startsAt: "2026-09-01T09:00:00.000Z" },
  });

  // Заглушка отвечает отказом на каждую вставку, поэтому вторая попытка тоже
  // не пройдёт; проверяется, что она вообще СОСТОЯЛАСЬ — то есть код распознал
  // форму ошибки и пошёл на откат, а не сразу в пятьсот вторую.
  assert.ok(
    warned.some((line) => line.includes("032") && line.includes("service_id")),
    `откат обязан сработать на PGRST204, а не только на 42703: ${JSON.stringify(warned)}`,
  );
  assert.equal(res.statusCode, 502, "после второй неудачи ответ остаётся честным отказом");
});

test("CS21 «Скрыть услугу» действительно скрывает", async () => {
  // Единственная форма удаления, которая есть у платформы. Без этой проверки
  // можно было удалить строку setBoolean и остаться зелёным: экран сказал бы
  // «Услуга скрыта», а услуга продолжила бы предлагаться в форме записи.
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });
  const { res, log } = await call({ method: "PATCH", body: { id: SERVICE_ID, isActive: false } });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writtenTo(log, "clinic_services")?.is_active, false);
});

test("CS22 нечисло в цене, длительности и порядке отвергается, а не превращается в «не задано»", async () => {
  const call = await loadRouter({ rows: { clinic_services: [activeService] } });

  for (const body of [
    { name: "Ботокс", basePriceMinor: "15 000 тг" },
    { name: "Ботокс", durationMinutes: "час" },
    { name: "Ботокс", sortOrder: "первый" },
  ]) {
    const { res } = await call({ method: "POST", body });
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`);
  }

  // Правка обязана отвергать то же самое: расхождение POST и PATCH в этом
  // файле уже случалось и жило молча.
  const patched = await call({ method: "PATCH", body: { id: SERVICE_ID, updates: { basePriceMinor: "дорого" } } });
  assert.equal(patched.res.statusCode, 400, JSON.stringify(patched.res.body));
});

test("CS23 неуказанная цена возвращается пустой, а не нулём", async () => {
  // Обратная половина CS6: там проверялось, что уходит в базу, здесь — что
  // приходит обратно. Подмена readNullableNumber на readNumber прошла бы
  // мимо всех остальных проверок, а на экране каждая неоценённая услуга
  // показала бы «0 ₸» — цифру, которой владелец не писал.
  const call = await loadRouter();
  const { res } = await call({ method: "POST", body: { name: "Комплекс" } });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const item = (res.body.data as Record<string, Record<string, unknown>>).item;
  assert.equal(item.basePriceMinor, null);
  assert.equal(item.durationMinutes, null);
});

/* ── Пять реестров, которые компилятор не связывает ── */

test("CS14 ресурс зарегистрирован во всех реестрах сразу", async () => {
  const server = await readFile(serverPath, "utf8");
  const router = await readFile(routerPath, "utf8");
  const authorization = await readFile(authorizationPath, "utf8");
  const journal = await readFile(journalPath, "utf8");

  assert.ok(server.includes('| "clinic-services"'), "тип ресурса");
  assert.ok(server.includes('"clinic-services": {'), "конфигурация ресурса");
  assert.ok(router.includes('"clinic-services",'), "список маршрутов");
  assert.ok(authorization.includes('"clinic-services": {'), "реестр прав");
  // Ресурс, которого нет в этой карте, не журналируется вообще и молча, а
  // задним числом историю не восстановить.
  assert.ok(journal.includes('"clinic-services": "service"'), "карта ресурс → сущность журнала");
});

test("CS15 миграция создаёт ровно то, на что рассчитывает сервер", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const required of [
    "create table if not exists public.clinic_services",
    "clinic_services_workspace_active_name_idx",
    "where is_active",
    "duration_minutes <= 600",
    "alter table public.clinic_services enable row level security",
    "alter table public.appointments enable row level security",
    "alter table public.deals enable row level security",
    "on table public.appointments",
    "on table public.deals",
  ]) {
    assert.ok(sql.includes(required), `миграция обязана содержать: ${required}`);
  }

  // Ветка не переписывает ни одного значения и ничего не сносит.
  for (const forbidden of ["drop column", "drop table", "delete from", "alter column", "update public.appointments", "update public.deals"]) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `миграция не имеет права содержать: ${forbidden}`);
  }
});

test("CS16 комментарии миграции не содержат ключевых слов, которые читает набор цепочки", async () => {
  // Ловушка без другого сторожа: readChain в test:migration-chain применяет свои
  // регулярные выражения к СЫРОМУ тексту и комментарии не вырезает. Прозаическая
  // фраза «create table …» в шапке завела бы в граф таблицу-призрак.
  const sql = await readFile(migrationPath, "utf8");
  const comments = sql
    .split("\n")
    .filter((line) => line.trim().startsWith("--"))
    .join("\n")
    .toLowerCase();

  for (const phrase of ["create table", "alter table", "references "]) {
    assert.ok(!comments.includes(phrase), `фраза «${phrase}» в комментарии ломает разбор цепочки`);
  }
});

test("CS17 журнал знает колонки услуги и не дублирует связь записи", async () => {
  const journal = await readFile(journalPath, "utf8");
  const block = journal.slice(journal.indexOf("const SERVICE_FIELDS"), journal.indexOf("const ENTITY_POLICY"));

  // Ключи — имена колонок базы. Браузерное имя здесь не журналируется вообще
  // и молча: эта ошибка в проекте уже случалась.
  for (const column of ["name", "category", "base_price_minor", "duration_minutes", "is_active", "description"]) {
    assert.ok(block.includes(`${column}:`), `в политике полей услуги нет колонки ${column}`);
  }
  assert.ok(!block.includes("basePriceMinor"), "ключи политики — имена колонок, не полей браузера");

  // Название услуги уже журналируется словами. Добавить рядом uuid значит
  // показать одно событие дважды, причём первой строкой — нечитаемой.
  const appointmentFields = journal.slice(journal.indexOf("const APPOINTMENT_FIELDS"), journal.indexOf("const TASK_FIELDS"));
  assert.ok(!appointmentFields.includes("service_id"), "uuid связи не место в ленте истории");
});

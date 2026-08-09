import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CRM — задача принадлежит чему-то, и её кто-то поставил.
//
// `tasks` живёт с миграции 010 и с тех пор не менялась. Ресурс зарегистрирован,
// права есть, обработчик работает — а функции нет: задачу нельзя связать ни с
// заявкой, ни с пациентом, поэтому вопрос «что делать дальше по этой заявке»
// в продукте не живёт нигде. Плюс три дефекта, копившихся молча:
//
//   * POST терял `deadline`. PATCH принимал его с самого начала, POST — нет,
//     так что задача, созданная со сроком, ложилась в базу с due_at = null.
//     В демо-режиме это невидимо: там ответ собирает makeTask, который deadline
//     читает, — ровно поэтому баг и дожил.
//   * assignee_user_id — настоящий внешний ключ с 010 — не писался ничем.
//     «Мои задачи» были не «не сделаны», а невыразимы: сравнивать было не с чем.
//   * У status и priority нет CHECK, а демо-экран писал в те же колонки русские
//     подписи поверх английских значений по умолчанию. В одном столбце
//     оказались бы оба словаря, и индекс по status считал бы по половине.
//
// Заглушка здесь фильтрует по-настоящему (eq/lt): проверки про сужающие
// фильтры бессмысленны против заглушки, отвечающей всеми строками на любой
// запрос.
//
// Ничего здесь не обращается к production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const migrationPath = path.join(repoRoot, "migrations", "031_tasks_links_and_authorship.sql");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STAFF_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOREIGN_LEAD_ID = "99999999-9999-4999-8999-999999999999";
const TASK_ID = "abababab-abab-4bab-8bab-abababababab";
const TOKEN = "header.payload.signature";

type QueryLog = { table: string; op: string; filters: Record<string, unknown> };
type Filter = { column: string; op: "eq" | "lt"; value: unknown };

function spyClient(
  rows: Record<string, unknown[]>,
  log: QueryLog[],
  missingColumns: Set<string> = new Set(),
) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const applied: Filter[] = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      let single = false;
      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) =>
          applied.every((f) => {
            if (f.op === "eq") return row[f.column] === f.value;
            // NULL < X в Postgres даёт NULL, то есть строка отсеивается.
            // Прежняя заглушка подменяла отсутствующее значение пустой строкой,
            // которая лексикографически меньше любой даты, — и задача без срока
            // считалась просроченной, ровно наоборот продовому поведению.
            const value = row[f.column];
            if (value === null || value === undefined) return false;
            return String(value) < String(f.value ?? "");
          }));

      /** Колонка, которой нет в базе, — это ошибка PostgREST, а не пустой результат. */
      const missingInRow = (row: unknown) =>
        Object.keys(row && typeof row === "object" ? row as Record<string, unknown> : {})
          .find((column) => missingColumns.has(column));

      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; entry.filters.__missing = missingInRow(row); return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; entry.filters.__missing = missingInRow(row); return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => { single = true; return chain(); },
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        eq(column: string, value: unknown) { applied.push({ column, op: "eq", value }); entry.filters[column] = value; return chain(); },
        lt(column: string, value: unknown) { applied.push({ column, op: "lt", value }); entry.filters[`${column}__lt`] = value; return chain(); },
        gte(column: string, value: unknown) { entry.filters[`${column}__gte`] = value; return chain(); },
        in(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        then(resolve: (value: { data: unknown; error: unknown; count?: number }) => void) {
          const missing = entry.filters.__missing;
          if (typeof missing === "string") {
            resolve({ data: null, error: { message: `column tasks.${missing} does not exist`, code: "42703" } });
            return;
          }
          const found = matching();
          // `.single()` отдаёт объект, а не массив: прежняя заглушка возвращала
          // массив всегда, сервер схлопывал его в {}, и ответ каждого write-теста
          // был пустой синтетической задачей — то есть fromRow не проверялся ничем.
          if (single) {
            const written = entry.filters.__row;
            resolve({ data: (written && typeof written === "object" ? { id: TASK_ID, ...written as Record<string, unknown> } : found[0] ?? null), error: null });
            return;
          }
          resolve({ data: found, error: null, count: found.length });
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

async function loadRouter(rows: Record<string, unknown[]> = {}, missingColumns: string[] = []) {
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
      { id: STAFF_A, auth_user_id: USER_A, workspace_id: WORKSPACE_A, role: "owner", status: "active", full_name: "Айгерим" },
    ],
    ...rows,
  };
  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    spyClient(clientRows, log, new Set(missingColumns)));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: { method?: string; body?: unknown; query?: Record<string, unknown> }) => {
    log.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: ["tasks"], workspaceId: WORKSPACE_A, ...(input.query ?? {}) },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log] };
  };
}

const written = (log: QueryLog[]) =>
  (log.find((e) => e.table === "tasks" && (e.op === "insert" || e.op === "update"))?.filters.__row ?? null) as Record<string, unknown> | null;

/* ── Дефекты, которые копились молча ── */

test("TK1 срок, введённый в форме, доходит до базы", async () => {
  // POST читал только due_at/dueAt, а интерфейс шлёт deadline. Задача со
  // сроком ложилась с due_at = null: на экране срок был, в базе его не было.
  const call = await loadRouter();
  const { res, log } = await call({ body: { title: "Перезвонить", deadline: "2026-09-01T14:00:00.000Z" } });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(written(log)?.due_at, "2026-09-01T14:00:00.000Z");
});

test("TK2 POST и PATCH принимают срок одинаково", async () => {
  const call = await loadRouter({ tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, title: "Перезвонить" }] });
  const { res, log } = await call({
    method: "PATCH",
    body: { id: TASK_ID, updates: { deadline: "2026-09-02T09:00:00.000Z" } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(
    written(log)?.due_at,
    "2026-09-02T09:00:00.000Z",
    "один ключ в запросе не может значить разное в зависимости от метода",
  );
});

test("TK3 русские подписи с демо-экрана нормализуются в канонический словарь", async () => {
  const call = await loadRouter();
  for (const [sent, stored] of [["Новые", "new"], ["В работе", "in_progress"], ["Готово", "done"]] as const) {
    const { log } = await call({ body: { title: "Задача", status: sent } });
    assert.equal(written(log)?.status, stored, `«${sent}» должно лечь как ${stored}`);
  }
  for (const [sent, stored] of [["Высокий", "high"], ["Средний", "medium"], ["Низкий", "low"]] as const) {
    const { log } = await call({ body: { title: "Задача", priority: sent } });
    assert.equal(written(log)?.priority, stored);
  }
});

test("TK4 неизвестный статус отвергается, а не понижается молча до «Новые»", async () => {
  // Прежняя версия подставляла дефолт: опечатка в PATCH возвращала задачу из
  // «В работе» в «Новые» и стирала время закрытия, отвечая 200. По индексу
  // status уже считают — мусор в нём ломает счёт молча.
  const call = await loadRouter();
  const created = await call({ body: { title: "Задача", status: "ожидает" } });
  assert.equal(created.res.statusCode, 400, JSON.stringify(created.res.body));
  assert.equal(created.log.filter((e) => e.op === "insert").length, 0, "и до базы не доходит");

  const priority = await call({ body: { title: "Задача", priority: "критический" } });
  assert.equal(priority.res.statusCode, 400);
});

test("TK4b правка неизвестным статусом не сбрасывает задачу и не стирает закрытие", async () => {
  const call = await loadRouter({ tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, status: "done" }] });
  for (const status of ["cancelled", ""]) {
    const { res, log } = await call({ method: "PATCH", body: { id: TASK_ID, updates: { status } } });
    assert.equal(res.statusCode, 400, `status=${JSON.stringify(status)} должен быть отвергнут`);
    assert.equal(log.filter((e) => e.op === "update").length, 0, "потеря состояния без сообщения — худший исход");
  }
});

/* ── Связи, проверенные по клинике ── */

test("TK5 задача из карточки заявки хранит эту заявку", async () => {
  const call = await loadRouter({ leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A }] });
  const { res, log } = await call({ body: { title: "Перезвонить", leadId: LEAD_ID } });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(written(log)?.lead_id, LEAD_ID, "иначе «что делать дальше по этой заявке» негде хранить");

  const lookup = log.find((e) => e.table === "leads");
  assert.ok(lookup, "ссылка проверяется, а не принимается на слово");
  assert.equal(lookup.filters.workspace_id, WORKSPACE_A);
});

test("TK6 заявку чужой клиники к задаче привязать нельзя", async () => {
  // Ровно та ошибка, из-за которой client_id у заявки вынесли из buildPatchRow
  // в построитель ссылок: uuid — это форма, а не принадлежность.
  const call = await loadRouter({ leads: [{ id: FOREIGN_LEAD_ID, workspace_id: WORKSPACE_B }] });
  const { res, log } = await call({ body: { title: "Перезвонить", leadId: FOREIGN_LEAD_ID } });

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((e) => e.op === "insert").length, 0, "отказ до записи");
});

test("TK7 исполнитель стал ссылкой на сотрудника, а имя — снимком рядом", async () => {
  // assignee_user_id существует с 010 как настоящий внешний ключ и не писался
  // ничем: исполнитель хранился строкой, поэтому «мои задачи» были невыразимы.
  const call = await loadRouter();
  const { res, log } = await call({ body: { title: "Перезвонить", assigneeUserId: STAFF_A } });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const row = written(log);
  assert.equal(row?.assignee_user_id, STAFF_A);
  assert.equal(row?.assignee_name, "Айгерим", "имя остаётся снимком: уволенный сотрудник не должен стирать прошлое");
});

test("TK8 задачу нельзя повесить на уволенного сотрудника", async () => {
  const call = await loadRouter({
    staff_users: [
      { id: STAFF_A, auth_user_id: USER_A, workspace_id: WORKSPACE_A, role: "owner", status: "active", full_name: "Айгерим" },
      { id: STAFF_B, workspace_id: WORKSPACE_A, role: "receptionist", status: "disabled", full_name: "Мария" },
    ],
  });
  const { res } = await call({ body: { title: "Перезвонить", assigneeUserId: STAFF_B } });

  assert.equal(res.statusCode, 400, "задача в очереди, которую никто не читает, — это потерянная задача");
});

test("TK9 снятие исполнителя убирает и имя", async () => {
  const call = await loadRouter({
    tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, assignee_user_id: STAFF_A, assignee_name: "Айгерим" }],
  });
  const { log } = await call({ method: "PATCH", body: { id: TASK_ID, updates: { assigneeUserId: "" } } });

  const row = written(log);
  assert.equal(row?.assignee_user_id, null);
  assert.equal(row?.assignee_name, null, "иначе карточка продолжит показывать того, кто больше не отвечает");
});

/* ── Автор и закрытие ── */

test("TK10 автор задачи — проверенное членство, а не заявление в теле", async () => {
  const call = await loadRouter();
  const { log } = await call({ body: { title: "Перезвонить", createdByStaffUserId: STAFF_B, createdByKind: "system" } });

  const row = written(log);
  assert.equal(row?.created_by_staff_user_id, STAFF_A, "id берётся из контекста, который доказал роутер");
  assert.equal(row?.created_by_kind, "manual", "вид автора тоже, иначе список автосозданных задач подделывается");
});

test("TK11 время закрытия двигает переход, а не присутствие ключа в теле", async () => {
  const open = await loadRouter({ tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, status: "in_progress" }] });
  const closed = await open({ method: "PATCH", body: { id: TASK_ID, updates: { status: "Готово" } } });
  const closedAt = written(closed.log)?.completed_at;
  assert.ok(typeof closedAt === "string" && closedAt.length > 0, "«сделано сегодня» без этого не считается");

  const done = await loadRouter({
    tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, status: "done", completed_at: "2026-01-05T10:00:00.000Z" }],
  });

  const reopened = await done({ method: "PATCH", body: { id: TASK_ID, updates: { status: "in_progress" } } });
  assert.equal(written(reopened.log)?.completed_at, null, "закрытой она больше не была");

  // Форма редактирования шлёт объект целиком, включая неизменившийся статус.
  const resaved = await done({ method: "PATCH", body: { id: TASK_ID, updates: { status: "done", title: "Перезвонить" } } });
  assert.ok(
    !("completed_at" in (written(resaved.log) ?? {})),
    "повторное сохранение не сдвигает дату закрытия: иначе давно закрытая задача попадёт в «сделано сегодня»",
  );
});

/* ── Сужающие фильтры ── */

test("TK12 «мои задачи» спрашиваются у базы, а не фильтруются в браузере", async () => {
  const call = await loadRouter({
    tasks: [
      { id: TASK_ID, workspace_id: WORKSPACE_A, assignee_user_id: STAFF_A, status: "new" },
      { id: "22222222-2222-4222-8222-222222222222", workspace_id: WORKSPACE_A, assignee_user_id: STAFF_B, status: "new" },
    ],
  });
  const { res, log } = await call({ method: "GET", query: { assigneeUserId: STAFF_A } });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const items = (res.body.data as { tasks: unknown[] }).tasks;
  assert.equal(items.length, 1, "отдать весь workspace и отфильтровать в браузере — это и есть механизм свалки");

  const read = log.find((e) => e.table === "tasks");
  assert.equal(read?.filters.assignee_user_id, STAFF_A);
  assert.equal(read?.filters.workspace_id, WORKSPACE_A, "сужение не расширяет доступ: тот же скоуп клиники");
});

test("TK13 задачи по одной заявке и по сроку тоже сужает сервер", async () => {
  const call = await loadRouter({
    tasks: [
      { id: TASK_ID, workspace_id: WORKSPACE_A, lead_id: LEAD_ID, due_at: "2026-09-01T10:00:00.000Z" },
      { id: "33333333-3333-4333-8333-333333333333", workspace_id: WORKSPACE_A, due_at: "2026-12-01T10:00:00.000Z" },
    ],
  });

  const byLead = await call({ method: "GET", query: { leadId: LEAD_ID } });
  assert.equal((byLead.res.body.data as { tasks: unknown[] }).tasks.length, 1);

  const overdue = await call({ method: "GET", query: { dueBefore: "2026-10-01T00:00:00.000Z" } });
  assert.equal((overdue.res.body.data as { tasks: unknown[] }).tasks.length, 1, "просроченные — вопрос к базе");
});

test("TK14 мусор в параметрах фильтра отвергается до запроса", async () => {
  const call = await loadRouter();
  for (const query of [{ assigneeUserId: "не-uuid" }, { leadId: "не-uuid" }, { dueBefore: "когда-нибудь" }]) {
    const { res, log } = await call({ method: "GET", query });
    assert.equal(res.statusCode, 400, `${JSON.stringify(query)} должно быть отвергнуто`);
    assert.equal(log.filter((e) => e.table === "tasks").length, 0, "и до базы не доходить");
  }
});

test("TK15 без параметров список ведёт себя как раньше", async () => {
  const call = await loadRouter({
    tasks: [
      { id: TASK_ID, workspace_id: WORKSPACE_A },
      { id: "44444444-4444-4444-8444-444444444444", workspace_id: WORKSPACE_A },
    ],
  });
  const { res } = await call({ method: "GET" });
  assert.equal((res.body.data as { tasks: unknown[] }).tasks.length, 2, "фильтры аддитивны: отсутствие значит без изменений");
});

/* ── Журнал ── */

test("TK16 задача попала в журнал изменений, а её текст — нет", async () => {
  const journal = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "crm", "change-journal.ts")).href
  )) as {
    journaledEntityFor: (resource: string) => string | null;
    diffForJournal: (entity: string, before: Record<string, unknown>, after: Record<string, unknown>) => Array<{ field: string; from: unknown; to: unknown }>;
  };

  assert.equal(journal.journaledEntityFor("tasks"), "task", "иначе «кто переназначил и когда закрыл» не восстановить");

  const changes = journal.diffForJournal(
    "task",
    { title: "", status: "new" },
    { title: "Перезвонить Марии по лазеру", status: "done" },
  );
  const text = JSON.stringify(changes);
  assert.ok(!text.includes("лазер"), "заголовок задачи — гарантированное место для клинической детали");
  assert.ok(text.includes("done"), "а статус — словарное поле, ради него историю и открывают");
});

test("TK19 до применения 031 задача всё равно создаётся — без связей, но создаётся", async () => {
  // Деплой доходит до production раньше ручной миграции. Первая версия ветки
  // писала created_by_kind в КАЖДОМ создании, поэтому в этом окне ломалось не
  // «связывание с заявкой», а создание задачи вообще — то, что до ветки
  // работало. Тот же приём деградации, которым закрыт поиск клиента.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const call = await loadRouter({}, ["created_by_kind", "created_by_staff_user_id", "lead_id", "completed_at"]);
    const { res, log } = await call({ body: { title: "Перезвонить" } });

    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const inserts = log.filter((e) => e.table === "tasks" && e.op === "insert");
    assert.equal(inserts.length, 2, "первая попытка отвергается базой, вторая идёт без колонок 031");
    assert.ok(!("created_by_kind" in (inserts[1].filters.__row as Record<string, unknown>)));
  } finally {
    console.warn = realWarn;
  }

  assert.ok(
    warnings.some((line) => line.includes("031")),
    "и лог оператора называет миграцию, которая вернёт функции полноту",
  );
});

test("TK20 чтение не переписывает статус, записанный прежним кодом", async () => {
  // Канонизация на пути ЧТЕНИЯ опустошила бы канбан: единственный экран задач
  // сравнивает статус с подписями, а ветка не тронула ни одного файла фронта.
  const call = await loadRouter({
    tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, status: "Готово", priority: "Средний" }],
  });
  const { res } = await call({ method: "GET" });

  const items = (res.body.data as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.equal(items[0].status, "Готово", "значение из базы отдаётся как есть; канон живёт на записи");
  assert.equal(items[0].priority, "Средний");
});

test("TK21 связь с клиентом и записью проверяется так же, как с заявкой", async () => {
  const own = await loadRouter({
    clients: [{ id: "55555555-5555-4555-8555-555555555555", workspace_id: WORKSPACE_A }],
    appointments: [{ id: "66666666-6666-4666-8666-666666666666", workspace_id: WORKSPACE_A }],
  });
  const ok = await own({
    body: { title: "Задача", clientId: "55555555-5555-4555-8555-555555555555", appointmentId: "66666666-6666-4666-8666-666666666666" },
  });
  assert.equal(ok.res.statusCode, 201, JSON.stringify(ok.res.body));
  assert.equal(written(ok.log)?.client_id, "55555555-5555-4555-8555-555555555555");
  assert.equal(written(ok.log)?.appointment_id, "66666666-6666-4666-8666-666666666666");

  const foreign = await loadRouter({ clients: [{ id: "55555555-5555-4555-8555-555555555555", workspace_id: WORKSPACE_B }] });
  const refused = await foreign({ body: { title: "Задача", clientId: "55555555-5555-4555-8555-555555555555" } });
  assert.equal(refused.res.statusCode, 400, "чужой пациент — то же правило, что и чужая заявка");
});

test("TK22 ссылка, присланная не строкой, отвергается, а не стирает связь", async () => {
  const call = await loadRouter({ tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, lead_id: LEAD_ID }] });
  const { res, log } = await call({ method: "PATCH", body: { id: TASK_ID, updates: { leadId: 0 } } });

  assert.equal(res.statusCode, 400, "клиент, шлющий 0 вместо «не выбрано», не должен молча терять связь");
  assert.equal(log.filter((e) => e.op === "update").length, 0);
});

test("TK23 правка имени исполнителя текстом снимает ссылку, а не расходится с ней", async () => {
  // Иначе карточка показывает одно имя, а «мои задачи» по ссылке относят
  // задачу другому сотруднику — имя перестаёт быть снимком назначения.
  const call = await loadRouter({
    tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, assignee_user_id: STAFF_A, assignee_name: "Айгерим" }],
  });
  const { log } = await call({ method: "PATCH", body: { id: TASK_ID, updates: { owner: "Мария" } } });

  const row = written(log);
  assert.equal(row?.assignee_name, "Мария");
  assert.equal(row?.assignee_user_id, null, "ссылка снимается: имя снова просто текст");
});

test("TK24 задача без срока не считается просроченной", async () => {
  const call = await loadRouter({
    tasks: [
      { id: TASK_ID, workspace_id: WORKSPACE_A, due_at: "2026-09-01T10:00:00.000Z" },
      { id: "77777777-7777-4777-8777-777777777777", workspace_id: WORKSPACE_A, due_at: null },
    ],
  });
  const { res } = await call({ method: "GET", query: { dueBefore: "2026-10-01T00:00:00.000Z" } });

  const items = (res.body.data as { tasks: unknown[] }).tasks;
  assert.equal(items.length, 1, "NULL < X в Postgres даёт NULL — строка отсеивается");
});

test("TK25 неизвестный статус в фильтре — отказ, а не список новых задач", async () => {
  const call = await loadRouter();
  const { res, log } = await call({ method: "GET", query: { status: "archived" } });

  assert.equal(res.statusCode, 400, "иначе вызывающая сторона не отличит «таких нет» от «такого статуса нет»");
  assert.equal(log.filter((e) => e.table === "tasks").length, 0);
});

/* ── Панель на карточках ── */

const panelPath = path.join(repoRoot, "artifacts", "negis", "src", "components", "crm", "task-panel.tsx");

test("TK26 панель одна на весь продукт, а не по копии на экран", async () => {
  // Шесть карточек метрики выросли по одной на страницу, и цена была в том,
  // что два экрана остались со старым бренд-цветом: менять было негде.
  const { readdir } = await import("node:fs/promises");
  const pagesDir = path.join(repoRoot, "artifacts", "negis", "src", "pages");
  const definitions: string[] = [];
  for (const name of await readdir(pagesDir)) {
    if (!name.endsWith(".tsx")) continue;
    const source = await readFile(path.join(pagesDir, name), "utf8");
    for (const match of source.matchAll(/^(?:export\s+)?function\s+(\w*Task\w*Panel\w*)/gm)) {
      definitions.push(`${name} → ${match[1]}`);
    }
  }
  assert.deepEqual(definitions, [], `экран, рисующий свою панель задач, перестаёт следовать общей: ${definitions.join(", ")}`);

  for (const page of ["LeadsPage.tsx", "ClientsPage.tsx"]) {
    const source = await readFile(path.join(pagesDir, page), "utf8");
    assert.ok(source.includes('from "@/components/crm/task-panel"'), `${page} должна использовать общую панель`);
  }
});

test("TK27 список задач сужает сервер, а не браузер", async () => {
  const panel = await readFile(panelPath, "utf8");

  assert.ok(
    panel.includes('const filterParam = entityType === "lead" ? "leadId" : "clientId";'),
    "вопрос «что по этой записи» задаётся серверу параметром",
  );
  assert.ok(
    /crmFetch\(`\/api\/crm\/tasks\?\$\{query\}`\)/.test(panel),
    "запрос идёт с фильтром",
  );
  // Фильтрация всего массива в браузере — это тот самый механизм, которым
  // список превращается в свалку, когда PostgREST молча обрежет выдачу.
  assert.ok(
    !/tasks\.filter\(\(task\) => task\.(leadId|clientId)/.test(panel),
    "и не пересеивается по связи повторно в браузере",
  );
});

test("TK28 отказ чтения показан отказом, а не пустым списком задач", async () => {
  const panel = await readFile(panelPath, "utf8");

  assert.ok(panel.includes('setState("failed")'), "у отказа своё состояние");
  const failed = panel.indexOf('state === "failed"');
  const empty = panel.indexOf("Задач пока нет");
  assert.ok(failed > 0 && empty > 0 && failed < empty, "отказ рисуется, и раньше пустого случая");
  assert.ok(
    panel.includes("Не удалось загрузить задачи"),
    "запись без задач и запись, задачи которой не прочитались, обязаны выглядеть по-разному",
  );
  assert.ok(
    /if \(!response\.ok \|\| body\.success !== true\)/.test(panel),
    "crmFetch не бросает на 5xx: ответ надо проверять, а не предполагать",
  );
});

test("TK29 создание ждёт сервер и не обещает того, чего не было", async () => {
  const panel = await readFile(panelPath, "utf8");
  const create = panel.slice(panel.indexOf("  const create = async ()"), panel.indexOf("  const close = async ("));

  assert.ok(create.includes("if (!trimmed || saving) return;"), "повторный клик не отправляет второй POST");
  assert.ok(create.includes("await load();"), "список перечитывается после подтверждения сервером");
  const successAt = create.indexOf('toast.success("Задача поставлена")');
  const guardAt = create.indexOf("if (!response.ok || body.success !== true)");
  assert.ok(guardAt > 0 && successAt > guardAt, "успех показывается только после проверки ответа");
  assert.ok(
    !create.includes("сохранено локально"),
    "локально здесь ничего не сохраняется, и обещать это нельзя",
  );
});

test("TK30 закрытие задачи тоже проверяет ответ", async () => {
  const panel = await readFile(panelPath, "utf8");
  const close = panel.slice(panel.indexOf("  const close = async ("));
  assert.ok(close.includes("if (!response.ok || body.success !== true)"), "отказ виден отказом");
  assert.ok(close.includes("await load();"), "и состояние берётся у сервера, а не додумывается");
});

test("TK31 панель прячется у роли без права на задачи", async () => {
  for (const page of ["LeadsPage.tsx", "ClientsPage.tsx"]) {
    const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", page), "utf8");
    assert.ok(
      source.includes("isRealWorkspace() && rolePermissions.tasks ?"),
      `${page}: кнопка, которую сервер отклонит после клика, — уже разобранный в этом репозитории сценарий`,
    );
  }
});

/* ── Пины исходников и миграции ── */

test("TK17 ссылки задачи идут через ту же проверку клиники, что и все остальные", async () => {
  const source = await readFile(serverPath, "utf8");
  const builder = source.slice(
    source.indexOf("async function buildTaskReferenceRow("),
    source.indexOf("async function buildDealReferenceRow("),
  );
  assert.ok(builder.length > 0, "построитель ссылок задачи должен существовать");

  for (const table of ['"leads"', '"clients"', '"appointments"', '"staff_users"']) {
    assert.ok(builder.includes(table), `${table} должна проверяться по клинике`);
  }
  assert.ok(
    builder.includes("readWorkspaceReference"),
    "проверка формы (isUuid) не является проверкой принадлежности — этот урок уже оплачен на client_id заявки",
  );

  // Не по отступам: пин, ломающийся от переноса строки, ловит форматирование,
  // а не подключение. Проверяется факт вызова с каждым из двух тел.
  for (const argument of ["workspaceId, body)", "workspaceId, patchBody)"]) {
    assert.ok(
      source.includes(`buildTaskReferenceRow(supabase, ${argument}`),
      `оба пути записи должны звать построитель: ${argument}`,
    );
  }
});

test("TK18 миграция 031 аддитивна, индексирует запросы и не молчит про права", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const column of ["lead_id", "client_id", "appointment_id", "created_by_staff_user_id", "created_by_kind", "completed_at"]) {
    assert.ok(sql.includes(`add column if not exists ${column}`), `${column} должна добавляться идемпотентно`);
  }
  for (const forbidden of ["drop column", "drop table", "delete from", "alter column"]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, `031 не должна быть разрушительной; найдено «${forbidden}»`);
  }

  // Одноразовое приведение написаний — обязательная часть, а не нарушение
  // аддитивности. Без него фильтр ?status=done не нашёл бы ни одной старой
  // закрытой задачи: параметр канонизируется, а в колонке лежит «Готово».
  assert.ok(sql.includes("update public.tasks"), "031 обязана привести уже записанные написания к канону");
  assert.ok(sql.includes("else status"), "значение, которого нет в списке, не трогается");
  assert.ok(sql.includes("tasks_created_by_kind_check"), "словарь вида автора живёт в базе, а не только в комментарии");
  for (const index of ["tasks_workspace_assignee_idx", "tasks_workspace_due_at_idx", "tasks_workspace_lead_idx"]) {
    assert.ok(sql.includes(index), `${index} — это и есть запросы «мои», «просроченные», «по заявке»`);
  }

  // Про RLS и грант в production репозиторий противоречит сам себе: 010 пишет,
  // что RLS выключена намеренно, а test:security1b записал наблюдение, что в
  // production она включена на всех до-023 таблицах. Проверить отсюда нельзя,
  // поэтому миграция написана верной при обеих гипотезах: включение включённого
  // и грант уже выданного — no-op, а не сделать ни того ни другого неверно при
  // одной из них.
  assert.ok(sql.includes("enable row level security"), "RLS включается явно");
  assert.ok(/grant[^;]*on table public\.tasks[^;]*to\s+service_role/.test(sql), "грант выписывается явно");
});

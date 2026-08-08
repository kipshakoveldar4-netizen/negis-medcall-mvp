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

function spyClient(rows: Record<string, unknown[]>, log: QueryLog[]) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const applied: Filter[] = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) =>
          applied.every((f) =>
            f.op === "eq" ? row[f.column] === f.value : String(row[f.column] ?? "") < String(f.value ?? "")));

      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
        eq(column: string, value: unknown) { applied.push({ column, op: "eq", value }); entry.filters[column] = value; return chain(); },
        lt(column: string, value: unknown) { applied.push({ column, op: "lt", value }); entry.filters[`${column}__lt`] = value; return chain(); },
        gte(column: string, value: unknown) { entry.filters[`${column}__gte`] = value; return chain(); },
        in(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        then(resolve: (value: { data: unknown; error: null; count?: number }) => void) {
          const found = matching();
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

async function loadRouter(rows: Record<string, unknown[]> = {}) {
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
  supabaseModule.setSupabaseServerClientFactoryForTests(() => spyClient(clientRows, log));

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

test("TK4 неизвестный статус не создаёт третий словарь в той же колонке", async () => {
  const call = await loadRouter();
  const { log } = await call({ body: { title: "Задача", status: "ожидает", priority: "критический" } });

  assert.equal(written(log)?.status, "new", "по индексу status уже считают — мусор в нём ломает счёт");
  assert.equal(written(log)?.priority, "medium");
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

test("TK11 закрытие задачи проставляет время, а повторное открытие снимает", async () => {
  const call = await loadRouter({ tasks: [{ id: TASK_ID, workspace_id: WORKSPACE_A, status: "in_progress" }] });

  const closed = await call({ method: "PATCH", body: { id: TASK_ID, updates: { status: "Готово" } } });
  const closedAt = written(closed.log)?.completed_at;
  assert.ok(typeof closedAt === "string" && closedAt.length > 0, "«сделано сегодня» и «просрочено» без этого не считаются");

  const reopened = await call({ method: "PATCH", body: { id: TASK_ID, updates: { status: "in_progress" } } });
  assert.equal(written(reopened.log)?.completed_at, null, "закрытой она больше не была");
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

  for (const wiring of [
    'if (resource === "tasks") {\n      Object.assign(row, await buildTaskReferenceRow(supabase, workspaceId, body));',
    'if (resource === "tasks") {\n      Object.assign(row, await buildTaskReferenceRow(supabase, workspaceId, patchBody));',
  ]) {
    assert.ok(source.includes(wiring), "оба пути записи должны звать построитель");
  }
});

test("TK18 миграция 031 аддитивна, индексирует запросы и не молчит про права", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const column of ["lead_id", "client_id", "appointment_id", "created_by_staff_user_id", "created_by_kind", "completed_at"]) {
    assert.ok(sql.includes(`add column if not exists ${column}`), `${column} должна добавляться идемпотентно`);
  }
  for (const forbidden of ["drop column", "drop table", "delete from", "update public.tasks", "alter column"]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, `031 обязана быть аддитивной; найдено «${forbidden}»`);
  }
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

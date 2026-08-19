import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Мастер видит свою работу, а не всю клинику.
//
// Владелец: «мастера не должны видеть контактные данные клиентов, только имя и
// время записи» — и следом: записи должны быть только СВОИ. Контакты уже
// срезаны (test:contact-privacy); здесь сужается сам набор строк.
//
// Что проверяется поведением, а не текстом исходника: чужая запись не приходит
// в списке; чужая запись не приходит и через эхо PATCH (иначе сужение списка
// ничего не стоит — правка по угаданному идентификатору осталась бы чтением);
// мастер не может переписать запись на коллегу и не может записать клиента к
// коллеге; администратор и ресепшн видят всё, как раньше; история без
// doctor_id находится по имени, потому что 033 намеренно ничего не заполняла.
//
// Ничто здесь не ходит в production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const STAFF_MASTER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOCTOR_CARD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_CARD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MINE_LINKED = "10000000-0000-4000-8000-000000000001";
const MINE_BY_NAME = "10000000-0000-4000-8000-000000000002";
const SOMEONE_ELSES = "10000000-0000-4000-8000-000000000003";
const MINE_RENAMED = "10000000-0000-4000-8000-000000000004";
const NAMESAKE_ROW = "10000000-0000-4000-8000-000000000005";
const NAMESAKE_CARD = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const NAMESAKE_SLOT = "2026-08-22T09:00:00.000Z";
const ANOTHER_A = "10000000-0000-4000-8000-000000000006";
const MINE_OLD_NAME = "10000000-0000-4000-8000-000000000007";
const MINE_NO_NAME = "10000000-0000-4000-8000-000000000008";
const TOKEN = "header.payload.signature";

const MY_NAME = "Айгуль Смагулова";
/** Имя с запятой — то, чем ломается фильтр, склеенный в строку PostgREST. */
const COMMA_NAME = "Иванова, А.";

type Query = { table: string; op: string; filters: Record<string, unknown>; row?: Record<string, unknown> };

/**
 * ilike как у PostgREST, а не «строки совпали».
 *
 * Двойник, сравнивавший строки точно, был добрее настоящей базы: `%`, `_` и
 * `*` в имени специалиста — ШАБЛОНЫ, и незакрытая звёздочка превращает «покажи
 * мои записи» в «покажи все». Проверять экранирование двойником, который
 * шаблонов не знает, невозможно — он зелёный в обоих случаях.
 */
function likeMatches(value: string, pattern: string): boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === "\\") {
      const next = pattern[index + 1] ?? "";
      expression += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
      continue;
    }
    if (ch === "%" || ch === "*") { expression += ".*"; continue; }
    if (ch === "_") { expression += "."; continue; }
    expression += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "i").test(value);
}

function spyClient(rows: Record<string, unknown[]>, log: Query[], failReadsOn: Set<string> = new Set()) {
  return {
    from(table: string) {
      const entry: Query = { table, op: "select", filters: {} };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const eqs: Array<[string, unknown]> = [];
      const likes: Array<[string, string]> = [];
      let requested = "*";

      /** «table» роняет все чтения таблицы, «table:column» — только те, что просят эту колонку. */
      const readFails = () =>
        failReadsOn.has(table) || [...failReadsOn].some((rule) => {
          const [ruleTable, ruleColumn] = rule.split(":");
          return ruleTable === table && Boolean(ruleColumn) && requested.includes(ruleColumn);
        });

      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) =>
          eqs.every(([column, value]) => row[column] === value)
          && likes.every(([column, value]) => likeMatches(String(row[column] ?? ""), value)),
        );

      Object.assign(builder, {
        select: (columns?: unknown) => { requested = typeof columns === "string" ? columns : "*"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        in: () => chain(),
        gte: () => chain(),
        lt: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.row = row as Record<string, unknown>; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.row = row as Record<string, unknown>; return chain(); },
        upsert: (row: unknown) => { entry.op = "insert"; entry.row = row as Record<string, unknown>; return chain(); },
        eq(column: string, value: unknown) { eqs.push([column, value]); entry.filters[column] = value; return chain(); },
        ilike(column: string, value: string) { likes.push([column, value]); entry.filters[`${column}__ilike`] = value; return chain(); },
        maybeSingle: () => Promise.resolve(readFails()
          ? { data: null, error: { code: "57014", message: `canceling statement due to statement timeout on ${table}` } }
          : { data: matching()[0] ?? null, error: null }),
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (entry.op === "select") {
            if (readFails()) {
              resolve({ data: null, error: { code: "57014", message: `canceling statement due to statement timeout on ${table}` } });
              return;
            }
            resolve({ data: matching(), error: null });
            return;
          }
          const written = { id: entry.row?.id ?? MINE_LINKED, ...(entry.row ?? {}) };
          resolve({ data: written, error: null });
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

const journalEvent = (entityId: string, clientName: string) => ({
  id: `event-${entityId}`,
  workspace_id: WORKSPACE,
  entity_type: "appointment",
  entity_id: entityId,
  action: "updated",
  actor_name: "Ресепшн",
  actor_role: "receptionist",
  actor_kind: "staff",
  actor_staff_user_id: null,
  created_at: "2026-08-19T10:00:00.000Z",
  metadata: { changes: [{ field: "client_name", label: "Клиент", from: "", to: clientName }] },
});

const appointment = (over: Record<string, unknown>) => ({
  workspace_id: WORKSPACE,
  client_name: "Клиент",
  starts_at: "2026-08-20T09:00:00.000Z",
  status: "scheduled",
  ...over,
});

async function callRouter(options: {
  role?: string;
  method?: string;
  body?: Record<string, unknown>;
  pathSegments?: string[];
  query?: Record<string, unknown>;
  /** Карточка справочника у мастера есть по умолчанию; так её можно убрать. */
  linkedCard?: boolean;
  staffName?: string;
  /** Имя карточки справочника, если оно разошлось с именем в записях. */
  cardName?: string;
  failReadsOn?: string[];
}) {
  const log: Query[] = [];
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const role = options.role ?? "doctor";
  const staffName = options.staffName ?? MY_NAME;
  const rows: Record<string, unknown[]> = {
    staff_users: [{ id: STAFF_MASTER, auth_user_id: USER, workspace_id: WORKSPACE, role, status: "active", full_name: staffName }],
    clinic_doctors: options.linkedCard === false
      ? [{ id: OTHER_CARD, workspace_id: WORKSPACE, full_name: "Динара", staff_user_id: null, is_active: true }]
      : [
        { id: DOCTOR_CARD, workspace_id: WORKSPACE, full_name: options.cardName ?? staffName, staff_user_id: STAFF_MASTER, is_active: true },
        { id: OTHER_CARD, workspace_id: WORKSPACE, full_name: "Динара", staff_user_id: null, is_active: true },
        // Полный тёзка с отдельной карточкой: его записи попадают в проверку
        // пересечений по имени, и отказ не имеет права назвать его пациента.
        { id: NAMESAKE_CARD, workspace_id: WORKSPACE, full_name: staffName, staff_user_id: null, is_active: true },
      ],
    appointments: [
      appointment({ id: MINE_LINKED, doctor_id: DOCTOR_CARD, doctor_name: staffName, client_name: "Мария" }),
      // История до 033: связи нет, есть только имя — и регистр другой.
      appointment({ id: MINE_BY_NAME, doctor_id: null, doctor_name: staffName.toLowerCase(), client_name: "Асель" }),
      appointment({ id: SOMEONE_ELSES, doctor_id: OTHER_CARD, doctor_name: "Динара", client_name: "Чужой клиент" }),
      // Моя по ссылке, но под прежним именем карточки: так выглядит история
      // после переименования.
      appointment({ id: MINE_RENAMED, doctor_id: DOCTOR_CARD, doctor_name: "Айгуль С.", client_name: "Сауле", starts_at: "2026-08-18T09:00:00.000Z" }),
      // Запись тёзки: имя моё, карточка чужая, пациент — не мой.
      appointment({ id: NAMESAKE_ROW, doctor_id: NAMESAKE_CARD, doctor_name: staffName, client_name: "Пациент тёзки", starts_at: NAMESAKE_SLOT }),
      // Другой мастер на ту же букву: ровно то, что подобрала бы незакрытая
      // звёздочка в имени.
      appointment({ id: ANOTHER_A, doctor_id: OTHER_CARD, doctor_name: "Алия", client_name: "Пациент Алии", starts_at: "2026-08-24T09:00:00.000Z" }),
      // Моя работа под прежним именем и БЕЗ связи: её находит только сбор
      // прежних имён карточки.
      appointment({ id: MINE_OLD_NAME, doctor_id: null, doctor_name: "Айгуль С.", client_name: "Гульмира", starts_at: "2026-08-17T09:00:00.000Z" }),
      // Связана со мной, а имя в снимке не заполнено вовсе: такую находит
      // только чтение по ссылке.
      appointment({ id: MINE_NO_NAME, doctor_id: DOCTOR_CARD, doctor_name: "", client_name: "Без имени мастера", starts_at: "2026-08-16T09:00:00.000Z" }),
    ],
    workspace_settings: [],
    // Журнал не пуст: без событий проверка «чужая история не отдаётся» была бы
    // зелёной всегда — просто потому, что отдавать нечего.
    audit_logs: [
      journalEvent(MINE_LINKED, "Мария"),
      journalEvent(SOMEONE_ELSES, "Чужой клиент"),
    ],
  };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    spyClient(rows, log, new Set(options.failReadsOn ?? [])));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const res = mockResponse();
  await routerModule.default(
    {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
      query: { path: options.pathSegments ?? ["appointments"], workspaceId: WORKSPACE, ...(options.query ?? {}) },
      body: options.body,
    },
    res,
  );
  return { res, log };
}

const listedIds = (res: MockResponse) =>
  ((res.body.data as Record<string, unknown>).appointments as Array<Record<string, unknown>>).map((item) => String(item.id));

test("OW1 мастеру приходят только его записи — и связанные, и найденные по имени", async () => {
  const { res } = await callRouter({});
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const ids = listedIds(res).sort();
  // Тёзка тоже попадает: одно имя на двоих различить нечем, и это записано в
  // ограничениях правила. Чужая запись коллеги — не попадает.
  assert.deepEqual(ids, [MINE_LINKED, MINE_BY_NAME, MINE_RENAMED, MINE_OLD_NAME, MINE_NO_NAME, NAMESAKE_ROW].sort());
});

test("OW2 чужая запись не приходит вовсе — ни строкой, ни именем клиента", async () => {
  const { res } = await callRouter({});
  assert.ok(!listedIds(res).includes(SOMEONE_ELSES), "чужая запись в списке");
  assert.ok(!JSON.stringify(res.body).includes("Чужой клиент"), "имя чужого клиента в ответе");
});

test("OW3 администратор видит всю клинику, как раньше", async () => {
  const { res } = await callRouter({ role: "admin" });
  assert.equal(listedIds(res).length, 8, JSON.stringify(res.body));
});

test("OW4 ресепшн тоже видит всё — правило про мастера его не касается", async () => {
  const { res } = await callRouter({ role: "receptionist" });
  assert.equal(listedIds(res).length, 8);
});

test("OW5 имя с запятой не ломает сужение — фильтр не склеивается в строку", async () => {
  // Один запрос с or=(...) переписывался бы таким именем: запятая внутри
  // значения — разделитель условий. Фильтр видимости, который ломается
  // данными, фильтром видимости не является.
  const { res } = await callRouter({ staffName: COMMA_NAME });
  const ids = listedIds(res).sort();
  // Прежнее имя карточки («Айгуль С.») в набор входит: оно собрано из уже
  // связанных записей, а не выдумано — см. OW26.
  assert.deepEqual(ids, [MINE_LINKED, MINE_BY_NAME, MINE_RENAMED, MINE_NO_NAME, MINE_OLD_NAME, NAMESAKE_ROW].sort(), JSON.stringify(res.body));
});

test("OW6 мастер без карточки и без имени не получает всю клинику", async () => {
  const { res } = await callRouter({ linkedCard: false, staffName: "" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(listedIds(res), [], "пустой список безопаснее показанного «на всякий случай»");
});

test("OW7 чужую запись мастер не прочитает и правкой", async () => {
  // Эхо PATCH возвращает всю строку: без этого гейта сужение списка не стоило
  // бы ничего — достаточно было бы знать идентификатор.
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: SOMEONE_ELSES, updates: { status: "confirmed" } },
  });
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes("Чужой клиент"));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "update").length, 0, "и ничего не записано");
});

test("OW8 свою запись мастер правит как обычно", async () => {
  const { res } = await callRouter({
    method: "PATCH",
    body: { id: MINE_LINKED, updates: { status: "confirmed" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test("OW9 переписать свою запись на коллегу нельзя", async () => {
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: MINE_LINKED, updates: { doctorId: OTHER_CARD, doctor: "Динара" } },
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "update").length, 0);
});

test("OW10 записать клиента к коллеге мастер не может", async () => {
  const { res, log } = await callRouter({
    method: "POST",
    body: { client: "Новый", doctor: "Динара", doctorId: OTHER_CARD, starts_at: "2026-08-21T09:00:00.000Z" },
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "insert").length, 0);
});

test("OW11 запись без указания специалиста создаётся на самого мастера", async () => {
  const { res, log } = await callRouter({
    method: "POST",
    body: { client: "Новый", starts_at: "2026-08-21T09:00:00.000Z" },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const insert = log.find((q) => q.table === "appointments" && q.op === "insert");
  assert.equal(insert?.row?.doctor_name, MY_NAME, "имя проставлено сервером");
  assert.equal(insert?.row?.doctor_id, DOCTOR_CARD, "и связь со справочником тоже");
});

test("OW12 экран не предлагает мастеру того, что сервер отклонит", async () => {
  const page = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"), "utf8");
  assert.ok(/userRole === "doctor" \? null : activeDoctors\.length > 0/.test(page), "выбор специалиста мастеру не показывается");
  assert.ok(/userRole !== "doctor" \? \(\s*<SelectField label=\{`Все \$\{terms\.specialistPlural\}`\}/.test(page), "фильтр по специалисту тоже");
});

test("OW13 старую свою запись — без связи и с другим регистром имени — мастер правит", async () => {
  // Вся история до 033 записана свободным текстом, и регистр в ней какой
  // угодно. Сравнение с учётом регистра отдало бы мастеру «не найдена» на его
  // же записи — то есть отняло бы работу, а не защитило чужую.
  const { res } = await callRouter({
    method: "PATCH",
    body: { id: MINE_BY_NAME, updates: { status: "confirmed" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test("OW14 история чужой записи не открывается по идентификатору", async () => {
  // Журнал открывается по uuid, а uuid чужой записи достать нетрудно. Ответ —
  // пустая история, а не отказ: отказ подтвердил бы, что запись существует.
  const { res } = await callRouter({
    pathSegments: ["change-log"],
    query: { entityType: "appointment", entityId: SOMEONE_ELSES },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.events, [], "чужая история отдана");
});

test("OW15 своя история по-прежнему открывается", async () => {
  const { res } = await callRouter({
    pathSegments: ["change-log"],
    query: { entityType: "appointment", entityId: MINE_LINKED },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal((res.body.events as unknown[]).length, 1, "своя история пуста — сужение бьёт по своим");
});

test("OW16 браузерная таблица прав не обещает мастеру разделы CRM", async () => {
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "contexts", "AuthContext.tsx"),
    "utf8",
  );
  const line = source.split(/\r?\n/).find((text) => /^\s*doctor: \{ dashboard/.test(text)) ?? "";
  assert.ok(/crm: false/.test(line), `мастеру обещан crm: ${line.trim()}`);
});

test("OW17 мастер без карточки справочника видит свои записи по имени", async () => {
  // Единственный источник личности здесь — staff_users.full_name. Пока
  // карточку не завели (а до 033 её не было ни у кого), это норма, а не сбой.
  const { res } = await callRouter({ linkedCard: false });
  const ids = listedIds(res).sort();
  assert.ok(ids.includes(MINE_BY_NAME) && ids.includes(MINE_LINKED), JSON.stringify(res.body));
  assert.ok(!ids.includes(SOMEONE_ELSES), "и чужие всё равно не приходят");
});

test("OW18 звёздочка в имени не превращает фильтр в «покажи всё»", async () => {
  // PostgREST принимает «*» как «%» в своём синтаксисе — до Postgres. Без
  // экранирования мастер с именем «А*» получил бы всю клинику.
  const { res } = await callRouter({ staffName: "А*" });
  const ids = listedIds(res);
  assert.ok(!ids.includes(ANOTHER_A), `звёздочка подобрала чужого мастера: ${JSON.stringify(res.body)}`);
  assert.ok(!ids.includes(SOMEONE_ELSES), "и коллегу тоже");
});

test("OW19 правка, меняющая только имя специалиста, отклоняется", async () => {
  // Ссылка остаётся своей, и слабая проверка «принадлежит» пропускала это.
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: MINE_LINKED, updates: { doctor: "Динара" } },
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "update").length, 0);
});

test("OW20 правка, меняющая только ссылку на специалиста, тоже отклоняется", async () => {
  const { res, log } = await callRouter({
    method: "PATCH",
    body: { id: MINE_LINKED, updates: { doctorId: OTHER_CARD } },
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "update").length, 0);
});

test("OW21 создание «моё имя, чужая карточка» отклоняется", async () => {
  const { res, log } = await callRouter({
    method: "POST",
    body: { client: "Новый", doctor: MY_NAME, doctorId: OTHER_CARD, starts_at: "2026-08-23T09:00:00.000Z" },
  });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(log.filter((q) => q.table === "appointments" && q.op === "insert").length, 0);
});

test("OW22 сбой чтения личности не выглядит свободным днём", async () => {
  // Пустой список после таймаута — это молчаливая ложь: мастер уходит домой,
  // считая, что записей нет.
  // Отказ наведён на чтения ЛИЧНОСТИ, а не на авторизацию: иначе проверка
  // была бы зелёной просто потому, что запрос не дошёл до списка.
  const { res } = await callRouter({ failReadsOn: ["clinic_doctors", "staff_users:full_name"] });
  assert.notEqual(res.statusCode, 200, `тихая пустота: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, false, "и ответ честно говорит об отказе");
});

test("OW23 переименование карточки не отнимает прежние записи", async () => {
  // В записи лежит снимок имени на момент визита. Карточку переименовали —
  // прежние строки обязаны остаться и видимыми, и правимыми.
  const { res } = await callRouter({ cardName: "Айгуль Смагулова-Ким" });
  assert.ok(listedIds(res).includes(MINE_RENAMED), `прежняя работа потеряна: ${JSON.stringify(listedIds(res))}`);
  const patched = await callRouter({
    cardName: "Айгуль Смагулова-Ким",
    method: "PATCH",
    body: { id: MINE_RENAMED, updates: { status: "confirmed" } },
  });
  assert.equal(patched.res.statusCode, 200, JSON.stringify(patched.res.body));
});

test("OW24 отказ «слот занят» не называет пациента однофамильца", async () => {
  const { res } = await callRouter({
    method: "POST",
    body: { client: "Новый", starts_at: NAMESAKE_SLOT, durationMinutes: 30 },
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal((res.body.conflict as Record<string, unknown>).clientName, "", "имя чужого пациента в отказе");
  assert.ok(!JSON.stringify(res.body).includes("Пациент тёзки"));
});

test("OW25 запись, связанная со мной ссылкой, приходит и с другим именем", async () => {
  // Чтение по ссылке — не украшение: без него запись, где имя писали иначе,
  // исчезала бы у собственного мастера.
  const { res } = await callRouter({ staffName: "Совсем другое имя", cardName: "Совсем другое имя" });
  assert.ok(listedIds(res).includes(MINE_RENAMED), `связь по ссылке не сработала: ${JSON.stringify(res.body)}`);
});

test("OW26 прежнее имя карточки находит работу, у которой связи нет", async () => {
  // Карточку переименовали. Строки со ссылкой найдутся по ней, а вот запись
  // до 033 — только по ПРЕЖНЕМУ имени, и взять его можно единственным
  // способом: из имён, которыми подписаны уже связанные записи.
  const { res } = await callRouter({ cardName: "Айгуль Смагулова-Ким", staffName: "Айгуль Смагулова-Ким" });
  assert.ok(listedIds(res).includes(MINE_OLD_NAME), `прежняя работа потеряна: ${JSON.stringify(listedIds(res))}`);
});

test("OW27 связанная запись без имени в снимке всё равно приходит", async () => {
  // Единственный способ её найти — чтение по ссылке: имени, по которому можно
  // было бы искать, в строке нет вовсе.
  const { res } = await callRouter({});
  assert.ok(listedIds(res).includes(MINE_NO_NAME), `запись без имени мастера потеряна: ${JSON.stringify(listedIds(res))}`);
});

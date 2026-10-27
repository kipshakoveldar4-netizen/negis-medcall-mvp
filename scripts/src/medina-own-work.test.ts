import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withAppointmentCreateRpcSpy, appointmentSpyRows, appointmentSpyBody, APPOINTMENT_SPY_VERSION } from "./appointment-create-rpc-spy.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Мастер видит свою работу, а не всю клинику.
//
// Владелец: «мастера не должны видеть контактные данные клиентов, только имя и
// время записи» — и следом: записи должны быть только СВОИ. Контакты уже
// срезаны (test:contact-privacy); здесь сужается сам набор строк.
// Oct 19, 2026 explicit owner decision: an own, doctor-authored appointment
// exposes even contacts added later by an admin. Other/unknown authors stay
// redacted; this readback exception does not permit doctor contact writes.
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
const STAFF_OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const DOCTOR_CARD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_CARD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OTHER_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const FOREIGN_CARD = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const FOREIGN_APPOINTMENT = "10000000-0000-4000-8000-000000000009";
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
      let single = false;

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
        single: () => { single = true; return chain(); },
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
          : { data: matching()[0] ? { ...matching()[0] } : null, error: null }),
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (entry.op === "select") {
            if (readFails()) {
              resolve({ data: null, error: { code: "57014", message: `canceling statement due to statement timeout on ${table}` } });
              return;
            }
            const selected = matching().map((row) => ({ ...row }));
            resolve({ data: single ? selected[0] ?? null : selected, error: null });
            return;
          }
          if (entry.op === "update") {
            const targets = matching();
            for (const target of targets) Object.assign(target, entry.row);
            resolve({ data: targets[0] ? { ...targets[0] } : null, error: null });
            return;
          }
          const written = { id: entry.row?.id ?? randomUUID(), ...(entry.row ?? {}) };
          (rows[table] ??= []).push(written);
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
  edit_version: APPOINTMENT_SPY_VERSION,
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
  namesakeName?: string;
  failReadsOn?: string[];
  appointmentRows?: Record<string, unknown>[];
  journalRows?: Record<string, unknown>[];
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
    staff_users: [
      { id: STAFF_MASTER, auth_user_id: USER, workspace_id: WORKSPACE, role, status: "active", full_name: staffName },
      { id: STAFF_OTHER, auth_user_id: null, workspace_id: WORKSPACE, role: "receptionist", status: "active", full_name: "Synthetic receptionist" },
    ],
    clinic_doctors: options.linkedCard === false
      ? [{ id: OTHER_CARD, workspace_id: WORKSPACE, full_name: "Динара", staff_user_id: null, is_active: true }]
      : [
        { id: DOCTOR_CARD, workspace_id: WORKSPACE, full_name: options.cardName ?? staffName, staff_user_id: STAFF_MASTER, is_active: true },
        { id: OTHER_CARD, workspace_id: WORKSPACE, full_name: "Динара", staff_user_id: null, is_active: true },
        // Полный тёзка с отдельной карточкой: его записи попадают в проверку
        // пересечений по имени, и отказ не имеет права назвать его пациента.
        { id: NAMESAKE_CARD, workspace_id: WORKSPACE, full_name: options.namesakeName ?? staffName, staff_user_id: null, is_active: true },
        { id: FOREIGN_CARD, workspace_id: OTHER_WORKSPACE, full_name: staffName, staff_user_id: null, is_active: true },
      ],
    appointments: options.appointmentRows?.map((row) => ({ ...row })) ?? [
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
    audit_logs: options.journalRows?.map((row) => ({ ...row })) ?? [
      journalEvent(MINE_LINKED, "Мария"),
      journalEvent(SOMEONE_ELSES, "Чужой клиент"),
    ],
  };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    withAppointmentCreateRpcSpy(spyClient(appointmentSpyRows(rows), log, new Set(options.failReadsOn ?? []))));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const res = mockResponse();
  await routerModule.default(
    {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
      query: { path: options.pathSegments ?? ["appointments"], workspaceId: WORKSPACE, ...(options.query ?? {}) },
      body: appointmentSpyBody((options.pathSegments ?? ["appointments"])[0], options.method, options.body),
    },
    res,
  );
  return { res, log, rows };
}

const listedIds = (res: MockResponse) =>
  ((res.body.data as Record<string, unknown>).appointments as Array<Record<string, unknown>>).map((item) => String(item.id));

test("OW1 мастеру приходят только его записи — и связанные, и найденные по имени", async () => {
  const { res } = await callRouter({});
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const ids = listedIds(res).sort();
  // Name fallback preserves legacy rows, but cannot override another doctor ID.
  assert.deepEqual(ids, [MINE_LINKED, MINE_BY_NAME, MINE_RENAMED, MINE_OLD_NAME, MINE_NO_NAME].sort());
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
  // Linked history supplies old names; even punctuation cannot admit a conflicting ID.
  assert.deepEqual(ids, [MINE_LINKED, MINE_BY_NAME, MINE_RENAMED, MINE_NO_NAME, MINE_OLD_NAME].sort(), JSON.stringify(res.body));
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
  // Without a linked card, only null/omitted-ID legacy rows may match the staff name.
  const omittedId = "10000000-0000-4000-8000-000000000010";
  const seeded = [
    appointment({ id: MINE_BY_NAME, doctor_id: null, doctor_name: MY_NAME.toLowerCase() }),
    appointment({ id: omittedId, doctor_name: MY_NAME }),
    ...[
      [MINE_LINKED, DOCTOR_CARD], [NAMESAKE_ROW, NAMESAKE_CARD], [SOMEONE_ELSES, OTHER_CARD],
    ].map(([id, doctorId]) => appointment({ id, doctor_id: doctorId, doctor_name: MY_NAME })),
  ];
  const { res, log, rows } = await callRouter({ linkedCard: false, appointmentRows: seeded });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(listedIds(res).sort(), [MINE_BY_NAME, omittedId].sort(),
    "a matching name must not admit any explicit doctor ID without a verified linked card");
  assert.deepEqual(rows.appointments, seeded);
  assert.equal(log.filter(query => query.op !== "select").length, 0);
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

test("OW24 linked namesake does not block my separate resource or expose its patient", async () => {
  const { res } = await callRouter({
    method: "POST",
    body: { client: "Новый", starts_at: NAMESAKE_SLOT, durationMinutes: 30 },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.conflict, undefined);
  assert.ok(!JSON.stringify(res.body).includes("Пациент тёзки"));
});

test("OW24-legacy name-only identity still refuses the occupied label without disclosing the linked patient's name", async () => {
  const { res } = await callRouter({
    linkedCard: false,
    appointmentRows: [appointment({ id: NAMESAKE_ROW, doctor_id: NAMESAKE_CARD, doctor_name: MY_NAME,
      client_name: "Пациент тёзки", starts_at: NAMESAKE_SLOT })],
    method: "POST", body: { client: "Новый", starts_at: NAMESAKE_SLOT, durationMinutes: 30 },
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal((res.body.conflict as Record<string, unknown>).clientName, "");
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

const STORED_PHONE = "+77015550101";
const STORED_WHATSAPP = "+77015550102";
const STORED_NOTES = `Allergy noted; call ${STORED_PHONE}, WhatsApp ${STORED_WHATSAPP}`;

function authoredAppointment(author: string | null | undefined) {
  return appointment({
    id: MINE_LINKED,
    doctor_id: DOCTOR_CARD,
    doctor_name: MY_NAME,
    client_name: "Synthetic existing patient",
    client_phone: STORED_PHONE,
    whatsapp: STORED_WHATSAPP,
    notes: STORED_NOTES,
    duration_minutes: 60,
    ...(author === undefined ? {} : { created_by_staff_user_id: author }),
  });
}

function responseItem(res: MockResponse): Record<string, unknown> {
  assert.equal(res.body.success, true, JSON.stringify(res.body));
  assert.equal(res.body.mode, "supabase", JSON.stringify(res.body));
  return (res.body.data as Record<string, unknown>).item as Record<string, unknown>;
}

function assertStoredContacts(item: Record<string, unknown>) {
  assert.equal(item.phone, STORED_PHONE, "stored phone survives the appointment mapper");
  assert.equal(item.whatsapp, STORED_WHATSAPP, "stored WhatsApp survives the appointment mapper");
  assert.equal(item.notes, STORED_NOTES, "own-authored notes are not contact-masked");
  assert.equal(item.createdByStaffUserId, STAFF_MASTER, "trusted author survives readback");
}

function assertHiddenContacts(item: Record<string, unknown>) {
  assert.equal(item.id, MINE_LINKED, "the appointment remains visible, only contacts are hidden");
  assert.equal(item.client, "Synthetic existing patient");
  assert.equal(item.startsAt, "2026-08-20T09:00:00.000Z");
  for (const field of ["phone", "whatsapp", "clientPhone", "client_phone"]) {
    assert.equal(field in item, false, `${field} is absent, not merely empty`);
  }
  assert.match(String(item.notes), /Allergy noted/, "non-contact notes survive");
  assert.notEqual(item.notes, STORED_NOTES, "stored contact-bearing notes are masked");
  assert.ok(!JSON.stringify(item).includes(STORED_PHONE));
  assert.ok(!JSON.stringify(item).includes(STORED_WHATSAPP));
}

for (const failedRead of ["clinic_doctors", "staff_users:full_name", "appointments:doctor_name"]) {
  test(`OW-identity GET refuses ${failedRead} failure without private data or writes`, async () => {
    const seeded = [
      { ...authoredAppointment(STAFF_MASTER), doctor_name: "Synthetic previous doctor name" },
      {
        ...authoredAppointment(STAFF_MASTER), id: MINE_BY_NAME, doctor_id: null,
        client_name: "Synthetic legacy patient",
      },
    ];
    const { res, log, rows } = await callRouter({ appointmentRows: seeded, failReadsOn: [failedRead] });
    assert.ok(log.some(query => query.table === "staff_users" && query.filters.auth_user_id === USER),
      "the authenticated membership lookup still executes");
    assert.notEqual(res.statusCode, 401, "the injected failure must not invalidate authentication");
    assert.notEqual(res.statusCode, 403, "the injected failure must not remove workspace access");
    assert.deepEqual(rows.appointments, seeded, "failed reads must not change the original appointments");
    assert.equal(log.filter(query => query.op !== "select").length, 0, "identity failures cannot cause writes");
    const output = JSON.stringify(res.body);
    assert.deepEqual({
      unavailable: res.statusCode >= 500 && res.statusCode < 600,
      success: res.body.success,
      errorType: typeof res.body.error,
      privatePayloadKeys: [
        "data", "appointments", "items", "item", "client", "phone", "whatsapp", "notes", "startsAt", "doctorId",
      ].filter(key => key in res.body),
      exposedPrivateValues: [
        MINE_LINKED, MINE_BY_NAME, "Synthetic existing patient", "Synthetic legacy patient",
        STORED_PHONE, STORED_WHATSAPP, STORED_NOTES,
      ].filter(value => output.includes(value)),
    }, {
      unavailable: true,
      success: false,
      errorType: "string",
      privatePayloadKeys: [],
      exposedPrivateValues: [],
    }, "one failed identity source must produce an honest unavailable response, not a partial calendar");
  });
}

type NameFallbackRoute = "GET" | "PATCH" | "change-log";

function nameFallbackFixture(fallback: "current" | "historical", doctorId: string | null | undefined) {
  const staffName = fallback === "historical" ? "Synthetic renamed doctor" : MY_NAME;
  const matchedName = fallback === "historical" ? "Synthetic previous doctor" : MY_NAME;
  const anchor = appointment({
    id: MINE_NO_NAME,
    doctor_id: DOCTOR_CARD,
    doctor_name: fallback === "historical" ? matchedName : "",
    client_name: "Synthetic own linked anchor",
  });
  const target: Record<string, unknown> = {
    ...authoredAppointment(STAFF_MASTER),
    id: NAMESAKE_ROW,
    doctor_id: doctorId,
    doctor_name: matchedName,
    client_name: "Synthetic name-fallback patient",
  };
  if (doctorId === undefined) delete target.doctor_id;
  const event = journalEvent(NAMESAKE_ROW, String(target.client_name));
  return {
    matchedName, anchor, target, event,
    options: {
      staffName, cardName: staffName, namesakeName: matchedName,
      appointmentRows: [anchor, target], journalRows: [event],
    },
  };
}

function callNameFallbackRoute(fixture: ReturnType<typeof nameFallbackFixture>, route: NameFallbackRoute) {
  return callRouter({
    ...fixture.options,
    ...(route === "PATCH" ? {
      method: "PATCH", body: { id: fixture.target.id, updates: { status: "confirmed" } },
    } : route === "change-log" ? {
      pathSegments: ["change-log"], query: { entityType: "appointment", entityId: fixture.target.id },
    } : {}),
  });
}

for (const fallback of ["current", "historical"] as const) {
  for (const route of ["GET", "PATCH", "change-log"] as const) {
    test(`OW-namesake ${route} rejects an explicit conflicting doctor ID via ${fallback} name fallback`, async () => {
      const fixture = nameFallbackFixture(fallback, NAMESAKE_CARD);
      const { res, log, rows } = await callNameFallbackRoute(fixture, route);
      const data = res.body.data as Record<string, unknown> | undefined;
      const output = JSON.stringify(res.body);
      const ids = (value: unknown) => (Array.isArray(value) ? value : []).map(item => String(item.id));
      assert.deepEqual({
        status: res.statusCode,
        success: res.body.success,
        appointmentIds: ids(data?.appointments),
        itemIds: ids(data?.items),
        events: route === "change-log" ? res.body.events : null,
        exposedPrivateValues: [fixture.target.id, fixture.target.client_name, STORED_PHONE, STORED_WHATSAPP, STORED_NOTES]
          .filter(value => output.includes(String(value))),
        writes: log.filter(query => query.op !== "select").map(query => [query.table, query.op]),
        journalReads: log.filter(query => query.table === "audit_logs" && query.op === "select").length,
      }, {
        status: route === "PATCH" ? 404 : 200,
        success: route !== "PATCH",
        appointmentIds: route === "GET" ? [MINE_NO_NAME] : [],
        itemIds: route === "GET" ? [MINE_NO_NAME] : [],
        events: route === "change-log" ? [] : null,
        exposedPrivateValues: [],
        writes: [],
        journalReads: 0,
      }, "an explicit other doctor ID must override matching names and stored authorship");
      assert.deepEqual(rows.appointments, fixture.options.appointmentRows);
      assert.deepEqual(rows.audit_logs, fixture.options.journalRows);
    });
  }
}

const positiveNameFallbackCases = [
  { label: "own doctor ID with an old doctor name", fallback: "current", doctorId: DOCTOR_CARD, doctorName: "Synthetic older doctor name" },
  { label: "own doctor ID with a null doctor name", fallback: "current", doctorId: DOCTOR_CARD, doctorName: null },
  { label: "own doctor ID with an omitted doctor name", fallback: "current", doctorId: DOCTOR_CARD, doctorName: undefined },
  { label: "current name fallback with a null doctor ID", fallback: "current", doctorId: null },
  { label: "current name fallback with an omitted doctor ID", fallback: "current", doctorId: undefined },
  { label: "historical name fallback with a null doctor ID", fallback: "historical", doctorId: null },
  { label: "historical name fallback with an omitted doctor ID", fallback: "historical", doctorId: undefined },
] as const;

for (const scenario of positiveNameFallbackCases) {
  test(`OW-namesake preserves ${scenario.label} across GET, PATCH and change-log`, async () => {
    for (const route of ["GET", "PATCH", "change-log"] as const) {
      const fixture = nameFallbackFixture(scenario.fallback, scenario.doctorId);
      if ("doctorName" in scenario) {
        if (scenario.doctorName === undefined) delete fixture.target.doctor_name;
        else fixture.target.doctor_name = scenario.doctorName;
      }
      const { res, log, rows } = await callNameFallbackRoute(fixture, route);
      assert.equal(res.statusCode, 200, `${route}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.success, true);
      assert.equal(res.body.mode, "supabase");
      if (route === "change-log") {
        const events = res.body.events as Record<string, unknown>[];
        assert.deepEqual(events.map(event => event.id), [fixture.event.id]);
        assert.ok(JSON.stringify(events).includes(String(fixture.target.client_name)), "own history remains nonempty");
      } else {
        const data = res.body.data as Record<string, unknown>;
        const items = data.appointments as Record<string, unknown>[];
        const item = route === "GET" ? items.find(item => item.id === fixture.target.id) : responseItem(res);
        assert.ok(item, `${route}: own or legacy appointment remains accessible`);
        assert.equal(item.id, fixture.target.id);
        assertStoredContacts(item);
        if (route === "GET") assert.deepEqual(listedIds(res).sort(), [MINE_NO_NAME, NAMESAKE_ROW].sort());
        else assert.equal(item.status, "confirmed");
      }
      const writes = log.filter(query => query.op !== "select");
      assert.deepEqual(writes.map(query => [query.table, query.op]), route === "PATCH"
        ? [["appointments", "update"], ["audit_logs", "insert"]] : []);
      const stored = (rows.appointments as Record<string, unknown>[]).find(item => item.id === fixture.target.id);
      assert.deepEqual(stored, route === "PATCH"
        ? { ...fixture.target, status: "confirmed", updated_at: stored?.updated_at } : fixture.target);
      if (scenario.fallback === "historical") {
        assert.ok(log.some(query => query.table === "appointments" && query.filters.doctor_id === DOCTOR_CARD),
          "historical identity is anchored to the acting doctor's linked appointment");
      }
    }
  });
}

test("OW-author GET retains a doctor's own stored appointment contacts", async () => {
  const seeded = authoredAppointment(STAFF_MASTER);
  const { res, log, rows } = await callRouter({ appointmentRows: [seeded] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.mode, "supabase");
  const items = (res.body.data as Record<string, unknown>).appointments as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assertStoredContacts(items[0]);
  assert.deepEqual(rows.appointments, [seeded], "a read does not mutate the stored fixture");
  assert.equal(log.filter((query) => query.op !== "select").length, 0);
});

test("OW-author PATCH echoes own stored contacts after a status-only update", async () => {
  const seeded = authoredAppointment(STAFF_MASTER);
  const { res, log, rows } = await callRouter({
    appointmentRows: [seeded],
    method: "PATCH",
    body: { id: MINE_LINKED, updates: { status: "confirmed" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const writes = log.filter((query) => query.table === "appointments" && query.op === "update");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].filters, { id: MINE_LINKED, workspace_id: WORKSPACE });
  assert.deepEqual(Object.keys(writes[0].row ?? {}).sort(), ["status", "updated_at"]);
  const stored = (rows.appointments as Record<string, unknown>[])[0];
  assert.deepEqual(stored, { ...seeded, status: "confirmed", updated_at: writes[0].row?.updated_at });
  const item = responseItem(res);
  assert.equal(item.id, MINE_LINKED);
  assert.equal(item.status, "confirmed");
  assertStoredContacts(item);
});

test("OW-author POST stamps the authenticated author and ignores both spoofed author aliases", async () => {
  const { res, log, rows } = await callRouter({
    appointmentRows: [],
    method: "POST",
    // Doctor contact writes are intentionally not part of this mapper contract.
    body: {
      client: "Synthetic new patient",
      startsAt: "2090-10-20T23:00:00.000Z",
      durationMinutes: 60,
      createdByStaffUserId: STAFF_OTHER,
      created_by_staff_user_id: STAFF_OTHER,
    },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const writes = log.filter((query) => query.table === "appointments" && query.op === "insert");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].row?.created_by_staff_user_id, STAFF_MASTER);
  assert.equal(writes[0].row?.doctor_id, DOCTOR_CARD);
  const stored = (rows.appointments as Record<string, unknown>[])[0];
  assert.equal(stored.created_by_staff_user_id, STAFF_MASTER);
  assert.equal((res.body.data as Record<string, unknown>).clientLinked, true);
  const item = responseItem(res);
  assert.equal(item.id, stored.id);
  assert.equal(item.createdByStaffUserId, STAFF_MASTER, "POST echo must retain the server's author, not the spoof");
});

const hiddenAuthors = [
  { label: "another staff author", author: STAFF_OTHER },
  { label: "null author", author: null },
  { label: "unknown legacy author", author: undefined },
];

for (const { label, author } of hiddenAuthors) {
  for (const method of ["GET", "PATCH"]) {
    test(`OW-author ${method} hides contacts for ${label}`, async () => {
      const seeded = authoredAppointment(author);
      const { res, rows } = await callRouter({
        appointmentRows: [seeded],
        method,
        ...(method === "PATCH" ? { body: { id: MINE_LINKED, updates: { status: "confirmed" } } } : {}),
      });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const item = method === "PATCH"
        ? responseItem(res)
        : ((res.body.data as Record<string, unknown>).appointments as Record<string, unknown>[])[0];
      assert.equal(res.body.mode, "supabase");
      assertHiddenContacts(item);
      const stored = (rows.appointments as Record<string, unknown>[])[0];
      assert.equal(stored.client_phone, STORED_PHONE, "redaction must not clear the stored phone");
      assert.equal(stored.whatsapp, STORED_WHATSAPP);
      assert.equal(stored.notes, STORED_NOTES);
      assert.equal(stored.created_by_staff_user_id, author);
    });
  }

  test(`OW-author PATCH cannot grant contacts by spoofing ${label}`, async () => {
    const { res, log, rows } = await callRouter({
      appointmentRows: [authoredAppointment(author)],
      method: "PATCH",
      body: {
        id: MINE_LINKED,
        updates: { status: "confirmed", createdByStaffUserId: STAFF_MASTER, created_by_staff_user_id: STAFF_MASTER },
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const write = log.find((query) => query.table === "appointments" && query.op === "update");
    assert.ok(write?.row);
    assert.equal("created_by_staff_user_id" in write.row, false);
    assert.equal("createdByStaffUserId" in write.row, false);
    assert.equal((rows.appointments as Record<string, unknown>[])[0].created_by_staff_user_id, author);
    assertHiddenContacts(responseItem(res));
  });
}

for (const { label, target } of [
  {
    label: "another doctor with a different name",
    target: { ...authoredAppointment(STAFF_MASTER), id: SOMEONE_ELSES, doctor_id: OTHER_CARD, doctor_name: "Динара" },
  },
  {
    label: "another workspace with the same doctor name",
    target: { ...authoredAppointment(null), id: FOREIGN_APPOINTMENT, workspace_id: OTHER_WORKSPACE, doctor_id: FOREIGN_CARD },
  },
]) {
  for (const method of ["GET", "PATCH"]) {
    test(`OW-author ${method} never exposes ${label}`, async () => {
      const { res, log, rows } = await callRouter({
        appointmentRows: [target],
        method,
        ...(method === "PATCH" ? { body: {
          id: target.id,
          updates: { status: "confirmed", createdByStaffUserId: STAFF_MASTER, created_by_staff_user_id: STAFF_MASTER },
        } } : {}),
      });
      assert.equal(res.statusCode, method === "GET" ? 200 : 404, JSON.stringify(res.body));
      if (method === "GET") assert.deepEqual(listedIds(res), []);
      const output = JSON.stringify(res.body);
      for (const privateValue of ["Synthetic existing patient", STORED_PHONE, STORED_WHATSAPP, STORED_NOTES]) {
        assert.ok(!output.includes(privateValue), `scoped response leaked ${privateValue}`);
      }
      assert.equal(log.filter((query) => query.op !== "select").length, 0);
      assert.deepEqual(rows.appointments, [target]);
    });
  }
}

test("OW-author receptionist control reads the same stored contacts regardless of author", async () => {
  const seeded = authoredAppointment(null);
  const { res } = await callRouter({ role: "receptionist", appointmentRows: [seeded] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const items = (res.body.data as Record<string, unknown>).appointments as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0].phone, STORED_PHONE);
  assert.equal(items[0].whatsapp, STORED_WHATSAPP);
  assert.equal(items[0].notes, STORED_NOTES);
});

for (const method of ["POST", "PATCH"]) {
  test(`OW-author ${method} still refuses doctor contact writes despite a spoofed author`, async () => {
    const seeded = authoredAppointment(STAFF_MASTER);
    const fields = { phone: STORED_PHONE, createdByStaffUserId: STAFF_MASTER, created_by_staff_user_id: STAFF_MASTER };
    const { res, log, rows } = await callRouter({
      appointmentRows: [seeded],
      method,
      body: method === "POST"
        ? { ...fields, client: "Synthetic new patient", startsAt: "2090-10-20T23:00:00.000Z" }
        : { id: MINE_LINKED, updates: { ...fields, status: "confirmed" } },
    });
    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(log.filter((query) => query.op !== "select").length, 0);
    assert.deepEqual(rows.appointments, [seeded]);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Запись клиента переживает базу, отставшую от кода.
//
// Что было. Мастер салона не мог записать ни одного клиента: «Не удалось
// создать запись: Сбой на стороне сервиса». В логе Vercel — отказ базы «Could
// not find the duration_minutes column of appointments in the schema cache»:
// на боевой базе не применили 012, а сервер шлёт duration_minutes в КАЖДОЙ
// вставке. Обход на этот случай в коде был — но знал только про колонки связей
// 032 и 033, поэтому снимал не то, что назвала ошибка, и повторял вставку
// ровно один раз.
//
// Набор проверяет ПОВЕДЕНИЕ, а не текст исходника: каждая проверка ниже
// краснеет от мутации того кода, который она называет. Пины по тексту остались
// только там, где проверять нечего иначе — на файле миграции и на чек-листе
// владельца.
//
// Ничто здесь не ходит в production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const APPOINTMENT_ID = "abababab-abab-4bab-8bab-abababababab";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "header.payload.signature";
const SLOT_START = "2026-08-20T09:00:00.000Z";
/** Уже занятый слот — в другое время, чтобы новая бронь не спорила сама с собой. */
const OTHER_SLOT = "2026-08-20T14:00:00.000Z";

/** Ровно то, чего не хватало боевой базе. */
const COLUMNS_012 = ["duration_minutes", "whatsapp", "source"];

type Write = { table: string; op: "insert" | "update"; row: Record<string, unknown> };
type Attempts = { writes: number };

type LagState = {
  /** Колонок нет в базе. Множество живое: кэш схемы умеет «догонять» — см. healAfter. */
  missing: Set<string>;
  /** Отказ, не относящийся к колонкам вовсе (например, нарушение уникальности). */
  writeError?: { code: string; message: string } | null;
  /** После какой по счёту попытки записи колонки «появляются» — модель устаревшего кэша схемы. */
  healAfter?: number;
  attempts: Attempts;
};

/**
 * База, у которой части колонок просто нет.
 *
 * Отказ дословно повторяет боевой: PostgREST называет ОДНУ колонку и код
 * PGRST204. Именно «одну» здесь важно — на этом и сломался единственный повтор.
 */
function laggingClient(state: LagState, writes: Write[], rows: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const filters: Record<string, unknown> = {};
      let op: "select" | "insert" | "update" = "select";
      let written: Record<string, unknown> = {};
      let requested = "*";

      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) =>
          Object.entries(filters).every(([column, value]) => row[column] === value),
        );

      const settle = (resolve: (value: { data: unknown; error: unknown }) => void) => {
        if (op === "select") {
          // Недостающая колонка ломает и чтение — форма отказа тут другая, её
          // даёт сам Postgres. Без этого «отставшая база» в наборе была бы
          // вдвое добрее настоящей: проверка пересечений читает
          // duration_minutes явным списком.
          const named = [...state.missing].find((column) => requested.includes(column));
          if (named) {
            resolve({ data: null, error: { code: "42703", message: `column ${table}.${named} does not exist` } });
            return;
          }
          resolve({ data: matching(), error: null });
          return;
        }
        state.attempts.writes += 1;
        if (state.healAfter !== undefined && state.attempts.writes >= state.healAfter) state.missing.clear();

        if (state.writeError) {
          resolve({ data: null, error: state.writeError });
          return;
        }
        // Первая недостающая колонка строки — база называет по одной за раз.
        const named = Object.keys(written).find((column) => state.missing.has(column));
        if (named) {
          resolve({
            data: null,
            error: { code: "PGRST204", message: `Could not find the ${named} column of ${table} in the schema cache` },
          });
          return;
        }
        writes.push({ table, op, row: { ...written } });
        resolve({ data: { id: APPOINTMENT_ID, ...written }, error: null });
      };

      Object.assign(builder, {
        select: (columns?: unknown) => { requested = typeof columns === "string" ? columns : "*"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        in: () => chain(),
        gte: () => chain(),
        lt: () => chain(),
        insert: (row: unknown) => { op = "insert"; written = row as Record<string, unknown>; return chain(); },
        upsert: (row: unknown) => { op = "insert"; written = row as Record<string, unknown>; return chain(); },
        update: (row: unknown) => { op = "update"; written = row as Record<string, unknown>; return chain(); },
        eq(column: string, value: unknown) { filters[column] = value; return chain(); },
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
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

async function callRouter(options: {
  missing?: string[];
  writeError?: { code: string; message: string };
  healAfter?: number;
  method?: string;
  resource?: string;
  body: Record<string, unknown>;
}) {
  const writes: Write[] = [];
  const attempts: Attempts = { writes: 0 };
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER_A, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const rows: Record<string, unknown[]> = {
    tasks: [{ id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, title: "Перезвонить", status: "open" }],
    clients: [{ id: CLIENT_ID, workspace_id: WORKSPACE_A, full_name: "Мария Ли" }],
    staff_users: [{ id: STAFF_A, auth_user_id: USER_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" }],
    clinic_services: [{ id: SERVICE_ID, name: "Маникюр", duration_minutes: 90, is_active: true, workspace_id: WORKSPACE_A }],
    appointments: [
      { id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, client_name: "Мария Ли", doctor_name: "Айгуль", starts_at: OTHER_SLOT, status: "scheduled" },
    ],
  };

  const state: LagState = {
    missing: new Set(options.missing ?? []),
    writeError: options.writeError ?? null,
    healAfter: options.healAfter,
    attempts,
  };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => laggingClient(state, writes, rows));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };

  const res = mockResponse();
  try {
  await routerModule.default(
    {
      method: options.method ?? "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      query: { path: [options.resource ?? "appointments"], workspaceId: WORKSPACE_A },
      body: options.body,
    },
    res,
  );
  } finally {
    console.warn = realWarn;
  }
  return {
    res,
    attempts,
    warnings,
    writes: writes.filter((w) => w.table === "appointments"),
    allWrites: writes,
  };
}

const booking = (over: Record<string, unknown> = {}) => ({
  client: "Мария Ли",
  phone: "+7 701 245 18 44",
  doctor: "Айгуль",
  starts_at: SLOT_START,
  status: "scheduled",
  ...over,
});

test("CL1 без duration_minutes запись всё равно создаётся", async () => {
  const { res, writes } = await callRouter({ missing: ["duration_minutes"], body: booking() });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes.length, 1, "сохранилась ровно одна строка");
  assert.ok(!("duration_minutes" in writes[0].row), "недостающая колонка снята");
  assert.equal(writes[0].row.client_name, "Мария Ли", "а сама запись — на месте");
});

test("CL2 снимается названная колонка, а не всё необязательное разом", async () => {
  const { res, writes } = await callRouter({
    missing: ["duration_minutes"],
    body: booking({ serviceId: SERVICE_ID }),
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes[0].row.service_id, SERVICE_ID, "связь с услугой не потеряна");
});

test("CL3 отставание сразу на две миграции тоже переживается", async () => {
  const { res, writes } = await callRouter({
    missing: ["duration_minutes", "service_id"],
    body: booking({ serviceId: SERVICE_ID }),
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(!("duration_minutes" in writes[0].row) && !("service_id" in writes[0].row));
});

test("CL4 правка записи переживает то же отставание", async () => {
  const { res, writes } = await callRouter({
    missing: ["duration_minutes"],
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { status: "confirmed", durationMinutes: 45 } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writes.at(-1)?.op, "update");
  assert.equal(writes.at(-1)?.row.status, "confirmed", "то, что база принять может, сохранено");
  assert.ok(!("duration_minutes" in (writes.at(-1)?.row ?? {})));
});

test("CL5 боевой случай целиком: нет всех трёх колонок 012 — запись создаётся", async () => {
  // Ровно то состояние, в котором мастер не мог записать ни одного клиента.
  const { res, writes } = await callRouter({ missing: [...COLUMNS_012], body: booking() });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes.length, 1);
  for (const column of COLUMNS_012) assert.ok(!(column in writes[0].row), `${column} снята`);
  assert.equal(writes[0].row.starts_at, SLOT_START, "время визита сохранено");
});

test("CL6 потолок повторов считается по колонкам: 012 плюс 032 — всё ещё запись, а не отказ", async () => {
  // Потолок, посчитанный по числу МИГРАЦИЙ, здесь исчерпывался на четвёртой
  // колонке, и мастер снова получал «Сбой на стороне сервиса».
  const { res, writes } = await callRouter({
    missing: [...COLUMNS_012, "service_id"],
    body: booking({ serviceId: SERVICE_ID }),
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes.length, 1, "и сохранилась ровно одна строка, а не несколько");
  assert.equal(writes[0].row.client_name, "Мария Ли");
});

test("CL7 отказ не про колонку не лечится повтором без колонок", async () => {
  // Иначе любой сбой базы молча снимал бы связи: запись сохранялась бы, но уже
  // не той, какой её создавали.
  const { res, writes, attempts } = await callRouter({
    writeError: { code: "23505", message: "duplicate key value violates unique constraint" },
    body: booking({ serviceId: SERVICE_ID }),
  });
  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(writes.length, 0, "ничего не сохранено");
  assert.equal(attempts.writes, 1, "и повторов не было вовсе");
});

test("CL8 незнакомая колонка не крутит цикл до таймаута", async () => {
  const { res, writes, attempts } = await callRouter({
    writeError: { code: "PGRST204", message: "Could not find the mystery_column of appointments in the schema cache" },
    body: booking(),
  });
  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(writes.length, 0);
  assert.ok(attempts.writes <= 4, `попыток должно быть немного, было ${attempts.writes}`);
});

test("CL9 устаревший кэш схемы не стоит оператору введённого значения", async () => {
  // Секунды между ALTER TABLE и перечитыванием кэша: колонка в базе ЕСТЬ, а
  // PostgREST отвечает как будто её нет. Дословный повтор проходит целым — без
  // него длительность визита молча превратилась бы в шестьдесят минут.
  const { res, writes } = await callRouter({
    missing: ["duration_minutes"],
    healAfter: 2,
    body: booking({ durationMinutes: 90 }),
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes[0].row.duration_minutes, 90, "введённая длительность сохранена, а не снята");
});

test("CL10 правка, от которой осталась одна метка времени, не отвечает «сохранено»", async () => {
  const { res, writes } = await callRouter({
    missing: ["duration_minutes"],
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { durationMinutes: 90 } },
  });
  assert.notEqual(res.statusCode, 200, `тихий успех: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, false, "и ответ честно говорит об отказе");
  const saved = writes.at(-1)?.row ?? {};
  assert.ok(!("duration_minutes" in saved), "значение действительно не сохранилось");
  // Отказ отвечается ПОСЛЕ того, как повтор уже прошёл в базу: там осталась
  // сдвинутая метка времени и больше ничего. Это закрепляется явно, иначе
  // проверка одинаково зеленела бы и на «не записали вовсе».
  assert.deepEqual(Object.keys(saved), ["updated_at"], "в базу ушла ровно одна служебная колонка");
});

test("CL11 лог называет владельцу миграцию и колонку — иначе он не знает, что применять", async () => {
  const { warnings } = await callRouter({ missing: ["duration_minutes"], body: booking() });
  assert.ok(
    warnings.some((line) => line.includes("012") && line.includes("duration_minutes")),
    `в логе нет миграции и колонки: ${JSON.stringify(warnings)}`,
  );
});

test("CL12 миграция 039 добавляет ровно те колонки и повторный запуск безопасен", async () => {
  const sql = await readFile(
    path.join(repoRoot, "migrations", "039_appointments_calendar_columns_repair.sql"),
    "utf8",
  );
  for (const column of ["duration_minutes integer default 60", "whatsapp text", "source text"]) {
    assert.ok(sql.includes(`add column if not exists ${column}`), `${column} добавляется идемпотентно`);
  }
  assert.ok(!/\balter table\s+public\.appointments\s+drop\b/i.test(sql), "ничего не сносится");
  assert.ok(/create index if not exists/.test(sql), "индексы тоже идемпотентны");
  assert.ok(sql.trim().startsWith("--") && sql.includes("begin;") && sql.includes("commit;"), "одна транзакция");
});

test("CL13 039 стоит в чек-листе владельца — иначе её просто не применят", async () => {
  const doc = await readFile(path.join(repoRoot, "docs", "MIGRATIONS.md"), "utf8");
  const pending = doc.slice(doc.indexOf("## Ждут применения руками"));
  assert.ok(pending.includes("039_appointments_calendar_columns_repair.sql"), "миграция названа в списке ожидающих");
});

test("CL14 без duration_minutes защита от двойной записи продолжает работать", async () => {
  // На отставшей базе проверка пересечений падала целиком — салон терял
  // единственную серверную защиту занятого времени, и узнать об этом можно
  // было только из лога Vercel.
  const { res, warnings } = await callRouter({
    missing: [...COLUMNS_012],
    body: booking({ starts_at: OTHER_SLOT }),
  });
  assert.equal(res.statusCode, 409, `двойная запись прошла: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "appointment_conflict");
  assert.ok(
    warnings.some((line) => line.includes("without duration_minutes")),
    "и оператор узнаёт, что длительность соседнего визита взята по умолчанию",
  );
});

test("CL15 частичная потеря доезжает до экрана, а не остаётся в логе", async () => {
  const { res, writes } = await callRouter({
    missing: ["duration_minutes", "whatsapp"],
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { status: "confirmed", durationMinutes: 90, whatsapp: "+7 701 000 00 00" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writes.at(-1)?.row.status, "confirmed", "то, что база принять может, сохранено");
  const unsaved = (res.body.data as Record<string, unknown>).unsaved;
  assert.ok(Array.isArray(unsaved), `ответ молчит о потере: ${JSON.stringify(res.body)}`);
  assert.deepEqual([...(unsaved as string[])].sort(), ["WhatsApp", "длительность"].sort());
});

test("CL16 задача, от которой ничего не сохранилось, тоже не отвечает «сохранено»", async () => {
  // Ветка задач старше и жила рядом с той же бедой. Отвечать на один и тот же
  // отказ противоположно в двух местах одной функции — недосмотр, а не решение.
  const { res } = await callRouter({
    missing: ["client_id"],
    method: "PATCH",
    resource: "tasks",
    body: { id: APPOINTMENT_ID, updates: { clientId: CLIENT_ID } },
  });
  assert.notEqual(res.statusCode, 200, `тихий успех: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, false);
});

test("CL17 журнал изменений не пишет то, чего в базе нет", async () => {
  // Лента «История изменений» — единственный ответ продукта на «кто и что
  // менял». Событие о связи, которой в базе не появилось, делает её ложью.
  const { allWrites } = await callRouter({
    missing: ["client_id"],
    method: "PATCH",
    resource: "tasks",
    // Название меняется по-настоящему: правка, не изменившая ничего, событием
    // не считается и в журнал не пишется вовсе — на пустом журнале проверка
    // была бы зелёной всегда.
    body: { id: APPOINTMENT_ID, updates: { clientId: CLIENT_ID, title: "Позвонить вечером" } },
  });
  const journal = allWrites.filter((w) => w.table === "audit_logs");
  assert.equal(journal.length, 1, "событие в журнале есть");
  const changes = ((journal[0].row.metadata as Record<string, unknown>).changes ?? []) as Array<Record<string, unknown>>;
  assert.ok(changes.some((change) => change.field === "title"), "настоящая правка записана");
  assert.ok(
    !changes.some((change) => change.field === "client_id"),
    `в журнале связь, которой не сохранилось: ${JSON.stringify(changes)}`,
  );
});

test("CL18 «нет таблицы» не обвиняет миграцию 012 и не повторяется впустую", async () => {
  const { res, attempts, warnings } = await callRouter({
    writeError: { code: "PGRST205", message: "Could not find the table 'public.appointments' in the schema cache" },
    body: booking(),
  });
  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(attempts.writes, 1, "повторять нечего: колонки ни при чём");
  assert.ok(
    !warnings.some((line) => line.includes("migration 012")),
    `лог обвиняет невиновную миграцию: ${JSON.stringify(warnings)}`,
  );
});

test("CL19 создание называет потерю тем же способом, что и правка", async () => {
  const { res, writes } = await callRouter({ missing: ["whatsapp"], body: booking({ whatsapp: "+7 701 000 00 00" }) });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes.length, 1, "запись создана");
  const unsaved = (res.body.data as Record<string, unknown>).unsaved;
  assert.deepEqual(unsaved, ["WhatsApp"], `ответ молчит о потере: ${JSON.stringify(res.body)}`);
});

test("CL20 отставшая база без колонки автора не блокирует запись клиента", async () => {
  // Регрессия 21.08.2026: колонка автора уехала в INSERT раньше миграции 043,
  // и администратор салона получил «Сбой на стороне сервиса» на каждой
  // попытке записать клиента. Каталог обходов обязан знать про неё.
  const { res, writes } = await callRouter({ missing: ["created_by_staff_user_id"], body: booking() });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes.length, 1, "запись создана");
  assert.ok(!("created_by_staff_user_id" in writes[0].row), "недостающая колонка снята");
});

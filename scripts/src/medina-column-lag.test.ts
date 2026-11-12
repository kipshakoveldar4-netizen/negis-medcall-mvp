import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appointmentSpyBody, appointmentSpyRows, withAppointmentCreateRpcSpy } from "./appointment-create-rpc-spy.js";

// Current create/PATCH require their complete actor-bound SQL protocol. The
// historical remove-a-column fallback is no longer an admitted appointment
// writer. These SDK doubles test refusal/no fallback, not SQL atomicity; that
// is exercised by the native appointment HTTP suite. Task fallback remains.
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
  table: string;
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
          const named = table === state.table && [...state.missing].find((column) => requested.includes(column));
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
        const named = table === state.table && Object.keys(written).find((column) => state.missing.has(column));
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
    clinic_doctors: [{ id: "66666666-6666-4666-8666-666666666666", workspace_id: WORKSPACE_A, full_name: "Айгуль", is_active: true, capacity: 2 }],
    workspace_settings: [{ workspace_id: WORKSPACE_A, key: "clinic_schedule", value: { timeZone: "UTC" } }],
    appointments: [
      { id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, client_name: "Мария Ли", doctor_name: "Айгуль", starts_at: OTHER_SLOT, status: "scheduled" },
    ],
  };

  const state: LagState = {
    table: options.resource ?? "appointments",
    missing: new Set(options.missing ?? []),
    writeError: options.writeError ?? null,
    healAfter: options.healAfter,
    attempts,
  };

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };
  const rpcCalls: string[] = [];
  const client = withAppointmentCreateRpcSpy(laggingClient(state, writes, appointmentSpyRows(rows)));
  const rpc = client.rpc.bind(client);
  client.rpc = async (name, args) => { rpcCalls.push(name); return rpc(name, args); };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => client);

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
      body: appointmentSpyBody(options.resource ?? "appointments", options.method ?? "POST", options.body),
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
    rpcCalls,
  };
}

const booking = (over: Record<string, unknown> = {}) => ({
  clientId: CLIENT_ID,
  client: "Мария Ли",
  phone: "+7 701 245 18 44",
  doctor: "Айгуль",
  starts_at: SLOT_START,
  status: "scheduled",
  ...over,
});

for (const method of ["POST", "PATCH"]) for (const missing of [
  ["duration_minutes"], ["whatsapp"], ["source"], ["service_id"], ["doctor_id"],
  ["duration_minutes", "whatsapp", "source", "service_id", "doctor_id"], ["unknown_column"],
]) test("current " + method + " never discards missing schema fields: " + missing.join(","), async () => {
  const updates = { status: "confirmed", durationMinutes: 90, whatsapp: "+77010000000", source: "Owned source",
    serviceId: SERVICE_ID, doctorId: "66666666-6666-4666-8666-666666666666" };
  // The named unknown column is injected as the provider's error below.
  const result = await callRouter({
    missing: missing.includes("unknown_column") ? [] : missing,
    ...(missing.includes("unknown_column") ? { writeError: { code: "PGRST204", message: "Missing owned unknown_column" } } : {}),
    method,
    body: method === "PATCH" ? { id: APPOINTMENT_ID, updates } : booking(updates),
  });
  assert.equal(result.res.statusCode, 503, JSON.stringify(result.res.body));
  assert.equal(result.res.body.success, false);
  assert.equal(result.res.body.code, method === "POST" ? "appointment_create_unavailable" : "appointment_patch_unavailable");
  assert.equal(result.attempts.writes, 1, "One RPC attempt, no column-removing/direct-write fallback");
  assert.deepEqual(result.allWrites, [], "No domain or fabricated audit commit");
  assert.deepEqual(result.rpcCalls, method === "POST"
    ? ["read_crm_appointment_request_v2", "create_crm_appointment_v2"] : ["patch_crm_appointment_journaled"]);
});

for (const method of ["POST", "PATCH"]) for (const [code, message, status] of [
  ["PGRST205", "Could not find public.appointments", 503],
  ["PGRST202", "Missing owned current RPC", 503],
  ["23P01", "appointment_capacity_exceeded", 409],
  ["23P01", "another_exclusion", 502],
  ["23514", "appointment_capacity_exceeded", 502],
  ["23P01", "appointment_capacity_exceeded: private-client", 502],
] as const) test("current " + method + " preserves exact provider error classification: " + code + "/" + message, async () => {
  const result = await callRouter({ writeError: { code, message }, method,
    body: method === "PATCH" ? { id: APPOINTMENT_ID, updates: { status: "confirmed" } } : booking() });
  assert.equal(result.res.statusCode, status, JSON.stringify(result.res.body));
  assert.equal(result.res.body.success, false);
  if (status === 409) assert.equal(result.res.body.code, "appointment_conflict");
  assert.equal(result.attempts.writes, 1);
  assert.deepEqual(result.allWrites, []);
  assert.equal(JSON.stringify(result.res.body).includes("private-client"), false);
});

for (const method of ["POST", "PATCH"]) test("capacity errors never become appointment conflicts on tasks: " + method, async () => {
  const result = await callRouter({ resource: "tasks", method,
    writeError: { code: "23P01", message: "appointment_capacity_exceeded" },
    body: method === "PATCH" ? { id: APPOINTMENT_ID, updates: { title: "Owned changed task" } } : { title: "Owned task" } });
  assert.equal(result.res.statusCode, 502, JSON.stringify(result.res.body));
  assert.notEqual(result.res.body.code, "appointment_conflict");
  assert.equal(result.attempts.writes, 1);assert.deepEqual(result.allWrites, []);assert.deepEqual(result.rpcCalls, []);
});

test("current create keeps author and all supplied fields when the schema is ready", async () => {
  const result = await callRouter({ body: booking({ durationMinutes: 90, whatsapp: "+77010000000", source: "Owned source" }) });
  assert.equal(result.res.statusCode, 201, JSON.stringify(result.res.body));
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].row.created_by_staff_user_id, STAFF_A);
  assert.equal(result.writes[0].row.duration_minutes, 90);
  assert.equal(result.writes[0].row.whatsapp, "+77010000000");
  assert.equal(result.writes[0].row.source, "Owned source");
  assert.equal((result.res.body.data as Record<string, unknown>).unsaved, undefined);
});

test("missing author cannot silently remove provenance from a current create", async () => {
  const result = await callRouter({ missing: ["created_by_staff_user_id"], body: booking() });
  assert.equal(result.res.statusCode, 503, JSON.stringify(result.res.body));
  assert.deepEqual(result.allWrites, []);
  assert.equal(result.attempts.writes, 1);
});

test("a schema that heals only on a second write does not trigger an automatic retry", async () => {
  const result = await callRouter({ missing: ["duration_minutes"], healAfter: 2, body: booking() });
  assert.equal(result.res.statusCode, 503, JSON.stringify(result.res.body));
  assert.equal(result.attempts.writes, 1);
  assert.deepEqual(result.allWrites, []);
});

test("an advisory busy row cannot authorize a column-stripping save on an incomplete schema", async () => {
  // Capacity is now enforced inside the real SQL RPC; its concurrent two-seat
  // case is in crm-appointment-native-http.test.mjs, not this query double.
  const result = await callRouter({ missing: [...COLUMNS_012], body: booking({ starts_at: OTHER_SLOT }) });
  assert.equal(result.res.statusCode, 503, JSON.stringify(result.res.body));
  assert.equal(result.res.body.code, "appointment_create_unavailable");
  assert.deepEqual(result.allWrites, []);
  assert.equal(result.attempts.writes, 1);
  assert.deepEqual(result.rpcCalls, ["read_crm_appointment_request_v2", "create_crm_appointment_v2"]);
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

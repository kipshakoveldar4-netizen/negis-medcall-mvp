import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CRM — two appointments for one doctor at one time.
//
// The rule existed only in the browser, over whatever array the page happened
// to hold (AppointmentsPage findConflict). That is wrong twice over. It is
// wrong at scale, because the list read has no limit and is therefore capped
// by whatever PostgREST is configured with — a setting this repository does
// not define — so past that point the conflicting appointment is simply not in
// the window and the clinic double-books with no warning. And it is wrong at
// any scale, because two registrars on two devices each hold their own array:
// neither can see the booking the other made a second ago.
//
// It stays advisory. Clinics overbook deliberately — an urgent case goes into
// an occupied slot — so the server refuses with 409 and an explicit
// `allowConflict` overrides it. What changes is that the override becomes a
// decision someone made rather than a gap nobody saw.
//
// The spy here filters for real (eq/gte/lt), unlike the shared one: the whole
// point of these tests is the range query and the overlap arithmetic, and a
// stub that answers every query with every row would prove nothing.
//
// Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const pagePath = path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EXISTING_ID = "abababab-abab-4bab-8bab-abababababab";
const OTHER_ID = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
const TOKEN = "header.payload.signature";

const DOCTOR = "д-р Сауле";
/** 10:00 UTC, one hour. */
const SLOT_START = "2026-09-01T10:00:00.000Z";
const SLOT_END = "2026-09-01T11:00:00.000Z";

type QueryLog = { table: string; op: string; filters: Record<string, unknown> };

type Filter = { column: string; op: "eq" | "gte" | "lt"; value: unknown };

function occupiedRow(over: Record<string, unknown> = {}) {
  return {
    id: EXISTING_ID,
    workspace_id: WORKSPACE_A,
    client_name: "Лаура Ким",
    doctor_name: DOCTOR,
    starts_at: SLOT_START,
    duration_minutes: 60,
    status: "scheduled",
    ...over,
  };
}

/** A spy that actually applies eq/gte/lt, so the range query is really exercised. */
function spyClient(rows: Record<string, unknown[]>, log: QueryLog[], failTables: Set<string>) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, op: "select", filters: {} };
      log.push(entry);
      const applied: Filter[] = [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const failure = failTables.has(table) ? { message: `relation ${table} unavailable`, code: "42P01" } : null;

      const matching = () =>
        (rows[table] ?? []).map((r) => r as Record<string, unknown>).filter((row) =>
          applied.every((f) => {
            const value = row[f.column];
            if (f.op === "eq") return value === f.value;
            const left = String(value ?? "");
            const right = String(f.value ?? "");
            return f.op === "gte" ? left >= right : left < right;
          }),
        );

      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: failure }),
        eq(column: string, value: unknown) { applied.push({ column, op: "eq", value }); entry.filters[column] = value; return chain(); },
        gte(column: string, value: unknown) { applied.push({ column, op: "gte", value }); entry.filters[`${column}__gte`] = value; return chain(); },
        lt(column: string, value: unknown) { applied.push({ column, op: "lt", value }); entry.filters[`${column}__lt`] = value; return chain(); },
        in(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        then(resolve: (value: { data: unknown; error: unknown; count?: number }) => void) {
          const found = matching();
          resolve({ data: found, error: failure, count: found.length });
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

async function loadRouter(options: { appointments?: unknown[]; failTables?: string[] } = {}) {
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

  const rows: Record<string, unknown[]> = {
    // auth_user_id is part of the fixture because this spy filters for real:
    // the membership lookup is `.eq("auth_user_id", …).eq("status", "active")`
    // (lib/auth/server.ts), and a row without it is simply not a member here.
    staff_users: [{ id: STAFF_A, auth_user_id: USER_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" }],
    appointments: options.appointments ?? [],
  };
  supabaseModule.setSupabaseServerClientFactoryForTests(() =>
    spyClient(rows, log, new Set(options.failTables ?? [])));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: { method?: string; body?: unknown }) => {
    log.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: ["appointments"], workspaceId: WORKSPACE_A },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log] };
  };
}

const booking = (over: Record<string, unknown> = {}) => ({
  client: "Мария Ли",
  phone: "+7 701 245 18 44",
  doctor: DOCTOR,
  starts_at: SLOT_START,
  durationMinutes: 60,
  status: "scheduled",
  ...over,
});

const writes = (log: QueryLog[]) =>
  log.filter((e) => e.table === "appointments" && (e.op === "insert" || e.op === "update"));

/* ── The refusal ── */

test("BC1 a second booking in an occupied slot is refused, and nothing is written", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res, log } = await call({ body: booking() });

  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "appointment_conflict");
  assert.equal(writes(log).length, 0, "the refusal must come before the write, not after it");
});

test("BC2 the refusal names the slot, so the operator can decide rather than guess", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res } = await call({ body: booking() });

  const conflict = res.body.conflict as Record<string, unknown>;
  assert.equal(conflict.startsAt, SLOT_START);
  assert.equal(conflict.clientName, "Лаура Ким", "who occupies the slot is the whole content of the decision");
  assert.equal(conflict.doctorName, DOCTOR);
  assert.match(String(res.body.error), /[А-Яа-я]/, "the message the operator sees stays in Russian");
});

test("BC3 an explicit override still books — a clinic may overbook on purpose", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res, log } = await call({ body: booking({ allowConflict: true }) });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(writes(log).length, 1, "the deliberate double booking is saved");
});

test("BC4 absence of an override is not consent", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  // Every falsy spelling a caller might send by accident.
  for (const value of [false, "false", "", 0, null]) {
    const { res } = await call({ body: booking({ allowConflict: value }) });
    assert.equal(res.statusCode, 409, `allowConflict=${JSON.stringify(value)} must not be read as permission`);
  }
});

/* ── What is not a conflict ── */

test("BC5 another doctor at the same hour is not a conflict", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res } = await call({ body: booking({ doctor: "д-р Айжан" }) });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
});

test("BC6 a cancelled or missed visit does not hold its slot", async () => {
  for (const status of ["cancelled", "no_show"]) {
    const call = await loadRouter({ appointments: [occupiedRow({ status })] });
    const { res } = await call({ body: booking() });
    assert.equal(res.statusCode, 201, `a ${status} appointment must free the time`);
  }
});

test("BC7 booking a cancelled visit into a busy slot is not blocked either", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res } = await call({ body: booking({ status: "cancelled" }) });
  assert.equal(res.statusCode, 201, "a cancelled appointment occupies nothing, so it can be recorded anywhere");
});

test("BC8 back-to-back appointments touch but do not overlap", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  // The existing visit ends exactly when this one starts.
  const { res } = await call({ body: booking({ starts_at: SLOT_END }) });
  assert.equal(res.statusCode, 201, "an end and a start at the same instant are not an overlap");
});

test("BC9 a long visit that began earlier is still found", async () => {
  // Starts three hours before the candidate and runs four hours. A check that
  // only looked at the candidate's own hour would miss it entirely.
  const call = await loadRouter({
    appointments: [occupiedRow({ starts_at: "2026-09-01T07:00:00.000Z", duration_minutes: 240 })],
  });
  const { res } = await call({ body: booking() });
  assert.equal(res.statusCode, 409, "the lookback window has to be wider than one slot");
});

test("BC10 another clinic's schedule is invisible", async () => {
  const call = await loadRouter({ appointments: [occupiedRow({ workspace_id: WORKSPACE_B })] });
  const { res, log } = await call({ body: booking() });

  assert.equal(res.statusCode, 201, "a booking in another clinic must not block this one");
  const check = log.find((e) => e.table === "appointments" && e.op === "select");
  assert.ok(check, "the check must run");
  assert.equal(check.filters.workspace_id, WORKSPACE_A, "and it is scoped like every other read");
});

/* ── Editing ── */

test("BC11 an appointment does not conflict with itself", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()] });
  const { res } = await call({
    method: "PATCH",
    body: { id: EXISTING_ID, updates: { service: "Чистка лица" } },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test("BC12 moving an appointment onto a colleague's slot is refused", async () => {
  const call = await loadRouter({
    appointments: [
      occupiedRow(),
      // The one being moved: same doctor, an hour later.
      occupiedRow({ id: OTHER_ID, client_name: "Мария Ли", starts_at: SLOT_END }),
    ],
  });
  const { res, log } = await call({
    method: "PATCH",
    body: { id: OTHER_ID, updates: { starts_at: SLOT_START } },
  });

  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal((res.body.conflict as Record<string, unknown>).id, EXISTING_ID);
  assert.equal(writes(log).length, 0);
});

test("BC13 a patch that carries only a status is judged on the merged row, not the patch alone", async () => {
  // The patch has no doctor and no time; both come from the stored row. A check
  // reading the patch alone would silently pass everything.
  const call = await loadRouter({
    appointments: [
      occupiedRow(),
      occupiedRow({ id: OTHER_ID, client_name: "Мария Ли", status: "cancelled" }),
    ],
  });
  const { res } = await call({
    method: "PATCH",
    body: { id: OTHER_ID, updates: { status: "confirmed" } },
  });

  assert.equal(
    res.statusCode,
    409,
    "reviving a cancelled visit into a slot someone else now holds is exactly the case a status-only patch hides",
  );
});

/* ── Degradation ── */

test("BC14 a check that cannot run does not become a check that passed — nor a clinic that cannot book", async () => {
  const call = await loadRouter({ appointments: [occupiedRow()], failTables: ["appointments"] });
  const { res } = await call({ body: booking() });

  // The read fails, so the conflict cannot be seen. Refusing every booking on
  // a failed advisory check would be worse than the state before this existed;
  // the write is attempted and its own failure is reported honestly.
  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  const text = JSON.stringify(res.body);
  for (const leak of ["relation", "42P01"]) {
    assert.ok(!text.includes(leak), `the answer must not quote the database: ${leak}`);
  }
});

/* ── Source pins ── */

test("BC15 the server is the authority, and the browser is only a fast pre-filter", async () => {
  const server = await readFile(serverPath, "utf8");
  for (const wiring of [
    "if (!allowsAppointmentConflict(body)) {",
    "if (patchedEntity === \"appointment\" && !allowsAppointmentConflict(patchBody)) {",
  ]) {
    assert.ok(server.includes(wiring), `both write paths must run the check: ${wiring}`);
  }
  assert.ok(
    server.includes('code: "appointment_conflict"'),
    "the refusal carries a code the browser can act on, not just a message",
  );

  const page = await readFile(pagePath, "utf8");
  assert.ok(
    page.includes("class SlotTakenError"),
    "the page must tell a busy slot apart from a database failure — they need different screens",
  );
  const submit = page.slice(page.indexOf("const submitForm"), page.indexOf("const renderDay"));
  assert.ok(
    submit.includes("await createAppointment(appointment, allowConflict)"),
    "creating must await the server: an optimistic create cannot ask the operator anything",
  );
  assert.ok(
    submit.includes("setConflictMessage(describeConflict(error))") && submit.split("setConflictMessage(describeConflict(error))").length === 3,
    "both the create and the edit path must reopen the same decision in the modal",
  );
});

test("BC16 the override is sent only when the operator chose it", async () => {
  const page = await readFile(pagePath, "utf8");

  // «Сохранить всё равно» is the only thing that passes true, and the flag is
  // omitted entirely otherwise — a body that always carried allowConflict:false
  // would be harmless, but one that always carried true would silently delete
  // the whole guarantee.
  assert.ok(
    page.includes("onClick={() => void submitForm(true)}"),
    "the override button is the single caller that grants permission",
  );
  for (const sender of ["allowConflict ? { allowConflict: true } : {}"]) {
    assert.ok(page.includes(sender), `the flag must be conditional: ${sender}`);
  }
  assert.ok(
    !/allowConflict:\s*true\s*,?\s*\n/.test(page.replace(/allowConflict \? \{ allowConflict: true \} : \{\}/g, "")),
    "nothing may hard-code the override",
  );
});

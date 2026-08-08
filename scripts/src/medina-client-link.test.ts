import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CRM — the client link, validated.
//
// Two defects with one shape. An appointment's client_id existed in the schema
// since 010 and was returned by every read, but no write path set it: a visit
// was never attached to the patient it was for. And a lead's client_id WAS
// written — guarded only by isUuid, which is a shape check, not a tenancy
// check: a client id from another clinic is also a uuid, the FK points at
// clients(id) with no workspace clause, and the value went straight in.
//
// Both now go through readWorkspaceReference like every other reference in
// this file: the id is looked up inside the acting workspace, a foreign id is
// refused with 400 before anything is written, and an explicit empty string
// unlinks. These tests drive the real router with a spying database.
//
// Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** A perfectly well-formed uuid that belongs to another clinic. */
const FOREIGN_CLIENT_ID = "99999999-9999-4999-8999-999999999999";
const APPOINTMENT_ID = "abababab-abab-4bab-8bab-abababababab";
const TOKEN = "header.payload.signature";

type StaffRow = { id: string; workspace_id: string; role: string; status: string };
type QueryLog = { table: string; filters: Record<string, unknown>; op: string };

/**
 * Same spy as the tenant-isolation suite, with one addition: maybeSingle
 * honours the recorded eq filters, because readWorkspaceReference is exactly
 * a filtered maybeSingle and these tests exist to prove the filter matters.
 */
function spyClient(rows: Record<string, unknown[]>, log: QueryLog[]) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, filters: {}, op: "select" };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const matches = (row: Record<string, unknown>) =>
        Object.entries(entry.filters).every(([column, value]) => column === "__row" || row[column] === value);
      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        delete: () => { entry.op = "delete"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => {
          const found = (rows[table] ?? []).map((r) => r as Record<string, unknown>).find(matches) ?? null;
          return Promise.resolve({ data: found, error: null });
        },
        eq(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        in(column: string, values: unknown) { entry.filters[column] = values; return chain(); },
        then(resolve: (value: { data: unknown; error: null; count?: number }) => void) {
          const tableRows = rows[table] ?? [];
          resolve({ data: tableRows, error: null, count: tableRows.length });
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

async function loadRouter(rows: Record<string, unknown[]>) {
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

  const owner: StaffRow = { id: STAFF_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" };
  const clientRows: Record<string, unknown[]> = { staff_users: [owner], ...rows };
  supabaseModule.setSupabaseServerClientFactoryForTests(() => spyClient(clientRows, log));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: { segments: string[]; method?: string; body?: unknown }) => {
    log.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: input.segments, workspaceId: WORKSPACE_A },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log] };
  };
}

const ownClient = { id: CLIENT_ID, workspace_id: WORKSPACE_A };

/* ── The lead's link, now a tenancy check ── */

test("CLK1 linking a lead to another clinic's client is refused before anything is written", async () => {
  // The foreign client exists — in someone else's workspace. Under the old
  // uuid-shape guard this request stored the id; the FK had nothing to say.
  const call = await loadRouter({
    clients: [{ id: FOREIGN_CLIENT_ID, workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A, full_name: "Лаура" }],
  });
  const { res, log } = await call({
    segments: ["leads"],
    method: "PATCH",
    body: { id: LEAD_ID, updates: { clientId: FOREIGN_CLIENT_ID } },
  });

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((e) => e.op === "update").length, 0, "the refusal comes before the write");

  const lookup = log.find((e) => e.table === "clients");
  assert.ok(lookup, "the id must be looked up, not trusted");
  assert.equal(lookup.filters.workspace_id, WORKSPACE_A, "and looked up inside the acting workspace");
});

test("CLK2 linking a lead to the clinic's own client stores the id the lookup returned", async () => {
  const call = await loadRouter({
    clients: [ownClient],
    leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A, full_name: "Лаура" }],
  });
  const { res, log } = await call({
    segments: ["leads"],
    method: "PATCH",
    body: { id: LEAD_ID, updates: { clientId: CLIENT_ID } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = log.find((e) => e.table === "leads" && e.op === "update");
  assert.ok(update, "the lead must be updated");
  assert.equal((update.filters.__row as Record<string, unknown>).client_id, CLIENT_ID);
  assert.equal(update.filters.workspace_id, WORKSPACE_A);
});

test("CLK3 an explicit empty string unlinks", async () => {
  const call = await loadRouter({
    leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A, full_name: "Лаура", client_id: CLIENT_ID }],
  });
  const { res, log } = await call({
    segments: ["leads"],
    method: "PATCH",
    body: { id: LEAD_ID, updates: { clientId: "" } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = log.find((e) => e.table === "leads" && e.op === "update");
  assert.ok(update);
  assert.equal((update.filters.__row as Record<string, unknown>).client_id, null);
  assert.equal(log.filter((e) => e.table === "clients").length, 0, "an unlink needs no lookup");
});

/* ── The appointment's link, which never existed ── */

test("CLK4 an appointment created from a lead's handoff stores the patient it is for", async () => {
  const call = await loadRouter({ clients: [ownClient] });
  const { res, log } = await call({
    segments: ["appointments"],
    method: "POST",
    body: { client: "Лаура Ким", phone: "+7 700 801 77 21", clientId: CLIENT_ID },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const insert = log.find((e) => e.table === "appointments" && e.op === "insert");
  assert.ok(insert, "the appointment must be created");
  assert.equal(
    (insert.filters.__row as Record<string, unknown>).client_id,
    CLIENT_ID,
    "the visit is attached to the client card — this is the write path that never existed",
  );

  const lookup = log.find((e) => e.table === "clients");
  assert.ok(lookup, "and the id was verified, not trusted");
  assert.equal(lookup.filters.workspace_id, WORKSPACE_A);
});

test("CLK5 an appointment refuses another clinic's client the same way the lead does", async () => {
  const call = await loadRouter({
    clients: [{ id: FOREIGN_CLIENT_ID, workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
  });
  const { res, log } = await call({
    segments: ["appointments"],
    method: "POST",
    body: { client: "Лаура Ким", phone: "+7 700 801 77 21", clientId: FOREIGN_CLIENT_ID },
  });

  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(log.filter((e) => e.op === "insert").length, 0, "nothing is written");
});

test("CLK6 an appointment saved without a client stays a plain visit", async () => {
  const call = await loadRouter({});
  const { res, log } = await call({
    segments: ["appointments"],
    method: "POST",
    body: { client: "Лаура Ким", phone: "+7 700 801 77 21" },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const insert = log.find((e) => e.table === "appointments" && e.op === "insert");
  assert.ok(insert);
  assert.ok(
    !("client_id" in (insert.filters.__row as Record<string, unknown>)),
    "a body that never mentions clientId must not invent the column",
  );
  assert.equal(log.filter((e) => e.table === "clients").length, 0, "and no lookup runs");
});

test("CLK7 editing an appointment keeps its client unless the edit says otherwise", async () => {
  const call = await loadRouter({
    clients: [ownClient],
    appointments: [{ id: APPOINTMENT_ID, workspace_id: WORKSPACE_A, client_id: CLIENT_ID }],
  });
  // The browser always serializes clientId (that is the F11 lesson), so a
  // normal edit carries the same id back; the lookup re-verifies and keeps it.
  const { res, log } = await call({
    segments: ["appointments"],
    method: "PATCH",
    body: { id: APPOINTMENT_ID, updates: { service: "Чистка лица", clientId: CLIENT_ID } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const update = log.find((e) => e.table === "appointments" && e.op === "update");
  assert.ok(update);
  assert.equal((update.filters.__row as Record<string, unknown>).client_id, CLIENT_ID);
});

/* ── Source pins: the chain that dropped the value ── */

test("CLK8 the appointments page carries clientId through every step that used to drop it", async () => {
  const source = await readFile(
    path.join(repoRoot, "artifacts", "negis", "src", "pages", "AppointmentsPage.tsx"),
    "utf8",
  );

  // The handoff from the lead card carried clientId from the day it was
  // written; the appointments page dropped it at five separate steps. Each
  // one is pinned, because losing any single link breaks the whole chain
  // silently — the form still works, the toast still says «Запись создана».
  const toApi = source.slice(source.indexOf("function appointmentToApi("), source.indexOf("async function safeJson("));
  assert.ok(
    /clientId:\s*appointment\.clientId \?\? ""/.test(toApi),
    "toApi must always send clientId — an absent key is dropped by JSON.stringify and the link silently never persists",
  );

  const fromApi = source.slice(source.indexOf("function appointmentFromApi("), source.indexOf("function appointmentToApi("));
  assert.ok(
    fromApi.includes("record.client_id"),
    "fromApi must read the id the server has always returned",
  );

  const prefill = source.slice(source.indexOf("const prefillKey"), source.indexOf("const filteredItems"));
  assert.ok(
    prefill.includes("readString(prefill.clientId)"),
    "the handoff from the lead card must not be dropped on consumption",
  );

  for (const carrier of ["function formFromAppointment(", "function appointmentFromForm(", "function defaultForm("]) {
    const at = source.indexOf(carrier);
    assert.ok(at >= 0, `${carrier} must exist`);
    assert.ok(
      source.slice(at, at + 700).includes("clientId"),
      `${carrier} must carry clientId — this is a link of the chain that used to drop it`,
    );
  }
});

test("CLK9 the old uuid-shape guard is gone from the lead mapping", async () => {
  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  assert.ok(
    !server.includes("row.client_id = isUuid(clientId) ? clientId : null;"),
    "a uuid-shape check is not a tenancy check: another clinic's client id is also a uuid",
  );
  const builder = server.slice(
    server.indexOf("async function buildLeadReferenceRow("),
    server.indexOf("async function buildAppointmentReferenceRow("),
  );
  assert.ok(
    builder.includes('table: "clients"'),
    "the lead's client link lives with the other validated references",
  );
});

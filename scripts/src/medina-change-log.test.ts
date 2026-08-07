import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// CRM — the change journal.
//
// audit_logs was created by migration 010 and stayed empty: no writer, no
// reader, no screen, and a line in the documentation calling it «база для
// будущего журнала действий». Meanwhile the product could not answer the
// question every CRM answers — who moved this lead, and when.
//
// Two halves are tested here. The handler half drives the real router with a
// spying database and proves the journal writes when a record actually
// changed, stays silent when nothing did or the change was refused, and never
// answers more broadly than the record it describes. The pure half proves the
// content rule that matters in a medical clinic: a note's text never enters
// the journal, a phone never enters it whole, and a reformatted number is not
// an event.
//
// Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const journalPath = path.join(repoRoot, "lib", "crm", "change-journal.ts");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = "header.payload.signature";

type StaffRow = { id: string; workspace_id: string; role: string; status: string };
type QueryLog = { table: string; filters: Record<string, unknown>; op: string };

/** Same spy as the tenant-isolation suite: every table, filter and operation. */
function spyClient(rows: Record<string, unknown[]>, log: QueryLog[], failTables: Set<string>) {
  return {
    from(table: string) {
      const entry: QueryLog = { table, filters: {}, op: "select" };
      log.push(entry);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const failure = failTables.has(table)
        ? { message: `permission denied for table ${table}`, code: "42501" }
        : null;
      Object.assign(builder, {
        select: () => chain(),
        insert: (row: unknown) => { entry.op = "insert"; entry.filters.__row = row; return chain(); },
        update: (row: unknown) => { entry.op = "update"; entry.filters.__row = row; return chain(); },
        upsert: (row: unknown) => { entry.op = "upsert"; entry.filters.__row = row; return chain(); },
        delete: () => { entry.op = "delete"; return chain(); },
        order: () => chain(),
        limit: () => chain(),
        single: () => chain(),
        maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: failure }),
        eq(column: string, value: unknown) { entry.filters[column] = value; return chain(); },
        in(column: string, values: unknown) { entry.filters[column] = values; return chain(); },
        then(resolve: (value: { data: unknown; error: unknown; count?: number }) => void) {
          const tableRows = rows[table] ?? [];
          resolve({ data: tableRows, error: failure, count: tableRows.length });
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

async function loadRouter(options: {
  memberships?: StaffRow[];
  rows?: Record<string, unknown[]>;
  failTables?: string[];
}) {
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
    staff_users: options.memberships ?? [],
    ...(options.rows ?? {}),
  };
  const failTables = new Set(options.failTables ?? []);
  supabaseModule.setSupabaseServerClientFactoryForTests(() => spyClient(clientRows, log, failTables));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  return async (input: {
    segments: string[];
    method?: string;
    query?: Record<string, unknown>;
    body?: unknown;
  }) => {
    log.length = 0;
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: input.segments, workspaceId: WORKSPACE_A, ...(input.query ?? {}) },
        body: input.body,
      },
      res,
    );
    return { res, log: [...log] };
  };
}

const STAFF_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const owner: StaffRow = { id: STAFF_A, workspace_id: WORKSPACE_A, role: "owner", status: "active" };
/** A doctor sees patients, not the sales pipeline: no view_leads in the catalog. */
const doctor: StaffRow = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", workspace_id: WORKSPACE_A, role: "doctor", status: "active" };

const journalWrites = (log: QueryLog[]) => log.filter((e) => e.table === "audit_logs" && e.op === "insert");

/* ── The journal writes, and only when something happened ── */

test("CL1 a lead the database accepted leaves exactly one journal entry, in the caller's workspace", async () => {
  const call = await loadRouter({ memberships: [owner] });
  const { res, log } = await call({
    segments: ["leads"],
    method: "POST",
    body: { name: "Лаура", phone: "+7 700 801 77 21", source: "WhatsApp" },
  });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const writes = journalWrites(log);
  assert.equal(writes.length, 1, "one save is one entry — a row per changed field is what makes a timeline unreadable");

  const row = writes[0].filters.__row as Record<string, unknown>;
  assert.equal(row.workspace_id, WORKSPACE_A, "the journal is tenant data and carries the verified workspace");
  assert.equal(row.entity_type, "lead");
  assert.equal(row.action, "created");
  assert.equal(row.actor_kind, "manual");
  assert.equal(row.actor_staff_user_id, STAFF_A, "the actor is the membership the router proved, not a claim in the body");
});

test("CL2 the journal entry comes after the record, never before it", async () => {
  const call = await loadRouter({ memberships: [owner] });
  const { log } = await call({ segments: ["leads"], method: "POST", body: { name: "Лаура" } });

  const inserts = log.filter((e) => e.op === "insert");
  assert.ok(inserts.length >= 2, `expected the record and the journal, got ${inserts.map((e) => e.table).join(", ")}`);
  assert.equal(inserts[0].table, "leads", "the record is written first — a journal entry for a row that was refused is a lie");
  assert.equal(inserts[inserts.length - 1].table, "audit_logs");
});

test("CL3 a refused mutation leaves no trace in the journal", async () => {
  // The membership is in another clinic, so the router never reaches the data.
  const call = await loadRouter({
    memberships: [{ id: "staff-b", workspace_id: WORKSPACE_B, role: "owner", status: "active" }],
  });
  const { res, log } = await call({ segments: ["leads"], method: "POST", body: { name: "Лаура" } });

  assert.equal(res.statusCode, 403);
  assert.equal(journalWrites(log).length, 0, "an attempt is not an event; only what happened is journaled");
});

test("CL4 a save that changed nothing is not an event", async () => {
  const call = await loadRouter({
    memberships: [owner],
    rows: { leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A, full_name: "Лаура", status: "new" }] },
  });
  // Same values the row already holds.
  const { res, log } = await call({
    segments: ["leads"],
    method: "PATCH",
    body: { id: LEAD_ID, updates: { name: "Лаура", status: "new" } },
  });

  assert.equal(res.statusCode, 200, `the edit itself has to succeed, or this proves nothing: ${JSON.stringify(res.body)}`);
  assert.equal(
    journalWrites(log).length,
    0,
    "re-saving a form without touching it must not add a line; that is how a timeline turns into noise",
  );
});

test("CL5 a real edit is journaled with what it was and what it became", async () => {
  const call = await loadRouter({
    memberships: [owner],
    rows: { leads: [{ id: LEAD_ID, workspace_id: WORKSPACE_A, full_name: "Лаура", status: "new", source: "WhatsApp" }] },
  });
  const { res, log } = await call({
    segments: ["leads"],
    method: "PATCH",
    body: { id: LEAD_ID, updates: { status: "in_progress" } },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const writes = journalWrites(log);
  assert.equal(writes.length, 1);
  const row = writes[0].filters.__row as Record<string, unknown>;
  const changes = (row.metadata as { changes: Array<{ field: string; from: unknown; to: unknown }> }).changes;

  assert.deepEqual(
    changes.map((c) => c.field),
    ["status"],
    "only the field the patch touched — source was not in the request and is not a change",
  );
  assert.equal(changes[0].from, "new");
  assert.equal(changes[0].to, "in_progress");
  assert.equal(row.entity_id, LEAD_ID);
});

/* ── The journal is never a wider door than the record ── */

test("CL6 a role that may not read leads may not read a lead's history", async () => {
  const call = await loadRouter({ memberships: [doctor] });
  const { res } = await call({
    segments: ["change-log"],
    query: { entityType: "lead", entityId: LEAD_ID },
  });

  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, "insufficient_permission");
});

test("CL7 the history a caller may read is scoped to the workspace and to that one record", async () => {
  const call = await loadRouter({
    memberships: [owner],
    rows: {
      audit_logs: [{
        id: "event-1",
        action: "updated",
        actor_name: "a@example.test",
        actor_role: "owner",
        actor_kind: "manual",
        created_at: "2026-08-07T10:00:00.000Z",
        metadata: { changes: [{ field: "status", label: "Этап", from: "new", to: "in_progress" }] },
      }],
    },
  });
  const { res, log } = await call({
    segments: ["change-log"],
    query: { entityType: "lead", entityId: LEAD_ID },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const events = res.body.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal((events[0].changes as unknown[]).length, 1);

  const read = log.find((e) => e.table === "audit_logs");
  assert.ok(read, "the journal must actually be queried");
  assert.equal(read.filters.workspace_id, WORKSPACE_A, "service_role bypasses RLS, so the filter is the isolation");
  assert.equal(read.filters.entity_type, "lead");
  assert.equal(read.filters.entity_id, LEAD_ID);
});

test("CL8 a malformed record id is refused before the database is touched", async () => {
  const call = await loadRouter({ memberships: [owner] });
  const { res, log } = await call({
    segments: ["change-log"],
    query: { entityType: "lead", entityId: "not-a-uuid" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(log.filter((e) => e.table === "audit_logs").length, 0);
});

test("CL9 an unknown entity kind is refused, not answered with an empty history", async () => {
  const call = await loadRouter({ memberships: [owner] });
  const { res } = await call({
    segments: ["change-log"],
    query: { entityType: "invoices", entityId: LEAD_ID },
  });
  assert.equal(res.statusCode, 400);
});

test("CL10 a history the database refuses is a refusal, not an empty timeline", async () => {
  const call = await loadRouter({ memberships: [owner], failTables: ["audit_logs"] });
  const { res } = await call({
    segments: ["change-log"],
    query: { entityType: "client", entityId: CLIENT_ID },
  });

  assert.equal(res.statusCode, 502, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  const text = JSON.stringify(res.body);
  for (const leak of ["permission denied", "audit_logs", "42501"]) {
    assert.ok(!text.includes(leak), `the answer must not quote the database: ${leak}`);
  }
});

test("CL11 a journal the database refuses does not fail the save it describes", async () => {
  const call = await loadRouter({ memberships: [owner], failTables: ["audit_logs"] });
  const { res } = await call({ segments: ["leads"], method: "POST", body: { name: "Лаура" } });

  assert.equal(
    res.statusCode,
    201,
    "a secondary write must never cost the operator real work; the entry is lost, the lead is not",
  );
});

/* ── What the journal is allowed to contain ── */

test("CL12 a note's text never enters the journal", async () => {
  const journal = (await import(pathToFileURL(journalPath).href)) as {
    diffForJournal: (entity: string, before: Record<string, unknown>, after: Record<string, unknown>) => Array<{ field: string; from: unknown; to: unknown }>;
  };

  const secret = "хочет диагностику кожи на этой неделе";
  const changes = journal.diffForJournal("lead", { notes: "" }, { notes: secret });

  assert.equal(changes.length, 1, "the fact that a note changed is worth recording");
  assert.equal(changes[0].field, "notes");
  assert.equal(changes[0].from, null);
  assert.equal(changes[0].to, null);
  assert.ok(
    !JSON.stringify(changes).includes("кожи"),
    "«Заметки» is where a clinical hint ends up in practice; the journal records that it changed and nothing more",
  );
});

test("CL13 a phone and a name are recorded masked, never whole", async () => {
  const journal = (await import(pathToFileURL(journalPath).href)) as {
    diffForJournal: (entity: string, before: Record<string, unknown>, after: Record<string, unknown>) => Array<{ field: string; from: unknown; to: unknown }>;
  };

  const changes = journal.diffForJournal(
    "lead",
    { phone: "+7 700 801 77 21", full_name: "Лаура Ким" },
    { phone: "+7 747 330 19 90", full_name: "Мария Ли" },
  );
  const text = JSON.stringify(changes);

  assert.equal(changes.length, 2);
  assert.ok(!text.includes("7473301990") && !text.includes("747 330"), "the new number must not appear in full");
  assert.ok(!text.includes("Мария Ли"), "the new name must not appear in full");
  assert.ok(text.includes("1990"), "but the entry has to stay recognisable — the last four digits do that");
});

test("CL14 reformatting is not an event", async () => {
  const journal = (await import(pathToFileURL(journalPath).href)) as {
    diffForJournal: (entity: string, before: Record<string, unknown>, after: Record<string, unknown>) => unknown[];
  };

  // The same number typed twice. Elsewhere in this product these two compare
  // equal by digits; a journal that disagreed would teach the operator to stop
  // reading it.
  assert.deepEqual(
    journal.diffForJournal("lead", { phone: "+7 700 801 77 21" }, { phone: "87008017721" }),
    [],
  );

  // A stage exists in two spellings in this database, and both are readable.
  assert.deepEqual(journal.diffForJournal("lead", { status: "New" }, { status: "new" }), []);
});

test("CL15 a column nobody classified cannot reach the journal", async () => {
  const journal = (await import(pathToFileURL(journalPath).href)) as {
    diffForJournal: (entity: string, before: Record<string, unknown>, after: Record<string, unknown>) => unknown[];
    CHANGE_JOURNAL_INTERNALS: { ENTITY_POLICY: Record<string, { fields: Record<string, { sensitivity: string }> }> };
  };

  // updated_at is written on almost every patch in this codebase; a diff of the
  // written row would file it as a change on every single save.
  assert.deepEqual(
    journal.diffForJournal("lead", { updated_at: "2026-01-01" }, { updated_at: "2026-08-07", diagnosis_code: "L70.0" }),
    [],
    "an unclassified column is silent by default: a new column has to be decided about, not leak in",
  );

  for (const [entity, policy] of Object.entries(journal.CHANGE_JOURNAL_INTERNALS.ENTITY_POLICY)) {
    for (const [field, rule] of Object.entries(policy.fields)) {
      assert.ok(
        ["value", "masked", "fact"].includes(rule.sensitivity),
        `${entity}.${field} has no sensitivity classification`,
      );
    }
  }
});

/* ── Source pins ── */

test("CL16 the actor comes from the verified context, never from the request", async () => {
  const source = await readFile(serverPath, "utf8");
  const actor = source.slice(source.indexOf("function journalActor("), source.indexOf("function validationDetails("));
  assert.ok(actor.length > 0, "journalActor must still exist");

  assert.ok(actor.includes("readWorkspaceContext(req)"), "the context is the only source of the actor");
  for (const fromRequest of ["body.", "req.query", "payload."]) {
    assert.ok(
      !actor.includes(fromRequest),
      `a journal that records who the caller claims to be is worse than none: ${fromRequest}`,
    );
  }
  assert.ok(
    actor.includes("context?.staffUserId"),
    "the id is the membership the router proved; the display name beside it is only a snapshot",
  );
});

/* ── The panel ── */

const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");
const panelPath = path.join(negisSrc, "components", "crm", "change-log-panel.tsx");

test("CL18 a history that failed to load is not shown as a history with nothing in it", async () => {
  const panel = await readFile(panelPath, "utf8");

  // The block this panel sits beside on ClientsPage swallows its own failure
  // and prints «История появится после…», so a refused read and a genuinely
  // new client look identical. That is the habit this whole suite exists
  // against, and it must not be copied into the new panel.
  assert.ok(panel.includes('setState("failed")'), "a failed load has its own state");
  const ready = panel.indexOf('state === "ready" && events.length === 0');
  const failed = panel.indexOf('state === "failed"');
  assert.ok(failed > 0 && ready > 0 && failed < ready, "the failure is rendered, and before the empty case");
  assert.ok(
    panel.includes("Не удалось загрузить историю"),
    "and it says so in words the operator can act on",
  );
  assert.ok(
    /if \(!response\.ok \|\| body\.success !== true\)/.test(panel),
    "crmFetch does not throw on 5xx: the answer has to be inspected, not assumed",
  );
});

test("CL19 the history is never served from cache", async () => {
  const api = await readFile(path.join(negisSrc, "lib", "api.ts"), "utf8");
  const guard = api.slice(api.indexOf("function isUncacheable("), api.indexOf("function ttlFor("));

  assert.ok(
    guard.includes("/change-log"),
    "a write clears the cache when the request starts, not when the server answers, and the browser's "
      + "own update is optimistic — a timeline reopened right after an edit would race the row it describes",
  );

  // And the path must not collide with the five-minute reference bucket.
  const ttl = api.slice(api.indexOf("function ttlFor("));
  const referencePattern = /\/\\?\/\((.*?)\)\\b\//.exec(ttl);
  if (referencePattern) {
    for (const name of referencePattern[1].split("|")) {
      assert.ok(!"change-log".includes(name), `change-log must not fall into the ${name} reference bucket`);
    }
  }
});

test("CL20 there is one history panel, not one per screen", async () => {
  // Six metric cards had grown one per page in this codebase, and the cost was
  // that two screens kept the old brand colour when it changed because there
  // was no single place to change. The panel starts shared.
  const pagesDir = path.join(negisSrc, "pages");
  const { readdir } = await import("node:fs/promises");
  const definitions: string[] = [];
  for (const name of await readdir(pagesDir)) {
    if (!name.endsWith(".tsx")) continue;
    const source = await readFile(path.join(pagesDir, name), "utf8");
    for (const match of source.matchAll(/^(?:export\s+)?function\s+(\w*ChangeLog\w*|\w*HistoryPanel\w*)\b/gm)) {
      definitions.push(`${name} → ${match[1]}`);
    }
  }
  assert.deepEqual(definitions, [], `a page drawing its own history panel stops following the shared one: ${definitions.join(", ")}`);

  const leads = await readFile(path.join(pagesDir, "LeadsPage.tsx"), "utf8");
  const clients = await readFile(path.join(pagesDir, "ClientsPage.tsx"), "utf8");
  for (const [name, source] of [["LeadsPage", leads], ["ClientsPage", clients]] as const) {
    assert.ok(
      source.includes('from "@/components/crm/change-log-panel"'),
      `${name} must use the shared panel`,
    );
  }
});

test("CL21 the panel shows the words the clinic uses, not the keys the database stores", async () => {
  const leads = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");
  const resolver = leads.slice(leads.indexOf("function makeLeadHistoryResolver("), leads.indexOf("function formatCreatedAt("));
  assert.ok(resolver.length > 0, "the resolver must still exist");

  // The journal stores what was written and never rewrites the past when a
  // stage is renamed; the readable name is applied here instead. Resolving
  // against ALL stages, not the active ones, is the point: a lead can sit in a
  // stage the clinic has since switched off, and the history has to keep
  // calling it what it was called.
  assert.ok(resolver.includes("stages.find"), "a stage key becomes a stage name");
  assert.ok(resolver.includes("staff.find"), "an assignee id becomes a colleague's name");
  assert.ok(
    leads.includes("makeLeadHistoryResolver(stageDefinitions, sourceDefinitions, staffOptions)"),
    "and it is fed every stage the clinic has ever had, not only the enabled ones",
  );
});

test("CL17 the writer cannot fail a save", async () => {
  const source = await readFile(journalPath, "utf8");
  const writer = source.slice(source.indexOf("export async function recordCrmChange("));
  assert.ok(writer.includes("try {"), "the write is guarded");
  assert.ok(writer.includes("console.warn"), "the detail reaches the operator log");
  assert.ok(
    !/throw\s+/.test(writer.slice(writer.indexOf("catch"))),
    "and nothing is rethrown past the guard",
  );
});

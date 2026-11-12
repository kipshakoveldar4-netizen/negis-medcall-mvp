import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute real declarations with an in-memory conditional database, never server imports.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type RecordValue = Record<string, unknown>;
type Resource = "content-videos" | "chat";
type Response = {
  status(code: number): Response;
  setHeader(name: string, value: string): Response;
  json(body: unknown): void;
};
type Runtime = {
  patchItem(resource: Resource, req: RecordValue, res: Response): Promise<unknown>;
  persistContentVideoPatchIfAvailable(input: {
    videoId?: unknown; workspaceId?: unknown; patch: RecordValue; expectedUpdatedAt?: unknown;
  }): Promise<boolean>;
  makeContentVideo(body: RecordValue): RecordValue;
  configs: Record<Resource, { fromRow(row: RecordValue): RecordValue }>;
};
const clone = <T,>(value: T): T => structuredClone(value);

async function sourceFile(file: string) {
  const source = await readFile(path.join(root, file), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(ast: import("typescript").SourceFile, name: string) {
  const matches = ast.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
    return ts.isVariableStatement(node) && node.declarationList.declarations.some(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
  });
  assert.equal(matches.length, 1, `extract exactly one actual declaration: ${name}`);
  return matches[0]!;
}
function select(ast: import("typescript").SourceFile, names: string[]) {
  return names.map((name) => declaration(ast, name).getText(ast)).join("\n");
}
function compile(source: string, file: string) {
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
}
function pureModule(ast: import("typescript").SourceFile): Record<string, any> {
  const exports: Record<string, any> = {};
  const forbidden = () => { throw new Error(`External access from pure fixture: ${ast.fileName}`); };
  new Script(compile(ast.text, ast.fileName), { filename: ast.fileName }).runInNewContext({
    exports, require: forbidden, fetch: forbidden,
    process: new Proxy({}, { get: forbidden }),
  }, { timeout: 1000 });
  return exports;
}

const guard = pureModule(await sourceFile("lib/content-studio/telegram-delivery-guard.ts"));
const readVersion = (value: unknown): string | null => {
  assert.equal(typeof guard.readContentVideoVersion, "function", "version reader must be exported by the shared guard");
  return guard.readContentVideoVersion(value);
};
const approval = pureModule(await sourceFile("lib/advertising/campaignBrief.ts"));
const privacy = pureModule(await sourceFile("lib/crm/contact-privacy.ts"));
const payment = pureModule(await sourceFile("lib/crm/arrival-payment.ts"));
const journal = await sourceFile("lib/crm/change-journal.ts");
const server = await sourceFile("lib/crm/server.ts");
const configStatement = declaration(server, "configs");
assert.ok(ts.isVariableStatement(configStatement));
const configInitializer = configStatement.declarationList.declarations[0]!.initializer;
assert.ok(configInitializer && ts.isObjectLiteralExpression(configInitializer));
const selectedConfigs = (["content-videos", "chat"] as const).map((name) => {
  const matches = configInitializer.properties.filter((property) => ts.isPropertyAssignment(property)
    && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) && property.name.text === name);
  assert.equal(matches.length, 1, `extract actual ${name} config, including its actual fromRow`);
  return matches[0]!.getText(server);
});
const compiledServer = compile([
  select(server, [
    "DEMO_WORKSPACE_ID", "uuidPattern", "WORKSPACE_CONTEXT_KEY", "SERVER_OWNED_COLUMNS", "SERVICE_FAILURE_DETAIL",
    "CrmReferenceValidationError", "MortgageSelfLeadError", "AppointmentConflictError",
    "AppointmentRequestError",
    "AppointmentOutsideScheduleError", "AppointmentServicesSchemaError",
    "isUuid", "asRecord", "readString", "readQueryString", "firstString", "readJsonArray", "hasAnyKey",
    "stripServerOwnedColumns", "buildPatchRow", "nextDemoId", "sendJson", "success", "errorBody",
    "attachWorkspaceContext", "readWorkspaceContext", "readWorkspaceId", "validationDetails",
    "appointmentServicesValidationDetails", "hasContactFields", "redactedDetail", "supabaseWarning",
    "makeContentVideo", "makeChatMessage", "patchItem", "persistContentVideoPatchIfAvailable",
  ]),
  select(journal, ["RESOURCE_ENTITY", "journaledEntityFor"]),
  `const configs = { ${selectedConfigs.join(",\n")} };`,
  "exports.runtime = { patchItem, persistContentVideoPatchIfAvailable, makeContentVideo, configs, attachWorkspaceContext };",
].join("\n"), "content-version.actual-server.ts");

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const FOREIGN_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const OTHER_VIDEO = "44444444-4444-4444-8444-444444444444";
const VERSION_A = "2026-10-24T09:10:11.123456+05:00";
const VERSION_B = "2026-10-24T09:10:11.123457+05:00";
function videoRow(patch: RecordValue = {}): RecordValue {
  return {
    id: VIDEO, workspace_id: WORKSPACE, title: "Synthetic package A", script: "Script A",
    caption: "Caption A", status: "script_ready", created_at: "2026-10-01T00:00:00Z",
    updated_at: VERSION_A, raw_payload: { packageData: { script: "Approved A" }, provenance: "fixture" },
    ...clone(patch),
  };
}
type QueryResult = { data: RecordValue | null; error: { message: string; code?: string } | null };
type QueryCall = {
  table: string; patch: RecordValue | null; filters: Array<[string, unknown]>;
  selection: string | null; terminal: "single" | "maybeSingle" | "await";
};
type DatabaseOptions = {
  rows?: RecordValue[];
  error?: QueryResult["error"];
  throws?: boolean;
  available?: boolean;
  now?: number;
  beforeUpdate?: (db: FakeDatabase) => void;
};

function databaseTimestamp(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3));
}

class FakeDatabase {
  rows: RecordValue[];
  calls: QueryCall[] = [];
  writes: QueryCall[] = [];
  violations: unknown[] = [];
  private beforeUpdate?: DatabaseOptions["beforeUpdate"];
  constructor(private options: DatabaseOptions = {}) {
    this.rows = clone(options.rows ?? [videoRow()]);
    this.beforeUpdate = options.beforeUpdate;
  }
  check(condition: unknown, message: string): asserts condition {
    if (condition) return;
    const error = new Error(message);
    this.violations.push(error);
    throw error;
  }
  from(table: string) {
    this.check(["content_videos", "chat_messages"].includes(table), `unexpected table: ${table}`);
    let patch: RecordValue | null = null;
    let selection: string | null = null;
    const filters: Array<[string, unknown]> = [];
    let execution: Promise<QueryResult> | undefined;
    const execute = (terminal: QueryCall["terminal"]) => {
      execution ??= Promise.resolve().then((): QueryResult => {
        const call = { table, patch: clone(patch), filters: clone(filters), selection, terminal };
        this.calls.push(call);
        if (patch) {
          // A concurrent editor commits here, after any pre-read and before SQL predicates.
          const hook = this.beforeUpdate;
          this.beforeUpdate = undefined;
          hook?.(this);
          if (this.options.throws) throw new Error("synthetic database transport failure");
          if (this.options.error) return { data: null, error: clone(this.options.error) };
        }
        const matches = this.rows.filter((row) => (table === "chat_messages" ? row.message !== undefined : row.message === undefined)
          && filters.every(([column, value]) => {
            // PostgreSQL compares timestamptz instants, including microseconds, not string spellings.
            if (column !== "updated_at") return row[column] === value;
            const expected = databaseTimestamp(value);
            return expected !== null && databaseTimestamp(row[column]) === expected;
          }));
        this.check(matches.length <= 1, "fixture query unexpectedly matched multiple rows");
        const row = matches[0];
        if (!row) return {
          data: null, error: terminal === "single" ? { message: "no row", code: "PGRST116" } : null,
        };
        if (patch) {
          Object.assign(row, clone(patch));
          this.writes.push(call);
        }
        return { data: selection === "id" ? { id: row.id } : clone(row), error: null };
      });
      return execution;
    };
    const chain = {
      update: (value: RecordValue) => {
        this.check(!patch && !execution, "one update per query, before execution");
        patch = clone(value);
        return chain;
      },
      eq: (column: string, value: unknown) => {
        this.check(["id", "workspace_id", "updated_at"].includes(column), `unexpected filter: ${column}`);
        this.check(!execution && !filters.some(([key]) => key === column), "filters must be set once before execution");
        filters.push([column, value]);
        return chain;
      },
      select: (columns: string) => {
        this.check(!execution && selection === null && ["*", "id"].includes(columns), `unexpected projection: ${columns}`);
        selection = columns;
        return chain;
      },
      maybeSingle: () => execute("maybeSingle"),
      single: () => execute("single"),
      then: <TResult1 = QueryResult, TResult2 = never>(
        resolve?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => execute("await").then(resolve, reject),
    };
    return chain;
  }
  get updates() { return this.calls.filter((call) => call.patch !== null); }
  get readyWrites() { return this.writes.filter((call) => call.patch?.status === "telegram_ready"); }
}

function fixture(options: DatabaseOptions = {}) {
  const db = new FakeDatabase(options);
  const frozenNow = options.now ?? Date.now();
  class FrozenDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? frozenNow : value); }
    static now() { return frozenNow; }
  }
  const externalCalls: string[] = [];
  const forbidden = (name: string) => {
    externalCalls.push(name);
    throw new Error(`Forbidden fixture access: ${name}`);
  };
  const exports: { runtime?: Runtime & { attachWorkspaceContext(req: RecordValue, context: RecordValue): void } } = {};
  new Script(compiledServer, { filename: "content-version.actual-server.cjs" }).runInNewContext({
    exports, Error, Date: options.now === undefined ? Date : FrozenDate, ...approval, ...privacy, ...payment,
    readContentVideoVersion: readVersion,
    getSupabaseServerClient: () => options.available === false ? null : db,
    require: () => forbidden("module import"), fetch: () => forbidden("network"),
    process: new Proxy({}, { get: () => forbidden("environment") }),
    console: { warn() {} },
  }, { timeout: 1000 });
  assert.ok(exports.runtime);
  const runtime = exports.runtime;
  const clean = () => {
    assert.deepEqual(externalCalls, [], "no environment, imports or external calls");
    assert.deepEqual(db.violations, [], "a caught fixture assertion must not masquerade as a handler refusal");
  };
  return {
    db, runtime,
    async patch(body: RecordValue, workspaceId: string | null = WORKSPACE, resource: Resource = "content-videos", query: RecordValue = {}) {
      let status = 0;
      const replies: RecordValue[] = [];
      const req: RecordValue = { method: "PATCH", body, query };
      if (workspaceId !== null) runtime.attachWorkspaceContext(req, { workspaceId, role: "owner", permissions: [] });
      const res: Response = {
        status(value) { status = value; return this; },
        setHeader() { return this; },
        json(value) { replies.push(clone(value) as RecordValue); },
      };
      try { await runtime.patchItem(resource, req, res); } finally { clean(); }
      assert.equal(replies.length, 1, "one actual handler response");
      return { status, body: replies[0]! };
    },
    async persist(input: Parameters<Runtime["persistContentVideoPatchIfAvailable"]>[0]) {
      try { return await runtime.persistContentVideoPatchIfAvailable(input); } finally { clean(); }
    },
  };
}
function readyBody(expectedUpdatedAt: unknown = VERSION_A): RecordValue {
  return { id: VIDEO, status: "telegram_ready", expectedUpdatedAt };
}
function assertRefused(reply: { status: number; body: RecordValue }, status: number, code?: string) {
  assert.equal(reply.status, status);
  assert.equal(reply.body.success, false);
  if (code) assert.equal(reply.body.code, code);
  assert.notEqual(reply.body.mode, "demo", "a rejected live write must not become demo success");
  assert.equal(reply.body.data, undefined);
}
function assertAtomic(db: FakeDatabase, version: string, helper = false, id = VIDEO) {
  assert.ok(db.updates.length > 0, "the actual function must issue an update");
  for (const call of db.updates) {
    assert.equal(call.table, "content_videos");
    assert.deepEqual([...call.filters].sort(([a], [b]) => a.localeCompare(b)), [
      ["id", id], ["updated_at", version], ["workspace_id", WORKSPACE],
    ]);
    assert.equal(call.terminal, "maybeSingle", "zero matches must be distinguishable from database errors");
    assert.equal(call.selection, helper ? "id" : "*");
    assert.deepEqual(Object.keys(call.patch!).sort(), ["status", "updated_at"], "status CAS must not write raw_payload or expectedUpdatedAt");
    assert.equal(call.patch!.status, "telegram_ready");
    assert.ok(readVersion(call.patch!.updated_at));
  }
}

const validVersions = [
  "2026-10-24T09:10:11Z", "2026-10-24T09:10:11.1Z", "2026-10-24T09:10:11.12Z",
  "2026-10-24T09:10:11.123Z", "2026-10-24T09:10:11.1234Z", "2026-10-24T09:10:11.12345Z",
  "2026-10-24T09:10:11.123456Z", VERSION_A, "2026-10-24T09:10:11.000001-03:30",
  "2024-02-29T23:59:59.999999+00:00",
];
const invalidVersions: Array<[string, unknown]> = [
  ["missing", undefined], ["null", null], ["number", 1792829411123], ["boolean", true],
  ["object", { updatedAt: VERSION_A }], ["array", [VERSION_A]], ["Date", new Date("2026-10-24T09:10:11Z")],
  ["empty", ""], ["whitespace", " "], ["leading space", ` ${VERSION_A}`], ["trailing space", `${VERSION_A} `],
  ["trailing newline", `${VERSION_A}\n`], ["date only", "2026-10-24"], ["timezone missing", "2026-10-24T09:10:11.123456"],
  ["locale timestamp", "October 24, 2026 09:10:11 GMT"], ["space separator", "2026-10-24 09:10:11Z"],
  ["uncolonized offset", "2026-10-24T09:10:11+0500"], ["invalid offset hour", "2026-10-24T09:10:11+24:00"],
  ["invalid offset minute", "2026-10-24T09:10:11+05:60"], ["seven fractional digits", "2026-10-24T09:10:11.1234567Z"],
  ["empty fraction", "2026-10-24T09:10:11.Z"], ["invalid month", "2026-13-24T09:10:11Z"],
  ["zero day", "2026-10-00T09:10:11Z"], ["overflow day", "2026-04-31T09:10:11Z"],
  ["non-leap February", "2026-02-29T09:10:11Z"], ["hour 24", "2026-10-24T24:00:00Z"],
  ["minute 60", "2026-10-24T09:60:11Z"], ["second 60", "2026-10-24T09:10:60Z"],
  ["unpadded date", "2026-1-24T09:10:11Z"], ["junk suffix", `${VERSION_A}junk`],
];

test("shared exported version reader preserves strict offset ISO tokens, including all six microsecond digits", () => {
  for (const version of validVersions) assert.equal(readVersion(version), version);
  for (const [label, version] of invalidVersions) assert.equal(readVersion(version), null, label);
  assert.notEqual(readVersion(VERSION_A), readVersion(VERSION_B));
  assert.equal(Date.parse(VERSION_A), Date.parse(VERSION_B), "fixtures differ below Date millisecond precision");
});

test("actual makeContentVideo and config.fromRow preserve valid versions and never fabricate a missing/invalid updatedAt", () => {
  const { runtime } = fixture();
  for (const version of validVersions) {
    assert.equal(runtime.makeContentVideo({ id: VIDEO, updatedAt: version }).updatedAt, version);
    assert.equal(runtime.makeContentVideo({ id: VIDEO, updated_at: version }).updatedAt, version);
    const mapped = runtime.configs["content-videos"].fromRow(videoRow({ updated_at: version }));
    assert.equal(mapped.updatedAt, version);
    assert.equal(runtime.makeContentVideo(mapped).updatedAt, version);
  }
  for (const [label, version] of invalidVersions) {
    for (const body of [{ id: VIDEO }, { id: VIDEO, updatedAt: version }, { id: VIDEO, updated_at: version }]) {
      assert.equal(Object.hasOwn(runtime.makeContentVideo(body), "updatedAt"), false, label);
    }
    const mapped = runtime.configs["content-videos"].fromRow(videoRow({
      updated_at: version, raw_payload: { updatedAt: VERSION_A, expectedUpdatedAt: VERSION_A },
    }));
    assert.equal(Object.hasOwn(mapped, "updatedAt"), false, `raw payload must not supply a DB version: ${label}`);
  }
});

for (const nested of [false, true]) {
  const shape = nested ? "updates envelope" : "flat body";
  for (const [label, version] of invalidVersions) {
    test(`live ready PATCH ${shape}: ${label} version fails before any database query`, async () => {
      const f = fixture();
      const patch = { status: "telegram_ready", ...(version !== undefined ? { expectedUpdatedAt: version } : {}) };
      const body = nested ? { id: VIDEO, updates: patch } : { id: VIDEO, ...patch };
      assertRefused(await f.patch(body), version === undefined ? 409 : 400,
        version === undefined ? "content_version_conflict" : "invalid_content_version");
      assert.deepEqual(f.db.calls, []);
      assert.deepEqual(f.db.rows, [videoRow()]);
    });
  }
  test(`live ready PATCH ${shape}: explicit undefined is a missing version conflict`, async () => {
    const f = fixture();
    const patch = { status: "telegram_ready", expectedUpdatedAt: undefined };
    assertRefused(await f.patch(nested ? { id: VIDEO, updates: patch } : { id: VIDEO, ...patch }), 409, "content_version_conflict");
    assert.deepEqual(f.db.calls, []);
  });
}

for (const version of [VERSION_A, "2026-10-24T09:10:11.000001Z", "2026-10-24T09:10:11-03:30"]) {
  test(`unchanged actual mapper version roundtrips through live ready PATCH: ${version}`, async () => {
    const initial = videoRow({ updated_at: version });
    const f = fixture({ rows: [initial] });
    const delivered = f.runtime.configs["content-videos"].fromRow(initial);
    const reply = await f.patch(readyBody(delivered.updatedAt));
    assert.equal(reply.status, 200);
    assert.equal(reply.body.success, true);
    assert.equal(reply.body.mode, "supabase");
    const data = reply.body.data as RecordValue;
    assert.equal((data.video as RecordValue).status, "telegram_ready");
    assert.equal((data.item as RecordValue).updatedAt, f.db.rows[0]!.updated_at);
    assert.equal((data.video as RecordValue).script, initial.script);
    assert.deepEqual(data.item, data.video);
    assert.equal(f.db.readyWrites.length, 1);
    assertAtomic(f.db, version);
    assert.deepEqual(f.db.rows[0]!.raw_payload, initial.raw_payload);
  });
}

for (const helper of [false, true]) {
  const entry = helper ? "persistence helper" : "actual PATCH handler";
  test(`${entry}: A delivered, B commits at UPDATE execution, final A status is refused without overwriting B`, async () => {
    const b = videoRow({ title: "Synthetic package B", script: "Script B", caption: "Caption B", updated_at: VERSION_B,
      raw_payload: { packageData: { script: "Approved B" }, provenance: "editor B" } });
    const events = ["A delivered"];
    const f = fixture({ beforeUpdate(db) { events.push("B saved at UPDATE execution"); db.rows[0] = clone(b); } });
    const delivered = f.runtime.configs["content-videos"].fromRow(f.db.rows[0]!);
    if (helper) {
      assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE, patch: { status: "telegram_ready" },
        expectedUpdatedAt: delivered.updatedAt }), false);
    } else {
      assertRefused(await f.patch(readyBody(delivered.updatedAt)), 409, "content_version_conflict");
    }
    assert.deepEqual(events, ["A delivered", "B saved at UPDATE execution"]);
    assert.deepEqual(f.db.rows, [b]);
    assert.equal(f.db.updates.length, 1);
    assert.equal(f.db.readyWrites.length, 0);
    assertAtomic(f.db, VERSION_A, helper);
  });

  test(`${entry}: simultaneous ready writes with the same version allow exactly one commit`, async () => {
    const f = fixture();
    if (helper) {
      const results = await Promise.all([0, 1].map(() => f.persist({
        videoId: VIDEO, workspaceId: WORKSPACE, patch: { status: "telegram_ready" }, expectedUpdatedAt: VERSION_A,
      })));
      assert.deepEqual([...results].sort(), [false, true]);
    } else {
      const results = await Promise.all([f.patch(readyBody()), f.patch(readyBody())]);
      assert.deepEqual(results.map((reply) => reply.status).sort(), [200, 409]);
      assertRefused(results.find((reply) => reply.status === 409)!, 409, "content_version_conflict");
    }
    assert.equal(f.db.updates.length, 2);
    assert.equal(f.db.readyWrites.length, 1);
    assert.notEqual(f.db.rows[0]!.updated_at, VERSION_A);
    assertAtomic(f.db, VERSION_A, helper);
  });

  for (const [clock, version, now] of [
    ["same millisecond", "2026-10-24T09:10:11.123Z", Date.parse("2026-10-24T09:10:11.123Z")],
    ["same millisecond with microseconds", VERSION_A, Date.parse(VERSION_A)],
    ["saved version in the future", "2099-10-24T09:10:11.123Z", Date.parse("2026-10-24T09:10:11.123Z")],
    ["future version with microseconds", "2099-10-24T09:10:11.123456+05:00", Date.parse(VERSION_A)],
  ] as Array<[string, string, number]>) {
    test(`${entry}: frozen clock (${clock}) still advances the version and admits only one same-version final`, async () => {
      const f = fixture({ rows: [videoRow({ updated_at: version })], now });
      if (helper) {
        const results = await Promise.all([0, 1].map(() => f.persist({
          videoId: VIDEO, workspaceId: WORKSPACE, patch: { status: "telegram_ready" }, expectedUpdatedAt: version,
        })));
        assert.deepEqual([...results].sort(), [false, true]);
      } else {
        const results = await Promise.all([f.patch(readyBody(version)), f.patch(readyBody(version))]);
        assert.deepEqual(results.map((reply) => reply.status).sort(), [200, 409]);
        assertRefused(results.find((reply) => reply.status === 409)!, 409, "content_version_conflict");
      }
      assert.equal(f.db.readyWrites.length, 1);
      assert.equal(f.db.updates.length, 2);
      assert.equal(f.db.rows[0]!.updated_at, new Date(Math.max(now, Date.parse(version) + 1)).toISOString());
      assert.ok(databaseTimestamp(f.db.rows[0]!.updated_at)! > databaseTimestamp(version)!);
      assertAtomic(f.db, version, helper);
    });
  }

  test(`${entry}: equivalent offset spelling matches the SQL instant without rounding microseconds`, async () => {
    const f = fixture();
    const expected = "2026-10-24T04:10:11.123456Z";
    if (helper) assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
      patch: { status: "telegram_ready" }, expectedUpdatedAt: expected }), true);
    else assert.equal((await f.patch(readyBody(expected))).status, 200);
    assert.equal(f.db.readyWrites.length, 1);
    assertAtomic(f.db, expected, helper);
  });

  for (const [label, rows, expected] of [
    ["microsecond-only stale version", [videoRow({ updated_at: VERSION_B })], VERSION_A],
    ["millisecond-truncated stale version", [videoRow()], "2026-10-24T04:10:11.123Z"],
    ["foreign workspace", [videoRow({ workspace_id: FOREIGN_WORKSPACE })], VERSION_A],
    ["missing row", [], VERSION_A],
    ["different id", [videoRow({ id: OTHER_VIDEO })], VERSION_A],
  ] as Array<[string, RecordValue[], string]>) {
    test(`${entry}: ${label} is a no-match refusal, not success`, async () => {
      const f = fixture({ rows });
      if (helper) assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
        patch: { status: "telegram_ready" }, expectedUpdatedAt: expected }), false);
      else assertRefused(await f.patch(readyBody(expected)), 409, "content_version_conflict");
      assert.deepEqual(f.db.rows, rows);
      assert.equal(f.db.writes.length, 0);
      assert.equal(f.db.updates.length, 1);
      assertAtomic(f.db, expected, helper);
    });
  }

  for (const [label, failure] of [
    ["returned query error", { error: { message: "synthetic query failure", code: "XX000" } }],
    ["missing-column error", { error: { message: "synthetic column failure", code: "42703" } }],
    ["thrown transport error", { throws: true }],
  ] as Array<[string, DatabaseOptions]>) {
    test(`${entry}: ${label} fails honestly without demo fallback or an unguarded retry`, async () => {
      const f = fixture(failure);
      if (helper) assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
        patch: { status: "telegram_ready" }, expectedUpdatedAt: VERSION_A }), false);
      else assertRefused(await f.patch(readyBody()), 502);
      assert.deepEqual(f.db.rows, [videoRow()]);
      assert.equal(f.db.writes.length, 0);
      assert.equal(f.db.updates.length, 1);
      assertAtomic(f.db, VERSION_A, helper);
    });
  }
}

test("live ready PATCH uses the authorized workspace and never writes request metadata or a broad raw payload", async () => {
  const foreign = videoRow({ workspace_id: FOREIGN_WORKSPACE, script: "Foreign script" });
  const f = fixture({ rows: [videoRow(), foreign] });
  const reply = await f.patch({
    ...readyBody(), workspaceId: FOREIGN_WORKSPACE, workspace_id: FOREIGN_WORKSPACE,
    raw_payload: { expectedUpdatedAt: "must not be persisted", script: "untrusted" },
  });
  assert.equal(reply.status, 200);
  assertAtomic(f.db, VERSION_A);
  assert.deepEqual(f.db.rows[1], foreign);
  assert.deepEqual(f.db.rows[0]!.raw_payload, videoRow().raw_payload);
});

test("nested ready PATCH reads the version from updates and accepts a query id", async () => {
  const f = fixture();
  const reply = await f.patch({ updates: { status: "telegram_ready", expectedUpdatedAt: VERSION_A } },
    WORKSPACE, "content-videos", { id: VIDEO });
  assert.equal(reply.status, 200);
  assertAtomic(f.db, VERSION_A);
});

for (const [label, version] of invalidVersions) {
  test(`persistence helper: ${label} ready version returns false without a query`, async () => {
    const f = fixture();
    assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
      patch: { status: "telegram_ready" }, expectedUpdatedAt: version }), false);
    assert.deepEqual(f.db.calls, []);
    assert.deepEqual(f.db.rows, [videoRow()]);
  });
}

test("persistence helper cannot borrow expectedUpdatedAt from patch instead of its explicit input", async () => {
  const f = fixture();
  assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE, patch: readyBody() }), false);
  assert.deepEqual(f.db.calls, []);
});

test("persistence helper unchanged control returns true and selects only id with all three atomic filters", async () => {
  const f = fixture();
  assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
    patch: { status: "telegram_ready" }, expectedUpdatedAt: VERSION_A }), true);
  assert.equal(f.db.readyWrites.length, 1);
  assertAtomic(f.db, VERSION_A, true);
  assert.deepEqual(f.db.rows[0]!.raw_payload, videoRow().raw_payload);
});

for (const [label, input, available] of [
  ["no database", { videoId: VIDEO, workspaceId: WORKSPACE }, false],
  ["missing workspace", { videoId: VIDEO }, true],
  ["demo workspace", { videoId: VIDEO, workspaceId: "demo-workspace" }, true],
  ["invalid workspace", { videoId: VIDEO, workspaceId: "not-a-uuid" }, true],
  ["missing id", { workspaceId: WORKSPACE }, true],
  ["demo id", { videoId: "content-local", workspaceId: WORKSPACE }, true],
] as Array<[string, RecordValue, boolean]>) {
  test(`persistence helper: ${label} returns false without accessing any table`, async () => {
    const f = fixture({ available });
    assert.equal(await f.persist({ ...input, patch: { status: "telegram_ready" }, expectedUpdatedAt: VERSION_A }), false);
    assert.deepEqual(f.db.calls, []);
  });
}

for (const expectedUpdatedAt of [undefined, "malformed", VERSION_A]) {
  test(`ordinary content text PATCH ignores unrelated version metadata: ${String(expectedUpdatedAt)}`, async () => {
    const f = fixture({ rows: [videoRow({ updated_at: VERSION_B })] });
    const reply = await f.patch({ id: VIDEO, script: "Ordinary new script", caption: "Ordinary new caption", expectedUpdatedAt });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.mode, "supabase");
    assert.equal(((reply.body.data as RecordValue).video as RecordValue).script, "Ordinary new script");
    assert.equal(f.db.rows[0]!.caption, "Ordinary new caption");
    assert.equal(f.db.rows[0]!.status, "script_ready");
    assert.deepEqual(f.db.rows[0]!.raw_payload, videoRow().raw_payload);
    assert.deepEqual(f.db.updates[0]!.filters, [["id", VIDEO], ["workspace_id", WORKSPACE]]);
    assert.equal(f.db.updates[0]!.terminal, "single");
    assert.deepEqual(Object.keys(f.db.updates[0]!.patch!).sort(), ["caption", "script", "updated_at"]);
  });
}

test("non-ready persistence remains an ordinary workspace-scoped update and returns a boolean", async () => {
  const f = fixture({ rows: [videoRow({ updated_at: VERSION_B })] });
  assert.equal(await f.persist({ videoId: VIDEO, workspaceId: WORKSPACE,
    patch: { script: "Ordinary helper edit", status: "script_ready" }, expectedUpdatedAt: "malformed" }), true);
  assert.equal(f.db.rows[0]!.script, "Ordinary helper edit");
  assert.deepEqual(f.db.rows[0]!.raw_payload, videoRow().raw_payload);
  assert.deepEqual(f.db.updates[0]!.filters, [["id", VIDEO], ["workspace_id", WORKSPACE]]);
  assert.equal(f.db.updates[0]!.terminal, "await");
  assert.equal(f.db.updates[0]!.selection, null);
  assert.deepEqual(Object.keys(f.db.updates[0]!.patch!).sort(), ["script", "status", "updated_at"]);
});

test("another resource with telegram_ready and malformed version metadata keeps its ordinary patch behavior", async () => {
  const initial = { id: VIDEO, workspace_id: WORKSPACE, channel: "test", message: "Old synthetic message" };
  const f = fixture({ rows: [initial] });
  const reply = await f.patch({ id: VIDEO, text: "New synthetic message", status: "telegram_ready", expectedUpdatedAt: "malformed" },
    WORKSPACE, "chat");
  assert.equal(reply.status, 200);
  assert.equal(((reply.body.data as RecordValue).item as RecordValue).text, "New synthetic message");
  assert.deepEqual(f.db.rows, [{ ...initial, message: "New synthetic message" }]);
  assert.deepEqual(f.db.updates[0]!.patch, { message: "New synthetic message" });
  assert.deepEqual(f.db.updates[0]!.filters, [["id", VIDEO], ["workspace_id", WORKSPACE]]);
  assert.equal(f.db.updates[0]!.terminal, "single");
});

for (const [label, options, workspaceId, id] of [
  ["no client", { available: false }, WORKSPACE, VIDEO],
  ["demo workspace", {}, "demo-workspace", VIDEO],
  ["missing authorized context", {}, null, VIDEO],
  ["demo video id", {}, WORKSPACE, "content-local"],
] as Array<[string, DatabaseOptions, string | null, string]>) {
  test(`version CAS is live-only: ${label} preserves existing demo boundary without a database write`, async () => {
    const f = fixture(options);
    const reply = await f.patch({ id, status: "telegram_ready" }, workspaceId);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.mode, "demo");
    assert.deepEqual(f.db.calls, []);
  });
}

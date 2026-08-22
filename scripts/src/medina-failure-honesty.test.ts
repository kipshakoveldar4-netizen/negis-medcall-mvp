import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Security-2F — a failure has to look like one.
//
// Two habits had grown into the CRM data path. A query the database refused was
// answered with 200 and a demo item, so a record the operator had just typed
// appeared in the list, was never saved, and was gone on the next load. And
// where a failure was reported, it carried the text Postgres or Supabase
// Storage produced — table and constraint names, "permission denied for table
// x", row-level security messages — to any authenticated member.
//
// These tests drive the real router with a database that fails, and pin the
// browser half at the source. Nothing here touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const routerPath = path.join(repoRoot, "api", "crm", "[...path].ts");
const serverPath = path.join(repoRoot, "lib", "crm", "server.ts");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "11111111-1111-4111-8111-111111111111";
const TOKEN = "header.payload.signature";

// The kind of thing PostgREST puts in error.message.
const POSTGRES_TEXT = 'permission denied for table clients (constraint "clients_pkey")';

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

const membership = { id: "staff-a", workspace_id: WORKSPACE_A, role: "owner", status: "active" };

/** Loads the real router with a client that fails on the named tables. */
async function loadRouter(failing: Record<string, string>) {
  process.env.SUPABASE_URL = "https://project.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.VIDEO_OPTIMIZATION_ENABLED = "true";

  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: USER_A, email: "a@example.test" }),
  })) as unknown as typeof globalThis.fetch;

  const supabaseModule = (await import(
    pathToFileURL(path.join(repoRoot, "lib", "supabase", "server.ts")).href
  )) as { setSupabaseServerClientFactoryForTests: (factory: (() => unknown) | null) => void };

  supabaseModule.setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      const settle = (shape: "one" | "list") => {
        const message = failing[table];
        if (message) return Promise.resolve({ data: null, error: { message } });
        const rows = table === "staff_users" ? [membership] : [];
        return Promise.resolve(
          shape === "list" ? { data: rows, error: null, count: rows.length } : { data: rows[0] ?? null, error: null },
        );
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        insert: () => builder,
        update: () => builder,
        upsert: () => builder,
        delete: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        is: () => builder,
        in: () => builder,
        single: () => settle("one"),
        maybeSingle: () => settle("one"),
        then(onFulfilled: (value: unknown) => unknown) { return settle("list").then(onFulfilled); },
      });
      return builder;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({ data: null, error: { message: POSTGRES_TEXT } }),
        getPublicUrl: () => ({ data: { publicUrl: "https://project.example.test/x" } }),
      }),
    },
  }));

  const routerModule = (await import(pathToFileURL(routerPath).href)) as {
    default: (req: unknown, res: MockResponse) => Promise<unknown>;
  };

  const call = async (input: { segments: string[]; method?: string; body?: unknown; query?: Record<string, unknown> }) => {
    const res = mockResponse();
    await routerModule.default(
      {
        method: input.method ?? "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        query: { path: input.segments, ...(input.query ?? {}) },
        body: input.body,
      },
      res,
    );
    return { res, warnings: [...warnings] };
  };

  return {
    call,
    restore: () => {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      supabaseModule.setSupabaseServerClientFactoryForTests(null);
    },
  };
}

async function withRouter<T>(failing: Record<string, string>, fn: (ctx: Awaited<ReturnType<typeof loadRouter>>) => Promise<T>): Promise<T> {
  const ctx = await loadRouter(failing);
  try {
    return await fn(ctx);
  } finally {
    ctx.restore();
  }
}

function bodyText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

// ===========================================================================
// A. A refused write is a failure
// ===========================================================================

test("F1 a create the database refuses is not reported as a saved record", async () => {
  await withRouter({ clients: POSTGRES_TEXT }, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["clients"],
      method: "POST",
      body: { name: "Пациент", phone: "+7 700 000 00 00" },
    });

    assert.equal(res.statusCode, 502, bodyText(res.body));
    assert.equal(res.body.success, false, "a record that was not written must not come back as success");
    assert.equal(bodyText(res.body).includes('"demo"'), false, "and must not come back as a demo item");
  });
});

test("F2 an update the database refuses is not reported as applied", async () => {
  await withRouter({ clients: POSTGRES_TEXT }, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["clients"],
      method: "PATCH",
      body: { id: "11111111-1111-4111-8111-111111111112", updates: { name: "Другое имя" } },
    });

    assert.equal(res.statusCode, 502, bodyText(res.body));
    assert.equal(res.body.success, false);
  });
});

test("F3 a read the database refuses is not reported as an empty clinic", async () => {
  await withRouter({ clients: POSTGRES_TEXT }, async (ctx) => {
    const { res } = await ctx.call({ segments: ["clients"] });

    assert.equal(res.statusCode, 502, bodyText(res.body));
    assert.equal(res.body.success, false, "an empty list is an answer, and it was the wrong one");
  });
});

// ===========================================================================
// B. And says nothing about the database
// ===========================================================================

test("F4 no failure hands the caller the text Postgres produced", async () => {
  await withRouter({ clients: POSTGRES_TEXT }, async (ctx) => {
    for (const input of [
      { segments: ["clients"] },
      { segments: ["clients"], method: "POST", body: { name: "Пациент", phone: "+7 700 000 00 00" } },
      { segments: ["clients"], method: "PATCH", body: { id: "11111111-1111-4111-8111-111111111112", updates: { name: "X" } } },
    ]) {
      const { res } = await ctx.call(input);
      const text = bodyText(res.body);
      for (const leak of ["permission denied", "constraint", "clients_pkey"]) {
        assert.equal(text.includes(leak), false, `${input.method ?? "GET"} leaked "${leak}": ${text}`);
      }
    }
  });
});

test("F5 the detail an operator needs still reaches the server log", async () => {
  await withRouter({ clients: POSTGRES_TEXT }, async (ctx) => {
    const { warnings } = await ctx.call({ segments: ["clients"] });
    assert.ok(
      warnings.some((line) => line.includes("permission denied")),
      "redacting the response must not throw the detail away",
    );
  });
});

test("F6 a signed upload that Storage refuses says so without quoting Storage", async () => {
  await withRouter({}, async (ctx) => {
    const { res } = await ctx.call({
      segments: ["ad-creatives", "signed-upload"],
      method: "POST",
      body: { fileName: "creative.jpg", mimeType: "image/jpeg", fileSize: 2048 },
    });

    assert.equal(res.statusCode, 502, bodyText(res.body));
    assert.equal(bodyText(res.body).includes("permission denied"), false);
  });
});

// ===========================================================================
// C. Demo mode is chosen before the query, not after it fails
// ===========================================================================

test("F7 demo mode still answers demo, because it never depended on a failure", async () => {
  const source = await readFile(serverPath, "utf8");
  const create = source.slice(source.indexOf("async function createItem"));
  const demoBranch = create.indexOf("if (!supabase || !isUuid(workspaceId))");
  const tryBlock = create.indexOf("  try {");

  assert.ok(demoBranch > 0, "the demo branch must still exist");
  assert.ok(
    demoBranch < tryBlock,
    "demo mode is decided before the query runs; only the after-the-failure fallback was removed",
  );
});

test("F8 the browser puts back a row the server refused", async () => {
  const source = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");

  assert.ok(source.includes("const revertWrite ="), "there must be a rollback");
  const revert = source.slice(source.indexOf("const revertWrite ="));
  const body = revert.slice(0, revert.indexOf("  };"));
  assert.ok(body.includes("if (!productionMode) return;"), "demo mode owns its own copy and must not roll back");
  assert.ok(body.includes("toast.error"), "a silent rollback is the same trap in the other direction");

  // Both writes have to use it, including the patch that used to be posted and
  // forgotten entirely.
  const add = source.slice(source.indexOf("const addItem ="), source.indexOf("const updateItem ="));
  const update = source.slice(source.indexOf("const updateItem ="));
  assert.ok(add.includes("revertWrite("), "a refused create must roll back");
  assert.ok(update.includes("revertWrite("), "a refused update must roll back");
  assert.ok(update.includes("const response = await crmFetch("), "the update must read the response at all");
});

test("F12 отказ сохранения не уносит с собой набранное сотрудником", async () => {
  // Список откатывался честно, но форма закрывалась ДО ответа: карточка
  // клиента, заявка со слов звонящего и сумма продажи стирались вместе с ней,
  // и набирать всё приходилось заново. Салон наполняет данные вручную — это
  // и есть «данные слетают».
  const storage = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  assert.ok(/const addItem = \(item: TItem\): Promise<boolean>/.test(storage), "запись отвечает, сохранилась ли она");
  assert.ok(/const updateItem = \(id: string, patch: Partial<TItem>\): Promise<boolean>/.test(storage), "правка тоже");
  // Демо-режим не умеет отказывать: там localStorage и есть запись.
  assert.equal((storage.match(/return Promise\.resolve\(true\);/g) || []).length, 2, "без endpoint обе операции успешны");

  for (const [page, marker] of [
    ["ClientsPage.tsx", "Клиент добавлен"],
    ["LeadsPage.tsx", "Заявка добавлена"],
    ["SalesPage.tsx", "Продажа добавлена"],
  ] as const) {
    const source = await readFile(path.join(negisSrc, "pages", page), "utf8");
    const submit = source.slice(source.indexOf("function submitForm"), source.indexOf("function submitForm") + 3000);
    assert.ok(/const saved = editingId/.test(submit), `${page}: форма ждёт ответ сервера`);
    assert.ok(/if \(!saved\) return;/.test(submit), `${page}: при отказе форма остаётся открытой`);
    assert.ok(
      submit.indexOf("if (!saved) return;") < submit.indexOf("setFormOpen(false)"),
      `${page}: форма закрывается только после подтверждения`,
    );
    assert.ok(submit.includes(marker), `${page}: успех по-прежнему называется словами`);
    // Двойной клик заводил второй такой же record.
    assert.ok(/disabled=\{saving\}/.test(source), `${page}: кнопка занята на время записи`);
  }
});

test("F13 сбой чтения не рисуется как пустая база", async () => {
  // Пустой экран на отказе чтения выглядит как стёртая база: сотрудник
  // заводит клиентов и заявки заново, а уникальности по телефону нет —
  // дубли остаются навсегда. Экран обязан различать «пусто» и «не смогли».
  for (const [page, title] of [
    ["ClientsPage.tsx", "Не удалось загрузить клиентов"],
    ["LeadsPage.tsx", "Не удалось загрузить заявки"],
    ["SalesPage.tsx", "Не удалось загрузить продажи"],
  ] as const) {
    const source = await readFile(path.join(negisSrc, "pages", page), "utf8");
    assert.ok(/const \{ items, loaded, loadError/.test(source), `${page}: экран берёт признак отказа у хука`);
    assert.ok(source.includes(title), `${page}: отказ называется своими словами`);
    assert.ok(/Не заводите их заново/.test(source), `${page}: и прямо говорит не дублировать`);
    // Ветка отказа проверяется РАНЬШЕ пустого списка — иначе её не увидят.
    assert.ok(
      source.indexOf(") : loadError ? (") < source.indexOf("items.length === 0 ?"),
      `${page}: отказ проверяется до пустого состояния`,
    );
  }
});

test("F14 патч, в котором сервер не понял ни одного поля, не выдаётся за сохранение", async () => {
  const source = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const patch = source.slice(source.indexOf("if (Object.keys(row).length === 0) {"));
  const block = patch.slice(0, patch.indexOf("// «Было» приходится читать отдельно"));
  // Присланные, но не принятые поля — молчаливая потеря: браузер оставлял
  // оптимистичное значение, сотрудник видел «сохранено», база не менялась.
  assert.ok(/code: "no_patchable_fields"/.test(block), "непонятый патч отвечает отказом");
  assert.ok(/const offered = Object\.keys\(patchBody\)/.test(block), "решение принимается по тому, что реально прислали");
  // Пустой патч так и остаётся успехом: иначе updated_at двигался бы на
  // каждом открытии карточки (пин CS4 держит это с другой стороны).
  assert.ok(/if \(offered\.length > 0\)/.test(block), "пустой запрос по-прежнему ничего не меняет и не ругается");
});

test("F15 кэш не переживает запись и не прячет заполненный справочник", async () => {
  const api = await readFile(path.join(negisSrc, "lib", "api.ts"), "utf8");

  // Ответ запроса, стартовавшего ДО записи, описывает состояние «до». Раньше
  // он спокойно ложился в только что очищенный кэш и жил там весь TTL.
  assert.ok(/let cacheEpoch = 0;/.test(api), "у кэша есть поколение");
  assert.ok(/cacheEpoch \+= 1;/.test(api), "запись двигает поколение");
  assert.ok(/if \(startedAtEpoch !== cacheEpoch\) return;/.test(api), "ответ из прошлого поколения не кэшируется");

  // Справочники: минута. Пять минут прятали от смены только что заведённый
  // прайс — салон заливает его разом, а не по одной услуге.
  const ttl = api.match(/const REFERENCE_TTL_MS = ([^;]+);/);
  assert.ok(ttl, "TTL справочников объявлен");
  assert.equal(ttl?.[1].trim(), "60_000", "справочники обновляются в пределах минуты");
});

test("F9 a refused production read reaches the operator instead of an empty clinic", async () => {
  const source = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  const hook = source.slice(source.indexOf("export function useDemoCollection"));

  // The reporter exists, keeps demo mode quiet, and dedupes by toast id so a
  // page with several collections shows one message, not three.
  const reporter = hook.slice(hook.indexOf("const reportLoadFailure ="));
  const body = reporter.slice(0, reporter.indexOf("  };"));
  assert.ok(body.includes("if (!productionMode) return;"), "demo mode owns its copy and must stay quiet");
  assert.ok(body.includes("setLoadError(true)"), "the state must be exposed, not just toasted");
  assert.ok(body.includes('id: "crm-load-failed"'), "several collections load at once; the toast must dedupe");

  // Both failure paths report: the non-supabase answer and the thrown fetch.
  const effect = hook.slice(hook.indexOf("const loadFromApi"), hook.indexOf("void loadFromApi()"));
  const branchAt = effect.indexOf('body.mode !== "supabase"');
  assert.ok(branchAt > 0, "the refused-answer branch must exist");
  assert.ok(
    effect.slice(branchAt).includes("reportLoadFailure();"),
    "a refused answer must report",
  );
  const catchAt = effect.indexOf("} catch {");
  assert.ok(
    effect.slice(catchAt).includes("if (!cancelled) reportLoadFailure();"),
    "a thrown fetch must report too, but never after unmount",
  );

  // And a later successful load clears it.
  assert.ok(effect.includes("setLoadError(false)"), "success must clear the error");
  assert.ok(hook.includes("loadError, setItems"), "loadError must be part of the hook's return");
});

/**
 * Fields the lead form computes for the browser's own use and deliberately does
 * not send. They are snapshots the server recomputes from the taxonomy tables
 * (a stage's colour is not a property of the lead), so shipping them would let a
 * renamed stage rewrite history. Every other key the form assigns is a value the
 * operator typed or chose, and it has to reach the API.
 */
const LEAD_FORM_DISPLAY_ONLY = new Set([
  "stageName",
  "stageKey",
  "stageColor",
  "semanticGroup",
  "sourceName",
  "sourceKey",
  "sourceChannel",
  "sourceColor",
]);

test("F11 every value the lead form collects reaches the API", async () => {
  const source = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");

  // The «Ответственный» select was added with a staff list, a server-side
  // check that refuses a colleague from another clinic, and tests pinning that
  // check — and it changed nothing. The value reached submitForm's patch and
  // stopped at the serializer, which never named it. The operator saw
  // «Заявка обновлена», and the assignee was gone on the next load: a silent
  // failure with a success toast, which is the whole subject of this suite.
  //
  // Derived, not listed: the expectation is read out of the form itself, so a
  // field added tomorrow is covered without anyone remembering this test.
  const submit = source.slice(source.indexOf("function submitForm()"), source.indexOf("function changeStatus("));
  assert.ok(submit.length > 0, "submitForm must still exist");

  const literalStart = submit.indexOf("const patch = {");
  assert.ok(literalStart > 0, "the form must still build one patch object");
  const literal = submit.slice(literalStart, submit.indexOf("\n    };", literalStart));

  const collected = [...literal.matchAll(/^ {6}(?:\.\.\.\([^)]*\?\s*\{\s*)?([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)]
    .map((match) => match[1])
    .filter((key) => !LEAD_FORM_DISPLAY_ONLY.has(key));
  assert.ok(collected.length >= 6, `the form should collect several fields, found: ${collected.join(", ")}`);

  const toApi = source.slice(source.indexOf("function leadToApi("), source.indexOf("function leadPatchToApi("));
  const patchToApi = source.slice(source.indexOf("function leadPatchToApi("), source.indexOf("export default function LeadsPage"));

  const dropped = collected.filter((key) => !patchToApi.includes(key));
  assert.deepEqual(
    dropped,
    [],
    `leadPatchToApi never names these, so editing a lead silently discards them: ${dropped.join(", ")}`,
  );

  // The create path runs through the other serializer, and it forgot the same field.
  assert.ok(
    toApi.includes("responsibleUserId"),
    "leadToApi must send the assignee too — a new lead created with a responsible person kept none",
  );
});

test("F10 a refused client creation does not report success, and leaves the lead alone", async () => {
  const source = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");

  // crmFetch does not throw on 4xx/5xx, so the POST result had to be inspected
  // by hand — and it was not. A refusal fell through to the locally built
  // object: the lead was linked to an id that never existed and the toast said
  // «Клиент создан из заявки». Reachable with an ordinary role, not only in an
  // outage: POST /api/crm/clients needs `manage_clients`, `marketer` has
  // `view_clients` + `manage_leads` and not that one, and the button is not
  // gated. The registrar saw success and no error.
  const convert = source.slice(source.indexOf("// No duplicate — create a new client"));
  assert.ok(convert.length > 0, "the conversion path must still exist");

  assert.ok(
    convert.includes("persistedOnServer"),
    "the outcome of the POST has to be carried explicitly, not inferred from a local object",
  );
  assert.ok(
    convert.includes("isUuid(persisted.id)"),
    "a uuid is the only proof the row reached Supabase; any truthy id passed before",
  );

  const guard = convert.indexOf("if (isRealWorkspace() && !persistedOnServer)");
  const link = convert.indexOf("updateItem(lead.id, { clientId: savedClient.id");
  const success = convert.indexOf('toast.success("Клиент создан из заявки.")');

  assert.ok(guard > 0, "a real clinic must refuse when the server did");
  assert.ok(
    guard < link && guard < success,
    "the refusal must come before the lead is linked and before the success toast",
  );
  assert.ok(
    convert.slice(guard, guard + 260).includes("return"),
    "refusing means leaving: the statusPatch below persists, and a lead moved into «В работе» " +
      "against a client that does not exist is the damage that outlives the wrong toast",
  );
});

test("F14 экран записей тоже различает «пусто» и «не смогли»", async () => {
  // Самая дорогая из шести критических находок аудита: по этому экрану
  // отпускают мастера домой и говорят пришедшему «свободно, заходите».
  // Пустая сетка на отказе чтения выглядела свободным днём, а единственным
  // признаком был тост, живущий четыре секунды.
  //
  // Проверка списком экранов (F13) этого не поймала: там перечислены три
  // страницы, и самая рабочая в список не попала. Поэтому проверка отдельная.
  const source = await readFile(path.join(negisSrc, "pages", "AppointmentsPage.tsx"), "utf8");
  assert.ok(/const \{ items, loaded, loadError/.test(source), "экран берёт признак отказа у хука");
  assert.ok(source.includes("Не удалось загрузить записи"), "отказ называется своими словами");
  assert.ok(/Это сбой связи, а не свободный день/.test(source), "и прямо говорит, что день не свободен");
  // Ни один вид не рисуется поверх отказа: пустая сетка и есть та самая ложь.
  for (const view of ["grid", "day", "week", "list"]) {
    assert.ok(
      source.includes(`loaded && !loadError && view === "${view}"`),
      `вид ${view} не рисуется, пока список не прочитан`,
    );
  }
});

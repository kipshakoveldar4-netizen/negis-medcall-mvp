import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Api = {
  operatorApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T>;
  OperatorApiError: new (message: string, status: number) => Error & { status: number };
};
type ErrorHelpers = {
  crmErrorMessage(status: number): string;
  CrmApiError: new (status: number, code: string, message: string) => Error & { status: number; code: string };
};
type Call = { path: string; init: RequestInit };

function transpile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const compiled = (async () => {
  const operator = await readFile(path.join(root, "artifacts/negis/src/lib/operatorApi.ts"), "utf8");
  const apiSource = await readFile(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8");
  const apiFile = ts.createSourceFile("api.ts", apiSource, ts.ScriptTarget.ES2022, true);
  // Keep the real error formatter and its class dependency, without evaluating
  // Vite env, authentication or crmFetch/cache code. Neither is a stub.
  const errorDeclarations = apiFile.statements.filter((node) =>
    (ts.isClassDeclaration(node) && node.name?.text === "CrmApiError")
    || (ts.isFunctionDeclaration(node) && node.name?.text === "crmErrorMessage"),
  );
  assert.equal(errorDeclarations.length, 2, "The real error helper and its dependency must exist");
  const contracts = await readFile(path.join(root, "lib/crm/operator-contracts.ts"), "utf8");
  return {
    operator: transpile(operator),
    errors: transpile(errorDeclarations.map((node) => node.getFullText(apiFile)).join("\n")),
    contracts: transpile(contracts),
  };
})();

function evaluate<T>(source: string, filename: string, require: (name: string) => unknown) {
  const exports = {} as T;
  new Script(source, { filename }).runInNewContext({ exports, require });
  return exports;
}

async function fixture(respond: (call: Call) => Response | Promise<Response>) {
  const source = await compiled;
  const unexpectedImport = (name: string): never => assert.fail(`Unexpected import: ${name}`);
  const errors = evaluate<ErrorHelpers>(source.errors, "isolated-crm-errors.cjs", unexpectedImport);
  const contracts = evaluate<object>(source.contracts, "isolated-operator-contracts.cjs", unexpectedImport);
  const calls: Call[] = [];
  const hook = () => assert.fail("React hooks must not run in the operator transport suite");
  // No fetch, process/env, browser globals or application auth are available.
  const api = evaluate<Api>(source.operator, "isolated-operator-api.cjs", (name) => {
    if (name === "react") return { useCallback: hook, useEffect: hook, useState: hook };
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "@/lib/api") return {
      CrmApiError: errors.CrmApiError,
      crmErrorMessage: errors.crmErrorMessage,
      crmFetch: async (path: string, init: RequestInit) => {
        const call = { path, init };
        calls.push(call);
        return respond(call);
      },
    };
    return unexpectedImport(name);
  });
  return { api, calls, errors };
}

function reply(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function operatorError(api: Api, status: number, inspect?: (message: string) => void) {
  return (error: unknown) => {
    assert.ok(error instanceof api.OperatorApiError);
    assert.equal(error.status, status);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.trim(), "Failure must have an explanatory message");
    inspect?.(error.message);
    return true;
  };
}

const LEADS = "operator-leads?requestId=synthetic-request&offset=0";
const DTO = {
  items: [{
    id: "synthetic-lead", name: "Synthetic contact", phone: "synthetic-phone",
    status: "new", source: "test", createdAt: "2026-01-01T00:00:00.000Z",
  }],
  hasMore: true,
};
const EMPTY = { items: [], hasMore: false };
const SERVER_DETAIL = "synthetic-server-detail: internal exception";

for (const method of [undefined, "DELETE"]) {
  test(`O1 bodyless ${method ?? "default"} call is a no-store GET without JSON headers/body`, async () => {
    const { api, calls } = await fixture(() => reply({ success: true, data: DTO }));
    await api.operatorApi(LEADS, undefined, method);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `/api/crm/${LEADS}`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(Object.hasOwn(calls[0].init, "body"), false);
    assert.equal(new Headers(calls[0].init.headers).has("Content-Type"), false);
  });
}

for (const method of [undefined, "PATCH", "DELETE"]) {
  test(`O2 ${method ?? "default POST"} write sends JSON and remains no-store`, async () => {
    const { api, calls } = await fixture(() => reply({ success: true, data: { updated: true } }));
    const body = { requestId: "synthetic-request", status: "contacted" };
    const controller = new AbortController();
    await api.operatorApi("operator-lead-status", body, method, controller.signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/api/crm/operator-lead-status");
    assert.equal(calls[0].init.method, method ?? "POST");
    assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].init.signal, controller.signal);
    assert.equal(new Headers(calls[0].init.headers).get("Content-Type"), "application/json");
    assert.equal(calls[0].init.body, JSON.stringify(body));
  });
}

test("O3 each call forwards its own AbortSignal and an aborted call does not settle its replacement", async () => {
  const pending = [deferred<Response>(), deferred<Response>()];
  let index = 0;
  const { api, calls } = await fixture(({ init }) => {
    const request = pending[index++];
    const abort = () => request.reject(new DOMException("Synthetic abort", "AbortError"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    return request.promise;
  });
  const oldController = new AbortController();
  const newController = new AbortController();
  const old = api.operatorApi(LEADS, undefined, "GET", oldController.signal);
  const rejected = assert.rejects(old, { name: "AbortError" });
  const current = api.operatorApi(LEADS, undefined, "GET", newController.signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.signal, oldController.signal);
  assert.equal(calls[1].init.signal, newController.signal);
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
  for (const call of calls) assert.equal(call.init.cache, "no-store");
  oldController.abort();
  await rejected;
  assert.equal(newController.signal.aborted, false);
  pending[1].resolve(reply({ success: true, data: DTO }));
  assert.deepEqual(await current, DTO);
});

for (const status of [401, 403]) {
  test(`O4 HTTP ${status} hides arbitrary server error even with success=true`, async () => {
    const { api, errors } = await fixture(() => reply({
      success: true, data: DTO, error: SERVER_DETAIL, code: "access_denied",
    }, status));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, status, (message) => {
      assert.equal(message, errors.crmErrorMessage(status));
      assert.notEqual(message, SERVER_DETAIL);
      assert.match(message, /[\u0400-\u04ff]/, "Auth failures need user-facing Russian copy");
    }));
  });
}

for (const status of [403, 503]) {
  test(`O5 authorization_unavailable at HTTP ${status} gives safe retry guidance`, async () => {
    const { api } = await fixture(() => reply({
      success: false, code: "authorization_unavailable", error: SERVER_DETAIL,
    }, status));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, status, (message) => {
      assert.notEqual(message, SERVER_DETAIL);
      assert.match(message, /\u0421\u0435\u0440\u0432\u0438\u0441 \u0432\u0445\u043e\u0434\u0430/);
      assert.match(message, /\u043f\u043e\u0437\u0436\u0435/, "Explain that retrying later is appropriate");
    }));
  });
}

for (const status of [500, 502, 503]) {
  test(`O6 HTTP ${status} cannot become data even when its body claims success`, async () => {
    const { api, errors } = await fixture(() => reply({ success: true, data: EMPTY }, status));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, status, (message) => {
      assert.equal(message, errors.crmErrorMessage(status));
    }));
  });
}

test("O7 crmFetch network rejection is propagated, not replaced with empty data", async () => {
  const failure = new TypeError("Synthetic network failure");
  const { api } = await fixture(() => Promise.reject(failure));
  await assert.rejects(api.operatorApi(LEADS), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
});

test("O7 missing-session CrmApiError before Response becomes a safe OperatorApiError(401)", async () => {
  const { api, errors } = await fixture(() => Promise.reject(new errors.CrmApiError(
    401, "authentication_required", SERVER_DETAIL,
  )));
  await assert.rejects(api.operatorApi(LEADS), operatorError(api, 401, (message) => {
    assert.equal(message, errors.crmErrorMessage(401));
    assert.notEqual(message, SERVER_DETAIL);
    assert.match(message, /[\u0400-\u04ff]/);
  }));
});

for (const [label, body] of [["malformed JSON", "{invalid"], ["empty body", ""]]) {
  test(`O8 HTTP 200 with ${label} rejects instead of becoming empty data`, async () => {
    const { api, errors } = await fixture(() => new Response(body, { status: 200 }));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, 200, (message) => {
      assert.equal(message, errors.crmErrorMessage(200));
    }));
  });
}

for (const [label, payload] of [
  ["success=false", { success: false, data: EMPTY }],
  ["missing success", { data: EMPTY }],
  ["null envelope", null],
] as const) {
  test(`O9 HTTP 200 with ${label} rejects instead of accepting empty data`, async () => {
    const { api } = await fixture(() => reply(payload));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, 200));
  });
}

// These are envelope checks, not per-endpoint DTO schemas. Keep real failures
// visible for the main session; the worker must not patch application runtime.
for (const [label, payload] of [
  ["success=string true", { success: "true", data: EMPTY }],
  ["success=1", { success: 1, data: EMPTY }],
  ["GET success=true without data", { success: true }],
] as const) {
  test(`O10 invalid ${label} must reject, not report a successful empty result`, async () => {
    const { api } = await fixture(() => reply(payload));
    await assert.rejects(api.operatorApi(LEADS), operatorError(api, 200));
  });
}

for (const [label, data] of [["populated", DTO], ["legitimately empty", EMPTY]] as const) {
  test(`O11 valid ${label} DTO is returned without envelope or invented schema changes`, async () => {
    const { api } = await fixture(() => reply({ success: true, data }));
    assert.deepEqual(await api.operatorApi<typeof DTO>(LEADS), data);
  });
}

test("O11 operator-account GET may legitimately return data=null", async () => {
  const { api, calls } = await fixture(() => reply({ success: true, data: null }));
  assert.equal(await api.operatorApi("operator-account"), null);
  assert.equal(calls[0].init.method, "GET");
});

for (const method of ["POST", "PATCH"]) {
  test(`O11 successful ${method} acknowledgement does not require data`, async () => {
    const { api } = await fixture(() => reply({ success: true }));
    assert.equal(await api.operatorApi("operator-lead-status", { status: "contacted" }, method), undefined);
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Init = RequestInit & { accessToken?: string };
type Api = {
  crmFetch(path: string, init?: Init): Promise<Response>;
  clearCrmCache(): void;
};

// Compile the real browser helper with synthetic Vite config, not application
// env. Each VM owns its maps/session and has no real network implementation.
const compiled = readFile(path.join(root, "artifacts/negis/src/lib/api.ts"), "utf8").then((source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env"
          && ts.isMetaProperty(node.expression)
          && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reply(data: unknown, status = 200, bodyGate?: Promise<void>) {
  const response = new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
  const reading = deferred<void>();
  const reads: Promise<string>[] = [];
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "clone", { value: () => {
    const copy = clone();
    const text = copy.text.bind(copy);
    Object.defineProperty(copy, "text", { value: () => {
      const read = (async () => {
        reading.resolve();
        if (bodyGate) await bodyGate;
        return text();
      })();
      reads.push(read);
      return read;
    } });
    return copy;
  } });
  return { response, reading: reading.promise, reads };
}

async function fixture() {
  const state = { token: "session-a", now: 1_000 };
  const calls: Array<ReturnType<typeof deferred<Response>> & { url: string; init: RequestInit }> = [];
  const exports = {} as Api;
  new Script(await compiled, { filename: "isolated-crm-api.cjs" }).runInNewContext({
    exports, Headers, Response,
    Date: class extends Date { static now() { return state.now; } },
    require(name: string) {
      assert.equal(name, "@/lib/serverAuth", "No other application imports are permitted");
      return { getSupabaseAccessToken: async () => state.token };
    },
    fetch(url: string, init: RequestInit) {
      const request = { ...deferred<Response>(), url, init };
      calls.push(request);
      const abort = () => request.reject(new DOMException("Aborted", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      return request.promise;
    },
  });
  async function answer(index: number, data: unknown, status = 200) {
    const value = reply(data, status);
    calls[index].resolve(value.response);
    await tick();
    await Promise.all(value.reads);
    await tick();
  }
  return { api: exports, state, calls, answer };
}

const CLIENTS = "/api/crm/clients?workspaceId=workspace-a";
const TOKEN = { accessToken: "session-a" };

test("C1 ordinary simultaneous GETs still share one request and independently readable bodies", async () => {
  const { api, calls, answer } = await fixture();
  const first = api.crmFetch(CLIENTS, TOKEN);
  const second = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 1);
  await answer(0, { revision: 1 });
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a, b);
  assert.deepEqual(await a.json(), { revision: 1 });
  assert.deepEqual(await b.json(), { revision: 1 });
  assert.deepEqual(await (await api.crmFetch(CLIENTS, TOKEN)).json(), { revision: 1 });
  assert.equal(calls.length, 1, "Confirmed ordinary reads keep navigation caching");
});

test("C2 pending and cached answers are isolated by token and workspace", async () => {
  const { api, calls, answer } = await fixture();
  const requests = [
    api.crmFetch(CLIENTS, TOKEN),
    api.crmFetch(CLIENTS, { accessToken: "session-b" }),
    api.crmFetch("/api/crm/clients?workspaceId=workspace-b", TOKEN),
  ];
  await tick();
  assert.equal(calls.length, 3);
  for (let index = 0; index < requests.length; index++) {
    await answer(index, { scope: index });
    assert.deepEqual(await (await requests[index]).json(), { scope: index });
  }
  assert.deepEqual(await (await api.crmFetch(CLIENTS, TOKEN)).json(), { scope: 0 });
  assert.equal(calls.length, 3);
});

test("C3 each request resolves the current session and replaces supplied Authorization", async () => {
  const { api, calls, state, answer } = await fixture();
  const first = api.crmFetch(CLIENTS, { headers: { Authorization: "Bearer forged" } });
  await tick();
  state.token = "session-b";
  const next = api.crmFetch(CLIENTS);
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer session-a");
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "Bearer session-b");
  await answer(0, {});
  await answer(1, {});
  await Promise.all([first, next]);
  state.token = "";
  await assert.rejects(api.crmFetch(CLIENTS), { status: 401, code: "authentication_required" });
  assert.equal(calls.length, 2);
});

test("C4 no-store operator revalidation cannot inherit an older authorized response", async () => {
  const { api, calls, answer } = await fixture();
  const path = "/api/crm/operator-leads?requestId=request-a&offset=0";
  const first = api.crmFetch(path, { ...TOKEN, cache: "no-store" });
  const revalidation = api.crmFetch(path, { ...TOKEN, cache: "no-store" });
  await tick();
  assert.equal(calls.length, 2, "Revalidation needs a new server access check");
  await answer(1, { code: "access_denied" }, 403);
  assert.equal((await revalidation).status, 403);
  await answer(0, { contacts: ["synthetic-contact"] });
  assert.equal((await first).status, 200);
});

test("C5 no-store does not join a normal GET already in flight", async () => {
  const { api, calls, answer } = await fixture();
  const first = api.crmFetch(CLIENTS, TOKEN);
  const fresh = api.crmFetch(CLIENTS, { ...TOKEN, cache: "no-store" });
  await tick();
  assert.equal(calls.length, 2);
  await answer(0, { revision: 1 });
  await answer(1, { revision: 2 });
  assert.deepEqual(await (await first).json(), { revision: 1 });
  assert.deepEqual(await (await fresh).json(), { revision: 2 });
});

for (const endpoint of ["auth-context", "video-jobs", "video-generation", "change-log"]) {
  test(`C6 ${endpoint} bypasses both completed and pending response reuse`, async () => {
    const { api, calls, answer } = await fixture();
    const path = `/api/crm/${endpoint}?workspaceId=workspace-a`;
    const first = api.crmFetch(path, TOKEN);
    const second = api.crmFetch(path, TOKEN);
    await tick();
    assert.equal(calls.length, 2);
    await answer(0, { revision: 1 });
    await answer(1, { revision: 2 });
    await Promise.all([first, second]);
    const third = api.crmFetch(path, TOKEN);
    await tick();
    assert.equal(calls.length, 3);
    await answer(2, { revision: 3 });
    assert.deepEqual(await (await third).json(), { revision: 3 });
  });
}

test("C7 clearing the cache detaches a pending read before a new request", async () => {
  const { api, calls, answer } = await fixture();
  const old = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  api.clearCrmCache();
  const current = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 2);
  await answer(1, { revision: 2 });
  await answer(0, { revision: 1 });
  await old;
  assert.deepEqual(await (await current).json(), { revision: 2 });
  assert.deepEqual(await (await api.crmFetch(CLIENTS, TOKEN)).json(), { revision: 2 });
});

test("C8 a write detaches earlier GETs without merging or swallowing writes", async () => {
  const { api, calls, answer } = await fixture();
  const old = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  const writes = [api.crmFetch(CLIENTS, { ...TOKEN, method: "POST" }), api.crmFetch(CLIENTS, { ...TOKEN, method: "POST" })];
  await tick();
  const current = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 4);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[2].init.method, "POST");
  for (let index = 0; index < 4; index++) await answer(index, { revision: index });
  await Promise.all([old, ...writes]);
  assert.deepEqual(await (await current).json(), { revision: 3 });
});

test("C9 an invalidation during body reading cannot repopulate the cache", async () => {
  const { api, calls, answer } = await fixture();
  const gate = deferred<void>();
  const old = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  const value = reply({ revision: 1 }, 200, gate.promise);
  calls[0].resolve(value.response);
  await value.reading;
  api.clearCrmCache();
  gate.resolve();
  await Promise.all(value.reads);
  await tick();
  await old;
  const current = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 2, "Old body must not be cached after the reset");
  await answer(1, { revision: 2 });
  assert.deepEqual(await (await current).json(), { revision: 2 });
});

test("C10 completion of an old request cannot remove its newer replacement", async () => {
  const { api, calls, answer } = await fixture();
  const old = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  api.clearCrmCache();
  const current = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 2);
  await answer(0, { revision: 1 });
  await old;
  const follower = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 2, "The newer pending request must still deduplicate");
  await answer(1, { revision: 2 });
  assert.deepEqual(await (await current).json(), { revision: 2 });
  assert.deepEqual(await (await follower).json(), { revision: 2 });
});

test("C11 aborting an old no-store read does not cancel the replacement read", async () => {
  const { api, calls, answer } = await fixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const old = api.crmFetch(CLIENTS, { ...TOKEN, cache: "no-store", signal: firstController.signal });
  const rejected = assert.rejects(old, { name: "AbortError" });
  const current = api.crmFetch(CLIENTS, { ...TOKEN, cache: "no-store", signal: secondController.signal });
  const observed = current.catch((error: unknown) => error);
  await tick();
  assert.equal(calls.length, 2);
  firstController.abort();
  await rejected;
  await answer(1, { revision: 2 });
  const result = await observed;
  assert.ok(result instanceof Response);
  assert.deepEqual(await result.json(), { revision: 2 });
  assert.equal(secondController.signal.aborted, false);
});

for (const status of [401, 403, 502]) {
  test(`C12 status ${status} is never cached or retained as a pending read`, async () => {
    const { api, calls, answer } = await fixture();
    const first = api.crmFetch(CLIENTS, TOKEN);
    await tick();
    await answer(0, { code: "refused" }, status);
    assert.equal((await first).status, status);
    const next = api.crmFetch(CLIENTS, TOKEN);
    await tick();
    assert.equal(calls.length, 2);
    await answer(1, { revision: 2 });
    assert.equal((await next).status, 200);
  });
}

test("C13 a network failure is removed from dedupe so retry reaches the server", async () => {
  const { api, calls, answer } = await fixture();
  const first = api.crmFetch(CLIENTS, TOKEN);
  const rejected = assert.rejects(first, /synthetic network failure/);
  await tick();
  calls[0].reject(new Error("synthetic network failure"));
  await rejected;
  await tick();
  const next = api.crmFetch(CLIENTS, TOKEN);
  await tick();
  assert.equal(calls.length, 2);
  await answer(1, {});
  await next;
});

for (const [path, ttl] of [[CLIENTS, 10_000], ["/api/crm/clinic-services?workspaceId=workspace-a", 60_000]] as const) {
  test(`C14 cached ${path} expires at its ${ttl}ms boundary`, async () => {
    const { api, calls, state, answer } = await fixture();
    const first = api.crmFetch(path, TOKEN);
    await tick();
    await answer(0, { revision: 1 });
    await first;
    state.now += ttl - 1;
    assert.deepEqual(await (await api.crmFetch(path, TOKEN)).json(), { revision: 1 });
    assert.equal(calls.length, 1);
    state.now += 1;
    const next = api.crmFetch(path, TOKEN);
    await tick();
    assert.equal(calls.length, 2);
    await answer(1, { revision: 2 });
    assert.deepEqual(await (await next).json(), { revision: 2 });
  });
}

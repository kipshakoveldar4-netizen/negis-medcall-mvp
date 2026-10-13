import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = process.argv.includes("--baseline");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Init = RequestInit & { accessToken?: string; expectedUserId?: string };
type Api = { crmFetch(path: string, init?: Init): Promise<Response> };
type OperatorApi = {
  operatorApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal, expectedUserId?: string): Promise<T>;
  OperatorApiError: new (message: string, status: number) => Error & { status: number };
};

// Actual transport and token helper, with synthetic SDK sessions and no network.
async function compile(file: string) {
  const source = baseline
    ? execFileSync("git", ["show", `87790e1:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env"
          && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
}
const source = (async () => ({
  auth: await compile("artifacts/negis/src/lib/serverAuth.ts"),
  api: await compile("artifacts/negis/src/lib/api.ts"),
  operator: await compile("artifacts/negis/src/lib/operatorApi.ts"),
  contracts: await compile("lib/crm/operator-contracts.ts"),
}))();

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const code = await source;
  const lookup = gate();
  const state = { userId: "A", token: "synthetic-A", error: false, lookups: 0 };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const unexpected = (name: string): never => assert.fail(`Unexpected dependency: ${name}`);
  function evaluate<T>(code: string, name: string, require: (name: string) => unknown) {
    const exports = {} as T;
    new Script(code, { filename: name }).runInNewContext({
      exports, require, Error, Headers, Response, AbortController, DOMException,
      fetch(url: string, init: RequestInit) {
        calls.push({ url, init });
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { saved: true } }), {
          headers: { "content-type": "application/json" },
        }));
      },
    });
    return exports;
  }
  const auth = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(code.auth, "serverAuth.fixture.cjs", (name) => {
    if (name === "@/lib/authSignOut") return { isSignOutPending: () => false, getSignOutRevision: () => 0 };
    assert.equal(name, "@/lib/supabase");
    return { hasSupabaseFrontendEnv: true, supabase: { auth: { async getSession() {
      state.lookups++;
      await lookup.promise;
      return {
        error: state.error ? new Error("Synthetic SDK failure") : null,
        data: { session: { user: { id: state.userId }, access_token: state.token } },
      };
    } } } };
  });
  const api = evaluate<Api>(code.api, "api.fixture.cjs", (name) => {
    assert.equal(name, "@/lib/serverAuth");
    return auth;
  });
  const contracts = evaluate<object>(code.contracts, "contracts.fixture.cjs", unexpected);
  const operator = evaluate<OperatorApi>(code.operator, "operatorApi.fixture.cjs", (name) => {
    if (name === "@/lib/api") return api;
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "react") return { useCallback: unexpected, useEffect: unexpected, useState: unexpected };
    return unexpected(name);
  });
  return { auth, api, operator, state, calls, release: lookup.resolve };
}

test("S1 queued A PATCH cannot dispatch using B's session after token lookup", async () => {
  const f = await fixture();
  const pending = f.operator.operatorApi("operator-account", { acceptingRequests: false }, "PATCH", undefined, "A");
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof f.operator.OperatorApiError);
    assert.equal(error.status, 401);
    return true;
  });
  await tick();
  f.state.userId = "B";
  f.state.token = "synthetic-B";
  f.release();
  await rejected;
  assert.equal(f.calls.length, 0, "No profile write can reach B");
});

for (const method of ["GET", "PATCH"]) {
  test(`S2 aborted ${method} cannot dispatch after a delayed lookup returns to A`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = f.operator.operatorApi("operator-account", method === "GET" ? undefined : { acceptingRequests: false }, method, controller.signal, "A");
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await tick();
    controller.abort();
    f.release();
    await rejected;
    assert.equal(f.calls.length, 0);
  });
}

test("S3 token rotation for the same actor is allowed without leaking the selector", async () => {
  const f = await fixture();
  const pending = f.operator.operatorApi("operator-account", { acceptingRequests: false }, "PATCH", undefined, "A");
  await tick();
  f.state.token = "synthetic-A-rotated";
  f.release();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(new Headers(f.calls[0].init.headers).get("Authorization"), "Bearer synthetic-A-rotated");
  assert.equal(Object.hasOwn(f.calls[0].init, "expectedUserId"), false);
  assert.equal(f.calls[0].init.method, "PATCH");
});

test("S4 an explicit token cannot bypass a pinned actor lookup", async () => {
  const f = await fixture();
  f.release();
  await f.api.crmFetch("/api/crm/operator-account", {
    method: "PATCH", accessToken: "synthetic-B", expectedUserId: "A",
  });
  assert.equal(f.state.lookups, 1);
  assert.equal(new Headers(f.calls[0].init.headers).get("Authorization"), "Bearer synthetic-A");
});

test("S5 a pre-aborted request does not even resolve the session", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  f.release();
  await assert.rejects(f.operator.operatorApi("operator-account", {}, "PATCH", controller.signal, "A"), { name: "AbortError" });
  assert.equal(f.state.lookups, 0);
  assert.equal(f.calls.length, 0);
});

for (const reason of ["missing-token", "sdk-failure"]) {
  test(`S6 ${reason} refuses a pinned write before dispatch`, async () => {
    const f = await fixture();
    if (reason === "missing-token") f.state.token = "";
    else f.state.error = true;
    f.release();
    await assert.rejects(f.operator.operatorApi("operator-account", {}, "PATCH", undefined, "A"), (error: unknown) => {
      assert.ok(error instanceof f.operator.OperatorApiError);
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(f.calls.length, 0);
  });
}

test("S7 legacy unpinned requests keep their existing explicit-token contract", async () => {
  const f = await fixture();
  await f.api.crmFetch("/api/crm/clients?workspaceId=synthetic", { accessToken: "synthetic-explicit" });
  assert.equal(f.state.lookups, 0);
  assert.equal(new Headers(f.calls[0].init.headers).get("Authorization"), "Bearer synthetic-explicit");
});

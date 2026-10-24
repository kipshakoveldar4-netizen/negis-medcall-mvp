import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual Login setup/submit and transport helpers; only SDK, hooks and HTTP are fake.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const loginPath = "artifacts/negis/src/pages/Login.tsx";
const source = process.env.MEDINA_LOGIN_TEST_BASELINE === "7c61854"
  ? execFileSync("git", ["show", `7c61854:${loginPath}`], { cwd: root, encoding: "utf8" })
  : await read(loginPath);
const sources = Object.fromEntries(await Promise.all([
  "artifacts/negis/src/lib/api.ts", "artifacts/negis/src/lib/serverAuth.ts",
  "artifacts/negis/src/lib/authSignOut.ts", "artifacts/negis/src/lib/permissions.ts",
  "artifacts/negis/src/lib/workspaceRoutes.ts", "lib/auth/staff-logins.ts",
  "lib/crm/workspace-purpose.ts", "lib/vertical/terms.ts",
].map(async (file) => [file, await read(file)])));

function evaluate(code: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}, extract = false) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("env", ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("DEV", ts.factory.createFalse()),
              ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("")),
            ])),
          ]);
        }
        if (extract && ts.isFunctionDeclaration(node) && node.name?.text === "Login" && node.body) {
          const statements = node.body.statements;
          assert.ok(ts.isReturnStatement(statements.at(-1)!), "Login must end in its JSX return");
          return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, ts.factory.createBlock([
              ...statements.slice(0, -1),
              ts.factory.createReturnStatement(ts.factory.createObjectLiteralExpression([
                ts.factory.createShorthandPropertyAssignment("submit"),
              ])),
            ], true));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  new Script(compiled).runInNewContext({
    exports, Error, DOMException, Headers, Response, URLSearchParams, ...bindings,
    require(name: string) {
      assert.ok(name in imports, `Unexpected dependency: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const terms = evaluate(sources["lib/vertical/terms.ts"]);
const purposes = evaluate(sources["lib/crm/workspace-purpose.ts"], { "../vertical/terms": terms });
const permissions = evaluate(sources["artifacts/negis/src/lib/permissions.ts"]);
const logins = evaluate(sources["lib/auth/staff-logins.ts"]);
const routes = evaluate(sources["artifacts/negis/src/lib/workspaceRoutes.ts"]);
const actorA = "login-local-actor-a", actorB = "login-local-actor-b";
const selectorKey = "negis_workspace_selector", inviteKey = "negis_pending_invite";
const linked = { success: true, data: { memberships: [{ workspaceId: "login-local-workspace",
  role: "owner", purpose: "clinic_services" }] } };
const empty = { success: true, data: { memberships: [] } };
const joins = (status?: string) => ({ success: true, data: { requests: status ? [{ status }] : [] } });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
async function flush() {
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let pass = 0; pass < 16; pass++) await Promise.resolve();
    await setImmediate();
  }
}
type Init = RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean };
type HttpRequest = { url: string; init: RequestInit; headers: ReturnType<typeof deferred<Response>>;
  body?: ReturnType<typeof deferred<string>>; bodyReads: number; responded: boolean };
type Options = { invite?: boolean; credentialsError?: boolean };

function setup(options: Options = {}) {
  const localStorage = storage(), sessionStorage = storage(options.invite ? { [inviteKey]: "local-invite" } : {});
  const window = { localStorage, sessionStorage, location: { origin: "https://example.test", pathname: "/login" } };
  const signOut = evaluate(sources["artifacts/negis/src/lib/authSignOut.ts"], {}, { window });
  const callbacks = new Set<(event: string, value: ReturnType<typeof session>) => void>();
  const cleanups: (() => void)[] = [], stateWrites: unknown[] = [];
  const requests: HttpRequest[] = [], calls: { url: string; init: Init }[] = [];
  const tokenCalls: (string | undefined)[] = [], tokenHolds: ReturnType<typeof deferred<void>>[] = [];
  const allTokenHolds: ReturnType<typeof deferred<void>>[] = [];
  const toasts: { kind: string; message: string }[] = [], locations: string[] = [], signOutActors: (string | null)[] = [];
  const submissions: Promise<void>[] = [];
  let actor: string | null = null, tokenGeneration = 0, signInCalls = 0, unsubscribeCalls = 0, stateIndex = 0;
  function session() {
    return actor ? { user: { id: actor, email: `${actor}@example.test` },
      access_token: `local-only:${actor}:${tokenGeneration}` } : null;
  }
  function emit(next: string | null, event = next ? "SIGNED_IN" : "SIGNED_OUT") {
    actor = next;
    for (const callback of [...callbacks]) callback(event, session());
  }
  const sdk = {
    onAuthStateChange(callback: (event: string, value: ReturnType<typeof session>) => void) {
      callbacks.add(callback);
      // The SDK's initial snapshot is not the actor established by this submit.
      callback("INITIAL_SESSION", session());
      return { data: { subscription: { unsubscribe() {
        if (callbacks.delete(callback)) unsubscribeCalls++;
      } } } };
    },
    async signInWithPassword() {
      signInCalls++;
      if (options.credentialsError) return { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
      emit(actorA);
      return { data: { session: session(), user: session()!.user }, error: null };
    },
    async getSession() { return { data: { session: session() }, error: null }; },
    async signOut() { signOutActors.push(actor); emit(null); return { error: null }; },
  };
  const supabaseModule = { hasSupabaseFrontendEnv: true, supabase: { auth: sdk } };
  const actualServerAuth = evaluate(sources["artifacts/negis/src/lib/serverAuth.ts"], {
    "@/lib/supabase": supabaseModule, "@/lib/authSignOut": signOut,
  });
  const serverAuth = { async getSupabaseAccessToken(expected?: string) {
    tokenCalls.push(expected);
    const hold = tokenHolds.shift();
    const token = await actualServerAuth.getSupabaseAccessToken(expected);
    if (hold) await hold.promise;
    return token;
  } };
  const api = evaluate(sources["artifacts/negis/src/lib/api.ts"], { "@/lib/serverAuth": serverAuth }, {
    window,
    fetch(url: string, init: RequestInit) {
      assert.ok(["/api/crm/auth-context", "/api/crm/join-request"].includes(url), "No external HTTP is allowed");
      const request: HttpRequest = { url, init, headers: deferred<Response>(), bodyReads: 0, responded: false };
      requests.push(request);
      return request.headers.promise;
    },
  });
  const login = evaluate(source, {
    react: {
      useState(initial: unknown) {
        const index = stateIndex++;
        const value = index === 0 ? "local-a@example.test" : index === 1 ? "local-test-password" : initial;
        return [value, (next: unknown) => { stateWrites.push(next); }];
      },
      useRef: (initial: unknown) => ({ current: initial }),
      useEffect(create: () => (() => void) | void) { const cleanup = create(); if (cleanup) cleanups.push(cleanup); },
    },
    wouter: { useLocation: () => ["/login", (location: string) => locations.push(location)] },
    "lucide-react": {},
    sonner: { toast: {
      error: (message: string) => toasts.push({ kind: "error", message }),
      success: (message: string) => toasts.push({ kind: "success", message }),
    } },
    "@/lib/api": { ...api, crmFetch(url: string, init: Init = {}) {
      calls.push({ url, init });
      return api.crmFetch(url, init);
    } },
    "@/lib/serverAuth": serverAuth, "@/lib/authSignOut": signOut,
    "@/lib/supabase": supabaseModule,
    "../../../../lib/auth/staff-logins": logins,
    "@/lib/permissions": permissions,
    "@/lib/demoStorage": { WORKSPACE_SELECTOR_KEY: selectorKey },
    "@/pages/JoinWorkspace": { PENDING_INVITE_KEY: inviteKey },
    "../../../../lib/crm/workspace-purpose": purposes,
    "@/lib/workspaceRoutes": routes,
  }, { window, localStorage, sessionStorage }, true).default();
  function start() {
    const promise = Promise.resolve(login.submit()) as Promise<void>;
    submissions.push(promise);
    return promise;
  }
  async function request(index = 0) {
    for (let pass = 0; pass < 8 && requests.length <= index; pass++) await flush();
    assert.ok(requests[index], `Expected isolated HTTP request ${index + 1}`);
    return requests[index];
  }
  function reply(target: HttpRequest, body: unknown, status = 200, raw = false) {
    target.responded = true;
    target.headers.resolve(new Response(raw ? String(body) : JSON.stringify(body), { status }));
  }
  function holdBody(target: HttpRequest) {
    target.responded = true;
    const body = target.body = deferred<string>();
    // Both consumers use the same delayed bytes; no real stream or socket exists.
    const response = { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
      json: async () => { target.bodyReads++; return JSON.parse(await body.promise); },
      text: async () => { target.bodyReads++; return body.promise; },
      clone: () => response,
    } as unknown as Response;
    target.headers.resolve(response);
    return body;
  }
  return {
    start, request, reply, holdBody, emit, calls, requests, tokenCalls, toasts, locations, stateWrites, signOutActors, signOut,
    async finish(running: Promise<void>) {
      let done = false;
      void running.then(() => { done = true; }, () => { done = true; });
      for (let pass = 0; pass < 8 && !done; pass++) {
        await flush();
        for (const pending of requests.filter((entry) => !entry.responded)) {
          assert.equal(pending.url, "/api/crm/join-request", "Only an unexpected baseline join lookup may be drained");
          reply(pending, joins());
        }
      }
      await running;
    },
    actor: () => actor, signInCalls: () => signInCalls, subscriptions: () => callbacks.size,
    unsubscribeCalls: () => unsubscribeCalls,
    refresh() { tokenGeneration++; emit(actorA, "TOKEN_REFRESHED"); },
    holdNextToken() { const hold = deferred<void>(); tokenHolds.push(hold); allTokenHolds.push(hold); return hold; },
    unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); },
    async dispose() {
      this.unmount();
      for (const hold of allTokenHolds) hold.resolve();
      // Release any request created by a failing baseline assertion as well.
      for (let pass = 0; pass < 4; pass++) {
        for (const pending of requests) {
          pending.body?.resolve(JSON.stringify({ success: false }));
          reply(pending, { success: false }, 503);
        }
        await flush();
      }
      await Promise.allSettled(submissions);
    },
  };
}
type Fixture = ReturnType<typeof setup>;
async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Options = {}) {
  const fixture = setup(options);
  try { await run(fixture); } finally { await fixture.dispose(); }
}
function silent(fixture: Fixture) {
  assert.deepEqual(fixture.toasts, [], "Expired work cannot publish any toast");
  assert.deepEqual(fixture.locations, [], "Expired work cannot navigate");
  assert.deepEqual(fixture.signOutActors, [], "Expired work cannot sign out any account");
}
function notUnlinked(fixture: Fixture) {
  assert.equal(fixture.toasts.some(({ message }) => message.includes("Аккаунт не привязан")), false);
  assert.deepEqual(fixture.signOutActors, []);
  assert.deepEqual(fixture.locations, []);
  assert.equal(fixture.toasts.filter(({ kind }) => kind === "error").length, 1);
}
function pinned(fixture: Fixture) {
  for (const call of fixture.calls) {
    assert.equal(call.init.expectedUserId, actorA);
    assert.equal(call.init.cache, "no-store");
    assert.equal(typeof call.init.dispatchGuard, "function");
  }
  for (const request of fixture.requests) {
    assert.match(new Headers(request.init.headers).get("Authorization") ?? "", /^Bearer local-only:login-local-actor-a:/);
    assert.equal(request.init.cache, "no-store");
  }
}

test("Login: invalid credentials retain the existing error without profile lookup or signout", async () => {
  await withFixture(async (f) => {
    await f.start();
    assert.deepEqual(f.toasts, [{ kind: "error", message: "Invalid login credentials" }]);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.signOutActors, []);
    assert.equal(f.subscriptions(), 0);
    assert.equal(f.stateWrites.at(-1), false);
  }, { credentialsError: true });
});

test("Login: valid membership succeeds through the real pinned no-store transport", async () => {
  await withFixture(async (f) => {
    const running = f.start();
    f.reply(await f.request(), linked);
    await f.finish(running);
    assert.deepEqual(f.locations, ["/dashboard"]);
    assert.equal(f.toasts.filter(({ kind }) => kind === "success").length, 1);
    assert.deepEqual(f.signOutActors, []);
    pinned(f);
    assert.equal(f.subscriptions(), 0);
    assert.equal(f.unsubscribeCalls(), 1);
  });
});

test("Login: same-actor token refresh does not invalidate a successful attempt", async () => {
  await withFixture(async (f) => {
    const running = f.start(), request = await f.request();
    f.refresh();
    f.reply(request, linked);
    await f.finish(running);
    assert.deepEqual(f.locations, ["/dashboard"]);
    assert.equal(f.actor(), actorA);
    assert.equal(f.toasts.filter(({ kind }) => kind === "success").length, 1);
    pinned(f);
  });
});

test("Login: duplicate submits share the ref mutex and a completed attempt permits retry", async () => {
  await withFixture(async (f) => {
    const first = f.start(), duplicate = f.start();
    const request = await f.request();
    assert.equal(f.signInCalls(), 1);
    assert.equal(f.requests.length, 1);
    f.reply(request, linked);
    await Promise.all([first, duplicate]);
    const retry = f.start();
    f.reply(await f.request(1), linked);
    await retry;
    assert.equal(f.signInCalls(), 2);
    assert.equal(f.subscriptions(), 0);
  });
});

test("Login: confirmed empty memberships and join requests sign out only the current actor", async () => {
  await withFixture(async (f) => {
    const running = f.start();
    f.reply(await f.request(), empty);
    f.reply(await f.request(1), joins());
    await f.finish(running);
    assert.deepEqual(f.signOutActors, [actorA]);
    assert.equal(f.toasts.filter(({ message }) => message.includes("Аккаунт не привязан")).length, 1);
    assert.deepEqual(f.locations, []);
    pinned(f);
    assert.equal(f.subscriptions(), 0);
  });
});

test("Login: a confirmed empty account with a pending invitation returns to join without logout", async () => {
  await withFixture(async (f) => {
    const running = f.start();
    f.reply(await f.request(), empty);
    await f.finish(running);
    assert.deepEqual(f.locations, ["/join"]);
    assert.deepEqual(f.signOutActors, []);
    assert.equal(f.requests.length, 1);
    assert.equal(f.toasts.filter(({ kind }) => kind === "success").length, 1);
  }, { invite: true });
});

for (const status of ["pending", "rejected"]) {
  test(`Login: confirmed empty with a ${status} join request retains the live account`, async () => {
    await withFixture(async (f) => {
      const running = f.start();
      f.reply(await f.request(), empty);
      f.reply(await f.request(1), joins(status));
      await f.finish(running);
      assert.deepEqual(f.locations, ["/join-request"]);
      assert.deepEqual(f.signOutActors, []);
      assert.equal(f.actor(), actorA);
      assert.deepEqual(f.toasts, []);
      pinned(f);
    });
  });
}

for (const status of [401, 403, 503]) {
  test(`Login: current auth-context HTTP ${status} is not an unlinked account`, async () => {
    await withFixture(async (f) => {
      const running = f.start();
      f.reply(await f.request(), { success: false }, status);
      await f.finish(running);
      notUnlinked(f);
      assert.equal(f.requests.length, 1);
      assert.equal(f.actor(), actorA);
      assert.match(f.toasts[0].message, status === 401 ? /Сессия истекла/ : status === 403 ? /Недостаточно прав/ : /Сервис авторизации/);
    });
  });
}

test("Login: a rejected auth-context read reports failure without signout or an unlinked diagnosis", async () => {
  await withFixture(async (f) => {
    const running = f.start();
    const request = await f.request();
    request.responded = true;
    request.headers.reject(new Error("Local transport unavailable"));
    await f.finish(running);
    notUnlinked(f);
    assert.equal(f.requests.length, 1);
  });
});

test("Login: malformed auth-context JSON is not a verified empty membership array", async () => {
  await withFixture(async (f) => {
    const running = f.start();
    f.reply(await f.request(), "{", 200, true);
    await f.finish(running);
    notUnlinked(f);
    assert.equal(f.requests.length, 1);
  });
});

test("Login: null, failed and malformed successful contracts never enter the unlinked branch", async () => {
  for (const body of [null, { success: false }, { success: "true", data: { memberships: [] } },
    { success: true, data: {} }, { success: true, data: { memberships: {} } },
    { success: true, data: { memberships: [null] } }]) {
    await withFixture(async (f) => {
      const running = f.start();
      f.reply(await f.request(), body);
      await f.finish(running);
      notUnlinked(f);
      assert.equal(f.requests.length, 1);
    });
  }
});

for (const phase of ["headers", "body"] as const) {
  for (const aba of [false, true]) {
    test(`Login: stale auth-context ${phase} after ${aba ? "A-B-A" : "A-B"} cannot publish or log out`, async () => {
      await withFixture(async (f) => {
        const running = f.start(), request = await f.request();
        const body = phase === "body" ? f.holdBody(request) : null;
        if (body) {
          await flush();
          assert.equal(request.bodyReads, 1, "The old response body must already be awaited");
        }
        f.emit(actorB);
        if (aba) f.emit(actorA);
        if (body) body.resolve(JSON.stringify(aba ? linked : empty));
        else f.reply(request, aba ? empty : { success: false }, aba ? 200 : 403);
        await f.finish(running);
        silent(f);
        assert.equal(f.requests.length, 1, "Expired context cannot start a join lookup");
        assert.equal(f.actor(), aba ? actorA : actorB);
        pinned(f);
        assert.equal(f.calls[0].init.dispatchGuard!(), false);
        assert.equal(f.subscriptions(), 0);
      });
    });
  }
}

for (const phase of ["headers", "body"] as const) {
  for (const aba of [false, true]) {
    test(`Login: stale join-request ${phase} after ${aba ? "A-B-A" : "A-B"} cannot sign out or navigate`, async () => {
      await withFixture(async (f) => {
        const running = f.start();
        f.reply(await f.request(), empty);
        const request = await f.request(1);
        const body = phase === "body" ? f.holdBody(request) : null;
        if (body) {
          await flush();
          assert.ok(request.bodyReads > 0, "The old join response body must already be awaited");
        }
        f.emit(actorB);
        if (aba) f.emit(actorA);
        const response = joins((phase === "body") !== aba ? "pending" : undefined);
        if (body) body.resolve(JSON.stringify(response));
        else f.reply(request, response);
        await f.finish(running);
        silent(f);
        assert.equal(f.actor(), aba ? actorA : actorB);
        pinned(f);
        assert.equal(f.calls[1].init.dispatchGuard!(), false);
        assert.equal(f.subscriptions(), 0);
      });
    });
  }
}

test("Login: A-B-A during deferred token lookup fences both dispatch and post-header publication", async () => {
  for (const phase of ["dispatch", "publication"]) {
    await withFixture(async (f) => {
      const token = phase === "dispatch" ? f.holdNextToken() : null;
      const running = f.start();
      let recheck = token;
      if (phase === "publication") {
        const request = await f.request();
        recheck = f.holdNextToken();
        f.reply(request, linked);
      }
      await flush();
      assert.ok(f.tokenCalls.length > 0);
      assert.ok(f.tokenCalls.every((expected) => expected === actorA), "Every token lookup pins the originating actor");
      assert.equal(f.requests.length, phase === "dispatch" ? 0 : 1);
      f.emit(actorB);
      f.emit(actorA);
      recheck!.resolve();
      await f.finish(running);
      silent(f);
      assert.equal(f.requests.length, phase === "dispatch" ? 0 : 1);
      assert.equal(f.subscriptions(), 0);
    });
  }
});

test("Login: unmount while an old body is pending prevents publication and state writes", async () => {
  await withFixture(async (f) => {
    const running = f.start(), request = await f.request(), body = f.holdBody(request);
    await flush();
    assert.equal(request.bodyReads, 1);
    f.unmount();
    const writes = f.stateWrites.length;
    body.resolve(JSON.stringify(linked));
    await f.finish(running);
    silent(f);
    assert.equal(f.stateWrites.length, writes);
    assert.equal(f.subscriptions(), 0);
  });
});

test("Login: a cleared signout marker cannot revive a preceding submit lifetime", async () => {
  await withFixture(async (f) => {
    const running = f.start(), request = await f.request();
    f.signOut.markSignOutPending();
    assert.equal(f.signOut.clearSignOutPending(), true);
    f.reply(request, linked);
    await f.finish(running);
    silent(f);
    assert.equal(f.calls[0].init.dispatchGuard!(), false);
    assert.equal(f.subscriptions(), 0);
  });
});

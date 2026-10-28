import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { eagerControlLazy, controlFixtureType, controlFixtureSuspense, ControlFixtureComponent } from "./control-lazy-test-fixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const apiPath = "artifacts/medina-control/src/lib/api.ts";
const appPath = "artifacts/medina-control/src/App.tsx";
// Set this to a local Git ref to run the same cases against the pre-patch module.
const baseline = process.env.MEDINA_CONTROL_API_TEST_BASELINE;
async function readSource(file: string) {
  return baseline
    ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
    : readFile(path.join(root, file), "utf8");
}
// Evaluate the whole production module, without extracting or rewriting its guards.
const compiled = ts.transpileModule(await readSource(apiPath), {
  fileName: apiPath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const appCode = ts.transpileModule(await readSource(appPath), {
  fileName: appPath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

const actorA = "control-fixture-actor-a";
const actorB = "control-fixture-actor-b";
const origin = "https://control-api.example.test";
const route = "/api/crm/platform-overview?period=7d";
const payload = { success: true, data: { actor: actorA, clinics: 2 } };

type Session = { user: { id: string }; access_token: string };
type SessionResult = { data: { session: Session | null }; error: unknown };
type Access = { actorId: string | null; isCurrent(): boolean };
type Api = {
  API_BASE_URL: string;
  ControlAccessError: new () => Error & { status: number; code: string };
  captureControlAccess(): Access;
  subscribeControlActor(listener: (session: Session | null) => void): () => void;
  controlFetch(path: string, init?: RequestInit, scope?: Access): Promise<Response>;
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Request = { url: string; init: RequestInit; headers: ReturnType<typeof deferred<Response>>; replied: boolean };
type Reader = "json" | "text" | "clone-json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let pass = 0; pass < 24; pass++) await Promise.resolve();
    await setImmediate();
  }
}

function setup(options: { automatic?: boolean; actor?: string | null; configured?: boolean;
  initialLookup?: ReturnType<typeof deferred<SessionResult>>; initialNotification?: boolean } = {}) {
  let actor = options.actor === undefined ? actorA : options.actor;
  let generation = 0;
  let sessionCalls = 0;
  const callbacks = new Set<(event: string, session: Session | null) => void>();
  const lookups: Array<() => SessionResult | Promise<SessionResult>> = [];
  const heldLookups: Array<ReturnType<typeof deferred<SessionResult>>> = [];
  const bodyReleases: Array<() => void> = [];
  const requests: Request[] = [];
  const publications: unknown[] = [];
  const running: Promise<Outcome<unknown>>[] = [];
  const logs: unknown[][] = [];
  if (options.initialLookup) {
    heldLookups.push(options.initialLookup);
    lookups.push(() => options.initialLookup!.promise);
  }

  function session(): Session | null {
    return actor ? { user: { id: actor }, access_token: `fixture-token:${actor}:${generation}` } : null;
  }
  function snapshot(): SessionResult { return { data: { session: session() }, error: null }; }
  function change(next: string | null, event = next ? "SIGNED_IN" : "SIGNED_OUT", silent = false) {
    actor = next;
    generation++;
    if (!silent) for (const callback of [...callbacks]) callback(event, session());
  }
  function reply(request: Request, status = 200, body: unknown = payload) {
    if (request.replied) return;
    request.replied = true;
    request.headers.resolve(new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    }));
  }
  const exports = {} as Api;
  const config = options.configured === false
    ? { ready: false, error: "Fixture configuration is unavailable" }
    : { ready: true, apiOrigin: origin, supabaseUrl: "https://auth.example.test", anonKey: "fixture-public-key" };
  const auth = {
    async getSession() {
      sessionCalls++;
      return lookups.length ? lookups.shift()!() : snapshot();
    },
    onAuthStateChange(callback: (event: string, value: Session | null) => void) {
      callbacks.add(callback);
      // The SDK's initial notification is asynchronous and has no network dependency.
      if (options.initialNotification !== false) {
        queueMicrotask(() => { if (callbacks.has(callback)) callback("INITIAL_SESSION", session()); });
      }
      return { data: { subscription: { unsubscribe() { callbacks.delete(callback); } } } };
    },
  };
  new Script(compiled, { filename: apiPath }).runInNewContext({
    exports, Error, TypeError, DOMException, Headers, Response, Request: globalThis.Request,
    URL, URLSearchParams, AbortController, AbortSignal, ReadableStream, TextEncoder, TextDecoder,
    queueMicrotask,
    console: Object.fromEntries(["log", "warn", "error", "info", "debug"].map((name) => [name,
      (...values: unknown[]) => { logs.push(values); }])),
    require(name: string) {
      assert.equal(name, "./supabase", `Unexpected dependency must not escape the isolated module: ${name}`);
      return { controlConfig: config, supabase: { auth } };
    },
    fetch(url: string | URL, init: RequestInit = {}) {
      const address = String(url);
      assert.equal(new URL(address).origin, origin, "No real HTTP or foreign origin is allowed");
      const request: Request = { url: address, init, headers: deferred<Response>(), replied: false };
      requests.push(request);
      // Deliberately allow late responses even when a signal has been aborted.
      // Actor fences must not rely on cancellation winning a transport race.
      if (options.automatic) reply(request);
      return request.headers.promise;
    },
  }, { timeout: 1_000 });

  function track<T>(promise: Promise<T>): Promise<Outcome<T>> {
    const outcome = promise.then<Outcome<T>, Outcome<T>>(
      (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }),
    );
    running.push(outcome);
    return outcome;
  }
  function start(scope?: Access, init: RequestInit = {}, reader: Reader = "json") {
    return track(exports.controlFetch(route, init, scope).then(async (response) => {
      const value: unknown = reader === "clone-json" ? await response.clone().json()
        : reader === "text" ? await response.text() : await response.json();
      publications.push(value);
      return value;
    }));
  }
  return {
    api: exports, auth, config, requests, publications, logs, change, reply, start, track,
    session, snapshot, sessionCalls: () => sessionCalls,
    refresh() { change(actor, "TOKEN_REFRESHED"); },
    async capture() {
      assert.equal(typeof exports.captureControlAccess, "function", "The actual module must export captureControlAccess");
      const access = exports.captureControlAccess();
      assert.equal("then" in access, false, "Access is a synchronous identity snapshot");
      assert.equal(access.actorId, actorA);
      assert.equal(typeof access.isCurrent, "function");
      assert.equal(access.isCurrent(), true);
      await flush();
      assert.equal(access.isCurrent(), true, "INITIAL_SESSION must not expire a live capture");
      return access;
    },
    holdSession() {
      const hold = deferred<SessionResult>();
      heldLookups.push(hold);
      lookups.push(() => hold.promise);
      return { resolve: (result = snapshot()) => hold.resolve(result) };
    },
    failSession(kind: "throw" | "error", error = new Error("Synthetic SDK session failure")) {
      lookups.push(() => {
        if (kind === "throw") throw error;
        return { data: { session: session() }, error };
      });
    },
    nextSession(result: SessionResult) { lookups.push(() => result); },
    async request(index = 0) {
      await flush();
      assert.ok(requests[index], `Expected isolated HTTP request ${index + 1}`);
      return requests[index];
    },
    holdBody(request: Request, status = 200) {
      assert.equal(request.replied, false);
      request.replied = true;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let released = false;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const resolve = (body: unknown = payload) => {
        if (released) return;
        released = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      };
      bodyReleases.push(resolve);
      request.headers.resolve(new Response(stream, { status, headers: { "content-type": "application/json" } }));
      return { resolve };
    },
    async dispose() {
      for (const hold of heldLookups) hold.resolve(snapshot());
      for (const release of bodyReleases) release();
      for (let cycle = 0; cycle < 4; cycle++) {
        for (const request of requests) reply(request, 503, { success: false });
        await flush();
      }
      await Promise.all(running);
      callbacks.clear();
    },
  };
}

type Fixture = ReturnType<typeof setup>;
async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Parameters<typeof setup>[0] = {}) {
  const fixture = setup(options);
  try { await flush(); await run(fixture); } finally { await fixture.dispose(); }
}

function view() {
  let mounted = true;
  return { scope: { actorId: actorA, isCurrent: () => mounted }, unmount() { mounted = false; } };
}
function rejected(outcome: Outcome<unknown>) {
  assert.equal(outcome.ok, false, "Expired or unavailable access must reject instead of publishing a response");
  if (!outcome.ok) {
    assert.ok(outcome.error, "A rejected request must retain a failure reason");
    assert.notEqual((outcome.error as Error).name, "TypeError", "An incomplete fixture cannot count as an access refusal");
    assert.notEqual((outcome.error as Error).name, "AssertionError");
  }
}
function unpublished(fixture: Fixture) {
  assert.deepEqual(fixture.publications, [], "No stale body may reach its consumer");
}
function pinned(fixture: Fixture, expectedActor = actorA) {
  for (const request of fixture.requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname + url.search, route);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store", "Caller cache preferences cannot weaken authenticated reads");
    assert.ok(new RegExp(`^Bearer fixture-token:${expectedActor}:\\d+$`).test(
      new Headers(request.init.headers).get("Authorization") ?? ""), "Only the originating actor may authorize this request");
    assert.ok(!request.url.includes("fixture-token"), "Credentials must never enter the URL");
    assert.ok(!/[?&](?:access_token|token|authorization)=/i.test(request.url));
  }
  assert.ok(!JSON.stringify(fixture.logs).includes("fixture-token"), "Credentials must not enter logs");
}

test("Control actor: live scoped writes preserve body and headers, replacing caller credentials only in Authorization", async () => {
  await withFixture(async (f) => {
    const current = view();
    const headers = new Headers({ Authorization: "Bearer caller-token", "Content-Type": "application/json", "X-Fixture": "kept" });
    const body = JSON.stringify({ workspaceId: "fixture-workspace" });
    const outcome = await f.start(current.scope, { method: "POST", body, headers, redirect: "follow", cache: "force-cache" });
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.deepEqual(outcome.value, payload);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].init.method, "POST");
    assert.equal(f.requests[0].init.body, body);
    assert.equal(new Headers(f.requests[0].init.headers).get("X-Fixture"), "kept");
    assert.equal(new Headers(f.requests[0].init.headers).get("Content-Type"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer caller-token", "Caller-owned headers are not mutated");
    pinned(f);
  }, { automatic: true });
});

test("Control actor: unready configuration cannot look up a session or dispatch", async () => {
  await withFixture(async (f) => {
    rejected(await f.start(view().scope));
    assert.equal(f.api.API_BASE_URL, "");
    assert.equal(f.sessionCalls(), 0);
    assert.equal(f.requests.length, 0);
  }, { configured: false, automatic: true });
});

test("Control actor: capture survives refresh but expires permanently across A-B-A and sign-out", async () => {
  await withFixture(async (f) => {
    const first = await f.capture();
    f.refresh();
    assert.equal(first.isCurrent(), true, "Token rotation alone is not a new actor lifetime");
    f.change(actorB);
    assert.equal(first.isCurrent(), false);
    f.change(actorA);
    assert.equal(first.isCurrent(), false, "Returning to the same user ID must not resurrect a capture");
    const next = await f.capture();
    f.change(null);
    f.change(actorA);
    assert.equal(next.isCurrent(), false, "Sign-out and sign-in of the same user are a new identity epoch");
    assert.equal((await f.capture()).isCurrent(), true);
  });
});

for (const kind of ["throw", "error"] as const) {
  test(`Control actor: getSession ${kind} fails closed even with caller Authorization and a usable session`, async () => {
    await withFixture(async (f) => {
      f.failSession(kind);
      rejected(await f.start(view().scope, { headers: { Authorization: "Bearer caller-token" } }));
      assert.equal(f.requests.length, 0);
      unpublished(f);
    }, { automatic: true });
  });
}

for (const [label, session] of [
  ["missing session", null],
  ["empty token", { user: { id: actorA }, access_token: "" }],
  ["missing actor", { user: { id: "" }, access_token: "fixture-unbound-token" }],
] as const) {
  test(`Control actor: ${label} cannot fall back to caller credentials`, async () => {
    await withFixture(async (f) => {
      f.nextSession({ data: { session }, error: null });
      rejected(await f.start(view().scope, { headers: { Authorization: "Bearer caller-token" } }));
      assert.equal(f.requests.length, 0);
    }, { automatic: true });
  });
}

test("Control actor: a stale view cannot send with the replacement actor token after session lookup", async () => {
  await withFixture(async (f) => {
    const lookup = f.holdSession();
    const running = f.start(view().scope);
    await flush();
    assert.ok(f.sessionCalls() > 0);
    assert.equal(f.requests.length, 0);
    f.change(actorB);
    lookup.resolve();
    rejected(await running);
    assert.equal(f.requests.length, 0, "An A operation cannot dispatch using B's freshly returned token");
    unpublished(f);
  }, { automatic: true });
});

test("Control actor: A-B-A during deferred lookup cannot dispatch with a new A token", async () => {
  await withFixture(async (f) => {
    const access = await f.capture();
    const lookup = f.holdSession();
    const running = f.start(access);
    await flush();
    f.change(actorB);
    f.change(actorA);
    lookup.resolve();
    rejected(await running);
    assert.equal(access.isCurrent(), false);
    assert.equal(f.requests.length, 0);
    unpublished(f);
    const fresh = await f.capture();
    assert.equal((await f.start(fresh)).ok, true, "A new lifetime must still be usable");
    pinned(f);
  }, { automatic: true });
});

test("Control actor: an unscoped call is also bound before its asynchronous token lookup", async () => {
  await withFixture(async (f) => {
    await f.capture();
    const lookup = f.holdSession();
    const running = f.start();
    await flush();
    f.change(actorB);
    lookup.resolve();
    rejected(await running);
    assert.equal(f.requests.length, 0, "Omitting a view scope cannot opt out of actor binding");
  }, { automatic: true });
});

test("Control actor: a silently replaced SDK actor blocks dispatch without an auth callback", async () => {
  await withFixture(async (f) => {
    const current = view();
    f.change(actorB, "SIGNED_IN", true);
    rejected(await f.start(current.scope));
    assert.equal(f.requests.length, 0);
    unpublished(f);
  }, { automatic: true });
});

for (const [label, next] of [["B", actorB], ["null", null]] as const) {
  test(`Control actor: observing a silent ${label} session permanently invalidates an old A capture`, async () => {
    await withFixture(async (f) => {
      const access = await f.capture();
      f.change(next, next ? "SIGNED_IN" : "SIGNED_OUT", true);
      rejected(await f.start(access));
      assert.equal(f.api.captureControlAccess().actorId, next ?? "");
      const afterInvalidation = f.sessionCalls();
      f.change(actorA, "SIGNED_IN", true);
      rejected(await f.start(access));
      assert.equal(access.isCurrent(), false);
      assert.equal(f.sessionCalls(), afterInvalidation, "An expired A capture cannot perform another SDK lookup");
      assert.equal(f.requests.length, 0, "A silently observed identity change must not revive old work");
      const observed = f.api.captureControlAccess();
      assert.equal(observed.actorId, next ?? "", "A silent SDK return does not update the observed actor by itself");
      rejected(await f.start(observed));
      if (next) {
        assert.equal(f.sessionCalls(), afterInvalidation + 1, "Fresh B work discovers returned A before refusing");
      } else {
        assert.equal(f.sessionCalls(), afterInvalidation, "A signed-out scope cannot start a private SDK lookup");
        assert.equal(f.api.captureControlAccess().isCurrent(), false);
        f.change(actorA, "SIGNED_IN");
      }
      assert.equal(observed.isCurrent(), false);
      assert.equal(access.isCurrent(), false, "SDK rediscovery must never resurrect old A work");
      assert.equal(f.requests.length, 0, "Rediscovering A must reject the B/null-scoped request before HTTP");
      unpublished(f);
      const fresh = await f.capture();
      rejected(await f.start(access));
      assert.equal(f.requests.length, 0);
      assert.equal((await f.start(fresh)).ok, true);
      pinned(f);
    }, { automatic: true });
  });
}

for (const transition of ["A-B", "A-B-A", "sign-out", "silent A-B"] as const) {
  test(`Control actor: delayed headers after ${transition} cannot expose the old Response`, async () => {
    await withFixture(async (f) => {
      const access = await f.capture();
      const running = f.track(f.api.controlFetch(route, {}, access));
      const request = await f.request();
      if (transition === "sign-out") f.change(null);
      else {
        f.change(actorB, "SIGNED_IN", transition === "silent A-B");
        if (transition === "A-B-A") f.change(actorA);
      }
      f.reply(request);
      rejected(await running);
      assert.equal(f.requests.length, 1);
      pinned(f);
    });
  });
}

for (const reader of ["json", "text", "clone-json"] as const) {
  for (const transition of ["A-B", "A-B-A", "silent A-B"] as const) {
    test(`Control actor: pending ${reader} body after ${transition} cannot publish`, async () => {
      await withFixture(async (f) => {
        const access = await f.capture();
        const running = f.start(access, {}, reader);
        const request = await f.request();
        const body = f.holdBody(request);
        await flush();
        unpublished(f);
        f.change(actorB, "SIGNED_IN", transition === "silent A-B");
        if (transition === "A-B-A") f.change(actorA);
        body.resolve();
        rejected(await running);
        unpublished(f);
        assert.equal(f.requests.length, 1);
        pinned(f);
      });
    });
  }
}

for (const phase of ["before lookup", "during lookup", "headers", "body"] as const) {
  test(`Control actor: isCurrent=false ${phase} independently expires an unmounted view`, async () => {
    await withFixture(async (f) => {
      const current = view();
      if (phase === "before lookup") current.unmount();
      const lookup = phase === "during lookup" ? f.holdSession() : null;
      const running = f.start(current.scope);
      if (phase === "headers" || phase === "body") {
        const request = await f.request();
        const body = phase === "body" ? f.holdBody(request) : null;
        if (body) await flush();
        current.unmount();
        if (body) body.resolve();
        else f.reply(request);
      } else {
        await flush();
        current.unmount();
        lookup?.resolve();
      }
      rejected(await running);
      unpublished(f);
      assert.equal(f.requests.length, phase === "headers" || phase === "body" ? 1 : 0);
      pinned(f);
    }, { automatic: phase === "before lookup" || phase === "during lookup" });
  });
}

for (const kind of ["throw", "error"] as const) {
  for (const phase of ["headers", "body"] as const) {
    test(`Control actor: SDK ${kind} while revalidating ${phase} cannot publish previously authorized data`, async () => {
      await withFixture(async (f) => {
        const running = f.start(view().scope);
        const request = await f.request();
        const body = phase === "body" ? f.holdBody(request) : null;
        if (body) await flush();
        f.failSession(kind);
        if (body) body.resolve();
        else f.reply(request);
        rejected(await running);
        unpublished(f);
        pinned(f);
      });
    });
  }
}

for (const kind of ["throw", "error"] as const) {
  test(`Control actor: SDK ${kind} diagnostics stay private at entry, headers and body`, async () => {
    for (const phase of ["entry", "headers", "body"] as const) {
      await withFixture(async (f) => {
        const privateDetail = "fixture-private-sdk-diagnostic";
        const sdkError = new Error(privateDetail);
        if (phase === "entry") f.failSession(kind, sdkError);
        const running = f.start(view().scope);
        if (phase !== "entry") {
          const request = await f.request();
          const body = phase === "body" ? f.holdBody(request) : null;
          if (body) await flush();
          f.failSession(kind, sdkError);
          if (body) body.resolve();
          else f.reply(request);
        }
        const outcome = await running;
        rejected(outcome);
        if (outcome.ok) return;
        assert.equal(typeof f.api.ControlAccessError, "function");
        assert.ok(outcome.error instanceof f.api.ControlAccessError, "SDK failures must become the fixed access error");
        const error = outcome.error;
        assert.ok(error !== sdkError, "The SDK error object must not escape to the consumer");
        assert.equal(error.status, 401);
        assert.equal(error.code, "control_session_changed");
        assert.ok(error.message === new f.api.ControlAccessError().message, "Only the fixed public message may escape");
        const exposed = [String(error), error.stack, String(error.cause), JSON.stringify(error),
          ...f.logs.flat().map(String)].join("\n");
        assert.ok(!exposed.includes(privateDetail), "Private SDK diagnostics must not escape through errors or logs");
        assert.equal(f.requests.length, phase === "entry" ? 0 : 1);
        unpublished(f);
        pinned(f);
      }, { automatic: phase === "entry" });
    }
  });
}

for (const phase of ["lookup", "headers", "body"] as const) {
  test(`Control actor: same-actor token refresh during ${phase} keeps access valid`, async () => {
    await withFixture(async (f) => {
      const current = view();
      const lookup = phase === "lookup" ? f.holdSession() : null;
      const running = f.start(current.scope);
      if (lookup) {
        await flush();
        f.refresh();
        lookup.resolve();
      }
      const request = await f.request();
      const body = phase === "body" ? f.holdBody(request) : null;
      if (body) await flush();
      if (!lookup) f.refresh();
      if (body) body.resolve();
      else f.reply(request);
      const outcome = await running;
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.deepEqual(outcome.value, payload);
      assert.equal(f.publications.length, 1);
      pinned(f);
    });
  });
}

for (const phase of ["before lookup", "during lookup"] as const) {
  test(`Control actor: caller abort ${phase} is not weakened by view scope`, async () => {
    await withFixture(async (f) => {
      const controller = new AbortController();
      const reason = new DOMException("Fixture caller cancellation", "AbortError");
      if (phase === "before lookup") controller.abort(reason);
      const lookup = phase === "during lookup" ? f.holdSession() : null;
      const running = f.start(view().scope, { signal: controller.signal });
      await flush();
      controller.abort(reason);
      lookup?.resolve();
      rejected(await running);
      assert.equal(f.requests.length, 0, "An aborted request must not reach fetch after async auth");
      unpublished(f);
    }, { automatic: true });
  });
}

test("Control actor: caller cancellation still reaches the dispatched transport signal", async () => {
  await withFixture(async (f) => {
    const controller = new AbortController();
    const running = f.start(view().scope, { signal: controller.signal });
    const request = await f.request();
    assert.ok(request.init.signal, "A view scope must not drop the caller's signal");
    assert.equal(request.init.signal.aborted, false);
    const reason = new DOMException("Fixture caller cancellation", "AbortError");
    controller.abort(reason);
    assert.equal(request.init.signal.aborted, true, "A composed signal must retain caller cancellation");
    request.replied = true;
    request.headers.reject(request.init.signal.reason);
    rejected(await running);
    unpublished(f);
    pinned(f);
  });
});

for (const completion of ["session", "error", "throw"] as const) {
  test(`Control actor: late initial getSession ${completion} cannot overwrite a newer auth observation`, async () => {
    const initial = deferred<SessionResult>();
    await withFixture(async (f) => {
      const oldSession = f.snapshot();
      f.change(actorB);
      f.change(actorA);
      const access = await f.capture();
      if (completion === "throw") initial.reject(new Error("Synthetic initial session failure"));
      else initial.resolve(completion === "error"
        ? { data: { session: null }, error: new Error("Synthetic initial session error") }
        : { data: { session: { ...oldSession.data.session!, user: { id: actorB } } }, error: null });
      await flush();
      assert.equal(access.isCurrent(), true, "An out-of-date bootstrap must not change the newer identity epoch");
      assert.equal(f.api.captureControlAccess().actorId, actorA);
      assert.equal((await f.start(access)).ok, true);
      pinned(f);
    }, { initialLookup: initial, automatic: true });
  });
}

test("Control actor: initial getSession initializes access even when no INITIAL_SESSION callback arrives", async () => {
  await withFixture(async (f) => {
    const access = await f.capture();
    assert.equal((await f.start(access)).ok, true);
    pinned(f);
  }, { initialNotification: false, automatic: true });
});

for (const status of [401, 403, 404]) {
  test(`Control actor: current HTTP ${status} exposes status without SDK recheck but its body still fails closed`, async () => {
    await withFixture(async (f) => {
      const access = await f.capture();
      const running = f.track(f.api.controlFetch(route, {}, access));
      const request = await f.request();
      const beforeHeaders = f.sessionCalls();
      f.failSession("error");
      f.reply(request, status, { success: false });
      const outcome = await running;
      assert.equal(outcome.ok, true, "A current refusal's status remains available without another SDK read");
      if (!outcome.ok) return;
      assert.equal(outcome.value.status, status);
      assert.equal(f.sessionCalls(), beforeHeaders);
      rejected(await f.track(outcome.value.json()));
      pinned(f);
    });
  });
}

test("Control actor: caller abort during a pending response body cannot publish even if bytes arrive", async () => {
  await withFixture(async (f) => {
    const access = await f.capture();
    const controller = new AbortController();
    const running = f.start(access, { signal: controller.signal });
    const request = await f.request();
    const body = f.holdBody(request);
    await flush();
    controller.abort(new DOMException("Fixture body cancellation", "AbortError"));
    body.resolve();
    rejected(await running);
    unpublished(f);
    pinned(f);
  });
});

type UiNode = { type: unknown; props: Record<string, any>; key: string | null };
function nodes(value: unknown): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as UiNode;
  return [node, ...nodes(node.props.children)];
}

function appFixture(fixture: Fixture) {
  const slots: unknown[] = [];
  const effects: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  let cursor = 0;
  const screens = Object.fromEntries(["Login", "Overview", "ClinicCard", "Onboarding", "Operators", "Contributors", "PartnerCompanies"]
    .map((name) => [name, () => null]));
  const exports = {} as { default(): UiNode };
  function jsx(type: unknown, props: UiNode["props"], key?: string | number): UiNode {
    return { type: controlFixtureType(type), props, key: key === undefined ? null : String(key) };
  }
  new Script(appCode, { filename: appPath }).runInNewContext({
    exports,
    require(name: string) {
      if (name === "react") return {
        lazy: eagerControlLazy, Suspense: controlFixtureSuspense, Component: ControlFixtureComponent,
        useState(initial: unknown) {
          const index = cursor++;
          if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
          return [slots[index], (next: unknown) => {
            slots[index] = typeof next === "function" ? next(slots[index]) : next;
          }];
        },
        useRef(initial: unknown) {
          const index = cursor++;
          if (!(index in slots)) slots[index] = { current: initial };
          return slots[index];
        },
        useEffect(effect: () => void | (() => void)) {
          const index = cursor++;
          if (!(index in slots)) { slots[index] = true; effects.push(effect); }
        },
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "./lib/supabase") return { controlConfig: fixture.config, supabase: { auth: fixture.auth } };
      if (name === "./lib/api") return fixture.api;
      if (name.startsWith("./screens/")) {
        const screen = name.slice("./screens/".length);
        assert.ok(Object.hasOwn(screens, screen), "Only known screen boundaries may be mocked");
        return { [screen]: screens[screen] };
      }
      assert.fail(`Unexpected App dependency: ${name}`);
    },
  }, { timeout: 1_000 });
  function render() { cursor = 0; return exports.default(); }
  return {
    screens, render,
    async mount() {
      render();
      for (const effect of effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      await flush();
      return render();
    },
    select(screen: "Overview" | "Operators" | "Onboarding" | "ClinicCard") {
      let tree = render();
      const buttons = nodes(tree).filter((node) => node.type === "button");
      if (screen === "Operators") buttons[2].props.onClick();
      else if (screen === "Onboarding") buttons[1].props.onClick();
      else {
        buttons[0].props.onClick();
        tree = render();
        if (screen === "ClinicCard") {
          const overview = nodes(tree).find((node) => node.type === screens.Overview);
          assert.ok(overview);
          overview.props.onOpenClinic("fixture-workspace");
        }
      }
      tree = render();
      assert.ok(nodes(tree).some((node) => node.type === screens[screen]), `The actual App selected ${screen}`);
      return tree;
    },
    unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}

function mainKey(tree: UiNode) {
  const main = nodes(tree).find((node) => node.type === "main");
  assert.ok(main, "The authenticated App must contain its real main subtree");
  return main.key;
}

for (const screen of ["Overview", "ClinicCard", "Onboarding", "Operators"] as const) {
  test(`Control App: ${screen} keeps its key on refresh and remounts after batched A-B-A and A-signout-A`, async () => {
    await withFixture(async (f) => {
      const app = appFixture(f);
      try {
        await app.mount();
        const initial = app.select(screen);
        const initialKey = mainKey(initial);
        f.refresh();
        const refreshed = app.render();
        assert.equal(mainKey(refreshed), initialKey, "Token refresh must preserve the live screen lifetime");
        assert.ok(nodes(refreshed).some((node) => node.type === app.screens[screen]));
        // There is deliberately no render between these auth events, as with React batching.
        f.change(actorB);
        f.change(actorA);
        const returned = app.render();
        assert.notEqual(mainKey(returned), initialKey, "A-B-A needs an identity epoch, not a user-ID-only key");
        assert.ok(nodes(returned).some((node) => node.type === app.screens.Overview), "Identity changes reset navigation");
        const nextKey = mainKey(app.select(screen));
        f.change(null);
        f.change(actorA);
        const signedBackIn = app.render();
        assert.notEqual(mainKey(signedBackIn), nextKey, "Same-user sign-in must not restore an old main subtree");
        assert.ok(nodes(signedBackIn).some((node) => node.type === app.screens.Overview));
      } finally { app.unmount(); }
    });
  });
}

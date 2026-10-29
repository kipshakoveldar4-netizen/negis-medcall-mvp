import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { setImmediate as immediate } from "node:timers/promises";
import test, { after, type TestContext } from "node:test";
import { createAuthSessionAuthority } from "../../artifacts/negis/src/lib/authSessionAuthority";

const frontendRequire = createRequire(new URL("../../artifacts/negis/package.json", import.meta.url));
const sdk = frontendRequire("@supabase/supabase-js");
// Follow the factory's frontend SDK types, never the separately pinned root SDK.
type LockFunc = Parameters<typeof createAuthSessionAuthority>[0]["lock"];
type Authority = ReturnType<typeof createAuthSessionAuthority> & { dispose?: () => void | Promise<void> };
type Auth = Parameters<Authority["observe"]>[0] & { dispose(): Promise<void> };
type Scope = Parameters<Authority["signInWithPassword"]>[1] & { signal: AbortSignal };
type ScopeProof = Pick<Scope, "expected" | "expectedUserId">;
type Method = "signin" | "signup";
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// All keys, passwords, JWT signing material and URLs below are synthetic fixtures.
const url = "https://auth-mutation-entry.invalid";
const key = "synthetic-public-key-not-valid-for-any-service";
const expiresAt = 4_102_444_800;
const actorA = "00000000-0000-4000-8000-000000000a01";
const actorB = "00000000-0000-4000-8000-000000000b02";
const nativeResources = () => process.getActiveResourcesInfo()
  .filter((type) => type === "Timeout" || /messageport/i.test(type)).sort();
const originalResources = nativeResources();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, boundary: string, timeout = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out at ${boundary}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate: () => boolean, boundary: string) {
  let stopped = false;
  try {
    await bounded((async () => {
      while (!stopped && !predicate()) await immediate();
    })(), boundary);
  } finally {
    stopped = true;
  }
}

function scope(proof: ScopeProof = {}) {
  let current = true;
  const controller = new AbortController();
  const value: Scope = { ...proof, isCurrent: () => current, signal: controller.signal };
  return {
    value,
    dispose() { current = false; },
    abort() { controller.abort(); },
  };
}

function user(actor: string) {
  return {
    id: actor, aud: "authenticated", role: "authenticated",
    email: `${actor}@example.test`, app_metadata: {}, user_metadata: {},
    identities: [], created_at: "2024-01-01T00:00:00.000Z",
  };
}

function session(actor: string, attempt: string) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: actor, aud: "authenticated", role: "authenticated", iss: `${url}/auth/v1`,
    iat: 1_704_067_200, exp: expiresAt, session_id: attempt,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", "local-test-only-not-a-service-secret").update(input).digest("base64url");
  return {
    access_token: `${input}.${signature}`, refresh_token: `synthetic-refresh-${attempt}`,
    token_type: "bearer", expires_in: 3_600, expires_at: expiresAt, user: user(actor),
  };
}

function credentials(actor: string, attempt: string) {
  return { email: user(actor).email, password: `synthetic-password-${attempt}` };
}

function sharedLock() {
  const tails = new Map<string, Promise<void>>();
  const active = new Set<string>();
  const calls: { name: string; timeout: number }[] = [];
  let fail: ((name: string) => boolean) | undefined;
  const lock: LockFunc = async <R,>(name: string, timeout: number, run: () => Promise<R>): Promise<R> => {
    calls.push({ name, timeout });
    const previous = tails.get(name);
    if (timeout === 0 && previous) throw Object.assign(new Error("Synthetic lock busy"), { isAcquireTimeout: true });
    const done = deferred<void>();
    tails.set(name, done.promise);
    try {
      if (previous) {
        if (timeout > 0) await bounded(previous, `shared SDK lock ${name}`, timeout);
        else await previous;
      }
      if (fail?.(name)) throw new Error("Synthetic lock refused");
      assert.equal(active.has(name), false, `shared lock must serialize ${name}`);
      active.add(name);
      try { return await run(); }
      finally { active.delete(name); }
    } finally {
      // A timed-out waiter must not release the next waiter ahead of its predecessor.
      const release = () => {
        done.resolve();
        if (tails.get(name) === done.promise) tails.delete(name);
      };
      if (previous) void previous.then(release);
      else release();
    }
  };
  return {
    lock, calls, active, tails,
    failWhen(predicate?: (name: string) => boolean) { fail = predicate; },
    async hold(name: string) {
      const entered = deferred<void>();
      const release = deferred<void>();
      const finished = lock(name, -1, async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      return { release: () => release.resolve(), finished };
    },
  };
}

type StorageAction = { kind: "get" | "set" | "remove"; key: string; value?: string };
function sharedStorage() {
  const values = new Map<string, string>();
  const actions: StorageAction[] = [];
  let fail: ((action: StorageAction) => boolean) | undefined;
  function visit(action: StorageAction) {
    actions.push(action);
    if (fail?.(action)) throw new Error(`Synthetic storage ${action.kind} refused`);
  }
  return {
    values, actions,
    getItem(key: string) { visit({ kind: "get", key }); return values.get(key) ?? null; },
    setItem(key: string, value: string) { visit({ kind: "set", key, value }); values.set(key, value); },
    removeItem(key: string) { visit({ kind: "remove", key }); values.delete(key); },
    failWhen(predicate?: (action: StorageAction) => boolean) { fail = predicate; },
  };
}

function closedFetch() {
  const requests: { url: URL; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const unexpected: string[] = [];
  const routes = new Map<string, ReturnType<typeof reply>>();
  function reply(body: unknown, options: { holdDispatch?: boolean; holdBody?: boolean; afterBody?: () => void } = {}) {
    const headers = deferred<void>();
    const bodyGate = deferred<void>();
    const bodyStarted = deferred<void>();
    if (!options.holdDispatch) headers.resolve();
    if (!options.holdBody) bodyGate.resolve();
    let dispatched = false;
    let reads = 0;
    return {
      get dispatched() { return dispatched; },
      get reads() { return reads; },
      bodyStarted: bodyStarted.promise,
      releaseHeaders: () => headers.resolve(),
      releaseBody: () => bodyGate.resolve(),
      async respond(): Promise<Response> {
        assert.equal(dispatched, false, "a synthetic route may only dispatch once");
        dispatched = true;
        // Ignore cancellation intentionally: late native responses must still be fenced.
        await headers.promise;
        const response = new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        response.json = async () => {
          reads++;
          bodyStarted.resolve();
          await bodyGate.promise;
          options.afterBody?.();
          return structuredClone(body);
        };
        return response;
      },
    };
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const method = target.pathname === "/auth/v1/signup" ? "signup"
      : target.pathname === "/auth/v1/token" && target.searchParams.get("grant_type") === "password" ? "signin" : null;
    const route = method && routes.get(`${method}:${String(body.password)}`);
    if (target.origin !== url || init?.method !== "POST" || !route) {
      unexpected.push(`${init?.method} ${target.href}`);
      throw new Error("Closed synthetic fetch refused an unexpected request");
    }
    requests.push({ url: target, body, signal: init.signal });
    return route.respond();
  };
  return {
    fetch, requests, unexpected,
    expect(method: Method, attempt: string, body: unknown, options?: Parameters<typeof reply>[1]) {
      const route = reply(body, options);
      const id = `${method}:synthetic-password-${attempt}`;
      assert.equal(routes.has(id), false);
      routes.set(id, route);
      return route;
    },
    releaseAll() { for (const route of routes.values()) { route.releaseHeaders(); route.releaseBody(); } },
  };
}

async function harness(t: TestContext, options: { timeoutMs?: number } = {}) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Global HTTP is forbidden in synthetic auth tests"); });
  const storage = sharedStorage();
  const mutex = sharedLock();
  const network = closedFetch();
  const authorities: Authority[] = [];
  const pending: Promise<unknown>[] = [];
  const holds: Awaited<ReturnType<typeof mutex.hold>>[] = [];
  const receivers: Auth[] = [];
  const subscriptions: { unsubscribe(): void }[] = [];
  const scopes: ReturnType<typeof scope>[] = [];
  let nonce = 0;
  function authority() {
    const value: Authority = createAuthSessionAuthority({
      url, key, storage, lock: mutex.lock, fetch: network.fetch,
      nonce: () => `non-secret-test-revision-${++nonce}`, timeoutMs: options.timeoutMs ?? 1_000,
    });
    authorities.push(value);
    return value;
  }
  const current = authority();
  const events: { event: string; token: string | null; actor: string | null }[] = [];
  async function observe(value = current) {
    const client = sdk.createClient(url, key, {
      global: { fetch: network.fetch },
      auth: {
        storage: value.storage, storageKey: value.storageKey, lock: mutex.lock,
        persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
      },
    });
    receivers.push(client.auth);
    await bounded(client.auth.getSession(), "native main receiver initialization");
    const { data: { subscription } } = value.observe(client.auth, (event, session) => {
      events.push({ event, token: session?.access_token ?? null, actor: session?.user.id ?? null });
    });
    subscriptions.push(subscription);
    await immediate();
    return client.auth;
  }
  function start<T>(operation: Promise<T>): Promise<Outcome<T>> {
    const outcome = operation.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
    pending.push(outcome);
    return outcome;
  }
  let cleaned = false;
  async function close() {
    if (cleaned) return;
    cleaned = true;
    storage.failWhen();
    mutex.failWhen();
    for (const lifetime of scopes) { lifetime.dispose(); lifetime.abort(); }
    for (const held of holds) held.release();
    network.releaseAll();
    try {
      await bounded(Promise.allSettled(pending), "all held native operations settle during cleanup", 4_000);
    } finally {
      for (const subscription of subscriptions) subscription.unsubscribe();
      for (const value of authorities) await value.dispose?.();
      for (const receiver of receivers) await receiver.dispose();
    }
    await immediate();
    assert.deepEqual(network.unexpected, [], "no unplanned endpoint or real network fallback");
    assert.equal(mutex.active.size, 0, "no held shared SDK locks after cleanup");
    assert.equal(mutex.tails.size, 0, "no queued shared SDK locks after cleanup");
    for (const lifetime of scopes) {
      assert.equal(getEventListeners(lifetime.value.signal, "abort").length, 0, "factory removes caller abort listeners");
    }
  }
  t.after(close);
  return {
    current, storage, mutex, network, events, authority, observe, start, close,
    unobserve() { for (const subscription of subscriptions.splice(0)) subscription.unsubscribe(); },
    scope(proof?: ScopeProof) { const lifetime = scope(proof); scopes.push(lifetime); return lifetime; },
    async holdMain() {
      const held = await mutex.hold(`lock:${current.storageKey}`);
      holds.push(held);
      return held;
    },
    async writeMain(value: string | null, owner = current) {
      await mutex.lock(`lock:${owner.storageKey}`, -1, async () => {
        if (value === null) owner.storage.removeItem(owner.storageKey);
        else owner.storage.setItem(owner.storageKey, value);
      });
    },
    persisted() { const raw = storage.values.get(current.storageKey); return raw ? JSON.parse(raw) : null; },
  };
}

function assertDenied(result: Outcome<unknown>, boundary: string) {
  if (!result.ok) { assert.ok(result.error, boundary); return; }
  assert.ok(result.value && typeof result.value === "object" && "error" in result.value
    && result.value.error, `${boundary}: must report denial, not successful stale auth`);
  if ("data" in result.value) {
    const data = result.value.data as { session?: unknown; user?: unknown } | null;
    assert.equal(data?.session ?? null, null, `${boundary}: no stale session returned`);
    assert.equal(data?.user ?? null, null, `${boundary}: no stale user returned`);
  }
}

function authResult(result: Outcome<unknown>) {
  if (!result.ok) throw result.error;
  assert.ok(result.value && typeof result.value === "object" && "error" in result.value && "data" in result.value,
    "native SDK result retains its public data/error shape");
  return result.value as { error: unknown; data: { session: ReturnType<typeof session> | null; user: { id: string } | null } };
}

function assertSucceeded(result: Outcome<unknown>, expected: ReturnType<typeof session>) {
  const value = authResult(result);
  assert.equal(value.error, null);
  assert.ok(value.data.session);
  assert.ok(value.data.user);
  assert.equal(value.data.session.access_token, expected.access_token);
  assert.equal(value.data.user.id, expected.user.id);
}

test("mutation entry uses the actual frontend SDK pinned to 2.118.0", () => {
  assert.equal(frontendRequire("@supabase/supabase-js/package.json").version, "2.118.0");
  assert.equal(typeof sdk.AuthClient.prototype.dispose, "function", "public native disposal must be available");
});

type Harness = Awaited<ReturnType<typeof harness>>;
function invoke(h: Harness, method: Method, actor: string, attempt: string, lifetime: ReturnType<typeof scope>, owner = h.current) {
  const input = credentials(actor, attempt);
  return h.start(method === "signin"
    ? owner.signInWithPassword(input, lifetime.value)
    : owner.signUp(input, lifetime.value));
}

function assertNotPublished(h: Harness, forbidden: ReturnType<typeof session>) {
  assert.notEqual(h.persisted()?.access_token, forbidden.access_token, "retired session must not reach main SDK storage");
  assert.equal(h.events.some((event) => event.token === forbidden.access_token), false,
    "retired session must not reach authority/native observers");
  assert.equal(h.storage.actions.some((action) => action.kind === "set" && action.key === h.current.storageKey
    && action.value?.includes(forbidden.access_token)), false, "not even a transient stale main-session write is allowed");
}

function seedCompanionKeys(h: Harness) {
  const companions = new Map([
    [`${h.current.storageKey}-code-verifier`, JSON.stringify("synthetic-existing-pkce/marker")],
    [`${h.current.storageKey}-user`, JSON.stringify({ user: user(actorB) })],
    ["unrelated-synthetic-storage", "must-stay-byte-identical"],
  ]);
  for (const [name, value] of companions) h.storage.values.set(name, value);
  const actionStart = h.storage.actions.length;
  return () => {
    for (const [name, value] of companions) {
      assert.equal(h.storage.values.get(name), value, `shared companion ${name} must retain its exact bytes`);
      assert.equal(h.storage.actions.slice(actionStart).some((action) => action.kind !== "get" && action.key === name),
        false, `native partial writes/removals must stay private: ${name}`);
    }
    assert.equal([...h.storage.values.keys()].some((name) => name.startsWith("medina-auth-operation-")), false,
      "per-operation SDK keys must never escape to shared storage");
  };
}

for (const method of ["signin", "signup"] as const) {
  test(`${method}: a held old A response cannot replace B or emit A across authority instances`, async (t) => {
    const h = await harness(t);
    const other = h.authority();
    await h.observe();
    await h.observe(other);
    const oldSession = session(actorA, `old-${method}`);
    const newSession = session(actorB, `new-${method}`);
    const oldReply = h.network.expect(method, `old-${method}`, oldSession, { holdDispatch: true });
    h.network.expect("signin", `new-${method}`, newSession);
    const old = invoke(h, method, actorA, `old-${method}`, h.scope());
    await until(() => oldReply.dispatched, "A native request is held before B starts");
    const current = invoke(h, "signin", actorB, `new-${method}`, h.scope(), other);
    assertSucceeded(await bounded(current, "B succeeds while A is held"), newSession);
    const committedBytes = h.storage.values.get(h.current.storageKey);
    await until(() => h.events.some((event) => event.token === newSession.access_token), "B native observer publication");
    oldReply.releaseHeaders();
    assertDenied(await bounded(old, "late A reply"), "old A after B success");
    await immediate();
    assert.equal(h.storage.values.get(h.current.storageKey), committedBytes, "persisted B must remain byte-identical");
    assertNotPublished(h, oldSession);
    assert.ok(h.mutex.calls.some((call) => call.name === `lock:${h.current.storageKey}`), "the standard main SDK lock is used");
  });

  test(`${method}: same-turn duplicate from the same scope is latest-intent-wins`, async (t) => {
    const h = await harness(t);
    await h.observe();
    const lifetime = h.scope();
    const firstSession = session(actorA, `same-actor-old-${method}`);
    const lastSession = session(actorA, `same-actor-new-${method}`);
    const firstReply = h.network.expect(method, `duplicate-old-${method}`, firstSession, { holdDispatch: true });
    h.network.expect(method, `duplicate-new-${method}`, lastSession);
    // Deliberately no await between calls and deliberately the identical scope object.
    const first = invoke(h, method, actorA, `duplicate-old-${method}`, lifetime);
    const last = invoke(h, method, actorA, `duplicate-new-${method}`, lifetime);
    assertSucceeded(await bounded(last, "same-turn latest intent"), lastSession);
    firstReply.releaseHeaders();
    assertDenied(await bounded(first, "same-turn retired first intent"), "same scope, same actor, older invocation");
    await immediate();
    assert.equal(h.persisted().access_token, lastSession.access_token);
    assertNotPublished(h, firstSession);
  });

  test(`${method}: a newer same-turn claim in another authority is not invalidated by the older claim`, async (t) => {
    const h = await harness(t);
    const other = h.authority();
    await h.observe();
    const firstSession = session(actorA, `cross-authority-old-${method}`);
    const lastSession = session(actorB, `cross-authority-new-${method}`);
    const reply = h.network.expect(method, `cross-authority-old-${method}`, firstSession, { holdDispatch: true });
    h.network.expect(method, `cross-authority-new-${method}`, lastSession);
    const first = invoke(h, method, actorA, `cross-authority-old-${method}`, h.scope());
    const last = invoke(h, method, actorB, `cross-authority-new-${method}`, h.scope(), other);
    assertSucceeded(await bounded(last, "newer independent authority claim"), lastSession);
    reply.releaseHeaders();
    assertDenied(await bounded(first, "older independent authority claim"), "older claim cannot revoke the later intent");
    assert.equal(h.persisted().access_token, lastSession.access_token);
    assertNotPublished(h, firstSession);
  });

  test(`${method}: original session snapshot is captured before waiting for the claim lock`, async (t) => {
    const h = await harness(t);
    await h.writeMain(JSON.stringify(session(actorA, `before-claim-wait-${method}`)));
    await h.observe();
    const held = await h.holdMain();
    const rejectedSession = session(actorA, `stale-snapshot-${method}`);
    h.network.expect(method, `stale-snapshot-${method}`, rejectedSession);
    const operation = invoke(h, method, actorA, `stale-snapshot-${method}`, h.scope());
    const newerBytes = JSON.stringify(session(actorB, `claim-holder-writes-${method}`));
    // This synthetic lock owner completes its main SDK storage write before granting the queued claim.
    assert.equal(h.mutex.active.has(`lock:${h.current.storageKey}`), true);
    h.current.storage.setItem(h.current.storageKey, newerBytes);
    held.release();
    assertDenied(await bounded(operation, "original snapshot replaced while claim queued"), "invocation predates main SDK storage change");
    assert.equal(h.network.requests.length, 0, "stale original snapshot is rejected before dispatch");
    assert.equal(h.storage.values.get(h.current.storageKey), newerBytes);
    assertNotPublished(h, rejectedSession);
  });

  for (const expectedUserId of [null, actorA]) {
    test(`${method}: expected UI subject ${expectedUserId === null ? "null" : "A"} refuses persisted B before dispatch`, async (t) => {
      const h = await harness(t);
      const original = JSON.stringify(session(actorB, `subject-current-${method}-${expectedUserId}`));
      await h.writeMain(original);
      await h.observe();
      const rejectedSession = session(actorA, `subject-rejected-${method}-${expectedUserId}`);
      h.network.expect(method, `subject-rejected-${method}-${expectedUserId}`, rejectedSession);
      const before = h.current.capture();
      const operation = invoke(h, method, actorA, `subject-rejected-${method}-${expectedUserId}`, h.scope({ expectedUserId }));
      assertDenied(await bounded(operation, "stale UI subject at mutation entry"), "expectedUserId mismatches persisted user");
      assert.equal(h.network.requests.length, 0);
      assert.deepEqual(h.current.capture(), before, "rejected UI subject must not claim a new intent");
      assert.equal(h.storage.values.get(h.current.storageKey), original);
      assertNotPublished(h, rejectedSession);
    });
  }

  test(`${method}: stale pre-auth proof cannot revoke a newer pending intent without a session write`, async (t) => {
    const h = await harness(t);
    await h.observe();
    const proof = h.current.capture();
    const newerSession = session(actorB, `proof-newer-${method}`);
    const rejectedSession = session(actorA, `proof-stale-${method}`);
    const reply = h.network.expect("signin", `proof-newer-${method}`, newerSession, { holdBody: true });
    const rejectedReply = h.network.expect(method, `proof-stale-${method}`, rejectedSession);
    const newer = invoke(h, "signin", actorB, `proof-newer-${method}`, h.scope());
    await bounded(reply.bodyStarted, "newer intent has claimed but not written a session");
    const claimed = h.current.capture();
    assert.equal(claimed.revision, proof.revision, "claim alone cannot change session revision");
    assert.notEqual(claimed.intent, proof.intent, "claim must change intent metadata");
    assert.equal(h.current.isCurrent(proof), false);
    assert.equal(h.current.isCurrent(claimed), true);
    const stale = invoke(h, method, actorA, `proof-stale-${method}`, h.scope({ expected: proof, expectedUserId: null }));
    assertDenied(await bounded(stale, "stale long-lived pre-auth proof"), "proof predates the newer pending intent");
    assert.equal(rejectedReply.dispatched, false);
    assert.deepEqual(h.current.capture(), claimed, "refused proof must not displace the valid pending intent");
    reply.releaseBody();
    assertSucceeded(await bounded(newer, "newer pending intent survives stale proof"), newerSession);
    assert.equal(h.persisted().access_token, newerSession.access_token);
    assertNotPublished(h, rejectedSession);
  });

  test(`${method}: latest same-actor intent revokes an already dispatched attempt from the same live scope`, async (t) => {
    const h = await harness(t);
    await h.observe();
    const lifetime = h.scope();
    const firstSession = session(actorA, `inflight-same-actor-old-${method}`);
    const lastSession = session(actorA, `inflight-same-actor-new-${method}`);
    const reply = h.network.expect(method, `inflight-old-${method}`, firstSession, { holdBody: true });
    h.network.expect(method, `inflight-new-${method}`, lastSession);
    const first = invoke(h, method, actorA, `inflight-old-${method}`, lifetime);
    await bounded(reply.bodyStarted, "earlier same-actor request body is held");
    assertSucceeded(await bounded(invoke(h, method, actorA, `inflight-new-${method}`, lifetime), "newer same-actor request"), lastSession);
    assert.equal(lifetime.value.isCurrent(), true, "scope identity and actor remain current, only the intent changed");
    reply.releaseBody();
    assertDenied(await bounded(first, "older same-actor request"), "new intent must revoke old native SDK write");
    assert.equal(h.persisted().access_token, lastSession.access_token);
    assertNotPublished(h, firstSession);
  });

  for (const retirement of ["dispose", "abort"] as const) {
    test(`${method}: scope ${retirement} before entry refuses dispatch`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const lifetime = h.scope();
      lifetime[retirement]();
      const rejectedSession = session(actorA, `never-dispatched-${method}-${retirement}`);
      h.network.expect(method, `never-${method}-${retirement}`, rejectedSession);
      const result = invoke(h, method, actorA, `never-${method}-${retirement}`, lifetime);
      assertDenied(await bounded(result, "already retired scope"), `scope ${retirement} before entry`);
      assert.equal(h.network.requests.length, 0);
      assertNotPublished(h, rejectedSession);
    });

    test(`${method}: scope ${retirement} while claim lock is queued refuses dispatch`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const held = await h.holdMain();
      const lifetime = h.scope();
      const rejectedSession = session(actorA, `queued-${method}-${retirement}`);
      h.network.expect(method, `queued-${method}-${retirement}`, rejectedSession);
      const before = h.mutex.calls.length;
      const operation = invoke(h, method, actorA, `queued-${method}-${retirement}`, lifetime);
      await until(() => h.mutex.calls.length > before, "queued revision claim");
      lifetime[retirement]();
      held.release();
      assertDenied(await bounded(operation, "retired claim wait"), `scope ${retirement} before lock acquisition`);
      assert.equal(h.network.requests.length, 0);
      assertNotPublished(h, rejectedSession);
    });

    test(`${method}: scope ${retirement} before native response body cannot publish`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const lifetime = h.scope();
      const rejectedSession = session(actorA, `pre-body-${method}-${retirement}`);
      const reply = h.network.expect(method, `pre-body-${method}-${retirement}`, rejectedSession, { holdDispatch: true });
      const operation = invoke(h, method, actorA, `pre-body-${method}-${retirement}`, lifetime);
      await until(() => reply.dispatched, "native request dispatched before retirement");
      assert.equal(reply.reads, 0, "body has not been consumed before retirement");
      lifetime[retirement]();
      reply.releaseHeaders();
      assertDenied(await bounded(operation, "response received after retirement"), `scope ${retirement} before body`);
      assertNotPublished(h, rejectedSession);
    });

    test(`${method}: scope ${retirement} during native body read cannot publish`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const lifetime = h.scope();
      const rejectedSession = session(actorA, `body-${method}-${retirement}`);
      const reply = h.network.expect(method, `body-${method}-${retirement}`, rejectedSession, { holdBody: true });
      const operation = invoke(h, method, actorA, `body-${method}-${retirement}`, lifetime);
      await bounded(reply.bodyStarted, "native SDK is reading the held body");
      lifetime[retirement]();
      reply.releaseBody();
      assertDenied(await bounded(operation, "body finished after retirement"), `scope ${retirement} during body`);
      assertNotPublished(h, rejectedSession);
    });

    test(`${method}: scope ${retirement} after parsing but before SDK storage cannot publish`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const lifetime = h.scope();
      const rejectedSession = session(actorA, `parsed-${method}-${retirement}`);
      h.network.expect(method, `parsed-${method}-${retirement}`, rejectedSession, {
        afterBody: () => lifetime[retirement](),
      });
      const operation = invoke(h, method, actorA, `parsed-${method}-${retirement}`, lifetime);
      assertDenied(await bounded(operation, "parsed result cannot cross storage guard"), `scope ${retirement} after parsing`);
      assertNotPublished(h, rejectedSession);
    });

    test(`${method}: scope ${retirement} while main-session write lock is queued cannot publish`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const lifetime = h.scope();
      const rejectedSession = session(actorA, `write-${method}-${retirement}`);
      const reply = h.network.expect(method, `write-${method}-${retirement}`, rejectedSession, { holdBody: true });
      const operation = invoke(h, method, actorA, `write-${method}-${retirement}`, lifetime);
      await bounded(reply.bodyStarted, "body reached before holding commit lock");
      const held = await h.holdMain();
      const before = h.mutex.calls.filter((call) => call.name === `lock:${h.current.storageKey}`).length;
      reply.releaseBody();
      await until(() => h.mutex.calls.filter((call) => call.name === `lock:${h.current.storageKey}`).length > before,
        "native SDK storage commit is queued under the shared lock");
      lifetime[retirement]();
      held.release();
      assertDenied(await bounded(operation, "retired storage commit"), `scope ${retirement} before main write`);
      assertNotPublished(h, rejectedSession);
    });
  }

  test(`${method}: exact session-byte ABA restoration still invalidates the held attempt`, async (t) => {
    const h = await harness(t);
    const original = JSON.stringify(session(actorB, `aba-original-${method}`));
    await h.writeMain(original);
    await h.observe();
    const rejectedSession = session(actorA, `aba-old-${method}`);
    const reply = h.network.expect(method, `aba-${method}`, rejectedSession, { holdBody: true });
    const operation = invoke(h, method, actorA, `aba-${method}`, h.scope());
    await bounded(reply.bodyStarted, "ABA attempt body held");
    const metadataBefore = [...h.storage.values].filter(([name]) => name !== h.current.storageKey);
    await h.writeMain(JSON.stringify(session(actorB, `aba-intermediate-${method}`)));
    await h.writeMain(original);
    assert.equal(h.storage.values.get(h.current.storageKey), original, "ABA restores the exact original bytes");
    assert.notDeepEqual([...h.storage.values].filter(([name]) => name !== h.current.storageKey), metadataBefore,
      "main SDK storage writes must change the non-secret revision even when session bytes return to A");
    reply.releaseBody();
    assertDenied(await bounded(operation, "ABA-revoked attempt"), "session bytes match but revision changed");
    assert.equal(h.storage.values.get(h.current.storageKey), original);
    assertNotPublished(h, rejectedSession);
  });

  test(`${method}: deadline aborts injected native transport and denies a late body`, async (t) => {
    const h = await harness(t, { timeoutMs: 30 });
    await h.observe();
    const rejectedSession = session(actorA, `timeout-${method}`);
    const reply = h.network.expect(method, `timeout-${method}`, rejectedSession, { holdBody: true });
    const operation = invoke(h, method, actorA, `timeout-${method}`, h.scope());
    await bounded(reply.bodyStarted, "native body held for deadline");
    await until(() => h.network.requests[0].signal?.aborted === true, "factory deadline aborts native transport");
    reply.releaseBody();
    assertDenied(await bounded(operation, "native late body after deadline"), "attempt expired before native write");
    assertNotPublished(h, rejectedSession);
  });

  for (const failure of ["storage-read", "intent-write", "claim-lock"] as const) {
    test(`${method}: ${failure} error fails closed before HTTP dispatch`, async (t) => {
      const h = await harness(t);
      await h.observe();
      const rejectedSession = session(actorA, `${failure}-${method}`);
      h.network.expect(method, `${failure}-${method}`, rejectedSession);
      if (failure === "claim-lock") h.mutex.failWhen((name) => name === `lock:${h.current.storageKey}`);
      else h.storage.failWhen((action) => failure === "storage-read"
        ? action.kind === "get" && action.key === h.current.storageKey
        : action.kind === "set" && action.key === h.current.intentKey);
      const operation = invoke(h, method, actorA, `${failure}-${method}`, h.scope());
      assertDenied(await bounded(operation, `${failure} refusal`), failure);
      assert.equal(h.network.requests.length, 0, "authority failure must not reach even fake HTTP");
      assertNotPublished(h, rejectedSession);
    });
  }

  for (const failure of ["session-write", "revision-write", "commit-lock"] as const) {
    test(`${method}: ${failure} after native partial key operations preserves B and shared PKCE/user bytes`, async (t) => {
      const h = await harness(t);
      const original = JSON.stringify(session(actorB, `failure-existing-${method}-${failure}`));
      await h.writeMain(original);
      await h.observe();
      const assertCompanions = seedCompanionKeys(h);
      const rejectedSession = session(actorA, `partial-${method}-${failure}`);
      const reply = h.network.expect(method, `partial-${method}-${failure}`, rejectedSession, { holdBody: true });
      const operation = invoke(h, method, actorA, `partial-${method}-${failure}`, h.scope());
      await bounded(reply.bodyStarted, "native response before partial save failure");
      if (failure === "commit-lock") h.mutex.failWhen((name) => name === `lock:${h.current.storageKey}`);
      else h.storage.failWhen((action) => action.kind === "set" && action.key === (failure === "revision-write"
        ? h.current.revisionKey : h.current.storageKey));
      reply.releaseBody();
      assertDenied(await bounded(operation, "partial native save fails closed"), failure);
      assert.equal(h.storage.values.get(h.current.storageKey), original, "failed native save cannot replace B");
      assertCompanions();
      // Failed setter calls are logged before throwing; only actual persisted bytes and publications count here.
      assert.equal(h.events.some((event) => event.token === rejectedSession.access_token), false);
    });
  }
}

for (const withSession of [true, false]) {
  test(`signup: ${withSession ? "session" : "confirmation-only user"} preserves literal caller redirect and shared companion keys`, async (t) => {
    const h = await harness(t);
    const original = JSON.stringify(session(actorB, `signup-existing-${withSession}`));
    await h.writeMain(original);
    await h.observe();
    const assertCompanions = seedCompanionKeys(h);
    const created = session(actorA, `signup-created-${withSession}`);
    const attempt = `literal-redirect-${withSession}`;
    const redirect = "https://Caller.Example.test:443/a/../Complete?next=%2fKeep%2F&x=1+2#Literal%2f";
    h.network.expect("signup", attempt, withSession ? created : user(actorA));
    const operation = h.start(h.current.signUp({
      ...credentials(actorA, attempt),
      options: { emailRedirectTo: redirect, data: { synthetic_marker: "literal-data" }, captchaToken: "synthetic-captcha" },
    }, h.scope({ expectedUserId: actorB, expected: h.current.capture() }).value));
    const result = await bounded(operation, "native signup response");
    assert.equal(h.network.requests.length, 1);
    assert.equal(h.network.requests[0].url.searchParams.get("redirect_to"), redirect, "caller redirect must not be normalized or rewritten");
    assert.deepEqual(h.network.requests[0].body.data, { synthetic_marker: "literal-data" });
    assert.deepEqual(h.network.requests[0].body.gotrue_meta_security, { captcha_token: "synthetic-captcha" });
    if (withSession) {
      assertSucceeded(result, created);
      assert.equal(h.persisted().access_token, created.access_token);
      await until(() => h.events.some((event) => event.token === created.access_token), "signup session observer publication");
    } else {
      const value = authResult(result);
      assert.equal(value.error, null);
      assert.equal(value.data.session, null, "native confirmation-only signup must not invent a session");
      assert.equal(value.data.user?.id, actorA);
      assert.equal(h.storage.values.get(h.current.storageKey), original, "confirmation-only signup must preserve B exactly");
      assert.equal(h.events.some((event) => event.actor === actorA), false);
    }
    assertCompanions();
  });
}

test("confirmation-only signup still supersedes an older held native sign-in intent", async (t) => {
  const h = await harness(t);
  await h.observe();
  const rejectedSession = session(actorA, "superseded-by-confirmation");
  const reply = h.network.expect("signin", "before-confirmation", rejectedSession, { holdBody: true });
  h.network.expect("signup", "confirmation-new-intent", user(actorB));
  const old = invoke(h, "signin", actorA, "before-confirmation", h.scope());
  await bounded(reply.bodyStarted, "native sign-in held before confirmation-only signup");
  const result = authResult(await bounded(invoke(h, "signup", actorB, "confirmation-new-intent", h.scope()), "confirmation-only newer intent"));
  assert.equal(result.error, null);
  assert.equal(result.data.session, null);
  assert.equal(result.data.user?.id, actorB);
  reply.releaseBody();
  assertDenied(await bounded(old, "sign-in superseded without a replacement session"), "confirmation-only signup claims latest intent");
  assert.equal(h.persisted(), null, "neither the confirmation user nor the retired sign-in may create a session");
  assert.equal(h.events.some((event) => event.actor === actorB), false);
  assertNotPublished(h, rejectedSession);
});

test("signin: current native SDK success publishes only the committed session and unsubscribes cleanly", async (t) => {
  const h = await harness(t);
  await h.observe();
  const assertCompanions = seedCompanionKeys(h);
  const expected = session(actorA, "current-signin");
  h.network.expect("signin", "current-signin", expected);
  const result = await bounded(invoke(h, "signin", actorA, "current-signin", h.scope({
    expectedUserId: null, expected: h.current.capture(),
  })), "current sign-in");
  assertSucceeded(result, expected);
  assert.equal(h.persisted().access_token, expected.access_token);
  await until(() => h.events.some((event) => event.event === "SIGNED_IN" && event.token === expected.access_token),
    "current native sign-in observer publication");
  assertCompanions();
  h.unobserve();
  const eventCount = h.events.length;
  await h.writeMain(JSON.stringify(session(actorB, "after-unsubscribe")));
  await immediate();
  await immediate();
  assert.equal(h.events.length, eventCount, "unsubscribed observers must not receive later own-writer updates");
});

test("a committed native sign-in receipt survives its own observer unmounting the originating UI", async (t) => {
  const h = await harness(t);
  const receiver = await h.observe();
  const lifetime = h.scope();
  const expected = session(actorA, "own-commit-unmount");
  const subscription = h.current.observe(receiver, (_event, published) => {
    if (published?.access_token === expected.access_token) { lifetime.dispose(); lifetime.abort(); }
  }).data.subscription;
  t.after(() => subscription.unsubscribe());
  h.network.expect("signin", "own-commit-unmount", expected);
  assertSucceeded(await bounded(invoke(h, "signin", actorA, "own-commit-unmount", lifetime), "own UI unmount after commit"), expected);
  await until(() => !lifetime.value.isCurrent(), "committed session really unmounted its originating scope");
  assert.equal(h.persisted().access_token, expected.access_token);
});

test("logout cannot dispatch a new global remote side effect after its intermediate refresh retires the caller", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Global HTTP is forbidden"); });
  const lifetime = scope();
  const memory = sharedStorage();
  const mutex = sharedLock();
  const original = { ...session(actorA, "logout-expired-original"), expires_at: 1 };
  const refreshed = session(actorA, "logout-intermediate-refresh");
  const refreshCommitted = deferred<void>();
  const releaseCommit = deferred<void>();
  let commitHeld = false;
  const requests: { path: string; remoteScope: string | null; callerCurrent: boolean; aborted: boolean }[] = [];
  let nonce = 0;
  const owner = createAuthSessionAuthority({
    url, key, nonce: () => `non-secret-logout-review-${++nonce}`, timeoutMs: 1_000,
    storage: memory,
    async lock(name, timeout, callback) {
      const result = await mutex.lock(name, timeout, callback);
      const saved = memory.values.get(owner.storageKey);
      if (!commitHeld && saved && JSON.parse(saved).refresh_token === refreshed.refresh_token) {
        // Pause the public lock's completion after the intermediate refresh commit.
        commitHeld = true; refreshCommitted.resolve(); await releaseCommit.promise;
      }
      return result;
    },
    fetch: async (input, init) => {
      const target = new URL(String(input));
      assert.equal(target.origin, url);
      assert.equal(init?.method, "POST");
      requests.push({ path: target.pathname, remoteScope: target.searchParams.get("scope"),
        callerCurrent: lifetime.value.isCurrent(), aborted: init.signal!.aborted });
      if (target.pathname === "/auth/v1/token" && target.searchParams.get("grant_type") === "refresh_token") {
        assert.equal(JSON.parse(String(init.body)).refresh_token, original.refresh_token);
        return Response.json(refreshed);
      }
      assert.equal(target.pathname, "/auth/v1/logout", "closed synthetic transport");
      return new Response(null, { status: 204 });
    },
  });
  owner.storage.setItem(owner.storageKey, JSON.stringify(original));
  const operation = owner.signOut(lifetime.value).then((value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }));
  t.after(async () => { releaseCommit.resolve(); await bounded(operation, "held sign-out cleanup"); });
  await bounded(refreshCommitted.promise, "native sign-out has committed its intermediate refresh");
  assert.equal(requests.filter((request) => request.path === "/auth/v1/logout").length, 0);
  // Dispose without abort: an already-aborted real fetch would never dispatch.
  lifetime.dispose(); releaseCommit.resolve();
  const result = await bounded(operation, "expired native sign-out settles and disposes");
  assert.equal(lifetime.value.isCurrent(), false, "intermediate refresh really retired the originating caller");
  assert.equal(requests.filter((request) => request.path === "/auth/v1/logout").length, 0,
    `no new global logout may dispatch after caller retirement: ${JSON.stringify(requests)}`);
  assertDenied(result, "scope disposed before the global logout was dispatched");
  assert.equal(JSON.parse(memory.values.get(owner.storageKey)!).access_token, refreshed.access_token,
    "retired sign-out cannot clear the intermediate committed refresh");
});

test("native SDK operation channels and timers close after settling while the main receiver stays alive", async (t) => {
  const descriptors = new Map(["window", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const resourcesBefore = nativeResources();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const browser = Object.assign(new EventTarget(), {
    location: new URL("https://synthetic-application.invalid/login"),
    addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      if (callback) {
        const registered = listeners.get(type) ?? new Set();
        registered.add(callback);
        listeners.set(type, registered);
      }
      EventTarget.prototype.addEventListener.call(this, type, callback, options);
    },
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
      if (callback) listeners.get(type)?.delete(callback);
      EventTarget.prototype.removeEventListener.call(this, type, callback, options);
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible" } });
  let h: Harness | undefined;
  try {
    assert.equal(typeof globalThis.BroadcastChannel, "function", "exercise native channels, not a fake channel implementation");
    h = await harness(t);
    await h.observe();
    const mainResources = nativeResources();
    assert.ok(mainResources.filter((name) => /messageport/i.test(name)).length
      > resourcesBefore.filter((name) => /messageport/i.test(name)).length, "main native SDK receiver must open a real channel");
    for (const method of ["signin", "signup"] as const) {
      const attempt = `native-resources-${method}`;
      const expected = session(actorA, attempt);
      const reply = h.network.expect(method, attempt, expected, { holdBody: true });
      const operation = invoke(h, method, actorA, attempt, h.scope());
      await bounded(reply.bodyStarted, "native operation is alive with its own channel");
      assert.ok(nativeResources().filter((name) => /messageport/i.test(name)).length
        > mainResources.filter((name) => /messageport/i.test(name)).length, "per-operation SDK really opens a separate native channel");
      reply.releaseBody();
      assertSucceeded(await bounded(operation, "native operation settles and disposes"), expected);
      await immediate();
      assert.deepEqual(nativeResources(), mainResources, "operation channel and deadline timer close before its promise settles");
    }
    await h.close();
    await immediate();
    assert.deepEqual(nativeResources(), resourcesBefore, "main and per-operation native channels all close");
    assert.equal([...listeners.values()].reduce((count, registered) => count + registered.size, 0), 0,
      "native visibility listeners and authority storage listeners are removed");
  } finally {
    try { await h?.close(); }
    finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});

after(async () => {
  await immediate();
  assert.deepEqual(nativeResources(), originalResources, "native timers and channels must not survive the suite");
});

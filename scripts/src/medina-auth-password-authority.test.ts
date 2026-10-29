import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import test, { after, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { createAuthSessionAuthority } from "../../artifacts/negis/src/lib/authSessionAuthority";

// Actual frontend SDK and factory; no application startup or environment files.
// A healthy native updateUser reads storage and PUTs /user; an expired session
// POSTs /token first. No invented GET /user or reauthentication/mail endpoint.
// Late-response fencing is NOT cancellation of an accepted remote password change.
// Password checks cover public results, shared persistence and observer payloads,
// not JS heap zeroization, server policy, cross-tab timing or WebLock timeouts.
const frontendRequire = createRequire(new URL("../../artifacts/negis/package.json", import.meta.url));
type Authority = ReturnType<typeof createAuthSessionAuthority>;
type Options = Parameters<typeof createAuthSessionAuthority>[0];
type Scope = Parameters<Authority["updateUserPassword"]>[1];
type Callback = Parameters<Authority["observe"]>[1];
type Session = NonNullable<Parameters<Callback>[1]>;
type User = Session["user"];
type LockFunc = Options["lock"];
type UserResult = Awaited<ReturnType<Authority["updateUserPassword"]>>;
type AuthError = NonNullable<UserResult["error"]>;
type PasswordApi = Pick<Authority, "updateUserPassword">;
type Receiver = Parameters<Authority["observe"]>[0] & {
  dispose(): Promise<void>;
  refreshSession(): ReturnType<Authority["setSession"]>;
};
const sdk = frontendRequire("@supabase/supabase-js") as {
  AuthClient: { new (options: {
    url: string; storageKey: string; storage: Options["storage"]; lock: LockFunc; fetch: typeof fetch;
    persistSession: true; autoRefreshToken: false; detectSessionInUrl: false; skipAutoInitialize: true;
  }): Receiver; prototype: { dispose(): Promise<void> } };
  AuthApiError: new (...args: never[]) => AuthError;
  AuthWeakPasswordError: new (...args: never[]) => AuthError & { reasons: string[] };
};
const origin = "https://auth-password.synthetic.invalid";
const publicKey = "synthetic-public-key-not-valid-for-a-service";
const password = "SYNTHETIC-PASSWORD-MARKER-NOT-A-REAL-CREDENTIAL";
const actorA = "00000000-0000-4000-8000-000000000a01";
const actorB = "00000000-0000-4000-8000-000000000b02";
const activeResources = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout" || /messageport/i.test(name)).sort();
const initialResources = activeResources();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: PromiseLike<T>, boundary: string, ms = 2_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out: ${boundary}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean, boundary: string) {
  const deadline = Date.now() + 2_500;
  while (!check()) { assert.ok(Date.now() < deadline, `Timed out: ${boundary}`); await immediate(); }
}

function syntheticSession(actor: string, tag: string, expired = false): Session {
  const now = Math.floor(Date.now() / 1_000);
  const user: User = { id: actor, aud: "authenticated", role: "authenticated", email: `${actor}@example.test`,
    app_metadata: {}, user_metadata: { synthetic_profile: tag }, created_at: "2026-01-01T00:00:00Z" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = expired ? now - 600 : now + 86_400;
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: actor, aud: "authenticated", role: "authenticated",
    iss: `${origin}/auth/v1`, session_id: tag, iat: now - 1_000, exp })}`;
  const signature = createHmac("sha256", "synthetic-local-signature-not-a-service-secret").update(unsigned).digest("base64url");
  return { access_token: `${unsigned}.${signature}`, refresh_token: `synthetic-refresh-${tag}`,
    token_type: "bearer", expires_at: exp, expires_in: exp - now, user };
}

function subject(authorization: string | null) {
  assert.ok(authorization, "native request must carry an authorization header");
  assert.ok(authorization.startsWith("Bearer "), "native request must carry a bearer token");
  return (JSON.parse(Buffer.from(authorization.slice(7).split(".")[1], "base64url").toString("utf8")) as { sub: string }).sub;
}

function memoryStorage() {
  const values = new Map<string, string>();
  const writes: { key: string; value: string | null }[] = [];
  return {
    values, writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); },
    removeItem(key: string) { values.delete(key); writes.push({ key, value: null }); },
  };
}

function sharedLock() {
  const tails = new Map<string, Promise<void>>();
  const calls: string[] = [];
  const gates: ReturnType<typeof deferred<void>>[] = [];
  let fail = false;
  let afterCommit: { key: string; match(value: string): boolean; entered: ReturnType<typeof deferred<void>>; gate: ReturnType<typeof deferred<void>> } | undefined;
  let read: ((key: string) => string | null) | undefined;
  const lock: LockFunc = async <R,>(name: string, _timeout: number, run: () => Promise<R>) => {
    calls.push(name);
    const previous = tails.get(name) ?? Promise.resolve();
    const done = deferred<void>();
    tails.set(name, done.promise);
    await previous;
    let result: R;
    try { if (fail) throw Error("Synthetic lock refused"); result = await run(); }
    finally { done.resolve(); if (tails.get(name) === done.promise) tails.delete(name); }
    const hook = afterCommit;
    const raw = hook && read?.(hook.key);
    if (hook && raw && hook.match(raw)) {
      afterCommit = undefined; hook.entered.resolve(); await hook.gate.promise;
    }
    return result;
  };
  return {
    lock, calls, tails,
    setFailure(value: boolean) { fail = value; },
    async hold(name: string) {
      const entered = deferred<void>();
      const gate = deferred<void>(); gates.push(gate);
      const done = lock(name, -1, async () => { entered.resolve(); await gate.promise; });
      await bounded(entered.promise, "shared lock holder");
      return { release: () => gate.resolve(), done };
    },
    gateAfterCommit(key: string, getter: (key: string) => string | null, match: (value: string) => boolean) {
      assert.equal(afterCommit, undefined);
      const entered = deferred<void>();
      const gate = deferred<void>(); gates.push(gate);
      read = getter; afterCommit = { key, match, entered, gate };
      return { entered: entered.promise, release: () => gate.resolve() };
    },
    releaseAll() { for (const gate of gates) gate.resolve(); },
  };
}

type Kind = "password" | "refresh";
type Call = { kind: Kind; url: URL; headers: Headers; body: Record<string, unknown>; signal?: AbortSignal | null };
function closedHttp() {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const plans: ReturnType<typeof plan>[] = [];
  function plan(kind: Kind, body: unknown, options: { status?: number; hold?: "transport" | "body"; afterBody?: () => void } = {}) {
    const transport = deferred<void>();
    const bodyGate = deferred<void>();
    const arrived = deferred<Call>();
    const reading = deferred<void>();
    if (options.hold !== "transport") transport.resolve();
    if (options.hold !== "body") bodyGate.resolve();
    let used = false;
    return {
      kind, get used() { return used; }, arrived: arrived.promise, reading: reading.promise,
      releaseTransport: () => transport.resolve(), releaseBody: () => bodyGate.resolve(),
      async respond(call: Call) {
        assert.equal(used, false); used = true; arrived.resolve(call);
        // Ignore cancellation on purpose so every late completion must still be fenced.
        await transport.promise;
        const response = Response.json(body, { status: options.status ?? 200,
          headers: { "X-Supabase-Api-Version": "2024-01-01" } });
        const json = response.json.bind(response);
        Object.defineProperty(response, "json", { value: async () => {
          reading.resolve(); await bodyGate.promise;
          const parsed: unknown = await json(); options.afterBody?.(); return parsed;
        } });
        return response;
      },
    };
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const kind = url.pathname === "/auth/v1/user" && method === "PUT" ? "password"
      : url.pathname === "/auth/v1/token" && method === "POST" && url.searchParams.get("grant_type") === "refresh_token" ? "refresh" : null;
    const pending = plans.find((candidate) => !candidate.used && candidate.kind === kind);
    if (url.origin !== origin || !kind || !pending) {
      unexpected.push(`${method} ${url.href}`); throw Error("Closed password HTTP refused an unplanned route");
    }
    const call: Call = { kind, url, headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, signal: init?.signal };
    calls.push(call);
    return pending.respond(call);
  };
  return {
    calls, unexpected, fetch,
    expect(kind: Kind, body: unknown, options?: Parameters<typeof plan>[2]) {
      const value = plan(kind, body, options); plans.push(value); return value;
    },
    releaseAll() { for (const item of plans) { item.releaseTransport(); item.releaseBody(); } },
    clearPasswordBodies() { for (const call of calls) delete call.body.password; },
  };
}

type Outcome = { ok: true; value: UserResult } | { ok: false; error: unknown };
function passwordApi(owner: Authority): PasswordApi {
  assert.equal(typeof owner.updateUserPassword, "function", "Main must expose updateUserPassword(password, scope)");
  return owner;
}

async function fixture(t: TestContext, options: { expired?: boolean; empty?: boolean; timeoutMs?: number } = {}) {
  t.mock.method(globalThis, "fetch", async () => { throw Error("Global HTTP is forbidden in password tests"); });
  const storage = memoryStorage();
  const mutex = sharedLock();
  const http = closedHttp();
  let nonce = 0;
  const owner = createAuthSessionAuthority({ url: origin, key: publicKey, storage, lock: mutex.lock, fetch: http.fetch,
    nonce: () => `non-secret-password-revision-${++nonce}`, timeoutMs: options.timeoutMs ?? 1_000 });
  const original = syntheticSession(actorA, "original-A", options.expired);
  const key = owner.storageKey;
  const lockName = `lock:${key}`;
  const pending: Promise<Outcome>[] = [];
  const lifetimes: { scope: Scope; dispose(): void; abort(): void }[] = [];
  const subscriptions: { unsubscribe(): void }[] = [];
  const receivers: Receiver[] = [];
  const cleanupReleases: (() => void)[] = [];
  const events: { event: string; actor: string | null; token: string | null; profile: unknown; saved: string | null }[] = [];
  async function write(value: Session | string | null, writer = owner) {
    await mutex.lock(lockName, -1, async () => {
      if (value === null) writer.storage.removeItem(key);
      else writer.storage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    });
  }
  if (!options.empty) await write(original);
  function lifetime(proof: Partial<Pick<Scope, "expected" | "expectedUserId">> = { expectedUserId: actorA, expected: owner.capture() }) {
    let current = true;
    const controller = new AbortController();
    const scope: Scope = { ...proof, signal: controller.signal, isCurrent: () => current };
    const result = { scope, dispose: () => { current = false; }, abort: () => controller.abort() };
    lifetimes.push(result); return result;
  }
  function start(scope = lifetime().scope, value = password): Promise<Outcome> {
    const operation = passwordApi(owner).updateUserPassword(value, scope)
      .then((result) => ({ ok: true as const, value: result }), (error) => ({ ok: false as const, error }));
    pending.push(operation); return operation;
  }
  async function observe() {
    const receiver = new sdk.AuthClient({ url: `${origin}/auth/v1`, storageKey: key, storage: owner.storage, lock: mutex.lock,
      fetch: http.fetch, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true });
    receivers.push(receiver);
    await bounded(receiver.getSession(), "native main receiver session lookup");
    type Lookup = Awaited<ReturnType<Receiver["getSession"]>>;
    let nextLookup: { entered: ReturnType<typeof deferred<Lookup>>; release: ReturnType<typeof deferred<void>> } | undefined;
    let lookupCalls = 0;
    const reader: Parameters<Authority["observe"]>[0] = {
      async getSession() {
        const held = nextLookup; nextLookup = undefined; lookupCalls++;
        const result = await receiver.getSession();
        if (held) { held.entered.resolve(result); await held.release.promise; }
        return result;
      },
      onAuthStateChange: receiver.onAuthStateChange.bind(receiver),
    };
    const subscription = owner.observe(reader, (event, session) => {
      events.push({ event, actor: session?.user.id ?? null, token: session?.access_token ?? null,
        profile: structuredClone(session?.user.user_metadata ?? null), saved: storage.getItem(key) });
    }).data.subscription;
    subscriptions.push(subscription); await immediate();
    return {
      receiver,
      get lookupCalls() { return lookupCalls; },
      holdNextLookup() {
        assert.equal(nextLookup, undefined);
        const entered = deferred<Lookup>();
        const release = deferred<void>();
        cleanupReleases.push(() => release.resolve());
        nextLookup = { entered, release };
        return { entered: entered.promise, release: () => release.resolve() };
      },
    };
  }
  t.after(async () => {
    mutex.setFailure(false);
    for (const item of lifetimes) { item.dispose(); item.abort(); }
    for (const release of cleanupReleases) release();
    mutex.releaseAll(); http.releaseAll();
    try { await bounded(Promise.allSettled(pending), "all password operations settle during cleanup", 4_000); }
    finally {
      for (const subscription of subscriptions) subscription.unsubscribe();
      for (const receiver of receivers) await receiver.dispose();
      http.clearPasswordBodies();
    }
    await immediate();
    assert.equal(mutex.tails.size, 0, "no held native/main locks");
    assert.deepEqual(http.unexpected, [], "no real HTTP, mail or invented SDK lookup route");
    for (const item of lifetimes) assert.equal(getEventListeners(item.scope.signal!, "abort").length, 0);
  });
  return { owner, key, lockName, original, storage, mutex, http, events, lifetime, start, write, observe,
    peer() {
      return createAuthSessionAuthority({ url: origin, key: publicKey, storage, lock: mutex.lock, fetch: http.fetch,
        nonce: () => `non-secret-password-peer-${++nonce}` });
    },
    releaseDuringCleanup(callback: () => void) { cleanupReleases.push(callback); },
    saved: () => storage.getItem(key),
    session: () => JSON.parse(storage.getItem(key)!) as Session,
    noPasswordRetained(result?: Outcome) {
      const persisted = JSON.stringify([...storage.values]) + JSON.stringify(storage.writes) + JSON.stringify(events)
        + (result ? JSON.stringify(result) : "");
      assert.equal(persisted.includes(password), false, "password marker stays out of persistence, receipts and observer data");
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function success(result: Outcome, actor = actorA) {
  if (!result.ok) throw result.error;
  assert.equal(result.value.error, null);
  assert.equal(result.value.data.user?.id, actor);
  return result.value.data.user!;
}
function denied(result: Outcome, boundary: string) {
  if (!result.ok) { assert.ok(result.error, boundary); return; }
  assert.ok(result.value.error, `${boundary}: stale operation cannot return success`);
  assert.equal(result.value.data.user, null, `${boundary}: stale user data cannot escape`);
}
function updatedUser(tag = "password-updated"): User {
  return { ...syntheticSession(actorA, tag).user, user_metadata: { synthetic_profile: tag } };
}
function assertPasswordPut(call: Call, token: string) {
  assert.equal(call.kind, "password");
  assert.equal(call.headers.get("authorization"), `Bearer ${token}`, "PUT uses the exact original/rotated A token, never ambient B");
  assert.equal(subject(call.headers.get("authorization")), actorA);
  assert.deepEqual(call.body, { password, code_challenge: null, code_challenge_method: null }, "native updateUser({ password }) wire body");
}
function noNewPasswordPut(f: Fixture) { assert.equal(f.http.calls.filter((call) => call.kind === "password").length, 0); }

test("password authority uses actual frontend SDK 2.118.0 and its public native update API", () => {
  assert.equal(frontendRequire("@supabase/supabase-js/package.json").version, "2.118.0");
  const owner = createAuthSessionAuthority({ url: origin, key: publicKey, storage: memoryStorage(), lock: sharedLock().lock,
    fetch: async () => { throw Error("No HTTP is permitted in the API contract check"); }, nonce: () => "non-secret-api-check" });
  passwordApi(owner);
  assert.equal(typeof sdk.AuthClient.prototype.dispose, "function");
});

test("current password PUT stays on A, saves coherent profile data and never persists the password", async (t) => {
  const f = await fixture(t);
  f.http.expect("password", { user: updatedUser() });
  const result = await bounded(f.start(), "native password success");
  const user = success(result);
  assertPasswordPut(f.http.calls[0], f.original.access_token);
  assert.equal(f.http.calls.length, 1, "healthy native updateUser has no network user lookup");
  assert.equal(f.session().access_token, f.original.access_token);
  assert.equal(f.session().refresh_token, f.original.refresh_token);
  assert.deepEqual(f.session().user, user);
  f.noPasswordRetained(result);
});

test("password profile publication preserves USER_UPDATED semantics and the exact committed session", async (t) => {
  const f = await fixture(t);
  await f.observe();
  f.events.length = 0;
  f.http.expect("password", { user: updatedUser() });
  success(await bounded(f.start(), "native password update observed"));
  await until(() => f.events.some((event) => JSON.stringify(event.profile) === JSON.stringify(updatedUser().user_metadata)),
    "current changed profile publication");
  assert.ok(f.events.some((event) => event.event === "USER_UPDATED"),
    `password profile must publish USER_UPDATED, observed: ${f.events.map((event) => event.event).join(",")}`);
  const event = f.events.find((item) => item.event === "USER_UPDATED")!;
  assert.equal(event.actor, actorA);
  assert.equal(event.token, f.original.access_token);
  assert.deepEqual(event.profile, updatedUser().user_metadata);
  assert.deepEqual(JSON.parse(event.saved!), f.session());
  assert.equal(f.events.some((item) => item.event === "SIGNED_IN"), false, "password/profile update is not a fresh sign-in intent");
  f.noPasswordRetained();
});

test("delayed password USER_UPDATED hint is dropped when the actual native lookup retries after peer B commits", async (t) => {
  const f = await fixture(t);
  const observed = await f.observe();
  f.events.length = 0;
  const held = observed.holdNextLookup();
  const lookupsBefore = observed.lookupCalls;
  f.http.expect("password", { user: updatedUser("delayed-hint-A") });
  const operation = f.start();
  const lookup = await bounded(held.entered, "actual main SDK returned updated A but its delivery is held");
  assert.equal(lookup.data.session?.user.id, actorA);
  assert.deepEqual(lookup.data.session?.user.user_metadata, updatedUser("delayed-hint-A").user_metadata);
  success(await bounded(operation, "password result settles independently of observer lookup delivery"));
  const b = syntheticSession(actorB, "peer-B-overtakes-hint");
  // A peer uses the same storage and lock, but has no local writer listeners here.
  await f.write(b, f.peer());
  assert.equal(f.events.length, 0, "peer commit does not fabricate a local event");
  held.release();
  await until(() => f.events.some((event) => event.actor === actorB), "stale hinted lookup retries against actual saved B");
  assert.ok(observed.lookupCalls >= lookupsBefore + 2, "a fresh actual SDK lookup is required after the stale snapshot");
  assert.ok(f.events.some((event) => event.actor === actorB && event.event === "SIGNED_IN"));
  assert.equal(f.events.some((event) => event.event === "USER_UPDATED"), false, "A password hint must not be transferred to B");
  assert.equal(f.events.some((event) => event.actor === actorA), false, "held A data cannot be published after B");
  assert.equal(f.saved(), JSON.stringify(b)); f.noPasswordRetained();
});

test("a current native TOKEN_REFRESHED for B retains its semantics over a delayed password USER_UPDATED hint for A", async (t) => {
  const f = await fixture(t);
  const observed = await f.observe();
  f.events.length = 0;
  const held = observed.holdNextLookup();
  f.http.expect("password", { user: updatedUser("hint-before-native-B") });
  const operation = f.start();
  const oldLookup = await bounded(held.entered, "actual A password observer result held");
  assert.equal(oldLookup.data.session?.user.id, actorA);
  success(await bounded(operation, "password result before B native event"));
  const b = syntheticSession(actorB, "native-B-before-refresh");
  const rotatedB = syntheticSession(actorB, "native-B-refreshed");
  await f.write(b, f.peer());
  f.http.expect("refresh", rotatedB);
  const refreshed = await bounded(observed.receiver.refreshSession(), "actual native B refresh and TOKEN_REFRESHED");
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.data.session?.access_token, rotatedB.access_token);
  assert.equal(f.http.calls.at(-1)?.body.refresh_token, b.refresh_token, "native receiver refreshes B, not the stale A lookup");
  await until(() => f.events.some((event) => event.actor === actorB && event.event === "TOKEN_REFRESHED"), "current native B event retains its type");
  const eventsBeforeRelease = f.events.length;
  held.release();
  await immediate(); await immediate();
  assert.equal(f.events.length, eventsBeforeRelease, "obsolete A lookup cannot add a delayed event after current B delivery");
  assert.equal(f.events.some((event) => event.event === "USER_UPDATED"), false, "old password hint cannot retag another native event");
  assert.equal(f.events.some((event) => event.actor === actorA), false);
  assert.equal(f.session().user.id, actorB);
  assert.equal(f.session().access_token, rotatedB.access_token); f.noPasswordRetained();
});

test("entry snapshots A before the shared session-lookup lock and cannot adopt B at grant", async (t) => {
  const f = await fixture(t);
  const held = await f.mutex.hold(f.lockName);
  const operation = f.start();
  const b = syntheticSession(actorB, "lookup-overtakes-A");
  // This fixture is the current lock owner completing a normal main SDK write.
  f.owner.storage.setItem(f.key, JSON.stringify(b));
  held.release();
  denied(await bounded(operation, "password entry lookup overtaken"), "A lookup predates B");
  noNewPasswordPut(f);
  assert.equal(f.http.calls.length, 0);
  assert.equal(f.saved(), JSON.stringify(b));
  f.noPasswordRetained();
});

for (const expectedUserId of [actorA, null]) {
  test(`entry rejects mismatching reauthentication subject ${expectedUserId === null ? "anonymous" : "A"}`, async (t) => {
    const f = await fixture(t);
    await f.write(syntheticSession(actorB, "subject-B"));
    const before = f.saved();
    const stamp = f.owner.capture();
    const scope = f.lifetime({ expectedUserId, expected: stamp }).scope;
    denied(await bounded(f.start(scope), "reauthentication identity mismatch"), "reauthentication identity is not current B");
    assert.deepEqual(f.owner.capture(), stamp, "refused subject must not claim another intent");
    assert.equal(f.saved(), before); noNewPasswordPut(f); f.noPasswordRetained();
  });
}

test("long reauthentication proof rejects byte-exact A -> B -> A even when the actor again matches", async (t) => {
  const f = await fixture(t);
  const proof = f.owner.capture();
  const original = f.saved()!;
  await f.write(syntheticSession(actorB, "reauth-ABA-B"));
  await f.write(original);
  assert.equal(f.saved(), original);
  assert.equal(f.owner.isCurrent(proof), false);
  denied(await bounded(f.start(f.lifetime({ expectedUserId: actorA, expected: proof }).scope), "reauthentication stamp ABA"), "proof predates session revision");
  noNewPasswordPut(f); assert.equal(f.saved(), original); f.noPasswordRetained();
});

test("a newer no-write challenge invalidates an older reauthentication proof without changing session bytes", async (t) => {
  const f = await fixture(t);
  const proof = f.owner.capture();
  const original = f.saved();
  f.http.expect("password", { code: "reauthentication_needed", msg: "Synthetic secure change challenge" }, { status: 400 });
  const challenge = await bounded(f.start(), "newer native password challenge");
  if (!challenge.ok) throw challenge.error;
  assert.equal(challenge.value.error?.code, "reauthentication_needed");
  assert.equal(f.saved(), original);
  const current = f.owner.capture();
  assert.equal(current.revision, proof.revision);
  assert.notEqual(current.intent, proof.intent);
  denied(await bounded(f.start(f.lifetime({ expectedUserId: actorA, expected: proof }).scope), "outdated reauthentication intent"),
    "reauthentication proof predates newer non-writing intent");
  assert.equal(f.http.calls.length, 1, "old proof cannot dispatch an additional password PUT");
  f.noPasswordRetained();
});

test("a throwing caller scope fails closed before native password dispatch or receipt", async (t) => {
  const f = await fixture(t);
  const lifetime = f.lifetime();
  const receipts: ReturnType<Authority["capture"]>[] = [];
  lifetime.scope.isCurrent = () => { throw Error("Synthetic caller scope is unavailable"); };
  lifetime.scope.onReceipt = (stamp) => receipts.push(stamp);
  denied(await bounded(f.start(lifetime.scope), "unreadable caller scope"), "isCurrent throws");
  assert.equal(f.http.calls.length, 0);
  assert.equal(receipts.length, 0); f.noPasswordRetained();
});

for (const stage of ["transport", "body"] as const) {
  test(`late password ${stage} cannot overwrite B or publish old A after a remotely dispatched PUT`, async (t) => {
    const f = await fixture(t);
    await f.observe();
    const reply = f.http.expect("password", { user: updatedUser("retired-A-profile") }, { hold: stage });
    const operation = f.start();
    const call = await bounded(reply.arrived, "original A password PUT dispatched");
    assertPasswordPut(call, f.original.access_token);
    if (stage === "body") await bounded(reply.reading, "native password body read held");
    const b = syntheticSession(actorB, `new-B-after-${stage}`);
    await f.write(b);
    await until(() => f.events.at(-1)?.actor === actorB, "B publication before late password response");
    const eventMark = f.events.length;
    const bytes = f.saved();
    reply.releaseTransport(); reply.releaseBody();
    denied(await bounded(operation, "late native password response"), "B superseded local authority");
    assert.equal(f.saved(), bytes);
    await immediate();
    assert.equal(f.events.slice(eventMark).some((event) => event.actor === actorA), false);
    assert.equal(f.http.calls.filter((item) => item.kind === "password").length, 1,
      "the original PUT was already dispatched; this test makes no remote rollback claim");
    f.noPasswordRetained();
  });

  test(`late native refresh ${stage} cannot replace B or authorize a password PUT for B`, async (t) => {
    const f = await fixture(t, { expired: true });
    const refreshed = syntheticSession(actorA, `refresh-A-${stage}`);
    const reply = f.http.expect("refresh", refreshed, { hold: stage });
    f.http.expect("password", { user: updatedUser() });
    const operation = f.start();
    const call = await bounded(reply.arrived, "native expired-A refresh dispatched");
    assert.equal(call.body.refresh_token, f.original.refresh_token);
    if (stage === "body") await bounded(reply.reading, "native refresh body read held");
    const b = syntheticSession(actorB, `B-during-refresh-${stage}`);
    await f.write(b);
    reply.releaseTransport(); reply.releaseBody();
    denied(await bounded(operation, "refresh overtaken by B"), "retired A refresh cannot hydrate B");
    noNewPasswordPut(f); assert.equal(f.saved(), JSON.stringify(b)); f.noPasswordRetained();
  });
}

test("current expired-A refresh rotates A before native password PUT without changing its subject", async (t) => {
  const f = await fixture(t, { expired: true });
  const refreshed = syntheticSession(actorA, "current-rotated-A");
  f.http.expect("refresh", refreshed);
  f.http.expect("password", { user: updatedUser() });
  success(await bounded(f.start(), "refresh then password PUT"));
  assert.equal(f.http.calls.length, 2);
  assert.equal(f.http.calls[0].body.refresh_token, f.original.refresh_token);
  assertPasswordPut(f.http.calls[1], refreshed.access_token);
  assert.equal(f.session().user.id, actorA);
  assert.equal(f.session().access_token, refreshed.access_token);
  f.noPasswordRetained();
});

for (const retirement of ["dispose", "abort"] as const) {
  test(`scope ${retirement} before password entry fails closed without HTTP`, async (t) => {
    const f = await fixture(t);
    const scope = f.lifetime(); scope[retirement]();
    const receipts: ReturnType<Authority["capture"]>[] = [];
    scope.scope.onReceipt = (stamp) => receipts.push(stamp);
    denied(await bounded(f.start(scope.scope), "retired password entry"), retirement);
    assert.equal(f.http.calls.length, 0); assert.deepEqual(receipts, []); f.noPasswordRetained();
  });

  test(`scope ${retirement} after intermediate refresh cannot authorize a NEW remote password PUT`, async (t) => {
    const f = await fixture(t, { expired: true });
    const refreshed = syntheticSession(actorA, `retired-refreshed-${retirement}`);
    const gate = f.mutex.gateAfterCommit(f.key, f.storage.getItem,
      (raw) => (JSON.parse(raw) as Session).refresh_token === refreshed.refresh_token);
    const scope = f.lifetime();
    f.http.expect("refresh", refreshed);
    f.http.expect("password", { user: updatedUser() });
    const operation = f.start(scope.scope);
    await bounded(gate.entered, "intermediate native refresh commit");
    const bytes = f.saved();
    scope[retirement](); gate.release();
    denied(await bounded(operation, "retired refreshed password operation"), "receipt cannot authorize another remote dispatch");
    noNewPasswordPut(f);
    assert.equal(f.saved(), bytes, "intermediate refresh cannot be cleared or rewritten after scope retirement");
    f.noPasswordRetained();
  });

  test(`scope ${retirement} during accepted PUT body forbids native session/profile commit`, async (t) => {
    const f = await fixture(t);
    const scope = f.lifetime();
    const bytes = f.saved();
    const reply = f.http.expect("password", { user: updatedUser() }, { hold: "body" });
    const operation = f.start(scope.scope);
    await bounded(reply.reading, "native password response held after dispatch");
    scope[retirement](); reply.releaseBody();
    denied(await bounded(operation, "scope retired during password response"), retirement);
    assert.equal(f.saved(), bytes);
    assert.equal(f.http.calls.length, 1, "local refusal does not unsend the original remote password PUT");
    f.noPasswordRetained();
  });

  test(`scope ${retirement} while final shared profile write is queued forbids that write`, async (t) => {
    const f = await fixture(t);
    const scope = f.lifetime();
    const bytes = f.saved();
    const reply = f.http.expect("password", { user: updatedUser() }, { hold: "body" });
    const operation = f.start(scope.scope);
    await bounded(reply.reading, "password response body held before storage");
    const holder = await f.mutex.hold(f.lockName);
    const before = f.mutex.calls.length;
    reply.releaseBody();
    await until(() => f.mutex.calls.length > before, "native password save queued on shared SDK lock");
    scope[retirement](); holder.release();
    denied(await bounded(operation, "queued password profile commit"), retirement);
    assert.equal(f.saved(), bytes); f.noPasswordRetained();
  });
}

test("B arriving after intermediate A refresh still prevents password PUT while the caller boolean remains true", async (t) => {
  const f = await fixture(t, { expired: true });
  const refreshed = syntheticSession(actorA, "A-before-B-commit");
  const gate = f.mutex.gateAfterCommit(f.key, f.storage.getItem,
    (raw) => (JSON.parse(raw) as Session).refresh_token === refreshed.refresh_token);
  f.http.expect("refresh", refreshed);
  f.http.expect("password", { user: updatedUser() });
  const scope = f.lifetime();
  const operation = f.start(scope.scope);
  await bounded(gate.entered, "A intermediate refresh persisted");
  const b = syntheticSession(actorB, "B-after-intermediate-A");
  await f.write(b);
  assert.equal(scope.scope.isCurrent(), true, "storage/stamp guard must work independently of caller booleans");
  gate.release();
  denied(await bounded(operation, "B replaces intermediate A refresh"), "main storage actor changed");
  noNewPasswordPut(f); assert.equal(f.saved(), JSON.stringify(b)); f.noPasswordRetained();
});

for (const [code, status] of [["reauthentication_needed", 400], ["reauthentication_not_valid", 400],
  ["insufficient_aal", 403], ["same_password", 422]] as const) {
  test(`native password challenge ${code} remains an SDK AuthApiError, not false success`, async (t) => {
    const f = await fixture(t);
    const bytes = f.saved();
    const message = `Synthetic SDK challenge: ${code}`;
    f.http.expect("password", { code, msg: message }, { status });
    const outcome = await bounded(f.start(), "native password challenge response");
    if (!outcome.ok) throw outcome.error;
    assert.equal(outcome.value.data.user, null);
    assert.ok(outcome.value.error instanceof sdk.AuthApiError);
    assert.equal(outcome.value.error.code, code);
    assert.equal(outcome.value.error.status, status);
    assert.equal(outcome.value.error.message, message);
    assert.equal(f.saved(), bytes); f.noPasswordRetained(outcome);
    assert.equal(f.http.calls.length, 1, "no automatic reauthentication mail or challenge completion");
  });
}

test("native weak-password reasons survive intact without storing the submitted password", async (t) => {
  const f = await fixture(t);
  f.http.expect("password", { code: "weak_password", msg: "Synthetic password policy refusal",
    weak_password: { reasons: ["length", "characters"] } }, { status: 422 });
  const outcome = await bounded(f.start(), "native weak-password error");
  if (!outcome.ok) throw outcome.error;
  assert.ok(outcome.value.error instanceof sdk.AuthWeakPasswordError);
  assert.deepEqual(outcome.value.error.reasons, ["length", "characters"]);
  assert.equal(outcome.value.error.code, "weak_password");
  assert.equal(outcome.value.data.user, null); f.noPasswordRetained(outcome);
});

test("missing native session never becomes an anonymous remote password request", async (t) => {
  const f = await fixture(t, { empty: true });
  const result = await bounded(f.start(f.lifetime({ expectedUserId: null, expected: f.owner.capture() }).scope), "native missing session");
  if (!result.ok) throw result.error;
  assert.equal(result.value.error?.name, "AuthSessionMissingError");
  assert.equal(result.value.data.user, null);
  assert.equal(f.http.calls.length, 0); f.noPasswordRetained(result);
});

test("actual per-operation native password client is publicly disposed before the result settles", async (t) => {
  const f = await fixture(t);
  const dispose = t.mock.method(sdk.AuthClient.prototype, "dispose");
  f.http.expect("password", { user: updatedUser() });
  success(await bounded(f.start(), "password result after native disposal"));
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(dispose.mock.calls[0].error, undefined);
  const disposal = dispose.mock.calls[0].result;
  assert.ok(disposal, "the actual public dispose returns its cleanup promise");
  await bounded(disposal, "public native dispose completes");
});

function heldPublicDispose(t: TestContext, f: Fixture) {
  const nativeDispose = sdk.AuthClient.prototype.dispose;
  const entered = deferred<void>();
  const gate = deferred<void>();
  let completed = false;
  f.releaseDuringCleanup(() => gate.resolve());
  t.mock.method(sdk.AuthClient.prototype, "dispose", async function (this: Receiver) {
    entered.resolve(); await gate.promise;
    await nativeDispose.call(this); completed = true;
  });
  return { entered: entered.promise, release: () => gate.resolve(), completed: () => completed };
}

test("password receipt is delivered once after public native dispose and before the SDK result resolves", async (t) => {
  const f = await fixture(t);
  const held = heldPublicDispose(t, f);
  const lifetime = f.lifetime();
  const receipts: { stamp: ReturnType<Authority["capture"]>; disposed: boolean }[] = [];
  lifetime.scope.onReceipt = (stamp) => receipts.push({ stamp, disposed: held.completed() });
  f.http.expect("password", { user: updatedUser() });
  const operation = f.start(lifetime.scope);
  await bounded(held.entered, "native password dispose is held");
  assert.equal(receipts.length, 0, "receipt cannot escape before dispose finishes");
  const committed = f.owner.capture();
  held.release();
  const result = await bounded(operation, "post-dispose password receipt");
  success(result);
  assert.deepEqual(receipts, [{ stamp: committed, disposed: true }]);
  assert.equal(f.owner.isCurrent(receipts[0].stamp), true);
  if (!result.ok) throw result.error;
  assert.deepEqual(Object.keys(result.value).sort(), ["data", "error"], "receipt must not replace or extend native result shape");
  f.noPasswordRetained(result);
});

for (const change of ["B", "ABA"] as const) {
  test(`held native dispose cannot emit password receipt or stale success after ${change}`, async (t) => {
    const f = await fixture(t);
    const held = heldPublicDispose(t, f);
    const lifetime = f.lifetime();
    const receipts: ReturnType<Authority["capture"]>[] = [];
    lifetime.scope.onReceipt = (stamp) => receipts.push(stamp);
    f.http.expect("password", { user: updatedUser() });
    const operation = f.start(lifetime.scope);
    await bounded(held.entered, "password committed before held native dispose");
    const committedBytes = f.saved()!;
    const committedStamp = f.owner.capture();
    assert.deepEqual(receipts, []);
    await f.write(syntheticSession(actorB, `during-dispose-${change}`));
    if (change === "ABA") {
      await f.write(committedBytes);
      assert.equal(f.saved(), committedBytes, "exact committed A bytes restored, not reconstructed");
    }
    const finalBytes = f.saved();
    assert.equal(f.owner.isCurrent(committedStamp), false, "revision changed even if the raw A bytes match again");
    held.release();
    denied(await bounded(operation, "password completion after held dispose"), `post-dispose ${change} ownership recheck`);
    assert.deepEqual(receipts, [], "stale completion cannot leak a receipt");
    assert.equal(f.saved(), finalBytes);
    f.noPasswordRetained();
  });
}

for (const retirement of ["dispose", "abort"] as const) {
  test(`uncommitted challenge cannot emit a receipt when caller ${retirement} during native disposal`, async (t) => {
    const f = await fixture(t);
    const held = heldPublicDispose(t, f);
    const lifetime = f.lifetime();
    const receipts: ReturnType<Authority["capture"]>[] = [];
    lifetime.scope.onReceipt = (stamp) => receipts.push(stamp);
    const original = f.saved();
    f.http.expect("password", { code: "reauthentication_needed", msg: "Synthetic secure change challenge" }, { status: 400 });
    const operation = f.start(lifetime.scope);
    await bounded(held.entered, "no-write challenge dispose is held");
    lifetime[retirement](); held.release();
    denied(await bounded(operation, "challenge result after caller retirement"), `post-dispose caller ${retirement}`);
    assert.deepEqual(receipts, []);
    assert.equal(f.saved(), original); f.noPasswordRetained();
  });
}

after(async () => {
  await immediate();
  assert.deepEqual(activeResources(), initialResources, "native password clients leave no timers or channels");
});

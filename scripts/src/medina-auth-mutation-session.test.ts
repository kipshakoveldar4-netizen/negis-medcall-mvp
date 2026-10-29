import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { createAuthSessionAuthority } from "../../artifacts/negis/src/lib/authSessionAuthority";

// Only the frontend's installed, unmodified SDK is exercised. All HTTP is synthetic.
// This suite does not cover browser cross-tab delivery, React, real JWT validation,
// provider behavior, or remote token revocation. No environment files are imported.
// Timeout settlement assumes fetch honors AbortSignal. Cancellation-ignoring
// response/body gates are always explicitly released by fixture teardown.
// FIFO/grant ordering is deterministic; browser lock acquisition timeouts are not modeled.
const frontendRequire = createRequire(new URL("../../artifacts/negis/package.json", import.meta.url));
// Derive SDK argument/result types through the factory's frontend imports. A
// relative node_modules type import breaks transitive resolution under pnpm.
type Authority = ReturnType<typeof createAuthSessionAuthority>;
type FactoryOptions = Parameters<typeof createAuthSessionAuthority>[0];
type NativeReceiver = Parameters<Authority["observe"]>[0];
type NativeCallback = Parameters<Authority["observe"]>[1];
type AuthChangeEvent = Parameters<NativeCallback>[0];
type Session = NonNullable<Parameters<NativeCallback>[1]>;
type User = Session["user"];
type LockFunc = FactoryOptions["lock"];
type NativeAuth = NativeReceiver & {
  initialize(): Promise<unknown>;
  dispose(): Promise<void>;
  setSession(tokens: Parameters<Authority["setSession"]>[0]): ReturnType<Authority["setSession"]>;
  signOut(options?: Parameters<Authority["signOut"]>[1]): ReturnType<Authority["signOut"]>;
  verifyOtp(params: Parameters<Authority["verifyOtp"]>[0]): ReturnType<Authority["verifyOtp"]>;
  refreshSession(tokens?: { refresh_token: string }): ReturnType<Authority["setSession"]>;
};
const sdk = frontendRequire("@supabase/supabase-js") as { AuthClient: { new (options: {
  url: string; storageKey: string; storage: FactoryOptions["storage"]; lock: LockFunc;
  fetch: typeof fetch; autoRefreshToken: false; detectSessionInUrl: false; persistSession: true;
}): NativeAuth; prototype: NativeAuth } };
const sdkVersion = frontendRequire("@supabase/supabase-js/package.json").version;
const origin = "https://auth-mutation.synthetic.invalid";
const ids = {
  A: "10000000-0000-4000-8000-000000000001",
  B: "10000000-0000-4000-8000-000000000002",
  C: "10000000-0000-4000-8000-000000000003",
} as const;
type Actor = keyof typeof ids;
type Scope = { isCurrent(): boolean; signal?: AbortSignal };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: PromiseLike<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function flush() { for (let i = 0; i < 12; i++) await immediate(); }
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await immediate();
  }
}

function session(actor: Actor, expired = false, generation?: string): Session {
  const now = Math.floor(Date.now() / 1000);
  const user: User = {
    id: ids[actor], aud: "authenticated", role: "authenticated",
    email: `${actor.toLowerCase()}@synthetic.invalid`, app_metadata: {}, user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: user.id, aud: user.aud, role: user.role, iss: `${origin}/auth/v1`,
    iat: now - 120, exp: expired ? now - 60 : now + 86400, session_id: user.id,
    ...(generation ? { jti: generation } : {}) };
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = createHmac("sha256", "local-synthetic-signature-not-a-credential").update(unsigned).digest("base64url");
  return { access_token: `${unsigned}.${signature}`, refresh_token: `synthetic-refresh-${actor}${generation ? `-${generation}` : ""}`,
    expires_at: claims.exp, expires_in: claims.exp - now, token_type: "bearer", user };
}

function subject(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub as string;
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; value: string | null }[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); this.writes.push({ key, value }); }
  removeItem(key: string) { this.values.delete(key); this.writes.push({ key, value: null }); }
}

// A shared generic FIFO LockFunc, including a gate after grant but before callback.
// Neither SDK private fields nor SDK method implementations are replaced.
class SharedLock {
  readonly calls: string[] = [];
  private tails = new Map<string, Promise<void>>();
  private gates = new Set<ReturnType<typeof deferred<void>>>();
  private nextGrant?: { name: string; entered: ReturnType<typeof deferred<void>>; gate: ReturnType<typeof deferred<void>> };
  readonly lock: LockFunc = async <R>(name: string, _timeout: number, fn: () => Promise<R>): Promise<R> => {
    this.calls.push(name);
    const before = this.tails.get(name) ?? Promise.resolve();
    const tail = deferred<void>();
    this.tails.set(name, tail.promise);
    const grant = this.nextGrant?.name === name ? this.nextGrant : undefined;
    if (grant) this.nextGrant = undefined;
    await before;
    try {
      if (grant) { grant.entered.resolve(); await grant.gate.promise; }
      return await fn();
    } finally {
      tail.resolve();
      if (this.tails.get(name) === tail.promise) this.tails.delete(name);
    }
  };
  async hold(name: string) {
    const gate = deferred<void>(), entered = deferred<void>();
    this.gates.add(gate);
    const done = this.lock(name, -1, async () => { entered.resolve(); await gate.promise; });
    await bounded(entered.promise, "lock holder entered");
    return { release: () => gate.resolve(), done };
  }
  gateNext(name: string) {
    assert.equal(this.nextGrant, undefined);
    const gate = deferred<void>(), entered = deferred<void>();
    this.gates.add(gate);
    this.nextGrant = { name, gate, entered };
    return { entered: entered.promise, release: () => gate.resolve() };
  }
  releaseAll() { for (const gate of this.gates) gate.resolve(); }
  get pending() { return this.tails.size; }
}

type Call = { url: URL; method: string; headers: Headers; body: Record<string, unknown>; signal?: AbortSignal | null };
type Reply = { status: number; body?: unknown };
type Hold = { path: string; stage: "transport" | "body"; entered: ReturnType<typeof deferred<Call>>;
  release: ReturnType<typeof deferred<void>>; reply?: Reply; call?: Call; used: boolean; honorAbort: boolean };

class FakeTransport {
  readonly calls: Call[] = [];
  readonly unexpected: string[] = [];
  private holds: Hold[] = [];
  hold(path: string, stage: Hold["stage"] = "transport", reply?: Reply, honorAbort = false) {
    const hold: Hold = { path, stage, entered: deferred<Call>(), release: deferred<void>(), reply, used: false, honorAbort };
    this.holds.push(hold);
    return { request: hold.entered.promise, release: () => hold.release.resolve() };
  }
  private defaultReply(call: Call): Reply {
    const path = call.url.pathname;
    if (path.endsWith("/logout")) return { status: 204 };
    if (path.endsWith("/user")) {
      const id = subject(call.headers.get("authorization")!.replace(/^Bearer /, ""));
      const actor = (Object.keys(ids) as Actor[]).find(key => ids[key] === id);
      assert.ok(actor, "only fixture JWT subjects are accepted");
      return { status: 200, body: session(actor).user };
    }
    if (path.endsWith("/verify")) {
      const actor = String(call.body.token_hash).endsWith("B") ? "B" : "A";
      return { status: 200, body: session(actor) };
    }
    if (path.endsWith("/token") && call.url.searchParams.get("grant_type") === "refresh_token") {
      const actor = String(call.body.refresh_token).endsWith("B") ? "B" : "A";
      return { status: 200, body: session(actor) };
    }
    this.unexpected.push(`${call.method} ${call.url}`);
    throw new Error("Unexpected synthetic auth request");
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) this.unexpected.push(`${init?.method ?? "GET"} ${url}`);
    assert.equal(url.origin, origin, "fetch must never leave the synthetic origin");
    const call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), signal: init?.signal,
      body: init?.body ? JSON.parse(String(init.body)) : {} };
    this.calls.push(call);
    const hold = this.holds.find(item => !item.used && url.pathname.endsWith(item.path));
    const reply = hold?.reply ?? this.defaultReply(call);
    if (hold) {
      hold.used = true; hold.call = call; hold.entered.resolve(call);
      if (hold.stage === "transport") {
        if (hold.honorAbort && init?.signal) {
          const signal = init.signal, aborted = deferred<never>();
          const cancel = () => aborted.reject(new DOMException("Synthetic request aborted", "AbortError"));
          signal.addEventListener("abort", cancel, { once: true });
          try {
            if (signal.aborted) cancel();
            await Promise.race([hold.release.promise, aborted.promise]);
          } finally { signal.removeEventListener("abort", cancel); }
        } else await hold.release.promise;
      }
    }
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    if (hold?.stage === "body" && body !== null) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        void hold.release.promise.then(() => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); });
      } });
      return new Response(stream, { status: reply.status, headers: { "content-type": "application/json" } });
    }
    return new Response(body, { status: reply.status, headers: { "content-type": "application/json" } });
  };
  releaseAll() { for (const hold of this.holds) hold.release.resolve(); }
}

function scope() {
  const controller = new AbortController();
  let current = true;
  return { value: { isCurrent: () => current, signal: controller.signal } satisfies Scope,
    expire: () => { current = false; }, abort: () => controller.abort() };
}
type Outcome<T> = { value: T; thrown?: never } | { value?: never; thrown: unknown };
function track<T>(promise: PromiseLike<T>): Promise<Outcome<T>> {
  return Promise.resolve(promise).then(value => ({ value }), thrown => ({ thrown }));
}
function successful<T extends { error: unknown }>(outcome: Outcome<T>) {
  assert.equal(outcome.thrown, undefined);
  assert.ok(outcome.value);
  assert.equal(outcome.value.error, null);
  return outcome.value;
}

async function fixture(t: TestContext, options: { timeoutMs?: number } = {}) {
  const forbiddenHttp = t.mock.method(globalThis, "fetch", async () => { assert.fail("Real/global HTTP is forbidden"); });
  const memory = new MemoryStorage(), shared = new SharedLock(), http = new FakeTransport();
  let nonce = 0;
  const authorities: Authority[] = [];
  const createPeer = () => {
    const value = createAuthSessionAuthority({ url: origin, key: "synthetic-public-key-not-a-credential",
      storage: memory, lock: shared.lock, fetch: http.fetch, nonce: () => `synthetic-op-${++nonce}`,
      timeoutMs: options.timeoutMs ?? 1500 });
    authorities.push(value);
    return value;
  };
  const authority = createPeer();
  const clients: NativeAuth[] = [], subscriptions: { unsubscribe(): void }[] = [];
  const tasks: Promise<unknown>[] = [], scopes: ReturnType<typeof scope>[] = [];
  const gates: ReturnType<typeof deferred<void>>[] = [];
  const gate = () => { const result = deferred<void>(); gates.push(result); return result; };
  const saved = () => memory.getItem(authority.storageKey);
  const savedSubject = () => { const raw = saved(); return raw ? JSON.parse(raw).user?.id ?? null : null; };
  const seed = (value: Session | null) => {
    if (value) authority.storage.setItem(authority.storageKey, JSON.stringify(value));
    else authority.storage.removeItem(authority.storageKey);
  };
  seed(session("A"));
  const createReceiver = async () => {
    const auth = new sdk.AuthClient({ url: `${origin}/auth/v1`, storageKey: authority.storageKey,
      storage: authority.storage, lock: shared.lock, fetch: http.fetch,
      autoRefreshToken: false, detectSessionInUrl: false, persistSession: true });
    clients.push(auth);
    await bounded(auth.initialize(), "native receiver initialize");
    return auth;
  };
  const observe = async () => {
    const auth = await createReceiver();
    const events: { event: AuthChangeEvent; id: string | null; savedId: string | null }[] = [];
    const result = authority.observe(auth, (event, value) => {
      let savedId: string | null = null;
      try { savedId = savedSubject(); } catch { /* The snapshot-failure test deliberately makes reads unavailable. */ }
      events.push({ event, id: value?.user.id ?? null, savedId });
    });
    assert.equal(typeof result.data.subscription.unsubscribe, "function", "native subscription return shape");
    subscriptions.push(result.data.subscription);
    await until(() => events.length > 0, "authority initial session");
    return { auth, events, unsubscribe: () => result.data.subscription.unsubscribe() };
  };
  const start = <T>(promise: PromiseLike<T>) => { const pending = track(promise); tasks.push(pending); return pending; };
  const freshScope = () => { const result = scope(); scopes.push(result); return result; };
  const commitB = async () => {
    const result = successful(await bounded(start(authority.setSession(session("B"), freshScope().value)), "B commit while A held"));
    assert.equal(result.data.session?.user.id, ids.B);
    assert.equal(savedSubject(), ids.B);
    return saved();
  };
  t.after(async () => {
    for (const item of scopes) item.abort();
    for (const item of gates) item.resolve();
    shared.releaseAll(); http.releaseAll();
    for (const subscription of subscriptions) subscription.unsubscribe();
    try { await bounded(Promise.all(tasks), "all fixture operations settled"); }
    finally {
      for (const value of authorities) {
        if ("dispose" in value && typeof value.dispose === "function") await value.dispose();
      }
      for (const client of clients) await client.dispose();
    }
    await flush();
    assert.deepEqual(http.unexpected, []);
    assert.equal(forbiddenHttp.mock.callCount(), 0, "global HTTP was never attempted, even if a caller caught its rejection");
    assert.equal(shared.pending, 0, "all shared locks released");
  });
  return { authority, memory, shared, http, saved, savedSubject, seed, createReceiver, observe,
    start, freshScope, commitB, gate, clients, subscriptions, createPeer, lockName: `lock:${authority.storageKey}` };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type NativeReceipt = { event: AuthChangeEvent; value: Session | null; saved: Session | null; revision: string | null };

async function nativeObserver(f: Fixture, t: TestContext, holdEvent?: AuthChangeEvent) {
  const auth = await f.createReceiver(), subscribe = auth.onAuthStateChange.bind(auth);
  const lookup = auth.getSession.bind(auth), gate = f.gate(), entered = deferred<Session | null>();
  const events: NativeReceipt[] = [];
  let inNativeCallback = false, held = false, synchronousLookups = 0;
  const getSession = t.mock.method(auth, "getSession", () => {
    if (inNativeCallback) synchronousLookups++;
    return lookup();
  });
  t.mock.method(auth, "onAuthStateChange", (callback: NativeCallback) => subscribe((event, value) => {
    const deliver = () => {
      inNativeCallback = true;
      try { callback(event, value); } finally { inNativeCallback = false; }
    };
    if (!held && event === holdEvent) {
      held = true; entered.resolve(value);
      // Delay only delivery at the public subscription boundary. The genuine
      // SDK event completes, releases its lock, and is never manufactured here.
      f.start(gate.promise.then(deliver));
    } else deliver();
  }));
  const subscription = f.authority.observe(auth, (event, value) => {
    const raw = f.saved();
    events.push({ event, value, saved: raw ? JSON.parse(raw) : null,
      revision: f.memory.getItem(f.authority.revisionKey) });
  }).data.subscription;
  f.subscriptions.push(subscription);
  if (holdEvent !== "INITIAL_SESSION") await until(() => events.length > 0, "native observer initial event");
  return { auth, events, request: entered.promise, release: () => gate.resolve(), getSession,
    synchronousLookups: () => synchronousLookups, unsubscribe: () => subscription.unsubscribe() };
}

async function nativeEvent(f: Fixture, auth: NativeAuth, event: AuthChangeEvent, generation = "native-refresh") {
  if (event === "SIGNED_OUT") return successful(await bounded(f.start(auth.signOut()), "native signed-out event"));
  if (event === "PASSWORD_RECOVERY") return successful(await bounded(f.start(auth.verifyOtp({
    token_hash: "synthetic-otp-A", type: "recovery",
  })), "native recovery event"));
  if (event === "TOKEN_REFRESHED") {
    const reply = f.http.hold("/token", "transport", { status: 200, body: session("A", false, generation) });
    reply.release();
    return successful(await bounded(f.start(auth.refreshSession()), "native refreshed event"));
  }
  return successful(await bounded(f.start(auth.setSession(session("A"))), "native signed-in event"));
}

function assertPersistedReceipts(events: NativeReceipt[]) {
  for (const receipt of events) {
    assert.equal(receipt.value?.user.id ?? null, receipt.saved?.user.id ?? null, `${receipt.event} subject`);
    assert.equal(receipt.value?.access_token ?? null, receipt.saved?.access_token ?? null, `${receipt.event} access token`);
    assert.equal(receipt.value?.refresh_token ?? null, receipt.saved?.refresh_token ?? null, `${receipt.event} refresh token`);
    assert.deepEqual(receipt.value?.user ?? null, receipt.saved?.user ?? null, `${receipt.event} persisted user`);
  }
}

function storageEvents(f: Fixture, t: TestContext) {
  const target = new EventTarget(), previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return () => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: f.authority.storageKey });
    target.dispatchEvent(event);
  };
}

type Mutation = "signOut" | "setSession" | "verifyOtp";
const requestPath = { signOut: "/logout", setSession: "/user", verifyOtp: "/verify" } as const;
function mutate(f: Fixture, kind: Mutation, caller: Scope) {
  if (kind === "signOut") return f.start(f.authority.signOut(caller));
  if (kind === "setSession") return f.start(f.authority.setSession(session("A"), caller));
  return f.start(f.authority.verifyOtp({ token_hash: "synthetic-otp-A", type: "recovery" }, caller));
}

test("mutation suite resolves the frontend's exact native SDK 2.118.0", () => {
  assert.equal(sdkVersion, "2.118.0", "do not substitute the scripts/root baseline SDK");
});

for (const setting of [undefined, "global", "local", "others"] as const)
test(`native signOut preserves SDK ${setting ?? "default global"} scope`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const before = f.saved(), mark = observer.events.length;
  const result = await f.start(f.authority.signOut(f.freshScope().value, setting ? { scope: setting } : undefined));
  successful(result);
  const calls = f.http.calls.filter(call => call.url.pathname.endsWith("/logout"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.searchParams.get("scope"), setting ?? "global");
  assert.equal(subject(calls[0].headers.get("authorization")!.replace(/^Bearer /, "")), ids.A);
  if (setting === "others") {
    assert.equal(f.saved(), before);
    await flush();
    assert.equal(observer.events.slice(mark).some(item => item.event === "SIGNED_OUT"), false);
  } else {
    assert.equal(f.saved(), null);
    await until(() => observer.events.slice(mark).some(item => item.event === "SIGNED_OUT"), "current logout observed");
  }
});

for (const status of [400, 401, 403, 404, 500] as const)
test(`native logout HTTP ${status} keeps SDK error/clear behavior and default global`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const mark = observer.events.length;
  // The 2.118 SDK clears local state on these failures too. Compare with a
  // second actual client, rather than inheriting 2.105 logout assumptions.
  const nativeMemory = new MemoryStorage(), nativeHttp = new FakeTransport(), nativeLock = new SharedLock();
  nativeMemory.setItem(f.authority.storageKey, f.saved()!);
  const native = new sdk.AuthClient({ url: `${origin}/auth/v1`, storageKey: f.authority.storageKey,
    storage: nativeMemory, lock: nativeLock.lock, fetch: nativeHttp.fetch,
    autoRefreshToken: false, detectSessionInUrl: false, persistSession: true });
  f.clients.push(native);
  await bounded(native.initialize(), "native logout control initialized");
  const reply = { status, body: { code: "synthetic_logout_rejected", msg: "Synthetic logout rejected" } };
  const nativeHeld = nativeHttp.hold("/logout", "transport", reply);
  nativeHeld.release();
  const control = await bounded(native.signOut(), "native rejected logout control");
  const held = f.http.hold("/logout", "transport", { status,
    body: { code: "synthetic_logout_rejected", msg: "Synthetic logout rejected" } });
  const pending = f.start(f.authority.signOut(f.freshScope().value));
  const call = await bounded(held.request, "rejected logout dispatched");
  assert.equal(call.url.searchParams.get("scope"), "global");
  held.release();
  const outcome = await bounded(pending, "rejected logout settled");
  assert.equal(outcome.thrown, undefined);
  assert.ok(outcome.value);
  assert.equal(outcome.value.error?.status ?? null, control.error?.status ?? null);
  assert.equal(outcome.value.error?.code ?? null, control.error?.code ?? null);
  assert.equal(f.saved(), nativeMemory.getItem(f.authority.storageKey));
  assert.equal(f.saved(), null, "native 2.118 clears current local session even on non-ignored rejection");
  await until(() => observer.events.slice(mark).some(item => item.event === "SIGNED_OUT"), "native failure clear observed");
  if ([401, 403, 404].includes(status)) {
    assert.equal(outcome.value.error, null);
  } else {
    assert.equal(outcome.value.error?.status, status);
  }
});

for (const status of [204, 400, 500] as const)
test(`held remote A logout HTTP ${status} cannot clear B or publish stale SIGNED_OUT after B commits`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const originalToken = JSON.parse(f.saved()!).access_token;
  const held = f.http.hold("/logout", "transport", { status,
    ...(status === 204 ? {} : { body: { code: "synthetic_logout_rejected", msg: "Synthetic rejection" } }) });
  const pending = f.start(f.authority.signOut(f.freshScope().value));
  const call = await bounded(held.request, "A logout dispatched");
  assert.equal(call.headers.get("authorization"), `Bearer ${originalToken}`, "logout uses exactly the original access token");
  assert.equal(subject(call.headers.get("authorization")!.replace(/^Bearer /, "")), ids.A);
  assert.equal(call.url.searchParams.get("scope"), "global");
  const rawB = await f.commitB();
  await until(() => observer.events.at(-1)?.id === ids.B, "B observed while logout held");
  const mark = observer.events.length;
  held.release();
  await bounded(pending, "old logout completion");
  await flush();
  assert.equal(f.saved(), rawB);
  assert.equal(observer.events.slice(mark).some(item => item.event === "SIGNED_OUT" || item.id === ids.A), false);
  assert.equal(f.http.calls.filter(item => item.url.pathname.endsWith("/logout")).length, 1);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
for (const invalidation of ["expired", "aborted"] as const)
test(`${kind}: ${invalidation} caller before invocation cannot dispatch or write`, async t => {
  const f = await fixture(t), caller = f.freshScope();
  const before = f.saved(), writes = f.memory.writes.length;
  if (invalidation === "expired") caller.expire(); else caller.abort();
  await bounded(mutate(f, kind, caller.value), "already stale mutation");
  assert.equal(f.saved(), before);
  assert.equal(f.http.calls.length, 0);
  assert.equal(f.memory.writes.length, writes, "not even a revision claim for an already retired caller");
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
for (const stage of ["queued", "granted"] as const)
test(`${kind}: ${stage} shared-lock callback rechecks expired scope before dispatch`, async t => {
  const f = await fixture(t), caller = f.freshScope();
  const count = f.shared.calls.length;
  const held = stage === "queued" ? await f.shared.hold(f.lockName) : undefined;
  const granted = stage === "granted" ? f.shared.gateNext(f.lockName) : undefined;
  const pending = mutate(f, kind, caller.value);
  if (granted) await bounded(granted.entered, "mutation lock granted before callback");
  else await until(() => f.shared.calls.length >= count + 2, "mutation queued behind holder");
  f.seed(session("B"));
  const rawB = f.saved(), writes = f.memory.writes.length;
  caller.expire(); caller.abort();
  held?.release(); granted?.release();
  await held?.done;
  await bounded(pending, "stale lock callback settled");
  assert.equal(f.saved(), rawB);
  assert.equal(f.http.calls.length, 0, "expired lock callback must not operate on B");
  assert.equal(f.memory.writes.length, writes);
});

for (const stage of ["queued", "granted"] as const)
test(`logout invoked for A before ${stage} claim cannot adopt newly saved B`, async t => {
  const f = await fixture(t), caller = f.freshScope();
  const held = stage === "queued" ? await f.shared.hold(f.lockName) : undefined;
  const granted = stage === "granted" ? f.shared.gateNext(f.lockName) : undefined;
  const count = f.shared.calls.length;
  const pending = f.start(f.authority.signOut(caller.value));
  if (granted) await bounded(granted.entered, "logout lock granted");
  else await until(() => f.shared.calls.length > count, "logout queued");
  f.seed(session("B"));
  const rawB = f.saved();
  held?.release(); granted?.release();
  await held?.done;
  await bounded(pending, "logout after session replacement before claim");
  assert.equal(f.http.calls.some(call => call.url.pathname.endsWith("/logout")
    && subject(call.headers.get("authorization")!.replace(/^Bearer /, "")) === ids.B), false,
  "an A logout must never target B even while its caller scope remains current");
  assert.equal(f.saved(), rawB);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
for (const stage of ["transport", "body"] as const)
for (const invalidation of ["expired", "aborted"] as const)
test(`${kind}: ${invalidation} scope at held ${stage} denies late session writes`, async t => {
  const f = await fixture(t), caller = f.freshScope(), observer = await f.observe();
  // Logout has no successful response body; use an SDK-ignored 401 JSON response.
  const reply = kind === "signOut" && stage === "body"
    ? { status: 401, body: { code: "bad_jwt", msg: "Synthetic invalidated token" } } : undefined;
  const held = f.http.hold(requestPath[kind], stage, reply);
  const before = f.saved(), pending = mutate(f, kind, caller.value);
  await bounded(held.request, `${kind} held ${stage}`);
  const writes = f.memory.writes.filter(item => item.key === f.authority.storageKey).length;
  const mark = observer.events.length;
  if (invalidation === "expired") caller.expire(); else caller.abort();
  held.release();
  await bounded(pending, "late retired mutation");
  await flush();
  assert.equal(f.saved(), before);
  assert.equal(f.memory.writes.filter(item => item.key === f.authority.storageKey).length, writes);
  assert.equal(observer.events.slice(mark).some(item => item.event === "SIGNED_OUT"), false);
});

for (const kind of ["setSession", "verifyOtp"] as const)
for (const stage of ["transport", "body"] as const)
test(`${kind}: old ${stage} response cannot overwrite a newer successful B`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const held = f.http.hold(requestPath[kind], stage);
  const pending = mutate(f, kind, f.freshScope().value);
  await bounded(held.request, "old setter dispatched");
  const rawB = await f.commitB();
  await until(() => observer.events.at(-1)?.id === ids.B, "B observed before old setter completes");
  const mark = observer.events.length;
  held.release();
  await bounded(pending, "obsolete setter settled");
  await flush();
  assert.equal(f.saved(), rawB);
  assert.equal(observer.events.slice(mark).some(item => item.id !== ids.B), false);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
test(`${kind}: exact raw session ABA is rejected by the storage revision`, async t => {
  const f = await fixture(t), original = f.saved()!;
  const held = f.http.hold(requestPath[kind]);
  const pending = mutate(f, kind, f.freshScope().value);
  await bounded(held.request, "ABA operation dispatched");
  const revisionBefore = [...f.memory.values].filter(([key]) => key !== f.authority.storageKey);
  f.seed(session("B"));
  f.authority.storage.setItem(f.authority.storageKey, original);
  assert.equal(f.saved(), original, "ABA restores the exact original bytes, not a rebuilt session");
  assert.notDeepEqual([...f.memory.values].filter(([key]) => key !== f.authority.storageKey), revisionBefore,
    "authority session writes must advance an opaque revision");
  const writes = f.memory.writes.length;
  held.release();
  const outcome = await bounded(pending, "ABA response settled");
  assert.ok(outcome.thrown || outcome.value?.error, "ABA completion must not report successful ownership");
  assert.equal(f.saved(), original);
  assert.equal(f.memory.writes.length, writes, "raw restoration cannot reauthorize an old session write");
});

for (const kind of ["setSession", "verifyOtp"] as const)
test(`${kind}: current native success saves and observes the actual subject`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const result = kind === "setSession"
    ? await f.start(f.authority.setSession(session("B"), f.freshScope().value))
    : await f.start(f.authority.verifyOtp({ token_hash: "synthetic-otp-B", type: "recovery" }, f.freshScope().value));
  successful(result);
  assert.equal(f.savedSubject(), ids.B);
  await until(() => observer.events.at(-1)?.id === ids.B, "saved B reaches observer");
  assert.ok(observer.events.every(item => item.id === item.savedId), "every observed subject matches saved storage");
});

test("native expired-token setSession refresh response is fenced after B commits", async t => {
  const f = await fixture(t), held = f.http.hold("/token");
  const pending = f.start(f.authority.setSession(session("A", true), f.freshScope().value));
  const call = await bounded(held.request, "expired setter refresh request");
  assert.equal(call.url.searchParams.get("grant_type"), "refresh_token");
  assert.equal(call.body.refresh_token, "synthetic-refresh-A");
  const rawB = await f.commitB();
  held.release();
  await bounded(pending, "old refresh settled");
  assert.equal(f.saved(), rawB);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
test(`${kind}: timeout aborts synthetic transport and removes caller signal listener`, async t => {
  const f = await fixture(t, { timeoutMs: 40 }), caller = f.freshScope();
  const signal = caller.value.signal;
  const add = t.mock.method(signal, "addEventListener");
  const remove = t.mock.method(signal, "removeEventListener");
  const held = f.http.hold(requestPath[kind], "transport", undefined, true);
  const before = f.saved(), pending = mutate(f, kind, caller.value);
  const call = await bounded(held.request, "timed operation dispatched");
  await bounded(pending, "timer retires operation without a remote reply", 1000);
  assert.equal(call.signal?.aborted, true);
  assert.equal(f.saved(), before);
  const additions = add.mock.calls.filter(item => item.arguments[0] === "abort");
  const removals = remove.mock.calls.filter(item => item.arguments[0] === "abort");
  assert.equal(additions.length, 1);
  assert.equal(removals.length, 1);
  assert.equal(additions[0].arguments[1], removals[0].arguments[1], "the same listener is removed on settlement");
  held.release();
});

test("observe ignores an obsolete held actual native getSession result after newer B lookup", async t => {
  const f = await fixture(t), observer = await f.observe();
  const nativeGetSession = observer.auth.getSession.bind(observer.auth);
  const gate = f.gate(), entered = deferred<void>();
  let once = true;
  // Gate a public method's *completion*. Its result is still from the real SDK
  // reading authority.storage under the shared lock; no session is fabricated.
  t.mock.method(observer.auth, "getSession", async () => {
    const result = await nativeGetSession();
    if (once) { once = false; entered.resolve(); await gate.promise; }
    return result;
  });
  f.seed(session("C"));
  await bounded(entered.promise, "native C lookup completed but held");
  const rawB = await f.commitB();
  await until(() => observer.events.at(-1)?.id === ids.B, "newer B lookup published");
  const mark = observer.events.length;
  gate.resolve();
  await flush();
  assert.equal(f.saved(), rawB);
  assert.equal(observer.events.slice(mark).some(item => item.id !== ids.B), false);
  assert.ok(observer.events.every(item => item.id === item.savedId));
});

test("observe cannot publish obsolete native INITIAL_SESSION A after current saved B", async t => {
  const f = await fixture(t), auth = await f.createReceiver();
  const nativeSubscribe = auth.onAuthStateChange.bind(auth);
  const gate = f.gate(), entered = deferred<Session | null>();
  let once = true;
  // Hold delivery of a genuine native event at the public subscription boundary.
  // Never mutate SDK private state or invoke a fabricated auth event callback.
  t.mock.method(auth, "onAuthStateChange", (callback: (event: AuthChangeEvent, value: Session | null) => void) => nativeSubscribe(async (event, value) => {
    if (once && event === "INITIAL_SESSION") {
      once = false; entered.resolve(value); await gate.promise;
    }
    callback(event, value);
  }));
  const events: { event: AuthChangeEvent; id: string | null; savedId: string | null }[] = [];
  const subscription = f.authority.observe(auth, (event, value) => {
    events.push({ event, id: value?.user.id ?? null, savedId: f.savedSubject() });
  }).data.subscription;
  f.subscriptions.push(subscription);
  assert.equal((await bounded(entered.promise, "actual native initial A event"))?.user.id, ids.A);
  const rawB = await f.commitB();
  await until(() => events.at(-1)?.id === ids.B, "B observed while native A completion held");
  const mark = events.length;
  gate.resolve();
  await flush();
  assert.equal(f.saved(), rawB);
  assert.equal(events.slice(mark).some(item => item.id !== ids.B), false,
    "native completion must be checked against actual current saved session");
  assert.ok(events.every(item => item.id === item.savedId));
});

test("observer unsubscribe removes native/writer delivery and ignores held lookup completion", async t => {
  const f = await fixture(t), observer = await f.observe();
  const nativeGetSession = observer.auth.getSession.bind(observer.auth);
  const entered = deferred<void>(), gate = f.gate();
  t.mock.method(observer.auth, "getSession", async () => {
    const result = await nativeGetSession();
    entered.resolve(); await gate.promise;
    return result;
  });
  f.seed(session("C"));
  await bounded(entered.promise, "lookup held before unsubscribe");
  observer.unsubscribe();
  const before = [...observer.events];
  gate.resolve();
  await f.commitB();
  // A public native method generates a genuine native event after unsubscribe.
  successful(await f.start(observer.auth.setSession(session("B"))));
  await flush();
  assert.deepEqual(observer.events, before);
});

test("observe storage-event subscription is removed and cannot wake after unsubscribe", async t => {
  const f = await fixture(t), target = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const added = t.mock.method(target, "addEventListener"), removed = t.mock.method(target, "removeEventListener");
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const observer = await f.observe();
  // Simulate another writer's storage event without inventing a native auth event.
  f.memory.setItem(f.authority.storageKey, JSON.stringify(session("B")));
  const dispatch = () => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: f.authority.storageKey });
    target.dispatchEvent(event);
  };
  dispatch();
  await until(() => observer.events.at(-1)?.id === ids.B, "storage event reads saved B");
  observer.unsubscribe();
  const before = [...observer.events];
  f.memory.setItem(f.authority.storageKey, JSON.stringify(session("C")));
  dispatch();
  await flush();
  assert.deepEqual(observer.events, before);
  const registrations = added.mock.calls.filter(item => item.arguments[0] === "storage");
  const removals = removed.mock.calls.filter(item => item.arguments[0] === "storage");
  assert.equal(registrations.length, 1);
  assert.equal(removals.length, 1);
  assert.equal(registrations[0].arguments[1], removals[0].arguments[1]);
});

test("operation SDK private keys never remove or overwrite shared PKCE/user keys", async t => {
  const f = await fixture(t);
  const keys = [`${f.authority.storageKey}-code-verifier`, `${f.authority.storageKey}-user`];
  for (const key of keys) f.memory.setItem(key, `synthetic-sentinel:${key}`);
  successful(await f.start(f.authority.setSession(session("B"), f.freshScope().value)));
  successful(await f.start(f.authority.verifyOtp({ token_hash: "synthetic-otp-A", type: "recovery" }, f.freshScope().value)));
  successful(await f.start(f.authority.signOut(f.freshScope().value)));
  for (const key of keys) assert.equal(f.memory.getItem(key), `synthetic-sentinel:${key}`);
  assert.equal([...f.memory.values.keys()].some(key => key.startsWith("medina-auth-operation-")), false,
    "operation storage stays private and is not leaked into shared storage");
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
test(`${kind}: another authority's newer non-writing intent retires old operation`, async t => {
  const f = await fixture(t), peer = f.createPeer();
  const original = f.saved(), revision = f.memory.getItem(f.authority.revisionKey);
  const held = f.http.hold(requestPath[kind]);
  const pending = mutate(f, kind, f.freshScope().value);
  await bounded(held.request, "old operation before peer intent");
  const oldIntent = f.memory.getItem(f.authority.intentKey);
  successful(await bounded(f.start(peer.signOut(f.freshScope().value, { scope: "others" })), "peer non-writing logout"));
  assert.equal(f.saved(), original);
  assert.equal(f.memory.getItem(f.authority.revisionKey), revision, "claim alone does not change the session-write revision");
  assert.notEqual(f.memory.getItem(f.authority.intentKey), oldIntent, "a distinct authority advances shared latest intent");
  const writes = f.memory.writes.length;
  held.release();
  const result = await bounded(pending, "old response after peer claim");
  assert.ok(result.thrown || result.value?.error, "same raw session does not authorize an obsolete shared intent");
  assert.equal(f.saved(), original);
  assert.equal(f.memory.writes.length, writes);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
test(`${kind}: scope is checked again inside a queued final write lock`, async t => {
  const f = await fixture(t), caller = f.freshScope();
  const remote = f.http.hold(requestPath[kind]);
  const pending = mutate(f, kind, caller.value);
  await bounded(remote.request, "operation response held before write");
  const holder = await f.shared.hold(f.lockName), count = f.shared.calls.length;
  remote.release();
  await until(() => f.shared.calls.length > count, "SDK session write queued behind shared holder");
  f.seed(session("B"));
  const rawB = f.saved(), writes = f.memory.writes.length;
  caller.expire();
  holder.release(); await holder.done;
  await bounded(pending, "retired final-write callback");
  assert.equal(f.saved(), rawB);
  assert.equal(f.memory.writes.length, writes);
});

for (const kind of ["signOut", "setSession", "verifyOtp"] as const)
test(`${kind}: actual operation SDK client is disposed before its promise settles`, async t => {
  const f = await fixture(t);
  // Spy on the public lifecycle method without replacing its implementation.
  const dispose = t.mock.method(sdk.AuthClient.prototype, "dispose");
  successful(await bounded(mutate(f, kind, f.freshScope().value), "native operation disposal"));
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(dispose.mock.calls[0].error, undefined);
  const cleanup = dispose.mock.calls[0].result;
  assert.ok(cleanup);
  await bounded(cleanup, "native operation dispose completed");
});

for (const event of ["PASSWORD_RECOVERY", "TOKEN_REFRESHED"] as const)
test(`observe preserves actual current native ${event} without callback lookup reentry`, async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t);
  const mark = observer.events.length;
  await nativeEvent(f, observer.auth, event);
  await until(() => observer.events.slice(mark).some(receipt => receipt.event === event), `current ${event} preserved`);
  await flush();
  assert.equal(observer.events.at(-1)?.event, event, "a prior writer lookup must not replace the native semantic event");
  assert.equal(observer.synchronousLookups(), 0);
  assertPersistedReceipts(observer.events);
});

for (const event of ["SIGNED_IN", "SIGNED_OUT", "PASSWORD_RECOVERY", "TOKEN_REFRESHED"] as const)
test(`observe rejects delayed native ${event} for A after B commits`, async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t, event);
  await nativeEvent(f, observer.auth, event);
  const payload = await bounded(observer.request, `actual ${event} captured`);
  assert.equal(payload?.user.id ?? null, event === "SIGNED_OUT" ? null : ids.A);
  const rawB = await f.commitB();
  await until(() => observer.events.at(-1)?.value?.user.id === ids.B, "B observed before delayed native delivery");
  const mark = observer.events.length;
  observer.release();
  await flush();
  assert.equal(f.saved(), rawB);
  assert.equal(observer.events.slice(mark).some(receipt => receipt.value?.user.id !== ids.B), false);
  if (event !== "SIGNED_IN") {
    assert.equal(observer.events.slice(mark).some(receipt => receipt.event === event), false,
      "obsolete event semantics cannot be transferred to B");
  }
  assert.equal(observer.synchronousLookups(), 0, "stale native callback cannot enter getSession synchronously");
  assertPersistedReceipts(observer.events);
});

for (const event of ["PASSWORD_RECOVERY", "TOKEN_REFRESHED"] as const)
test(`observe rejects delayed native ${event} after same-subject token rotation`, async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t, event);
  await nativeEvent(f, observer.auth, event, "older-native-token");
  const payload = await bounded(observer.request, "same-subject native event captured");
  const current = session("A", false, "newer-persisted-token");
  successful(await bounded(f.start(f.authority.setSession(current, f.freshScope().value)), "same-actor rotation committed"));
  await until(() => observer.events.at(-1)?.value?.access_token === current.access_token, "newer A token observed");
  const revision = f.memory.getItem(f.authority.revisionKey), mark = observer.events.length;
  assert.equal(payload?.user.id, current.user.id, "subject equality alone is insufficient");
  assert.notEqual(payload?.access_token, current.access_token);
  observer.release();
  await flush();
  assert.equal(f.memory.getItem(f.authority.revisionKey), revision);
  assert.equal(observer.events.slice(mark).some(receipt => receipt.event === event), false);
  assert.equal(observer.synchronousLookups(), 0);
  assertPersistedReceipts(observer.events);
});

test("stale native initial event resyncs a raw-only replacement outside SDK callback", async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t, "INITIAL_SESSION");
  await bounded(observer.request, "native initial A captured");
  // No local writer notification or simulated browser event accompanies this write.
  const rawB = JSON.stringify(session("B"));
  f.memory.setItem(f.authority.storageKey, rawB);
  observer.release();
  await until(() => observer.events.some(receipt => receipt.value?.user.id === ids.B), "stale event resync reads actual B");
  assert.equal(f.saved(), rawB);
  assert.equal(observer.synchronousLookups(), 0);
  assert.equal(observer.events.some(receipt => receipt.event === "INITIAL_SESSION"), false,
    "a stale initial event is not relabeled with B's payload");
  assertPersistedReceipts(observer.events);
});

test("delayed native null INITIAL_SESSION cannot clear a newly committed B", async t => {
  const f = await fixture(t);
  f.seed(null);
  const observer = await nativeObserver(f, t, "INITIAL_SESSION");
  assert.equal(await bounded(observer.request, "native empty initial session captured"), null);
  await f.commitB();
  await until(() => observer.events.at(-1)?.value?.user.id === ids.B, "newly committed B observed");
  const mark = observer.events.length;
  observer.release(); await flush();
  assert.equal(observer.events.slice(mark).some(receipt => receipt.value === null), false);
  assertPersistedReceipts(observer.events);
});

test("unsubscribe suppresses delayed native event and any deferred stale-event resync", async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t, "PASSWORD_RECOVERY");
  await nativeEvent(f, observer.auth, "PASSWORD_RECOVERY");
  await bounded(observer.request, "native recovery captured before cleanup");
  await f.commitB();
  await until(() => observer.events.at(-1)?.value?.user.id === ids.B, "B observed before cleanup");
  observer.unsubscribe();
  const before = [...observer.events], lookups = observer.getSession.mock.callCount();
  observer.release(); await flush();
  assert.deepEqual(observer.events, before);
  assert.equal(observer.getSession.mock.callCount(), lookups);
});

for (const event of ["PASSWORD_RECOVERY", "TOKEN_REFRESHED"] as const)
test(`late native initial delivery cannot replace already current ${event} semantics`, async t => {
  const f = await fixture(t), observer = await nativeObserver(f, t, "INITIAL_SESSION");
  const initial = await bounded(observer.request, "native initial event held before semantic event");
  if (event === "PASSWORD_RECOVERY") {
    assert.ok(initial);
    const response = f.http.hold("/verify", "transport", { status: 200, body: initial });
    response.release();
  }
  await nativeEvent(f, observer.auth, event);
  await until(() => observer.events.at(-1)?.event === event, "current native semantic event published");
  const before = [...observer.events], lookups = observer.getSession.mock.callCount();
  if (event === "PASSWORD_RECOVERY") {
    assert.equal(initial?.access_token, observer.events.at(-1)?.value?.access_token,
      "same raw identity still cannot make a late initial event supersede recovery");
  }
  observer.release(); await flush();
  assert.deepEqual(observer.events, before, "the current saved revision was already published with the proper native event");
  assert.equal(observer.getSession.mock.callCount(), lookups, "no resync is needed for an already observed revision");
  assert.equal(observer.synchronousLookups(), 0);
  assertPersistedReceipts(observer.events);
});

for (const event of ["PASSWORD_RECOVERY", "TOKEN_REFRESHED"] as const)
test(`duplicate storage recheck cannot replace current native ${event}`, async t => {
  const f = await fixture(t), dispatch = storageEvents(f, t), observer = await nativeObserver(f, t);
  await nativeEvent(f, observer.auth, event);
  await until(() => observer.events.at(-1)?.event === event, "native semantic event observed");
  const before = [...observer.events], revision = f.memory.getItem(f.authority.revisionKey);
  dispatch(); dispatch();
  await flush();
  assert.equal(f.memory.getItem(f.authority.revisionKey), revision);
  assert.deepEqual(observer.events, before, "same successful revision cannot synthesize a generic SIGNED_IN");
  assertPersistedReceipts(observer.events);
});

for (const failure of ["reject", "error result"] as const)
test(`latest lookup ${failure} quarantines published A without deleting B; same-snapshot retry restores B`, async t => {
  const f = await fixture(t), dispatch = storageEvents(f, t), observer = await f.observe();
  assert.equal(observer.events.at(-1)?.id, ids.A);
  const nativeLookup = observer.auth.getSession.bind(observer.auth);
  const SyntheticAuthError = frontendRequire("@supabase/supabase-js").AuthError;
  const lookup = t.mock.method(observer.auth, "getSession", async () => {
    await nativeLookup();
    if (failure === "reject") throw new Error("Synthetic native lookup completion failed");
    return { data: { session: null }, error: new SyntheticAuthError("Synthetic native read failed") };
  });
  const mark = observer.events.length, rawB = JSON.stringify(session("B"));
  f.authority.storage.setItem(f.authority.storageKey, rawB);
  const revision = f.memory.getItem(f.authority.revisionKey);
  await until(() => observer.events.slice(mark).some(receipt => receipt.event === "SIGNED_OUT" && receipt.id === null),
    "failed latest B lookup emits neutral receipt");
  assert.equal(f.saved(), rawB, "observer failure never removes B's persisted session");
  assert.equal(f.memory.getItem(f.authority.revisionKey), revision);
  lookup.mock.restore();
  dispatch();
  await until(() => observer.events.at(-1)?.id === ids.B, "successful same-snapshot retry recovers B");
  assert.equal(f.saved(), rawB);
  assert.equal(f.memory.getItem(f.authority.revisionKey), revision, "neutral quarantine is not a successful dedupe stamp");
  const before = [...observer.events];
  dispatch(); await flush();
  assert.deepEqual(observer.events, before, "a successfully verified retry is deduped thereafter");
  observer.unsubscribe();
  dispatch(); await flush();
  assert.deepEqual(observer.events, before);
});

test("malformed saved B identity quarantines published A and permits later legitimate native recovery", async t => {
  const f = await fixture(t), dispatch = storageEvents(f, t), observer = await nativeObserver(f, t);
  const b = session("B"), malformed = JSON.stringify({ ...b, user: { ...b.user, id: 17 } });
  assert.equal(observer.events.at(-1)?.value?.user.id, ids.A);
  const mark = observer.events.length;
  f.memory.setItem(f.authority.storageKey, malformed);
  dispatch();
  await until(() => observer.events.slice(mark).some(receipt => receipt.event === "SIGNED_OUT" && receipt.value === null),
    "malformed current identity emits neutral receipt");
  assert.equal(f.saved(), malformed, "quarantine does not mutate malformed storage either");
  const reply = f.http.hold("/verify", "transport", { status: 200, body: b });
  reply.release();
  successful(await bounded(f.start(observer.auth.verifyOtp({ token_hash: "synthetic-otp-B", type: "recovery" })), "legitimate recovery after quarantine"));
  await until(() => observer.events.at(-1)?.event === "PASSWORD_RECOVERY", "later legitimate semantic event preserved");
  assert.equal(observer.events.at(-1)?.value?.user.id, ids.B);
  assert.equal(observer.synchronousLookups(), 0);
});

test("snapshot read throw inside lookup rejection handling quarantines without an unhandled rejection", async t => {
  const f = await fixture(t), dispatch = storageEvents(f, t), observer = await f.observe();
  const nativeLookup = observer.auth.getSession.bind(observer.auth), getItem = f.memory.getItem.bind(f.memory);
  let unreadable = false;
  const storageRead = t.mock.method(f.memory, "getItem", (key: string) => {
    if (unreadable && key === f.authority.storageKey) throw new Error("Synthetic storage read unavailable");
    return getItem(key);
  });
  const lookup = t.mock.method(observer.auth, "getSession", async () => {
    await nativeLookup();
    unreadable = true;
    throw new Error("Synthetic latest lookup rejected before catch snapshot");
  });
  const rawB = JSON.stringify(session("B")), mark = observer.events.length;
  try {
    f.authority.storage.setItem(f.authority.storageKey, rawB);
    await until(() => observer.events.slice(mark).some(receipt => receipt.event === "SIGNED_OUT" && receipt.id === null),
      "unreadable error snapshot emits neutral receipt");
  } finally {
    unreadable = false; lookup.mock.restore(); storageRead.mock.restore();
  }
  assert.equal(f.saved(), rawB);
  dispatch();
  await until(() => observer.events.at(-1)?.id === ids.B, "readable same snapshot restores B");
  assert.equal(f.saved(), rawB);
});

for (const failure of ["reject", "error result"] as const)
test(`obsolete held lookup ${failure} cannot quarantine a newer verified B`, async t => {
  const f = await fixture(t), observer = await f.observe();
  const nativeLookup = observer.auth.getSession.bind(observer.auth), gate = f.gate(), entered = deferred<void>();
  const SyntheticAuthError = frontendRequire("@supabase/supabase-js").AuthError;
  let once = true;
  t.mock.method(observer.auth, "getSession", async () => {
    const result = await nativeLookup();
    if (!once) return result;
    once = false; entered.resolve(); await gate.promise;
    if (failure === "reject") throw new Error("Synthetic obsolete lookup failure");
    return { data: { session: null }, error: new SyntheticAuthError("Synthetic obsolete lookup error") };
  });
  f.seed(session("C"));
  await bounded(entered.promise, "obsolete native lookup held before failure");
  const rawB = await f.commitB();
  await until(() => observer.events.at(-1)?.id === ids.B, "newer B successfully verified");
  const before = [...observer.events];
  gate.resolve(); await flush();
  assert.deepEqual(observer.events, before);
  assert.equal(f.saved(), rawB);
});

test("native snapshot read throw defers neutral quarantine without throwing or logging to SDK", async t => {
  const f = await fixture(t), auth = await f.createReceiver();
  const subscribe = auth.onAuthStateChange.bind(auth), lookup = auth.getSession.bind(auth);
  const getItem = f.memory.getItem.bind(f.memory);
  let armed = false, unreadable = false, inNativeCallback = false, reentries = 0;
  let savedAtNative: string | null = null;
  const events: { event: AuthChangeEvent; id: string | null; inNativeCallback: boolean }[] = [];
  const logs = t.mock.method(console, "error", () => {});
  const storageRead = t.mock.method(f.memory, "getItem", (key: string) => {
    if (unreadable && key === f.authority.storageKey) throw new Error("Synthetic native snapshot unavailable");
    return getItem(key);
  });
  t.mock.method(auth, "getSession", () => {
    if (inNativeCallback) reentries++;
    return lookup();
  });
  t.mock.method(auth, "onAuthStateChange", (callback: NativeCallback) => subscribe((event, value) => {
    if (armed && event === "PASSWORD_RECOVERY") {
      armed = false; savedAtNative = getItem(f.authority.storageKey); unreadable = true;
    }
    inNativeCallback = true;
    try { callback(event, value); } finally { inNativeCallback = false; }
  }));
  const subscription = f.authority.observe(auth, (event, value) => {
    events.push({ event, id: value?.user.id ?? null, inNativeCallback });
  }).data.subscription;
  f.subscriptions.push(subscription);
  await until(() => events.at(-1)?.id === ids.A, "private A published before native storage failure");
  const mark = events.length;
  armed = true;
  try {
    successful(await bounded(f.start(auth.verifyOtp({ token_hash: "synthetic-otp-B", type: "recovery" })), "actual native recovery completes without observer error"));
    await until(() => events.slice(mark).some(receipt => receipt.event === "SIGNED_OUT" && receipt.id === null),
      "native snapshot failure emits deferred neutral receipt");
    assert.ok(events.slice(mark).every(receipt => !receipt.inNativeCallback));
    assert.equal(reentries, 0);
    assert.equal(logs.mock.callCount(), 0, "observer read errors never escape to SDK logging");
  } finally {
    unreadable = false; storageRead.mock.restore();
  }
  assert.equal(f.saved(), savedAtNative, "neutral quarantine does not remove B written by the real native SDK");
  assert.equal(f.savedSubject(), ids.B);
  successful(await bounded(f.start(auth.verifyOtp({ token_hash: "synthetic-otp-B", type: "recovery" })), "later legitimate native event after storage recovery"));
  assert.equal(events.at(-1)?.event, "PASSWORD_RECOVERY");
  assert.equal(events.at(-1)?.id, ids.B);
  assert.equal(logs.mock.callCount(), 0);
});

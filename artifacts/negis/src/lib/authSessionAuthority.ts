import {
  AuthClient, type AuthChangeEvent, type Session, type LockFunc,
  type SignInWithPasswordCredentials, type SignUpWithPasswordCredentials,
  type VerifyOtpParams, type SignOut,
} from '@supabase/supabase-js';

export interface AuthStamp { revision: string | null; intent: string | null }
export interface AuthMutationScope {
  isCurrent(): boolean;
  signal?: AbortSignal;
  expected?: AuthStamp;
  expectedUserId?: string | null;
  onReceipt?(stamp: AuthStamp): void;
}
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export class StaleAuthIntentError extends Error {
  constructor() { super('Попытка входа больше не актуальна. Повторите действие.'); }
}
type Snapshot = { raw: string | null; revision: string | null };
type NativeAuthClient = InstanceType<typeof AuthClient>;
type AuthReceiver = Pick<NativeAuthClient, 'getSession' | 'onAuthStateChange'>;
type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
interface AuthorityOptions {
  url: string;
  key: string;
  storage: SessionStorage;
  lock: LockFunc;
  fetch?: typeof globalThis.fetch;
  nonce?: () => string;
  timeoutMs?: number;
}

/** Public SDK storage/lock adapters. Session bytes stay inside the original storage boundary. */
export function createAuthSessionAuthority(options: AuthorityOptions) {
  const url = options.url.replace(/\/$/, '');
  const storageKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  const revisionKey = `${storageKey}.medina-revision`;
  const intentKey = `${storageKey}.medina-intent`;
  const lockName = `lock:${storageKey}`;
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<(event?: AuthChangeEvent) => void>();
  let sequence = 0;
  const snapshot = (): Snapshot => ({ raw: options.storage.getItem(storageKey), revision: options.storage.getItem(revisionKey) });
  const equal = (a: Snapshot, b: Snapshot) => a.raw === b.raw && a.revision === b.revision;
  const capture = (): AuthStamp => ({ revision: options.storage.getItem(revisionKey), intent: options.storage.getItem(intentKey) });
  const isCurrent = (stamp: AuthStamp) => { const now = capture(); return now.revision === stamp.revision && now.intent === stamp.intent; };
  const notify = (event?: AuthChangeEvent) => { for (const listener of [...listeners]) listener(event); };
  const saveStorage = (key: string, value: string, event?: AuthChangeEvent) => {
    if (key === storageKey) options.storage.setItem(revisionKey, nonce());
    options.storage.setItem(key, value);
    if (key === storageKey) notify(event);
  };
  const storage: SessionStorage = {
    getItem: key => options.storage.getItem(key),
    setItem(key, value) {
      saveStorage(key, value);
    },
    removeItem(key) {
      if (key === storageKey) options.storage.setItem(revisionKey, nonce());
      options.storage.removeItem(key);
      if (key === storageKey) notify();
    },
  };
  const callerCurrent = (scope: AuthMutationScope) => {
    try { return !scope.signal?.aborted && scope.isCurrent(); } catch { return false; }
  };

  async function run<T>(scope: AuthMutationScope, perform: (client: NativeAuthClient) => Promise<T>, event?: AuthChangeEvent): Promise<T> {
    if (!callerCurrent(scope)) throw new StaleAuthIntentError();
    const original = snapshot();
    if (scope.expected && !isCurrent(scope.expected)) throw new StaleAuthIntentError();
    if ('expectedUserId' in scope) {
      let actor: string | null = null;
      try { actor = original.raw === null ? null : JSON.parse(original.raw).user.id; } catch { throw new StaleAuthIntentError(); }
      if (actor !== scope.expectedUserId) throw new StaleAuthIntentError();
    }
    const id = ++sequence, abort = new AbortController();
    const cancel = () => abort.abort();
    scope.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, options.timeoutMs ?? 30_000);
    let client: NativeAuthClient | null = null;
    const privateKeys = new Map<string, string>();
    let expected: Snapshot | null = null, intent: string | null = null, changed = false, completed = false;
    const assertCurrent = (allowCommittedReceipt = false) => {
      // Publishing our own committed session can unmount the originating form.
      // Its receipt remains usable only while the exact committed revision lives.
      // A receipt cannot authorize another remote dispatch or shared write.
      if (sequence !== id || ((!changed || !allowCommittedReceipt) && (abort.signal.aborted || !callerCurrent(scope)))
        || !expected || options.storage.getItem(intentKey) !== intent || !equal(snapshot(), expected)) throw new StaleAuthIntentError();
    };
    try {
      await options.lock(lockName, 5_000, async () => {
        if (sequence !== id || abort.signal.aborted || !callerCurrent(scope)) throw new StaleAuthIntentError();
        if (!equal(snapshot(), original) || (scope.expected && !isCurrent(scope.expected))) throw new StaleAuthIntentError();
        intent = nonce(); options.storage.setItem(intentKey, intent);
        expected = original;
      });
      assertCurrent();
      const operationKey = `medina-auth-operation-${nonce()}`;
      const scopedStorage = {
        getItem(key: string) {
          assertCurrent(true);
          return key === operationKey ? expected!.raw : privateKeys.get(key) ?? null;
        },
        async setItem(key: string, value: string) {
          if (key !== operationKey) { assertCurrent(true); privateKeys.set(key, value); return; }
          await options.lock(lockName, 5_000, async () => {
            assertCurrent();
            saveStorage(storageKey, value, event);
            expected = snapshot(); changed = true;
          });
        },
        async removeItem(key: string) {
          if (key !== operationKey) { assertCurrent(true); privateKeys.delete(key); return; }
          await options.lock(lockName, 5_000, async () => {
            assertCurrent();
            storage.removeItem(storageKey);
            expected = snapshot(); changed = true;
          });
        },
      };
      client = new AuthClient({
        url: `${url}/auth/v1`, headers: { apikey: options.key, Authorization: `Bearer ${options.key}` },
        storageKey: operationKey, storage: scopedStorage, persistSession: true,
        autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true,
        async fetch(input, init) {
          const target = new URL(String(input));
          const method = (init?.method ?? 'GET').toUpperCase();
          const allowed = target.origin === new URL(url).origin
            && ((method === 'POST' && ['/token', '/signup', '/verify', '/logout'].some(path => target.pathname === `/auth/v1${path}`))
              || (method === 'PUT' && target.pathname === '/auth/v1/user')
              || (method === 'GET' && target.pathname === '/auth/v1/user'));
          if (!allowed) throw new Error('Auth transport refused');
          try { assertCurrent(); } catch {
            return Response.json({ code: 'request_cancelled', msg: 'Auth attempt retired' }, { status: 409 });
          }
          try {
            return await transport(input, { ...init, signal: abort.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
          } catch {
            return Response.json({ code: 'auth_transport_unavailable', msg: 'Auth transport unavailable' }, { status: abort.signal.aborted ? 409 : 503 });
          }
        },
      });
      const result = await perform(client);
      assertCurrent(true);
      completed = true;
      return result;
    } finally {
      clearTimeout(timer);
      scope.signal?.removeEventListener('abort', cancel);
      try {
        await client?.dispose();
        if (completed) {
          assertCurrent(true);
          scope.onReceipt?.(capture());
          assertCurrent(true);
        }
      } finally { abort.abort(); privateKeys.clear(); expected = null; }
    }
  }

  function observe(auth: AuthReceiver, callback: AuthCallback) {
    let alive = true, revision = 0;
    let published: Snapshot | undefined;
    const persisted = (state: Snapshot): Session | null | undefined => {
      if (state.raw === null) return null;
      try {
        const session = JSON.parse(state.raw) as Session | null;
        return session && typeof session.user?.id === 'string'
          && typeof session.access_token === 'string' && typeof session.refresh_token === 'string'
          ? session : undefined;
      } catch { return undefined; }
    };
    const sameIdentity = (session: Session | null, current: Session | null) => {
      if (!session || !current) return session === current;
      return session.user?.id === current.user.id && session.access_token === current.access_token
        && session.refresh_token === current.refresh_token;
    };
    const recheck = (event?: AuthChangeEvent) => {
      if (!alive) return;
      const ticket = ++revision;
      void (async () => {
        let before: Snapshot | undefined, after: Snapshot | undefined;
        let current: Session | null | undefined, failed = false;
        try {
          before = snapshot();
          const { data, error } = await auth.getSession();
          if (!alive || ticket !== revision) return;
          after = snapshot();
          if (!equal(before, after)) { recheck(); return; }
          current = persisted(after);
          failed = !!error || current === undefined || !sameIdentity(data.session, current);
        } catch {
          if (!alive || ticket !== revision) return;
          try {
            after = snapshot();
            if (before && !equal(before, after)) { recheck(); return; }
          } catch { /* Unreadable storage must also quarantine the previous private session. */ }
          failed = true;
        }
        if (!alive || ticket !== revision) return;
        if (failed || !after || current === undefined) {
          published = undefined;
          callback('SIGNED_OUT', null);
          return;
        }
        if (published && equal(published, after)) return;
        published = after;
        callback(current ? event ?? 'SIGNED_IN' : 'SIGNED_OUT', current);
      })();
    };
    const native = auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      const ticket = revision;
      const deferRecheck = () => {
        queueMicrotask(() => { if (alive && ticket === revision) recheck(); });
      };
      let before: Snapshot, current: Session | null | undefined;
      try {
        before = snapshot(); current = persisted(before);
        if ((event === 'INITIAL_SESSION' && published) || current === undefined
          || !sameIdentity(session, current) || !equal(before, snapshot())) {
          if (published && equal(before, published)) return;
          // Native delivery can outlive its saved session. Re-enter the SDK only
          // after returning from its callback, without transferring event semantics.
          deferRecheck();
          return;
        }
      } catch {
        deferRecheck();
        return;
      }
      revision++; published = before; callback(event, current);
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === revisionKey || event.key === null) recheck();
    };
    listeners.add(recheck);
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return { data: { subscription: { unsubscribe() {
      alive = false; revision++; listeners.delete(recheck);
      native.data.subscription.unsubscribe();
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    } } } };
  }

  return {
    storageKey, revisionKey, intentKey, storage, observe, capture, isCurrent,
    signInWithPassword: (credentials: SignInWithPasswordCredentials, scope: AuthMutationScope) => run(scope, client => client.signInWithPassword(credentials)),
    signUp: (credentials: SignUpWithPasswordCredentials, scope: AuthMutationScope) => run(scope, client => client.signUp(credentials)),
    setSession: (session: { access_token: string; refresh_token: string }, scope: AuthMutationScope) => run(scope, client => client.setSession(session)),
    verifyOtp: (params: VerifyOtpParams, scope: AuthMutationScope) => run(scope, client => client.verifyOtp(params)),
    updateUserPassword: (password: string, scope: AuthMutationScope) => run(scope, client => client.updateUser({ password }), 'USER_UPDATED'),
    signOut: (scope: AuthMutationScope, settings?: SignOut) => run(scope, client => client.signOut(settings)),
  };
}

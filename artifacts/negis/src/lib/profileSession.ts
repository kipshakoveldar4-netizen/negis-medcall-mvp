import { AuthClient, type Session, type UserAttributes } from '@supabase/supabase-js';

type ProfileSession = Pick<Session, 'access_token' | 'refresh_token' | 'user'>;

export class StaleProfileSessionError extends Error {
  constructor() { super('Profile session is no longer current'); }
}

/** A lifetime fence, not JWT authentication. Token refresh preserves session_id. */
export function profileSessionIdentity(session: ProfileSession | null): string {
  if (!session?.user?.id) return '';
  try {
    const part = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part));
    if (typeof claims.session_id === 'string' && claims.session_id) return `${session.user.id}:${claims.session_id}`;
  } catch { /* An older session without session_id is fenced by SDK events too. */ }
  return session.user.id;
}

/** Never let an SDK's asynchronous session lookup select another account. */
export async function updateProfileForSession(
  session: ProfileSession,
  updates: Pick<UserAttributes, 'data' | 'password'>,
  isCurrent: () => boolean,
  signal: AbortSignal,
) {
  const assertCurrent = () => {
    if (signal.aborted || !isCurrent()) throw new StaleProfileSessionError();
  };
  assertCurrent();
  const env = import.meta.env as Record<string, string | undefined>;
  const url = env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const key = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
  if (!url || !key || !session.access_token || !session.refresh_token || !session.user.id) {
    throw new Error('Profile session is unavailable');
  }
  const actor = session.user.id;
  const credentials = { access_token: session.access_token, refresh_token: session.refresh_token };
  const transport = globalThis.fetch.bind(globalThis);
  const endpoint = `${url}/auth/v1/user`;
  const client = new AuthClient({
    url: `${url}/auth/v1`, headers: { apikey: key },
    storageKey: `medina-profile-${crypto.randomUUID()}`,
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    // Public SDK option: no URL processing, visibility listeners or recovery.
    skipAutoInitialize: true,
    fetch(input, init) {
      const headers = new Headers(init?.headers);
      const method = init?.method?.toUpperCase();
      if (String(input) !== endpoint || !['GET', 'PUT'].includes(method ?? '')
        || headers.get('Authorization') !== `Bearer ${credentials.access_token}`) {
        // In particular, never refresh a token or reauthenticate this client.
        throw new Error('Profile session transport refused');
      }
      headers.set('apikey', key);
      assertCurrent();
      // No await between the final guard and dispatch. A request already issued
      // for A may still finish after an abort; it can never be retargeted to B.
      return transport(input, { ...init, headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    },
  });
  try {
    const bound = await client.setSession(credentials);
    assertCurrent();
    if (bound.error) throw bound.error;
    if (bound.data.user?.id !== actor) throw new StaleProfileSessionError();
    const result = await client.updateUser(updates);
    assertCurrent();
    if (result.error) throw result.error;
    if (result.data.user?.id !== actor) throw new StaleProfileSessionError();
    return result.data.user;
  } finally {
    credentials.access_token = '';
    credentials.refresh_token = '';
    await client.stopAutoRefresh();
    // The SDK owns only ephemeral memory: no shared session, storage,
    // BroadcastChannel or listeners are updated by this isolated operation.
  }
}

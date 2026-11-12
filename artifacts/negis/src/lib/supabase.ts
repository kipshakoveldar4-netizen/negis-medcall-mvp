import { createClient, navigatorLock, processLock, type LockFunc } from '@supabase/supabase-js'
import { createAuthSessionAuthority, type AuthStamp } from './authSessionAuthority'

const env = import.meta.env as Record<string, string | undefined>
const configuredSupabaseUrl = env.VITE_SUPABASE_URL
const configuredSupabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
const supabaseUrl = configuredSupabaseUrl || 'https://placeholder.supabase.co'
const supabaseAnonKey = configuredSupabaseAnonKey || 'placeholder'

/** Legacy URL hint captured before the SDK erases the fragment. Not recovery authority. */
export const arrivedByRecoveryLink = (() => {
  if (typeof window === 'undefined') return false
  const raw = `${window.location.hash || ''}${window.location.search || ''}`
  return raw.includes('type=recovery')
})()

const sharedLock: LockFunc = (name, timeout, callback) => globalThis.navigator?.locks
  ? navigatorLock(name, timeout, callback) : processLock(name, timeout, callback)
const memory = new Map<string, string>()
const authority = createAuthSessionAuthority({ url: supabaseUrl, key: supabaseAnonKey,
  storage: {
    getItem: key => typeof window === 'undefined' ? memory.get(key) ?? null : window.localStorage.getItem(key),
    setItem: (key, value) => { if (typeof window === 'undefined') memory.set(key, value); else window.localStorage.setItem(key, value) },
    removeItem: key => { if (typeof window === 'undefined') memory.delete(key); else window.localStorage.removeItem(key) },
  },
  lock: (name, timeout, callback) => {
    if (!globalThis.navigator?.locks) return Promise.reject(new Error('Безопасная смена аккаунта недоступна в этом браузере.'))
    return sharedLock(name, timeout, callback)
  },
})
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey: authority.storageKey, storage: authority.storage, lock: sharedLock },
})

export type RecoverySessionProof = Readonly<{ id: string; actorId: string; stamp: AuthStamp; expiresAt: number }>
let recovery: { id: string; actorId: string; revision: string | null; access: string; refresh: string; expiresAt: number } | null = null
const recoveryObserver = authority.observe(supabase.auth, (event, session) => {
  let stamp: AuthStamp
  try { stamp = authority.capture() } catch { recovery = null; return }
  if (event === 'PASSWORD_RECOVERY' && session) {
    const expiresAt = Math.min((session.expires_at ?? 0) * 1000, Date.now() + 15 * 60_000)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { recovery = null; return }
    recovery = { id: crypto.randomUUID(), actorId: session.user.id, revision: stamp.revision,
      access: session.access_token, refresh: session.refresh_token, expiresAt }
    return
  }
  if (!recovery) return
  if (!session || session.user.id !== recovery.actorId
    || (event !== 'TOKEN_REFRESHED' && (session.access_token !== recovery.access || session.refresh_token !== recovery.refresh))) {
    recovery = null
    return
  }
  recovery = { ...recovery, revision: stamp.revision, access: session.access_token, refresh: session.refresh_token }
})

// A URL marker is not recovery authority. Only the observed native event issues this receipt.
export function getRecoverySessionProof(): RecoverySessionProof | null {
  if (!recovery) return null
  try {
    if (Date.now() >= recovery.expiresAt) { recovery = null; return null }
    const stamp = authority.capture()
    return stamp.revision === recovery.revision ? { id: recovery.id, actorId: recovery.actorId, stamp, expiresAt: recovery.expiresAt } : null
  } catch { return null }
}
export function consumeRecoverySessionProof(id: string): void {
  if (recovery?.id === id) recovery = null
}
export const sessionAuth = {
  signInWithPassword: authority.signInWithPassword, signUp: authority.signUp,
  signOut: authority.signOut, setSession: authority.setSession, verifyOtp: authority.verifyOtp,
  updateUserPassword: authority.updateUserPassword,
  capture: authority.capture, isCurrent: authority.isCurrent,
  onAuthStateChange: (callback: Parameters<typeof authority.observe>[1]) => authority.observe(supabase.auth, callback),
  dispose() { recoveryObserver.data.subscription.unsubscribe(); recovery = null },
}
if (import.meta.hot) import.meta.hot.dispose(() => { sessionAuth.dispose(); void supabase.auth.dispose() })
export const hasSupabaseFrontendEnv = Boolean(configuredSupabaseUrl && configuredSupabaseAnonKey)

/** Три исхода проверки пароля. «Не знаю» — отдельный исход, а не «неверный». */
export type PasswordCheck = 'ok' | 'wrong' | 'unavailable'

/**
 * Проверка текущего пароля перед сменой — прямым запросом к GoTrue, без
 * второго клиента Supabase.
 *
 * Почему не signInWithPassword на основном клиенте: удачный вход подменил бы
 * активную сессию и поднял onAuthStateChange, а тот перечитывает членства —
 * человека с двумя клиниками выбросило бы в выбор клиники посреди диалога.
 *
 * Почему не отдельный клиент: каждый GoTrueClient в браузере вешает слушателя
 * visibilitychange и не снимает его, а создавать клиент на каждое нажатие
 * «Сохранить» — это утечка слушателей и предупреждение «Multiple GoTrueClient
 * instances» в консоли продакшена.
 *
 * И главное: голый fetch отдаёт КОД ОТВЕТА. Клиент возвращал один и тот же
 * error на неверный пароль, на обрыв сети и на 429 — и всё это показывалось
 * как «текущий пароль неверный». Мастер на моргающем Wi-Fi решал, что забыл
 * свой пароль, и шёл за сбросом.
 */
export async function verifyCurrentPassword(email: string, password: string): Promise<PasswordCheck> {
  if (!hasSupabaseFrontendEnv) return 'unavailable'
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
      body: JSON.stringify({ email, password }),
    })
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { access_token?: string } | null
      // Сессия, созданная ИСКЛЮЧИТЕЛЬНО чтобы сверить пароль, не должна
      // пережить проверку. scope=local гасит только её: глобальный выход
      // завершил бы и рабочую сессию человека.
      if (body?.access_token) {
        await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
          method: 'POST',
          headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${body.access_token}` },
        }).catch(() => undefined)
      }
      return 'ok'
    }
    // 400/401 — GoTrue отвечает так именно на неверные учётные данные.
    if (response.status === 400 || response.status === 401) return 'wrong'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

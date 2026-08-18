import { createClient } from '@supabase/supabase-js'

const env = import.meta.env as Record<string, string | undefined>
const configuredSupabaseUrl = env.VITE_SUPABASE_URL
const configuredSupabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
const supabaseUrl = configuredSupabaseUrl || 'https://placeholder.supabase.co'
const supabaseAnonKey = configuredSupabaseAnonKey || 'placeholder'

/**
 * Пришли ли мы по ссылке восстановления пароля.
 *
 * Снимается ДО createClient и на уровне модуля намеренно: клиент разбирает хеш
 * адреса и стирает его через history.replaceState, поэтому к моменту, когда
 * страница смены пароля смонтируется, отличить настоящее восстановление от
 * просто живой сессии по адресу уже нельзя.
 *
 * Это не косметика. Страница /reset-password открывала форму нового пароля по
 * ЛЮБОЙ живой сессии, а под имперсонацией живая сессия принадлежит владельцу
 * клиники — сотруднику платформы достаточно было набрать адрес, чтобы сменить
 * владельцу пароль от его глобального аккаунта.
 */
export const arrivedByRecoveryLink = (() => {
  if (typeof window === 'undefined') return false
  const raw = `${window.location.hash || ''}${window.location.search || ''}`
  return raw.includes('type=recovery')
})()

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
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

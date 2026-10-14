type ControlConfig =
  | { ready: false; error: string }
  | { ready: true; apiOrigin: string; supabaseUrl: string; anonKey: string };

function origin(raw: string, development: boolean): string | null {
  // Reject syntax that URL would silently repair or normalize into an origin.
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(development && loopback && url.protocol === "http:")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publicKey(key: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).role === "anon";
  } catch {
    return false;
  }
}

export function resolveControlConfig(
  env: Record<string, string | undefined>,
  development = false,
): ControlConfig {
  const mode = env.VITE_MEDINA_CONTROL_MODE?.trim() || "";
  if (mode && mode !== "isolated-preview") return { ready: false, error: "Неизвестный режим портала." };
  const apiOrigin = origin(env.VITE_MEDINA_API_URL?.trim() || "", development);
  const supabaseUrl = origin(env.VITE_SUPABASE_URL?.trim() || "", development);
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim() || "";
  if (!apiOrigin || !supabaseUrl || !publicKey(anonKey)) {
    return { ready: false, error: "Портал не настроен: проверьте адрес API, адрес базы и публичный ключ." };
  }
  if (development && mode !== "isolated-preview") {
    const loopback = (value: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
    if (!loopback(apiOrigin) || !loopback(supabaseUrl)) {
      return { ready: false, error: "Для локального портала выберите изолированный тестовый режим или локальные API и базу." };
    }
  }
  if (mode === "isolated-preview") {
    // Only immutable previews of the existing project may use the dedicated test database.
    const previewHost = /^negis-medcall-mvp-api-server-[a-z0-9]{9}-yeldar-s-projects\.vercel\.app$/;
    const api = new URL(apiOrigin);
    if (supabaseUrl !== "https://ukiobbwsdoblooynzlnx.supabase.co"
      || api.protocol !== "https:" || api.port || !previewHost.test(api.hostname)) {
      return { ready: false, error: "Тестовый портал заблокирован: адрес API или база не соответствуют тестовой среде." };
    }
  }
  return { ready: true, apiOrigin, supabaseUrl, anonKey };
}

export function resolveControlBrowserEnv(
  env: Record<string, string | undefined>,
  development = false,
): Record<string, string> {
  const config = resolveControlConfig(env, development);
  return {
    VITE_MEDINA_CONTROL_MODE: config.ready ? env.VITE_MEDINA_CONTROL_MODE?.trim() || "" : "",
    VITE_MEDINA_API_URL: config.ready ? config.apiOrigin : "",
    VITE_SUPABASE_URL: config.ready ? config.supabaseUrl : "",
    VITE_SUPABASE_ANON_KEY: config.ready ? config.anonKey : "",
  };
}

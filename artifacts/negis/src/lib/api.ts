const appBasePath = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const configuredApiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "";

export const API_BASE_URL = configuredApiBase || appBasePath;

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function publicApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = configuredApiBase || `${window.location.origin}${appBasePath}`;
  return `${base}${normalizedPath}`;
}

// Security-2B: every /api/crm/* request is authenticated server-side, so the
// browser must attach the current Supabase access token. The token goes in the
// Authorization header only — never in the URL, never in a log line.

export class CrmApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CrmApiError";
    this.status = status;
    this.code = code;
  }
}

/** Russian copy for the states a clinic user can actually hit. */
export function crmErrorMessage(error: unknown): string {
  if (!(error instanceof CrmApiError)) return "Не удалось загрузить данные. Попробуйте позже.";
  if (error.status === 401) return "Сессия истекла. Войдите снова.";
  if (error.status === 403) return "Недостаточно прав для этого действия.";
  if (error.status === 404) return "Запись не найдена.";
  if (error.status === 503) return "Сервис авторизации временно недоступен. Попробуйте позже.";
  return "Не удалось выполнить запрос. Попробуйте позже.";
}

type CrmFetchInit = RequestInit & { accessToken?: string };

/**
 * Resolves the current access token from the Supabase session.
 *
 * Deliberately a low-level lookup rather than a React context read: AuthContext
 * itself calls the CRM API during bootstrap, and importing it here would close
 * a dependency cycle. Nothing is cached, so a rotated or cleared session takes
 * effect on the very next request.
 */
async function resolveAccessToken(explicit?: string): Promise<string> {
  const provided = (explicit || "").trim();
  if (provided) return provided;

  const { getSupabaseAccessToken } = await import("@/lib/serverAuth");
  return (await getSupabaseAccessToken()).trim();
}

/**
 * Concurrent identical GETs share one network request.
 *
 * Measured on production: the auth bootstrap fired /api/crm/auth-context three
 * times in a 15ms window (three serverless invocations, 1.4–4.3s each), and
 * the clients page issued the same list read twice more — every page paid for
 * its data several times over, which is most of what "переход подвисает" was.
 *
 * Only GET is deduplicated, and only while the request is in flight: a write
 * must never be swallowed by another write, and sequential reads (polling) are
 * untouched because the entry is gone by the time the next one starts. The key
 * includes the token so two sessions can never share a response. Followers get
 * clone()s, so each caller still reads its own body.
 */
const inflightGets = new Map<string, Promise<Response>>();

/**
 * Single entry point for CRM requests. Without a token the request is not sent
 * at all: an unauthenticated call would only come back as 401, and firing it
 * anyway invites retry loops.
 */
export async function crmFetch(path: string, init: CrmFetchInit = {}): Promise<Response> {
  const { accessToken, headers, ...rest } = init;
  const token = await resolveAccessToken(accessToken);
  if (!token) {
    throw new CrmApiError(401, "authentication_required", "Authentication required");
  }

  // Built from scratch so a caller cannot smuggle in its own Authorization.
  const mergedHeaders = new Headers(headers);
  mergedHeaders.delete("Authorization");
  mergedHeaders.set("Authorization", `Bearer ${token}`);

  const method = (rest.method || "GET").toUpperCase();
  if (method !== "GET") {
    return fetch(apiUrl(path), { ...rest, headers: mergedHeaders });
  }

  const dedupeKey = `${path}::${token}`;
  const pending = inflightGets.get(dedupeKey);
  if (pending) {
    return pending.then((response) => response.clone());
  }

  const request = fetch(apiUrl(path), { ...rest, headers: mergedHeaders });
  inflightGets.set(dedupeKey, request);
  request
    .catch(() => undefined)
    .finally(() => {
      inflightGets.delete(dedupeKey);
    });
  return request.then((response) => response.clone());
}

/** crmFetch + crmJson in one call, for the common read path. */
export async function crmRequest<T = unknown>(path: string, init: CrmFetchInit = {}): Promise<T> {
  const response = await crmFetch(path, init);
  return crmJson<T>(response);
}

/** Parses a CRM response, turning auth failures into typed errors. */
export async function crmJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;

  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "request_failed";
    const message = typeof body?.error === "string" ? body.error : "Request failed";
    throw new CrmApiError(response.status, code, message);
  }

  return body as T;
}

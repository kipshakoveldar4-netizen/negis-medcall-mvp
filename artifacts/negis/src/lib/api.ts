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
  // Принимает и брошенную ошибку, и просто код ответа. Второе — потому что
  // crmFetch не бросает на 4xx/5xx: вызывающий держит статус в руках и без
  // этого писал бы собственный набор строк, расходящийся с этим по смыслу.
  const status = error instanceof CrmApiError
    ? error.status
    : (typeof error === "number" ? error : null);
  if (status === null) return "Не удалось загрузить данные. Попробуйте позже.";
  if (status === 401) return "Сессия истекла. Войдите снова.";
  if (status === 403) return "Недостаточно прав для этого действия.";
  if (status === 404) return "Запись не найдена.";
  if (status === 503) return "Сервис авторизации временно недоступен. Попробуйте позже.";
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
 * A short-lived cache for answers that already came back, layered on top of the
 * in-flight dedupe above. The dedupe only helps callers that overlap in time;
 * this helps the user who walks between pages.
 *
 * Measured on production 2026-08-06, warm cache, real clicks in the sidebar:
 * entering /leads fired four reads in parallel — leads 665ms, lead-sources
 * 1189ms, meta-launches 1225ms, lead-stages 1262ms — and the page showed
 * nothing until the slowest returned. Leaving to /clients and coming back a few
 * seconds later paid the full price again (leads 566ms, lead-sources 570ms,
 * lead-stages 1149ms, meta-launches 1395ms): no answer survived a navigation.
 * The main thread was never blocked (zero long tasks) and the route chunk is
 * 9.6kB gzipped, so what the owner called «подвисает при переходе» was, in
 * full, waiting for the network.
 *
 * In memory only, deliberately: this is a medical CRM and patient rows must not
 * be left in localStorage. The map dies with the tab.
 *
 * Tenant and session isolation come from the key, not from a check: the token
 * is part of it, and workspaceId travels in the path, so neither a second
 * session nor a second clinic can read an entry that is not theirs.
 */
type CachedGet = { at: number; status: number; body: string; contentType: string };

const getCache = new Map<string, CachedGet>();

/** Reference rows a clinic edits perhaps monthly — the funnel's own skeleton. */
const REFERENCE_TTL_MS = 5 * 60_000;
/** Everything else: long enough to make going back instant, short enough that
 *  a lead filed on another device shows up on the next visit. */
const LIST_TTL_MS = 10_000;

/**
 * Two endpoints must always hit the network.
 *
 * `video-jobs` is polled on a timer while a render runs (AdsAutomation.tsx:1697)
 * and a cached answer would freeze the progress card. `auth-context` decides
 * what the user may see, so a revoked membership has to take effect on the very
 * next navigation rather than up to ten seconds later.
 */
function isUncacheable(path: string): boolean {
  // `change-log` is the third. A write clears this cache at the moment the
  // request starts, not when the server answers, and the browser's own update
  // is optimistic — so a history reopened right after an edit would race the
  // row it is meant to describe and could be served the answer from before it.
  // Ten seconds of a stale timeline is exactly the ten seconds an operator
  // spends checking that their change took.
  // `video-generation` — четвёртый, и по той же причине, что `video-jobs`:
  // это опрос рендера по таймеру. Ответ, переживший десять секунд, показал бы
  // застывший процент, а на последнем шаге — «ещё рендерится» вместо готовой
  // ссылки. Интервал опроса сейчас больше времени жизни кэша, но полагаться на
  // это соотношение нельзя: оно меняется правкой константы в другом файле.
  return (
    path.includes("/video-jobs") ||
    path.includes("/video-generation") ||
    path.includes("/auth-context") ||
    path.includes("/change-log")
  );
}

function ttlFor(path: string): number {
  // `staff` joins the funnel's skeleton here: the lead card reads it to name the
  // colleague a lead is assigned to, and a clinic's roster changes about as
  // often as its stages do.
  // `clinic-services` joins them for the same reason: the booking form reads the
  // price list every time it opens, and a clinic edits that list about as often
  // as it edits its stages.
  return /\/(lead-stages|lead-sources|staff|clinic-services|clinic-doctors|doctor-schedule)\b/.test(path) ? REFERENCE_TTL_MS : LIST_TTL_MS;
}

/**
 * Drops every cached answer. Called on sign-out and when the operator switches
 * clinic, so nothing from the previous session or tenant can be painted.
 */
export function clearCrmCache(): void {
  getCache.clear();
}

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
    // A write can change anything the cache is holding, and guessing which
    // entries it touched is how stale rows reach a patient card. Drop all.
    clearCrmCache();
    return fetch(apiUrl(path), { ...rest, headers: mergedHeaders });
  }

  const dedupeKey = `${path}::${token}`;
  const cacheable = !isUncacheable(path);

  if (cacheable) {
    const hit = getCache.get(dedupeKey);
    if (hit && Date.now() - hit.at < ttlFor(path)) {
      return new Response(hit.body, {
        status: hit.status,
        headers: { "content-type": hit.contentType },
      });
    }
  }

  const pending = inflightGets.get(dedupeKey);
  if (pending) {
    return pending.then((response) => response.clone());
  }

  const request = fetch(apiUrl(path), { ...rest, headers: mergedHeaders });
  inflightGets.set(dedupeKey, request);
  request
    .then(async (response) => {
      // Only a confirmed answer is worth keeping. A 401 or a 502 cached for ten
      // seconds would turn one bad moment into a stuck screen.
      if (!cacheable || !response.ok) return;
      const body = await response.clone().text();
      getCache.set(dedupeKey, {
        at: Date.now(),
        status: response.status,
        body,
        contentType: response.headers.get("content-type") || "application/json",
      });
    })
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

import { controlConfig, supabase } from "./supabase";
import type { Session } from "@supabase/supabase-js";

// Портал ходит в существующий API продукта на его домене. Адрес задаётся
// переменной сборки; без проверенной конфигурации запросы запрещены.
// Токен — только в заголовке Authorization: не в адресе и не в логе.

export const API_BASE_URL = controlConfig.ready ? controlConfig.apiOrigin : "";

export type ControlAccess = { actorId: string; isCurrent(): boolean };
let actorId = "";
let revision = 0;
let initialized = false;
const actorListeners = new Set<(session: Session | null) => void>();

function observeActor(session: Session | null) {
  const next = session?.user?.id || "";
  const changed = !initialized || actorId !== next;
  if (changed) revision++;
  actorId = next;
  initialized = true;
  if (changed) for (const listener of [...actorListeners]) listener(session);
}

export function subscribeControlActor(listener: (session: Session | null) => void): () => void {
  actorListeners.add(listener);
  return () => { actorListeners.delete(listener); };
}

if (controlConfig.ready) {
  supabase.auth.onAuthStateChange((_event, session) => observeActor(session));
  const initialRevision = revision;
  void supabase.auth.getSession().then(({ data, error }) => {
    if (revision === initialRevision) observeActor(error ? null : data.session);
  }, () => { if (revision === initialRevision) observeActor(null); });
}

export function captureControlAccess(): ControlAccess {
  const capturedActor = actorId, capturedRevision = revision;
  return { actorId: capturedActor, isCurrent: () => controlConfig.ready && initialized && Boolean(capturedActor)
    && actorId === capturedActor && revision === capturedRevision };
}

export class ControlAccessError extends Error {
  readonly status = 401;
  readonly code = "control_session_changed";
  constructor() { super("Сеанс изменился. Обновите страницу и проверьте вход."); }
}

function assertCurrent(scope: ControlAccess, signal?: AbortSignal | null) {
  if (signal?.aborted) {
    const error = new Error("Запрос отменён"); error.name = "AbortError"; throw error;
  }
  if (!scope.isCurrent()) throw new ControlAccessError();
}

async function currentSession(scope: ControlAccess, signal?: AbortSignal | null) {
  assertCurrent(scope, signal);
  let result: Awaited<ReturnType<typeof supabase.auth.getSession>>;
  try { result = await supabase.auth.getSession(); }
  catch { assertCurrent(scope, signal); observeActor(null); throw new ControlAccessError(); }
  assertCurrent(scope, signal);
  const { data, error } = result;
  const session = data.session;
  if (error) { observeActor(null); throw new ControlAccessError(); }
  if (session?.user.id !== scope.actorId) {
    observeActor(session);
    throw new ControlAccessError();
  }
  if (!session.access_token) { observeActor(null); throw new ControlAccessError(); }
  return session;
}

function guardedResponse(response: Response, scope: ControlAccess, signal?: AbortSignal | null): Response {
  const readers = new Set<PropertyKey>(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);
  return new Proxy(response, { get(target, key) {
    if (key === "clone") return () => { assertCurrent(scope, signal); return guardedResponse(target.clone(), scope, signal); };
    const value = Reflect.get(target, key, target);
    if (readers.has(key) && typeof value === "function") return async () => {
      await currentSession(scope, signal);
      const body = await value.call(target);
      await currentSession(scope, signal);
      return body;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export async function verifyControlAccess(scope: ControlAccess, signal?: AbortSignal | null): Promise<void> {
  await currentSession(scope, signal);
  assertCurrent(scope, signal);
}

export async function controlFetch(path: string, init: RequestInit = {}, scope = captureControlAccess()): Promise<Response> {
  if (!controlConfig.ready) throw new Error(controlConfig.error);
  const session = await currentSession(scope, init.signal);

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${session.access_token}`);

  const normalized = path.startsWith("/") ? path : `/${path}`;
  assertCurrent(scope, init.signal);
  const response = await fetch(`${API_BASE_URL}${normalized}`, { ...init, headers, cache: "no-store", redirect: "error" });
  assertCurrent(scope, init.signal);
  // Refusals are usable immediately; private response bodies remain guarded.
  if (![401, 403, 404].includes(response.status)) await currentSession(scope, init.signal);
  return guardedResponse(response, scope, init.signal);
}

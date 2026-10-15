import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { readWorkspaceId } from "@/lib/demoStorage";
import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";
import { dayKeyInZone } from "@/lib/clinicDay";
import { formatSlot, minuteOfClinicDay } from "@/lib/dayGrid";
import type { MortgageActivity, MortgageActivityDraft, MortgageActivityStatus, MortgageContact, MortgagePriority, MortgageSnapshot, MortgageSnapshotQuery } from "../../../../lib/crm/mortgage-contract";

export type { MortgageActivity, MortgageActivityDraft, MortgageActivityKind, MortgageActivityStatus, MortgageContact, MortgageMember, MortgagePriority, MortgageSnapshot, MortgageSnapshotQuery } from "../../../../lib/crm/mortgage-contract";

type Scope = { actorId: string; workspaceId: string; role: string | null; purpose: string | null };
type Access = {
  workspaceId: string;
  isCurrent: () => boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};
const MortgageContext = createContext<Access | null>(null);
const ended = () => new DOMException("Mortgage session ended", "AbortError");

export function MortgageScope({ children }: { children: ReactNode }) {
  const { user, userRole, clinicId, workspacePurpose, isLoading, isSigningOut, isDemoMode, isImpersonation } = useAuth();
  const scope: Scope = {
    actorId: !isLoading && !isSigningOut && !isDemoMode && !isImpersonation ? user?.id || "" : "",
    workspaceId: userRole === "lead_manager" ? clinicId || "" : clinicId || readWorkspaceId(),
    role: userRole,
    purpose: workspacePurpose,
  };
  // Old closures see the new scope during render, before effect cleanup runs.
  const live = useRef(scope);
  live.current = scope;
  const observedActor = useRef(scope.actorId);
  const authObserved = useRef(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  useLayoutEffect(() => {
    if (!hasSupabaseFrontendEnv) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextActor = session?.user.id || "";
      authObserved.current = true;
      if (observedActor.current === nextActor) return;
      observedActor.current = nextActor;
      setAuthEpoch((value) => value + 1);
    });
    return () => subscription.unsubscribe();
  }, []);
  if (isLoading || isSigningOut) return null;
  // AuthContext may catch up after the SDK event; do not remount the old actor meanwhile.
  if (authObserved.current && observedActor.current !== scope.actorId) return null;
  if (!scope.actorId || !scope.workspaceId || isDemoMode || isImpersonation
    || scope.purpose !== "mortgage_leads" || !["owner", "admin", "lead_manager"].includes(scope.role || "")) {
    return <p role="alert" className="p-6 text-sm">Нет доступа к ипотечному рабочему пространству.</p>;
  }
  return <MortgageSession key={JSON.stringify([scope.actorId, scope.workspaceId, scope.role, scope.purpose, authEpoch])} scope={scope} live={live}>{children}</MortgageSession>;
}

function MortgageSession({ scope, live, children }: { scope: Scope; live: { current: Scope }; children: ReactNode }) {
  const captured = useRef(scope).current;
  const sessionRef = useRef<AbortController | null>(null);
  const invalidated = useRef<"auth" | "expired" | "denied" | "missing" | null>(null);
  const [lifetime, setLifetime] = useState<{ controller: AbortController; epoch: number } | null>(null);
  const [revoked, setRevoked] = useState<"auth" | "expired" | "denied" | "missing" | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    sessionRef.current = controller;
    if (invalidated.current) controller.abort();
    setRevoked(invalidated.current);
    // Every setup owns a fresh controller, including StrictMode effect replay.
    setLifetime((previous) => ({ controller, epoch: (previous?.epoch ?? 0) + 1 }));
    const subscription = hasSupabaseFrontendEnv
      ? supabase.auth.onAuthStateChange((_event, session) => {
          if ((session?.user.id || "") !== captured.actorId) {
            invalidated.current = "auth";
            controller.abort();
            setRevoked("auth");
          }
        }).data.subscription
      : null;
    return () => {
      controller.abort();
      subscription?.unsubscribe();
      if (sessionRef.current === controller) sessionRef.current = null;
    };
  }, [captured]);
  const access = useMemo<Access | null>(() => {
    if (!lifetime) return null;
    const { controller } = lifetime;
    const isCurrent = () => Boolean(captured.actorId && captured.workspaceId
      && live.current.actorId === captured.actorId && live.current.workspaceId === captured.workspaceId
      && live.current.role === captured.role && live.current.purpose === captured.purpose
      && sessionRef.current === controller && !controller.signal.aborted && !invalidated.current);
    const request = async (path: string, init?: RequestInit) => {
      if (!isCurrent()) throw ended();
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      signal.throwIfAborted();
      const response = await crmFetch(path, { ...init, cache: "no-store", expectedUserId: captured.actorId, signal });
      if (!isCurrent()) throw ended();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        // Membership/assignment may change without an auth event. Invalidate all
        // consumers before a refused read or write can return to its caller.
        invalidated.current = response.status === 401 ? "expired" : response.status === 403 ? "denied" : "missing";
        controller.abort();
        setRevoked(invalidated.current);
        throw ended();
      }
      signal.throwIfAborted();
      return response;
    };
    return { workspaceId: captured.workspaceId, isCurrent, request };
  }, [captured, lifetime, live]);
  if (revoked === "expired" || revoked === "denied" || revoked === "missing") return <div role="alert" className="border-y border-[var(--negis-border)] p-6 text-sm text-[var(--negis-text)]">
    <p className="font-semibold">{revoked === "expired" ? "Сеанс завершён. Войдите снова." : revoked === "denied" ? "Доступ к рабочему пространству отозван." : "Клиент или запись больше недоступны."}</p>
  </div>;
  if (!access || !lifetime || revoked || !access.isCurrent()) return null;
  return <MortgageContext.Provider key={lifetime.epoch} value={access}>{children}</MortgageContext.Provider>;
}

export class MortgageRequestError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

async function readResult(access: Access, response: Response): Promise<Record<string, unknown>> {
  if (!access.isCurrent()) throw ended();
  let body: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    if (!access.isCurrent()) throw ended();
    throw new MortgageRequestError(`Сервер вернул нечитаемый ответ (${response.status}).`, "invalid_response", response.status);
  }
  if (!access.isCurrent()) throw ended();
  if (!response.ok || body.success !== true || body.mode !== "supabase") {
    throw new MortgageRequestError(typeof body.error === "string" ? body.error : `Не удалось выполнить запрос (${response.status}).`,
      typeof body.code === "string" ? body.code : "request_failed", response.status);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function hasCounts(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isCount(value[key]));
}
function isInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function isNullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function isNullableInstant(value: unknown): boolean { return value === null || isInstant(value); }
function isContact(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ["id", "name", "phone", "notes", "status", "source"])
    && Boolean(value.id) && isInstant(value.createdAt) && isInstant(value.updatedAt)
    && isNullableString(value.responsibleUserId) && isNullableString(value.responsibleName);
}
function isActivity(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, ["id", "leadId", "title", "notes", "contactName"]) || !value.id || !value.leadId
    || !isInstant(value.createdAt) || !isInstant(value.updatedAt)
    || !isNullableString(value.responsibleUserId) || !isNullableString(value.responsibleName)
    || typeof value.priority !== "string" || !["low", "normal", "high"].includes(value.priority)) return false;
  const statuses = value.kind === "meeting" ? ["open", "done", "cancelled", "missed"] : ["open", "in_progress", "done", "cancelled"];
  if (typeof value.status !== "string" || !statuses.includes(value.status)) return false;
  return value.kind === "meeting"
    ? isInstant(value.startsAt) && isInstant(value.endsAt) && Date.parse(value.endsAt) > Date.parse(value.startsAt) && value.dueAt === null
    : value.kind === "task" && value.startsAt === null && value.endsAt === null && isNullableInstant(value.dueAt);
}
function isMember(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ["id", "name", "role", "status"]) && Boolean(value.id);
}
function isEvent(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ["id", "activityId", "action", "title", "actorName"])
    && Boolean(value.id && value.activityId) && isInstant(value.createdAt);
}
function isMemberMetrics(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ["id", "name", "role"]) && Boolean(value.id)
    && hasCounts(value, ["assignedLeads", "openTasks", "overdueTasks", "doneTasks", "plannedMeetings", "doneMeetings", "missedMeetings"]);
}
function snapshotFrom(body: Record<string, unknown>): MortgageSnapshot {
  const data = body.data;
  if (!isRecord(data) || typeof data.timeZone !== "string"
    || !Array.isArray(data.contacts) || !data.contacts.every(isContact) || !isCount(data.contactsTotal)
    || !Array.isArray(data.activities) || !data.activities.every(isActivity) || typeof data.activitiesTruncated !== "boolean"
    || !Array.isArray(data.members) || !data.members.every(isMember)
    || !Array.isArray(data.events) || !data.events.every(isEvent)
    || !hasCounts(data.metrics, ["totalLeads", "unassignedLeads", "inProgressLeads", "meetingsToday", "overdueTasks", "activeManagers"])
    || !Array.isArray(data.memberMetrics) || !data.memberMetrics.every(isMemberMetrics)
    || !isCount(data.periodDays) || data.periodDays < 1 || !isCount(data.page) || !isCount(data.pageSize) || data.pageSize < 1) {
    throw new MortgageRequestError("Сервер не вернул данные рабочего пространства.", "invalid_response", 200);
  }
  requireMortgageTimeZone(data.timeZone);
  return data as MortgageSnapshot;
}

export function useMortgageWorkspace(query: MortgageSnapshotQuery = {}) {
  const access = useContext(MortgageContext);
  if (!access) throw new Error("useMortgageWorkspace requires MortgageScope");
  const params = new URLSearchParams({ workspaceId: access.workspaceId });
  for (const key of ["q", "page", "leadId", "from", "to", "days"] as const) {
    if (query[key] !== undefined && query[key] !== "") params.set(key, String(query[key]));
  }
  const path = `/api/crm/mortgage-workspace?${params}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data: MortgageSnapshot | null; loading: boolean; error: string }>({ path: "", data: null, loading: true, error: "" });
  const refresh = useCallback(() => { if (access.isCurrent()) setRevision((value) => value + 1); }, [access]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const current = () => active && access.isCurrent();
    if (!current()) return;
    setState({ path, data: null, loading: true, error: "" });
    void (async () => {
      try {
        const response = await access.request(path, { signal: controller.signal });
        const body = await readResult(access, response);
        if (current()) setState({ path, data: snapshotFrom(body), loading: false, error: "" });
      } catch (error) {
        if (current() && !controller.signal.aborted) setState({ path, data: null, loading: false, error: messageFor(error) });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [access, path, revision]);

  const mutate = useCallback(async (endpoint: string, method: string, body: unknown) => {
    const response = await access.request(`${endpoint}?workspaceId=${encodeURIComponent(access.workspaceId)}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await readResult(access, response);
    if (!access.isCurrent()) throw ended();
    refresh();
  }, [access, refresh]);
  const saveActivity = useCallback(async (draft: MortgageActivityDraft, existing?: MortgageActivity) => {
    const requestId = draft.requestId;
    if (!existing && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || "")) {
      throw new Error("Не удалось определить запрос. Откройте форму заново.");
    }
    // Explicit fields keep assignee/clinical data out of this contract.
    const body = {
      kind: draft.kind, leadId: draft.leadId, title: draft.title, notes: draft.notes ?? "",
      status: draft.status ?? "open", priority: draft.priority ?? "normal",
      startsAt: draft.startsAt ?? null, endsAt: draft.endsAt ?? null, dueAt: draft.dueAt ?? null,
      ...(existing ? { id: existing.id, expectedUpdatedAt: existing.updatedAt } : { requestId }),
    };
    await mutate("/api/crm/mortgage-workspace", existing ? "PATCH" : "POST", body);
  }, [mutate]);
  const searchContacts = useCallback(async (q: string): Promise<MortgageContact[]> => {
    const search = new URLSearchParams({ workspaceId: access.workspaceId, q, page: "0" });
    const response = await access.request(`/api/crm/mortgage-workspace?${search}`);
    const body = await readResult(access, response);
    const snapshot = snapshotFrom(body);
    if (!access.isCurrent()) throw ended();
    return snapshot.contacts;
  }, [access]);
  const createContact = useCallback(async (input: { name: string; phone: string; notes?: string; responsibleUserId?: string }) => {
    await mutate("/api/crm/leads", "POST", { name: input.name, phone: input.phone, notes: input.notes ?? "", status: "new", source: "manual", responsibleUserId: input.responsibleUserId ?? "" });
  }, [mutate]);
  const updateContact = useCallback(async (id: string, updates: { name?: string; phone?: string; notes?: string; status?: string }) => {
    const safeUpdates = { name: updates.name, phone: updates.phone, notes: updates.notes, status: updates.status };
    await mutate("/api/crm/leads", "PATCH", { id, updates: safeUpdates });
  }, [mutate]);
  const visible = access.isCurrent() && state.path === path;
  return {
    data: visible ? state.data : null, loading: access.isCurrent() && (!visible || state.loading),
    error: visible ? state.error : "", refresh, saveActivity, searchContacts, createContact, updateContact,
    request: access.request, isCurrent: access.isCurrent,
  };
}

export function requireMortgageTimeZone(timeZone: string): string {
  if (!timeZone) throw new Error("Сервер не вернул часовой пояс рабочего пространства.");
  try { new Intl.DateTimeFormat("en-GB", { timeZone }).format(0); }
  catch { throw new Error("Сервер вернул неверный часовой пояс рабочего пространства."); }
  return timeZone;
}

export function mortgageLocalDateTime(iso: string | null | undefined, timeZone: string): string {
  requireMortgageTimeZone(timeZone);
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  const minute = minuteOfClinicDay(iso, timeZone);
  return minute === null ? "" : `${dayKeyInZone(Date.parse(iso), timeZone)}T${formatSlot(minute)}`;
}

export function mortgageDateTimeToIso(local: string, timeZone: string, unchangedIso?: string | null): string {
  requireMortgageTimeZone(timeZone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Укажите дату и время.");
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== local) throw new Error("Проверьте дату и время.");
  if (unchangedIso && mortgageLocalDateTime(unchangedIso, timeZone) === local) return unchangedIso;
  // Probe offsets on both sides of a transition. Never parse a wall time in the device zone.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = wall + hours * 3_600_000;
    const formatted = mortgageLocalDateTime(new Date(instant).toISOString(), timeZone);
    offsets.add(Date.parse(`${formatted}:00Z`) - instant);
  }
  const candidates = [...offsets].map((offset) => wall - offset)
    .filter((instant) => mortgageLocalDateTime(new Date(instant).toISOString(), timeZone) === local);
  if (candidates.length === 0) throw new Error("Это время отсутствует из-за перевода часов. Выберите другое время.");
  if (candidates.length !== 1) throw new Error("Это время повторяется из-за перевода часов. Выберите другое время.");
  return new Date(candidates[0]).toISOString();
}

export function mortgageAddDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function mortgageWeekStart(day: string): string {
  return mortgageAddDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

export function mortgageMonthStep(day: string, step: number): string {
  const date = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + step);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(Number(day.slice(8)), last));
  return date.toISOString().slice(0, 10);
}

export function mortgageDayLabel(day: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }): string {
  return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

export function mortgageInstantLabel(iso: string | null, timeZone: string): string {
  requireMortgageTimeZone(timeZone);
  if (!iso || !Number.isFinite(Date.parse(iso))) return "Без срока";
  return new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export const mortgageStatusLabels: Record<MortgageActivityStatus, string> = { open: "Запланировано", in_progress: "В работе", done: "Выполнено", cancelled: "Отменено", missed: "Неявка" };
export const mortgagePriorityLabels: Record<MortgagePriority, string> = { low: "Низкий", normal: "Обычный", high: "Высокий" };
export function mortgageActivityDraft(activity: MortgageActivity): MortgageActivityDraft {
  return { kind: activity.kind, leadId: activity.leadId, title: activity.title, notes: activity.notes,
    status: activity.status, priority: activity.priority, startsAt: activity.startsAt, endsAt: activity.endsAt, dueAt: activity.dueAt };
}
export const mortgageFieldClass = "h-11 w-full min-w-0 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 text-sm text-[var(--negis-text)] disabled:opacity-60";
export const mortgageButtonClass = "inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
export const mortgagePrimaryClass = `${mortgageButtonClass} !border-[var(--negis-primary)] !bg-[var(--negis-primary)] !text-white`;

export function MortgageNotice({ loading, error, refresh, truncated = false }: { loading: boolean; error: string; refresh: () => void; truncated?: boolean }) {
  if (error) return <div role="alert" className="flex flex-wrap items-center gap-3 border-y border-red-200 bg-red-50 p-4 text-sm text-red-800"><p className="min-w-0 flex-1 break-words">{error}</p><button type="button" className={mortgageButtonClass} onClick={refresh}>Повторить</button></div>;
  if (loading) return <p role="status" className="py-6 text-sm text-[var(--negis-muted)]">Загрузка...</p>;
  return truncated ? <p role="status" className="border-y border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Показана часть записей. Сузьте период или выберите клиента.</p> : null;
}

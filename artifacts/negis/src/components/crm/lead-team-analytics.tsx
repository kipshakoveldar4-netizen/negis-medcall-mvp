import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { roleLabels, type StaffRole } from "@/lib/permissions";

type SessionAccess = {
  isCurrent: () => boolean;
  loadTeamAnalytics: (days: number) => Promise<Response>;
};

type Activity = {
  updatedEvents: number;
  createdEvents: number;
  touchedLeads: number;
  lastRecordedAt: string | null;
};

type Analytics = {
  timeZone: string;
  generatedAt: string;
  period: { days: number; from: string; to: string };
  totalLeads: number;
  unassignedLeads: number;
  otherAssigneeLeads: number;
  activityStatus: "available" | "unavailable";
  members: Array<{
    staffId: string;
    name: string;
    role: string;
    status: string;
    assigned: { total: number; new: number; inProgress: number; booked: number; postponed: number; lost: number; other: number };
    activity: Activity | null;
  }>;
};

type LoadState = { kind: "idle" | "loading" } | { kind: "failed"; denied: boolean } | { kind: "ready"; analytics: Analytics };
const PERIODS = [7, 30, 90] as const;
const ASSIGNED_FIELDS = ["total", "new", "inProgress", "booked", "postponed", "lost", "other"] as const;
const LEGACY_ASSIGNED_FIELDS = ASSIGNED_FIELDS.filter((field) => field !== "postponed");
const ACTIVITY_FIELDS = ["updatedEvents", "createdEvents", "touchedLeads"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasCounts(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === day;
}

function compareInstants(left: string, right: string): number {
  const remainder = (value: string) => Number((value.match(/\.(\d{1,6})/)?.[1] ?? "").padEnd(6, "0").slice(3));
  return (Date.parse(left) - Date.parse(right)) * 1000 + remainder(left) - remainder(right);
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function teamBookingConversion(booked: number, assigned: number): number | null {
  if (!Number.isSafeInteger(booked) || !Number.isSafeInteger(assigned) || assigned <= 0 || booked < 0 || booked > assigned) return null;
  return Math.round(booked / assigned * 1000) / 10;
}

function safeSum(values: number[]): number | null {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}

function readAnalytics(body: unknown, days: number): Analytics {
  const analytics = isRecord(body) && body.success === true && body.mode === "supabase" && isRecord(body.data)
    ? body.data.analytics : null;
  if (!PERIODS.some((period) => period === days) || !isRecord(analytics) || !isTimeZone(analytics.timeZone) || !isTimestamp(analytics.generatedAt)
    || !isRecord(analytics.period) || analytics.period.days !== days
    || !isTimestamp(analytics.period.from) || !isTimestamp(analytics.period.to)
    || !hasCounts(analytics, ["totalLeads", "unassignedLeads", "otherAssigneeLeads"])
    || (analytics.activityStatus !== "available" && analytics.activityStatus !== "unavailable")
    || !Array.isArray(analytics.members)
    || !analytics.members.every((member: unknown) => isRecord(member)
      && typeof member.staffId === "string" && member.staffId !== ""
      && typeof member.name === "string" && typeof member.role === "string" && typeof member.status === "string"
      && hasCounts(member.assigned, LEGACY_ASSIGNED_FIELDS)
      && isRecord(member.assigned)
      && (!Object.hasOwn(member.assigned, "postponed") || hasCounts(member.assigned, ["postponed"]))
      && (member.activity === null || (isRecord(member.activity)
        && hasCounts(member.activity, ACTIVITY_FIELDS)
        && (member.activity.lastRecordedAt === null || isTimestamp(member.activity.lastRecordedAt)))))) {
    throw new Error("Invalid team analytics response");
  }
  // Older servers may omit postponed, but their existing counts must still reconcile.
  const result = { ...analytics, members: analytics.members.map((member) => ({
    ...member, assigned: { postponed: 0, ...member.assigned },
  })) } as Analytics;
  const ids = new Set(result.members.map((member) => member.staffId));
  if (ids.size !== result.members.length
    || compareInstants(result.period.to, result.period.from) !== days * 86_400_000_000
    || compareInstants(result.period.to, result.generatedAt) !== 0
    || result.members.some((member) => safeSum(ASSIGNED_FIELDS.filter((key) => key !== "total").map((key) => member.assigned[key])) !== member.assigned.total)
    || safeSum([result.unassignedLeads, result.otherAssigneeLeads, ...result.members.map((member) => member.assigned.total)]) !== result.totalLeads) {
    throw new Error("Inconsistent team analytics response");
  }
  return result;
}

function dateTime(value: string, timeZone: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

export function LeadTeamAnalytics({ access, initiallyExpanded = false, heading = "Работа команды" }: {
  access: SessionAccess; initiallyExpanded?: boolean; heading?: string;
}) {
  const [sessionAccess] = useState(() => access);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [days, setDays] = useState<number>(30);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const revision = useRef(0);
  const lifetime = useRef({ mounted: true, invalidated: false });
  const isCurrent = () => {
    if (!lifetime.current.mounted || lifetime.current.invalidated) return false;
    // Observed access loss expires this pinned lifetime, even if identity returns.
    if (!sessionAccess.isCurrent()) lifetime.current.invalidated = true;
    return !lifetime.current.invalidated;
  };

  useEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      revision.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!expanded || !isCurrent()) return;
    const requestRevision = ++revision.current;
    let cancelled = false;
    const current = () => !cancelled && revision.current === requestRevision && isCurrent();
    setState({ kind: "loading" });
    void (async () => {
      try {
        if (!current()) return;
        const response = await sessionAccess.loadTeamAnalytics(days);
        if (!current()) return;
        if (!response.ok) {
          setState({ kind: "failed", denied: response.status === 403 });
          return;
        }
        const body: unknown = await response.json();
        if (!current()) return;
        setState({ kind: "ready", analytics: readAnalytics(body, days) });
      } catch {
        if (current()) setState({ kind: "failed", denied: false });
      }
    })();
    return () => {
      cancelled = true;
      if (revision.current === requestRevision) revision.current += 1;
    };
  }, [sessionAccess, expanded, days, refresh]);

  if (!isCurrent()) return null;
  const analytics = state.kind === "ready" ? state.analytics : null;
  const assignedTotal = analytics?.members.reduce((sum, member) => sum + member.assigned.total, 0) ?? 0;
  const bookedTotal = analytics?.members.reduce((sum, member) => sum + member.assigned.booked, 0) ?? 0;
  const postponedTotal = analytics?.members.reduce((sum, member) => sum + member.assigned.postponed, 0) ?? 0;
  const lostTotal = analytics?.members.reduce((sum, member) => sum + member.assigned.lost, 0) ?? 0;
  const loading = state.kind === "loading";

  return (
    <details className="min-w-0 max-w-full border-y py-3" style={{ borderColor: "var(--negis-border)" }} open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === expanded || !isCurrent()) return;
        revision.current += 1;
        setState({ kind: next ? "loading" : "idle" });
        setExpanded(next);
      }}>
      <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--negis-text)" }}>{heading}</summary>
      {expanded && <div className="min-w-0 space-y-4 pt-4" aria-busy={loading}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs" style={{ color: "var(--negis-muted)" }}>
            Период активности
            <select className="ml-2 rounded-md border px-2 py-1.5 text-sm" aria-label="Период активности команды" value={days}
              style={{ borderColor: "var(--negis-border)", background: "var(--negis-surface)", color: "var(--negis-text)" }}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!PERIODS.some((period) => period === next) || next === days || !isCurrent()) return;
                revision.current += 1;
                setState({ kind: "loading" });
                setDays(next);
              }}>
              {PERIODS.map((period) => <option key={period} value={period}>{period} дней</option>)}
            </select>
          </label>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border disabled:opacity-50"
            style={{ borderColor: "var(--negis-border)", color: "var(--negis-text)" }}
            title="Обновить работу команды" aria-label="Обновить работу команды" disabled={loading}
            onClick={() => {
              if (!isCurrent()) return;
              revision.current += 1;
              setState({ kind: "loading" });
              setRefresh((value) => value + 1);
            }}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>

        {loading && <p role="status" className="flex items-center gap-2 text-sm" style={{ color: "var(--negis-muted)" }}>
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />Загрузка работы команды...
        </p>}
        {state.kind === "failed" && <p role="alert" className="text-sm" style={{ color: "var(--negis-error)" }}>
          {state.denied ? "Нет доступа к работе команды." : "Не удалось загрузить работу команды."}
        </p>}

        {analytics && <>
          <section className="min-w-0" aria-label="Результаты по назначенным заявкам">
            <h3 className="mb-3 text-xs font-semibold text-[var(--negis-muted)]">Текущие назначенные заявки · всё время</h3>
            <dl className="grid min-w-0 grid-cols-2 gap-4 border-y border-[var(--negis-border)] py-4 lg:grid-cols-5">
              {[
                ["Назначено сотрудникам", assignedTotal.toLocaleString("ru-RU")],
                ["Записаны", bookedTotal.toLocaleString("ru-RU")],
                ["Конверсия в запись", percent(teamBookingConversion(bookedTotal, assignedTotal))],
                ["Отложенные", postponedTotal.toLocaleString("ru-RU")],
                ["Потеряны", lostTotal.toLocaleString("ru-RU")],
              ].map(([label, value]) => <div key={label} className="min-w-0">
                <dt className="break-words text-xs text-[var(--negis-muted)]">{label}</dt>
                <dd className="mt-1 break-words text-xl font-semibold tabular-nums text-[var(--negis-text)]">{value}</dd>
              </div>)}
            </dl>
            {analytics.members.length > 0 && <div className="mt-4 grid min-w-0 gap-x-8 gap-y-4 lg:grid-cols-2" aria-label="Конверсия в запись по сотрудникам">
              {analytics.members.map((member) => {
                const conversion = teamBookingConversion(member.assigned.booked, member.assigned.total);
                return <dl key={member.staffId} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5">
                  <dt className="min-w-0 break-words text-xs font-medium text-[var(--negis-text)]">{member.name || "Сотрудник"}<span className="mt-0.5 block text-[11px] font-normal text-[var(--negis-muted)]">{member.status === "active" ? "Активен" : "Неактивен"}</span></dt>
                  <dd className="text-right text-xs tabular-nums text-[var(--negis-text)]"><strong className="font-semibold">{percent(conversion)}</strong><span className="mt-0.5 block text-[11px] text-[var(--negis-muted)]">{member.assigned.booked.toLocaleString("ru-RU")} из {member.assigned.total.toLocaleString("ru-RU")}</span></dd>
                  <dd className="col-span-2 min-w-0" title="Заявки в статусе «Записана» / все текущие заявки сотрудника. Это текущий снимок, не история переходов за период.">
                    {conversion === null ? <div className="h-2 bg-[var(--negis-surface-2)]" aria-hidden="true" />
                      : <meter min={0} max={100} value={conversion} aria-label={`Конверсия в запись: ${member.name || "Сотрудник"}; ${member.assigned.booked} из ${member.assigned.total}`}
                        className="block h-2 w-full appearance-none overflow-hidden rounded-sm bg-[var(--negis-surface-2)] [&::-webkit-meter-bar]:h-2 [&::-webkit-meter-bar]:rounded-sm [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-[var(--negis-surface-2)] [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-[var(--negis-primary)] [&::-webkit-meter-optimum-value]:bg-none [&::-moz-meter-bar]:bg-[var(--negis-primary)] [&::-moz-meter-bar]:bg-none">{percent(conversion)}</meter>}
                  </dd>
                </dl>;
              })}
            </div>}
          </section>
          <div>
            <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>Текущие заявки · все время</h3>
            <dl className="grid gap-3 sm:grid-cols-3">
              {[
                ["Всего заявок", analytics.totalLeads],
                ["Не назначены", analytics.unassignedLeads],
                ["Другие ответственные", analytics.otherAssigneeLeads],
              ].map(([label, count]) => <div key={label} className="min-w-0">
                <dt className="break-words text-xs" style={{ color: "var(--negis-muted)" }}>{label}</dt>
                <dd className="text-xl font-semibold tabular-nums" style={{ color: "var(--negis-text)" }}>{count}</dd>
              </div>)}
            </dl>
            <p className="mt-2 text-xs" style={{ color: "var(--negis-muted)" }}>Снимок: {dateTime(analytics.generatedAt, analytics.timeZone)}</p>
          </div>
          <div className="text-xs" style={{ color: "var(--negis-muted)" }}>
            <p>Ручные события · последние {analytics.period.days} дней: {dateTime(analytics.period.from, analytics.timeZone)} – {dateTime(analytics.period.to, analytics.timeZone)}</p>
            <p>Журнал сохранений: возможны пропуски.</p>
            {analytics.activityStatus === "unavailable" && <p>Активность недоступна.</p>}
          </div>
          {analytics.members.length === 0 ? <p className="text-sm" style={{ color: "var(--negis-muted)" }}>Сотрудников нет.</p> : (
            <div className="min-w-0 max-w-full overflow-x-auto" role="region" aria-label="Показатели работы команды" tabIndex={0}>
              <table className="w-full min-w-[1200px] text-left text-xs" style={{ color: "var(--negis-text)" }}>
                <thead style={{ color: "var(--negis-muted)" }}>
                  <tr>
                    <th scope="col" rowSpan={2} className="sticky left-0 z-20 w-44 min-w-44 max-w-56 px-2 py-2"
                      style={{ background: "var(--negis-surface)" }}>Сотрудник</th>
                    <th scope="colgroup" colSpan={ASSIGNED_FIELDS.length} className="px-2 py-2">Текущие заявки · все время</th>
                    <th scope="colgroup" colSpan={4} className="px-2 py-2">Ручные события · {analytics.period.days} дней</th>
                  </tr>
                  <tr>{["Назначено", "Новые", "В работе", "Записаны", "Отложенные", "Потеряны", "Другие статусы", "Правки", "Создания", "Уникальные заявки", "Последнее изменение"]
                    .map((label) => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr>
                </thead>
                <tbody>{analytics.members.map((member) => {
                  const activity = analytics.activityStatus === "available" ? member.activity : null;
                  return <tr key={member.staffId} className="border-t align-top" style={{ borderColor: "var(--negis-border)" }}>
                    <th scope="row" className="sticky left-0 z-10 min-w-44 max-w-56 px-2 py-3 font-medium"
                      style={{ background: "var(--negis-surface)" }}>
                      <span className="block break-words">{member.name || "Сотрудник"}</span>
                      <span className="block break-words text-xs font-normal" style={{ color: "var(--negis-muted)" }}>
                        {Object.hasOwn(roleLabels, member.role) ? roleLabels[member.role as StaffRole] : member.role}
                      </span>
                      <span className="mt-1 inline-block rounded-sm px-1.5 py-0.5 text-xs" title={member.status}
                        style={{ background: "var(--negis-ground)", color: member.status === "active" ? "var(--negis-success)" : "var(--negis-muted)" }}>
                        {member.status === "active" ? "Активен" : "Неактивен"}
                      </span>
                    </th>
                    {ASSIGNED_FIELDS.map((field) => <td key={field} className="px-2 py-3 tabular-nums">{member.assigned[field]}</td>)}
                    {ACTIVITY_FIELDS.map((field) => (
                      <td key={field} className="px-2 py-3 tabular-nums" title={activity ? undefined : "Активность недоступна"}>
                        {activity ? activity[field] : "-"}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-3" title={activity ? undefined : "Активность недоступна"}>
                      {activity?.lastRecordedAt ? dateTime(activity.lastRecordedAt, analytics.timeZone) : "-"}
                    </td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </>}
      </div>}
    </details>
  );
}

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
    assigned: { total: number; new: number; inProgress: number; booked: number; lost: number; other: number };
    activity: Activity | null;
  }>;
};

type LoadState = { kind: "idle" | "loading" } | { kind: "failed"; denied: boolean } | { kind: "ready"; analytics: Analytics };
const PERIODS = [7, 30, 90] as const;
const ASSIGNED_FIELDS = ["total", "new", "inProgress", "booked", "lost", "other"] as const;
const ACTIVITY_FIELDS = ["updatedEvents", "createdEvents", "touchedLeads"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasCounts(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function readAnalytics(body: unknown, days: number): Analytics {
  const analytics = isRecord(body) && body.success === true && body.mode === "supabase" && isRecord(body.data)
    ? body.data.analytics : null;
  if (!isRecord(analytics) || !isTimestamp(analytics.generatedAt)
    || !isRecord(analytics.period) || analytics.period.days !== days
    || !isTimestamp(analytics.period.from) || !isTimestamp(analytics.period.to)
    || !hasCounts(analytics, ["totalLeads", "unassignedLeads", "otherAssigneeLeads"])
    || (analytics.activityStatus !== "available" && analytics.activityStatus !== "unavailable")
    || !Array.isArray(analytics.members)
    || !analytics.members.every((member: unknown) => isRecord(member)
      && typeof member.staffId === "string" && member.staffId !== ""
      && typeof member.name === "string" && typeof member.role === "string" && typeof member.status === "string"
      && hasCounts(member.assigned, ASSIGNED_FIELDS)
      && (member.activity === null || (isRecord(member.activity)
        && hasCounts(member.activity, ACTIVITY_FIELDS)
        && (member.activity.lastRecordedAt === null || isTimestamp(member.activity.lastRecordedAt)))))) {
    throw new Error("Invalid team analytics response");
  }
  return analytics as Analytics;
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

export function LeadTeamAnalytics({ access }: { access: SessionAccess }) {
  const [sessionAccess] = useState(() => access);
  const [expanded, setExpanded] = useState(false);
  const [days, setDays] = useState<number>(30);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const revision = useRef(0);

  useEffect(() => {
    if (!expanded || !sessionAccess.isCurrent()) return;
    const requestRevision = ++revision.current;
    let cancelled = false;
    const current = () => !cancelled && revision.current === requestRevision && sessionAccess.isCurrent();
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

  if (!sessionAccess.isCurrent()) return null;
  const analytics = state.kind === "ready" ? state.analytics : null;
  const loading = state.kind === "loading";

  return (
    <details className="min-w-0 max-w-full border-y py-3" style={{ borderColor: "var(--negis-border)" }} open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === expanded || !sessionAccess.isCurrent()) return;
        revision.current += 1;
        setState({ kind: next ? "loading" : "idle" });
        setExpanded(next);
      }}>
      <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Работа команды</summary>
      {expanded && <div className="min-w-0 space-y-4 pt-4" aria-busy={loading}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs" style={{ color: "var(--negis-muted)" }}>
            Период активности
            <select className="ml-2 rounded-md border px-2 py-1.5 text-sm" aria-label="Период активности команды" value={days}
              style={{ borderColor: "var(--negis-border)", background: "var(--negis-surface)", color: "var(--negis-text)" }}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!PERIODS.some((period) => period === next) || next === days || !sessionAccess.isCurrent()) return;
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
              if (!sessionAccess.isCurrent()) return;
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
            <p className="mt-2 text-xs" style={{ color: "var(--negis-muted)" }}>Снимок: {dateTime(analytics.generatedAt)}</p>
          </div>
          <div className="text-xs" style={{ color: "var(--negis-muted)" }}>
            <p>Ручные события · последние {analytics.period.days} дней: {dateTime(analytics.period.from)} – {dateTime(analytics.period.to)}</p>
            <p>Журнал сохранений: возможны пропуски.</p>
            {analytics.activityStatus === "unavailable" && <p>Активность недоступна.</p>}
          </div>
          {analytics.members.length === 0 ? <p className="text-sm" style={{ color: "var(--negis-muted)" }}>Сотрудников нет.</p> : (
            <div className="min-w-0 max-w-full overflow-x-auto" role="region" aria-label="Показатели работы команды" tabIndex={0}>
              <table className="w-full min-w-[1120px] text-left text-xs" style={{ color: "var(--negis-text)" }}>
                <thead style={{ color: "var(--negis-muted)" }}>
                  <tr>
                    <th scope="col" rowSpan={2} className="sticky left-0 z-20 w-44 min-w-44 max-w-56 px-2 py-2"
                      style={{ background: "var(--negis-surface)" }}>Сотрудник</th>
                    <th scope="colgroup" colSpan={6} className="px-2 py-2">Текущие заявки · все время</th>
                    <th scope="colgroup" colSpan={4} className="px-2 py-2">Ручные события · {analytics.period.days} дней</th>
                  </tr>
                  <tr>{["Назначено", "Новые", "В работе", "Записаны", "Потеряны", "Другие статусы", "Правки", "Создания", "Уникальные заявки", "Последнее изменение"]
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
                      {activity?.lastRecordedAt ? dateTime(activity.lastRecordedAt) : "-"}
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

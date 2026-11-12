import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { roleLabels } from "@/lib/permissions";
import {
  MortgageIconButton, MortgageState, mortgageSegmentClass, mortgageTableClass,
} from "@/components/mortgage/MortgagePrimitives";

const PERIODS = [7, 30, 90] as const;
const COUNT_FIELDS = ["assignedLeads", "heldLeads", "signedLeads", "heldSignedLeads", "signedInPeriod"] as const;
type CountField = typeof COUNT_FIELDS[number];

export type MortgageResultsMember = Record<CountField, number> & {
  staffId: string;
  name: string;
  role: "owner" | "admin" | "lead_manager";
  status: string;
};

export type MortgageResultsData = {
  timeZone: string;
  generatedAt: string;
  period: { days: number; from: string; to: string };
  unassignedLeads: number;
  otherAssigneeLeads: number;
  members: MortgageResultsMember[];
};

export type MortgageResultsProps = {
  workspaceId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  isCurrent: () => boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === day;
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function compareInstants(left: string, right: string): number {
  // PostgreSQL timestamps retain microseconds beyond Date's millisecond precision.
  const remainder = (value: string) => Number((value.match(/\.(\d{1,6})/)?.[1] ?? "").padEnd(6, "0").slice(3));
  return (Date.parse(left) - Date.parse(right)) * 1000 + remainder(left) - remainder(right);
}

function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!isCount(value) || value > Number.MAX_SAFE_INTEGER - total) throw new Error("Некорректная сумма в отчёте.");
    total += value;
  }
  return total;
}

/** Reads the complete API envelope; period counts never constrain the current portfolio. */
export function parseMortgageResults(body: unknown, requestedDays: number): MortgageResultsData {
  const data = isRecord(body) && body.success === true && body.mode === "supabase" ? body.data : null;
  if (!PERIODS.some((days) => days === requestedDays) || !isRecord(data)
    || !isTimeZone(data.timeZone) || !isInstant(data.generatedAt) || !isRecord(data.period)
    || data.period.days !== requestedDays || !isInstant(data.period.from) || !isInstant(data.period.to)
    || compareInstants(data.period.to, data.period.from) !== requestedDays * 86_400_000_000
    || compareInstants(data.period.to, data.generatedAt) !== 0
    || !isCount(data.unassignedLeads) || !isCount(data.otherAssigneeLeads)
    || !Array.isArray(data.members)) {
    throw new Error("Сервер вернул некорректный отчёт.");
  }
  const ids = new Set<string>();
  for (const member of data.members) {
    if (!isRecord(member) || typeof member.staffId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(member.staffId)
      || ids.has(member.staffId.toLowerCase())
      || typeof member.name !== "string" || typeof member.status !== "string"
      || typeof member.role !== "string" || !["owner", "admin", "lead_manager"].includes(member.role)
      || !COUNT_FIELDS.every((field) => isCount(member[field]))) {
      throw new Error("Сервер вернул некорректные данные сотрудников.");
    }
    ids.add(member.staffId.toLowerCase());
    const counts = member as MortgageResultsMember;
    if (counts.heldLeads > counts.assignedLeads || counts.signedLeads > counts.assignedLeads
      || counts.heldSignedLeads > Math.min(counts.heldLeads, counts.signedLeads)) {
      throw new Error("Показатели клиентов в отчёте не согласованы.");
    }
  }
  const result = data as MortgageResultsData;
  for (const field of COUNT_FIELDS) safeSum(result.members.map((member) => member[field]));
  safeSum([result.unassignedLeads, result.otherAssigneeLeads, ...result.members.map((member) => member.assignedLeads)]);
  return result;
}

export function mortgageResultsRatio(numerator: number, denominator: number): number | null {
  if (!isCount(numerator) || !isCount(denominator) || denominator === 0 || numerator > denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function percent(numerator: number, denominator: number): string {
  const ratio = mortgageResultsRatio(numerator, denominator);
  return ratio === null ? "—" : `${ratio.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function dateTime(value: string, timeZone: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

type Query = MortgageResultsProps & { days: number; refresh: number };
type LoadState = { query: Query | null } & (
  | { kind: "loading" }
  | { kind: "error"; message: string; denied: boolean }
  | { kind: "ready"; data: MortgageResultsData }
);

export function MortgageResults({ workspaceId, request, isCurrent }: MortgageResultsProps) {
  const [days, setDays] = useState<number>(30);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LoadState>({ query: null, kind: "loading" });
  const headingId = useId();
  const query = useMemo(() => ({ workspaceId, request, isCurrent, days, refresh }), [workspaceId, request, isCurrent, days, refresh]);
  const latest = useRef(query);
  latest.current = query;
  const revision = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    activeController.current = controller;
    const requestRevision = ++revision.current;
    const current = () => !controller.signal.aborted && revision.current === requestRevision
      && latest.current === query && query.isCurrent();
    if (current()) {
      setState({ query, kind: "loading" });
      void (async () => {
        try {
          const params = new URLSearchParams({ workspaceId: query.workspaceId, days: String(query.days) });
          const response = await query.request(`/api/crm/mortgage-results?${params}`, {
            method: "GET", signal: controller.signal, cache: "no-store",
          });
          if (!current()) return;
          // Reading the body can outlive both the request and a period/session change.
          const body: unknown = await response.json().catch(() => null);
          if (!current()) return;
          if (!response.ok) {
            const schemaNotReady = response.status === 503 && isRecord(body) && body.code === "schema_not_ready";
            const denied = response.status === 401 || response.status === 403;
            setState({ query, kind: "error", denied, message: schemaNotReady
              ? "Учёт договоров ещё не подключён к этой базе. Отчёт недоступен."
              : denied ? "Нет доступа к отчёту о встречах и договорах."
                : `Не удалось загрузить отчёт (${response.status}).` });
            return;
          }
          const data = parseMortgageResults(body, query.days);
          if (current()) setState({ query, kind: "ready", data });
        } catch {
          if (current()) setState({ query, kind: "error", denied: false,
            message: "Не удалось получить корректный отчёт о встречах и договорах." });
        }
      })();
    }
    return () => {
      controller.abort();
      if (revision.current === requestRevision) revision.current += 1;
      if (activeController.current === controller) activeController.current = null;
    };
  }, [query]);

  if (!isCurrent()) return null;
  const visible = state.query === query ? state : { kind: "loading" as const };
  const reload = () => {
    if (!isCurrent()) return;
    revision.current += 1;
    activeController.current?.abort();
    setState({ query, kind: "loading" });
    setRefresh((value) => value + 1);
  };

  return <section className="w-full min-w-0 max-w-full space-y-4" aria-labelledby={headingId} aria-busy={visible.kind === "loading"}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 id={headingId} className="min-w-0 break-words text-sm font-semibold">Встречи и договоры</h2>
      <MortgageIconButton icon={RefreshCw} label="Обновить встречи и договоры" disabled={visible.kind === "loading"} onClick={reload} />
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <span className="min-w-0 break-words text-xs text-[var(--negis-muted)]">Заключённые договоры за период</span>
      <div role="group" aria-label="Период заключения договоров" className="inline-flex max-w-full rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-0.5">
        {PERIODS.map((period) => <button key={period} type="button" className={mortgageSegmentClass} aria-pressed={days === period}
          onClick={() => {
            if (days === period || !isCurrent()) return;
            revision.current += 1;
            activeController.current?.abort();
            setState({ query, kind: "loading" });
            setDays(period);
          }}>{period} дней</button>)}
      </div>
    </div>
    {visible.kind === "loading" ? <MortgageState kind="loading">Загрузка встреч и договоров...</MortgageState>
      : visible.kind === "error" ? <MortgageState kind={visible.denied ? "denied" : "error"} onRetry={reload}>{visible.message}</MortgageState>
        : <ResultsTables data={visible.data} />}
  </section>;
}

function MemberName({ member }: { member: MortgageResultsMember }) {
  const status = member.status === "active" ? "Активен" : member.status === "inactive" ? "Неактивен"
    : member.status === "invited" ? "Приглашён" : "Статус не указан";
  return <>
    <span className="block [overflow-wrap:anywhere]">{member.name.trim() || "Без имени"}</span>
    <span className="mt-1 block font-normal text-[var(--negis-muted)] [overflow-wrap:anywhere]">{roleLabels[member.role]} · {status}</span>
  </>;
}

function PortfolioCells({ counts }: { counts: Record<CountField, number> }) {
  return <>
    {[counts.assignedLeads, counts.heldLeads, counts.signedLeads, counts.heldSignedLeads].map((value, index) =>
      <td key={index} className="px-3 py-3 text-right tabular-nums">{value.toLocaleString("ru-RU")}</td>)}
    <td className="px-3 py-3 text-right tabular-nums">{percent(counts.heldLeads, counts.assignedLeads)}</td>
    <td className="px-3 py-3 text-right tabular-nums">{percent(counts.signedLeads, counts.assignedLeads)}</td>
    <td className="px-3 py-3 text-right tabular-nums">{percent(counts.heldSignedLeads, counts.heldLeads)}</td>
  </>;
}

function ResultsTables({ data }: { data: MortgageResultsData }) {
  const totals = Object.fromEntries(COUNT_FIELDS.map((field) => [field, safeSum(data.members.map((member) => member[field]))])) as Record<CountField, number>;
  const nameClass = "sticky left-0 z-10 w-44 min-w-44 max-w-44 bg-[var(--negis-surface)] px-3 py-3 font-medium";
  return <div className="min-w-0 max-w-full space-y-5">
    <section className="min-w-0 max-w-full" aria-label="Текущие клиенты сотрудников · всё время">
      <h3 className="break-words text-xs font-semibold text-[var(--negis-muted)]">Текущие клиенты сотрудников · всё время</h3>
      <p className="mt-2 break-words text-xs text-[var(--negis-muted)]">По текущему ответственному за клиента, независимо от выбранного периода. Каждый клиент учитывается один раз в каждом показателе.</p>
      <p className="mt-1 break-words text-xs text-[var(--negis-muted)]">Встреча учтена, если она завершена и её время окончания уже прошло. Договор учтён, если запись о заключении не аннулирована. «Договор после встречи» — клиенты с договором, заключённым не раньше окончания завершённой встречи.</p>
      <p className="my-3 break-words text-xs text-[var(--negis-muted)]">Без ответственного: {data.unassignedLeads.toLocaleString("ru-RU")} · Другие ответственные: {data.otherAssigneeLeads.toLocaleString("ru-RU")}. Эти клиенты не входят в итоги сотрудников.</p>
      {data.members.length === 0 ? <MortgageState kind="empty">Нет сотрудников для отчёта.</MortgageState>
        : <div className={mortgageTableClass} role="region" aria-label="Встречи, договоры и конверсии текущих клиентов" tabIndex={0}>
            <table className="w-full min-w-[1440px] table-fixed text-left text-xs">
            <thead className="bg-[var(--negis-surface-2)] text-[var(--negis-muted)]">
              <tr>
                <th scope="col" className={`${nameClass} z-20`}>Сотрудник</th>
                {["Назначено клиентов", "Клиенты со встречей", "Клиенты с договором", "Договор после встречи", "Со встречей / назначено", "С договором / назначено", "Договор после встречи / со встречей"].map((label) =>
                  <th scope="col" key={label} className="break-words px-3 py-3 text-right font-medium">{label}</th>)}
              </tr>
            </thead>
            <tbody>{data.members.map((member) => <tr key={member.staffId} className="border-t border-[var(--negis-border)] align-top hover:bg-[var(--negis-surface-2)]">
              <th scope="row" className={nameClass}><MemberName member={member} /></th>
              <PortfolioCells counts={member} />
            </tr>)}</tbody>
            <tfoot className="border-t border-[var(--negis-border)] font-semibold">
              <tr><th scope="row" className={nameClass}>Итого по сотрудникам</th><PortfolioCells counts={totals} /></tr>
            </tfoot>
          </table>
        </div>}
    </section>
    <section className="min-w-0 max-w-full border-t border-[var(--negis-border)] pt-4" aria-label="Заключённые договоры за период">
      <h3 className="break-words text-xs font-semibold">Заключённые договоры за период</h3>
      <p className="mt-2 break-words text-xs text-[var(--negis-muted)]">{data.period.days} дней · {dateTime(data.period.from, data.timeZone)} — {dateTime(data.period.to, data.timeZone)}</p>
      <p className="my-3 break-words text-xs text-[var(--negis-muted)]">По ответственному, сохранённому при заключении договора. Смена текущего ответственного не переносит результат. Аннулированные записи исключены. Количество может превышать число текущих клиентов сотрудника и не используется в конверсиях выше.</p>
      {data.members.length === 0 ? <MortgageState kind="empty">Нет сотрудников для отчёта за период.</MortgageState>
        : <div className={mortgageTableClass} role="region" aria-label="Договоры за период по сохранённому ответственному" tabIndex={0}>
          <table className="w-full min-w-[420px] table-fixed text-left text-xs">
            <thead className="bg-[var(--negis-surface-2)] text-[var(--negis-muted)]"><tr>
              <th scope="col" className={`${nameClass} z-20`}>Сотрудник</th>
              <th scope="col" className="break-words px-3 py-3 text-right font-medium">Заключённые договоры · {data.period.days} дней</th>
            </tr></thead>
            <tbody>{data.members.map((member) => <tr key={member.staffId} className="border-t border-[var(--negis-border)] align-top hover:bg-[var(--negis-surface-2)]">
              <th scope="row" className={nameClass}><MemberName member={member} /></th>
              <td className="px-3 py-3 text-right tabular-nums">{member.signedInPeriod.toLocaleString("ru-RU")}</td>
            </tr>)}</tbody>
            <tfoot className="border-t border-[var(--negis-border)] font-semibold"><tr>
              <th scope="row" className={nameClass}>Итого по сотрудникам</th>
              <td className="px-3 py-3 text-right tabular-nums">{totals.signedInPeriod.toLocaleString("ru-RU")}</td>
            </tr></tfoot>
          </table>
        </div>}
    </section>
    <p className="break-words text-xs text-[var(--negis-muted)]">Снимок: {dateTime(data.generatedAt, data.timeZone)}</p>
  </div>;
}

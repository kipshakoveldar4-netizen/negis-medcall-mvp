import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Check, Circle, ClipboardList, Flag, Loader2, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { ActivityDialog } from "@/components/mortgage/ActivityDialog";
import {
  MortgageActivityStatus as MortgageActivityBadge, MortgageIconButton, MortgageMetricStrip, MortgagePageHeader,
  mortgageButtonClass, mortgageInputClass as mortgageFieldClass, mortgagePrimaryClass,
} from "@/components/mortgage/MortgagePrimitives";
import { dayKeyInZone } from "@/lib/clinicDay";
import {
  MortgageScope, MortgageNotice, mortgageActivityDraft, mortgageAddDays,
  mortgageInstantLabel, mortgagePriorityLabels, mortgageStatusLabels, useMortgageWorkspace,
  type MortgageActivity, type MortgageActivityStatus,
} from "@/lib/mortgage-workspace";

type DueFilter = "all" | "overdue" | "today" | "week" | "none" | "range";
export type MortgageTaskFilters = { search: string; status: string; priority: string; managerId: string; due: DueFilter; from: string; to: string };

export function mortgageTaskOverdue(task: MortgageActivity, now: number): boolean {
  return task.kind === "task" && task.status !== "done" && task.status !== "cancelled" && Boolean(task.dueAt) && Date.parse(task.dueAt!) < now;
}

export function mortgageFilterTasks(items: MortgageActivity[], filters: MortgageTaskFilters, timeZone: string, now: number): MortgageActivity[] {
  const today = dayKeyInZone(now, timeZone);
  const q = filters.search.trim().toLocaleLowerCase("ru-RU");
  const ranks = { high: 0, normal: 1, low: 2 };
  return items.filter((task) => {
    if (task.kind !== "task") return false;
    if (filters.status === "active" ? task.status !== "open" && task.status !== "in_progress" : filters.status !== "all" && task.status !== filters.status) return false;
    if (filters.priority !== "all" && task.priority !== filters.priority) return false;
    if (filters.managerId !== "all" && task.responsibleUserId !== filters.managerId) return false;
    if (q && ![task.title, task.notes, task.contactName, task.responsibleName || ""].some((value) => value.toLocaleLowerCase("ru-RU").includes(q))) return false;
    const dueDay = task.dueAt && Number.isFinite(Date.parse(task.dueAt)) ? dayKeyInZone(Date.parse(task.dueAt), timeZone) : "";
    if (filters.due === "overdue" && !mortgageTaskOverdue(task, now)) return false;
    if (filters.due === "today" && dueDay !== today) return false;
    if (filters.due === "week" && (!dueDay || dueDay < today || dueDay > mortgageAddDays(today, 6))) return false;
    if (filters.due === "none" && task.dueAt) return false;
    if (filters.due === "range" && (!dueDay || (filters.from && dueDay < filters.from) || (filters.to && dueDay > filters.to))) return false;
    return true;
  }).sort((left, right) => {
    const active = (item: MortgageActivity) => item.status === "done" || item.status === "cancelled" ? 1 : 0;
    return active(left) - active(right) || Number(mortgageTaskOverdue(right, now)) - Number(mortgageTaskOverdue(left, now))
      || (left.dueAt ? Date.parse(left.dueAt) : Infinity) - (right.dueAt ? Date.parse(right.dueAt) : Infinity)
      || ranks[left.priority] - ranks[right.priority] || left.id.localeCompare(right.id);
  });
}

export default function MortgageTasks() {
  return <MortgageScope><MortgageTasksBody /></MortgageScope>;
}

function MortgageTasksBody() {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const leadId = params.get("leadId") || undefined;
  const workspace = useMortgageWorkspace({ leadId, days: 90 });
  const [filters, setFilters] = useState<MortgageTaskFilters>({ search: "", status: "active", priority: "all", managerId: "all", due: "all", from: "", to: "" });
  const [editor, setEditor] = useState<{ activity?: MortgageActivity } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, []);
  const autoOpened = useRef("");
  useEffect(() => {
    if (params.get("new") !== "1") { autoOpened.current = ""; return; }
    if (workspace.data && params.get("new") === "1" && autoOpened.current !== search) {
      autoOpened.current = search;
      setEditor({});
      const next = new URLSearchParams(search);
      next.delete("new");
      const query = next.toString();
      navigate(`${pathname}${query ? `?${query}` : ""}`, { replace: true });
    }
  }, [search, workspace.data, pathname, navigate]);
  const data = workspace.data;
  const invalidRange = filters.due === "range" && Boolean(filters.from && filters.to && filters.from > filters.to);
  const tasks = useMemo(() => data && !invalidRange ? mortgageFilterTasks(data.activities, filters, data.timeZone, now) : [], [data, filters, now, invalidRange]);
  const allTasks = data?.activities.filter((item) => item.kind === "task") ?? [];
  const overdue = allTasks.filter((task) => mortgageTaskOverdue(task, now)).length;
  const completed = allTasks.filter((task) => task.status === "done").length;
  const changeStatus = async (task: MortgageActivity, status: MortgageActivityStatus) => {
    if (pending.current.has(task.id) || !workspace.isCurrent()) return;
    pending.current.add(task.id); setBusyIds(new Set(pending.current)); setActionError("");
    try {
      await workspace.saveActivity({ ...mortgageActivityDraft(task), status }, task);
    } catch (reason) {
      if (alive.current && workspace.isCurrent()) setActionError(reason instanceof Error ? reason.message : "Не удалось изменить задачу.");
    } finally {
      pending.current.delete(task.id);
      if (alive.current && workspace.isCurrent()) setBusyIds(new Set(pending.current));
    }
  };
  return <PageLayout><div className="grid w-full min-w-0 gap-5" style={{ letterSpacing: 0 }}>
    <MortgagePageHeader title="Задачи" caption={data ? `Baspana · ${data.timeZone}` : "Baspana"}>
      <MortgageIconButton icon={RefreshCw} label="Обновить" onClick={workspace.refresh} disabled={workspace.loading} />
      <button type="button" className={mortgagePrimaryClass} disabled={!data} onClick={() => setEditor({})}><Plus className="h-4 w-4" />Новая задача</button>
    </MortgagePageHeader>
    {data && <MortgageMetricStrip items={[
      { label: "Всего задач", value: allTasks.length },
      { label: "Просрочено", value: overdue, tone: "error" },
      { label: "Выполнено", value: completed },
    ]} />}
    <div className="medina-task-filters grid min-w-0 items-end gap-3 border-b border-[var(--negis-border)] pb-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="relative col-span-2 block min-w-0"><span className="sr-only">Поиск задач</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--negis-muted)]" /><input className={`${mortgageFieldClass} pl-9`} type="search" placeholder="Задача, клиент, менеджер" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} /></label>
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]">Статус<select className={mortgageFieldClass} value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="active">Активные</option><option value="all">Все статусы</option>{(["open", "in_progress", "done", "cancelled"] as const).map((status) => <option key={status} value={status}>{status === "open" ? "Открыта" : mortgageStatusLabels[status]}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]">Приоритет<select className={mortgageFieldClass} value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))}><option value="all">Все приоритеты</option>{(["low", "normal", "high"] as const).map((priority) => <option key={priority} value={priority}>{mortgagePriorityLabels[priority]}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]">Срок<select className={mortgageFieldClass} value={filters.due} onChange={(event) => setFilters((current) => ({ ...current, due: event.target.value as DueFilter }))}><option value="all">Любой срок</option><option value="overdue">Просроченные</option><option value="today">Сегодня</option><option value="week">Ближайшие 7 дней</option><option value="none">Без срока</option><option value="range">Диапазон дат</option></select></label>
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]">Ответственный<select aria-label="Ответственный" className={mortgageFieldClass} value={filters.managerId} onChange={(event) => setFilters((current) => ({ ...current, managerId: event.target.value }))}><option value="all">Все ответственные</option>{data?.members.filter((member) => member.role === "lead_manager" || (member.role === "admin" && member.status === "active")).map((member) => <option key={member.id} value={member.id}>{member.name}{member.status !== "active" ? " (неактивен)" : ""}</option>)}</select></label>
      <button type="button" className={`${mortgageButtonClass} self-end max-sm:col-span-2`} onClick={() => setFilters({ search: "", status: "active", priority: "all", managerId: "all", due: "all", from: "", to: "" })}><X className="h-4 w-4" />Сбросить</button>
    </div>
    {filters.due === "range" && <div className="grid min-w-0 gap-3 sm:max-w-lg sm:grid-cols-2"><label className="grid min-w-0 gap-1 text-sm">С<input className={mortgageFieldClass} type="date" value={filters.from} onInput={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, from: value })); }} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label><label className="grid min-w-0 gap-1 text-sm">По<input className={mortgageFieldClass} type="date" value={filters.to} onInput={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, to: value })); }} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label></div>}
    {invalidRange && <p role="alert" className="text-sm text-red-700">Начальная дата должна быть не позже конечной.</p>}
    {leadId && <div className="flex flex-wrap gap-3 text-sm"><Link href={`/clients?leadId=${encodeURIComponent(leadId)}`} className="text-[var(--negis-primary)] underline underline-offset-2">Карточка клиента</Link><Link href="/tasks" className="text-[var(--negis-muted)] underline underline-offset-2">Все клиенты</Link></div>}
    <MortgageNotice loading={workspace.loading} error={workspace.error} refresh={workspace.refresh} truncated={data?.activitiesTruncated} />
    {actionError && <p role="alert" className="break-words border-l-2 border-red-600 pl-3 text-sm text-red-700">{actionError}</p>}
    {data && <section className="min-w-0" aria-labelledby="mortgage-task-list">
      <h2 id="mortgage-task-list" className="mb-3 flex items-center gap-2 text-base font-semibold"><ClipboardList className="h-4 w-4" />Задачи <span className="text-sm font-normal text-[var(--negis-muted)]">{tasks.length}</span></h2>
      {!tasks.length ? <p className="border-y border-[var(--negis-border)] py-10 text-center text-sm text-[var(--negis-muted)]">Задачи не найдены</p> : <ul className="space-y-2">{tasks.map((task) => {
        const isOverdue = mortgageTaskOverdue(task, now);
        const terminal = task.status === "done" || task.status === "cancelled";
        return <li key={task.id} className="flex min-w-0 items-start gap-2 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-3 sm:gap-3">
          <button type="button" className={`${mortgageButtonClass} mt-0.5 !h-10 !w-10 !px-0 ${task.status === "done" ? "text-emerald-700" : ""}`} title={task.status === "done" ? "Возобновить задачу" : terminal ? "Возобновить задачу" : "Выполнить задачу"} aria-label={`${terminal ? "Возобновить" : "Выполнить"}: ${task.title}`} disabled={busyIds.has(task.id)} onClick={() => void changeStatus(task, terminal ? "open" : "done")}>{busyIds.has(task.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : task.status === "done" ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}</button>
          <div className="min-w-0 flex-1">
            <button type="button" className={`block max-w-full break-words text-left text-sm font-semibold ${terminal ? "text-[var(--negis-muted)]" : ""}`} onClick={() => setEditor({ activity: task })}>{task.title}</button>
            <Link href={`/clients?leadId=${encodeURIComponent(task.leadId)}`} className="break-words text-sm text-[var(--negis-primary)] underline underline-offset-2">{task.contactName || "Клиент"}</Link>
            {task.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-[var(--negis-muted)]">{task.notes}</p>}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--negis-muted)]"><span className={isOverdue ? "font-medium text-red-700" : ""}>{isOverdue ? "Просрочено · " : ""}{mortgageInstantLabel(task.dueAt, data.timeZone)}</span><span className={`inline-flex items-center gap-1 ${task.priority === "high" ? "rounded bg-amber-50 px-2 py-1 text-amber-800" : ""}`}><Flag className="h-3 w-3 shrink-0" />{mortgagePriorityLabels[task.priority]}</span><MortgageActivityBadge activity={task} /><span className="break-words">{task.responsibleName || "Без менеджера"}</span></div>
          </div>
          <MortgageIconButton icon={Pencil} label={`Редактировать: ${task.title}`} disabled={busyIds.has(task.id)} onClick={() => setEditor({ activity: task })} />
        </li>;
      })}</ul>}
    </section>}
    {editor && <ActivityDialog open onOpenChange={(open) => { if (!open) setEditor(null); }} workspace={workspace} kind="task" activity={editor.activity} leadId={leadId} />}
  </div></PageLayout>;
}

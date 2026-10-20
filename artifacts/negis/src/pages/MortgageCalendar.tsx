import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Loader2, Pencil, Plus, RefreshCw, UserRoundX, X } from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { ActivityDialog } from "@/components/mortgage/ActivityDialog";
import {
  MortgageActivityStatus as MortgageActivityBadge, MortgageIconButton, MortgagePageHeader,
  mortgageButtonClass, mortgageInputClass as mortgageFieldClass, mortgagePrimaryClass, mortgageSegmentClass,
} from "@/components/mortgage/MortgagePrimitives";
import { dayKeyInZone } from "@/lib/clinicDay";
import { formatSlot, minuteOfClinicDay, placeColumn } from "@/lib/dayGrid";
import {
  MortgageScope, MortgageNotice, mortgageActivityDraft, mortgageAddDays, mortgageDateTimeToIso,
  mortgageDayLabel, mortgageInstantLabel, mortgageMonthStep,
  mortgageStatusLabels, mortgageWeekStart, useMortgageWorkspace, type MortgageActivity, type MortgageActivityStatus,
} from "@/lib/mortgage-workspace";

type Mode = "day" | "week" | "month";
type Editor = { activity?: MortgageActivity; initialStartsAt?: string };
const modes: Array<{ value: Mode; label: string }> = [{ value: "day", label: "День" }, { value: "week", label: "Неделя" }, { value: "month", label: "Месяц" }];
const tone = (status: MortgageActivityStatus) => status === "missed" ? "border-red-200 bg-red-50 text-red-900" : status === "cancelled" ? "border-zinc-200 bg-zinc-100 text-zinc-600" : status === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-emerald-200 bg-[var(--negis-primary-soft)] text-[var(--negis-text)]";

export function mortgageCalendarDays(day: string, mode: Mode): string[] {
  const start = mode === "month" ? mortgageWeekStart(`${day.slice(0, 7)}-01`) : mode === "week" ? mortgageWeekStart(day) : day;
  return Array.from({ length: mode === "month" ? 42 : mode === "week" ? 7 : 1 }, (_, index) => mortgageAddDays(start, index));
}

export function mortgageMeetingOnDay(activity: MortgageActivity, day: string, timeZone: string): boolean {
  if (activity.kind !== "meeting" || !activity.startsAt || !activity.endsAt) return false;
  const start = Date.parse(activity.startsAt), end = Date.parse(activity.endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    && dayKeyInZone(start, timeZone) <= day && dayKeyInZone(end - 1, timeZone) >= day;
}

export function mortgageMeetingColumn(items: MortgageActivity[], day: string, timeZone: string) {
  const projected = items.filter((item) => mortgageMeetingOnDay(item, day, timeZone)).flatMap((activity) => {
    const startDay = dayKeyInZone(Date.parse(activity.startsAt!), timeZone);
    const endDay = dayKeyInZone(Date.parse(activity.endsAt!), timeZone);
    const start = startDay < day ? 0 : minuteOfClinicDay(activity.startsAt!, timeZone);
    const end = endDay > day ? 1440 : minuteOfClinicDay(activity.endsAt!, timeZone);
    if (start === null || end === null || end <= start) return [];
    // Project already-zoned wall minutes onto UTC for the existing pure lane layout.
    return [{ id: activity.id, doctorId: "", doctor: "", activity, startsAt: `${day}T${formatSlot(start)}:00Z`, durationMinutes: end - start }];
  });
  return placeColumn(projected, "UTC").placed;
}

export default function MortgageCalendar() {
  return <MortgageScope><MortgageCalendarBody /></MortgageScope>;
}

function MortgageCalendarBody() {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const leadId = params.get("leadId") || undefined;
  const [mode, setMode] = useState<Mode>("week");
  const [day, setDay] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [managerId, setManagerId] = useState("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [action, setAction] = useState<{ activity: MortgageActivity; status: MortgageActivityStatus } | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scheduleRef = useRef<HTMLDivElement | null>(null);
  const scrolledPeriod = useRef("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const days = useMemo(() => day ? mortgageCalendarDays(day, mode) : [], [day, mode]);
  const query = useMemo(() => ({ leadId, days: 90, ...(timeZone && days.length ? {
    from: mortgageDateTimeToIso(`${days[0]}T00:00`, timeZone),
    to: mortgageDateTimeToIso(`${mortgageAddDays(days[days.length - 1], 1)}T00:00`, timeZone),
  } : {}) }), [leadId, days, timeZone]);
  const workspace = useMortgageWorkspace(query);
  useEffect(() => {
    if (!workspace.data) return;
    setTimeZone(workspace.data.timeZone);
    setDay((current) => current || dayKeyInZone(Date.now(), workspace.data!.timeZone));
  }, [workspace.data]);
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
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const today = timeZone ? dayKeyInZone(now, timeZone) : "";
  useEffect(() => {
    const key = `${day}:${mode}`;
    if (!workspace.data || !scheduleRef.current || scrolledPeriod.current === key) return;
    const minute = days.includes(today) ? minuteOfClinicDay(new Date(now).toISOString(), timeZone) : 0;
    scheduleRef.current.scrollTop = Math.max(0, (minute ?? 0) * 1.1 - 66);
    scrolledPeriod.current = key;
  }, [day, mode, workspace.data, days, today, timeZone, now]);
  const meetings = (workspace.data?.activities ?? []).filter((item) => item.kind === "meeting" && (managerId === "all" || item.responsibleUserId === managerId))
    .sort((left, right) => Date.parse(left.startsAt!) - Date.parse(right.startsAt!) || left.id.localeCompare(right.id));
  const visibleMeetings = meetings.filter((item) => days.some((date) => mortgageMeetingOnDay(item, date, timeZone)));
  const managers = workspace.data?.members.filter((member) => member.role === "lead_manager" || (member.role === "admin" && member.status === "active")) ?? [];
  const newAt = (date: string, minute?: number) => setEditor({ initialStartsAt: `${date}T${formatSlot(minute ?? (date === today ? (minuteOfClinicDay(new Date(now).toISOString(), timeZone) ?? 0) : 0))}` });
  const move = (direction: number) => setDay((current) => mode === "month" ? mortgageMonthStep(current, direction) : mortgageAddDays(current, direction * (mode === "week" ? 7 : 1)));
  const changeStatus = async () => {
    if (!action || busyRef.current || !workspace.isCurrent()) return;
    busyRef.current = true; setBusy(true); setActionError("");
    try {
      await workspace.saveActivity({ ...mortgageActivityDraft(action.activity), status: action.status }, action.activity);
      if (alive.current && workspace.isCurrent()) setAction(null);
    } catch (reason) {
      if (alive.current && workspace.isCurrent()) setActionError(reason instanceof Error ? reason.message : "Не удалось изменить встречу.");
    } finally { busyRef.current = false; if (alive.current && workspace.isCurrent()) setBusy(false); }
  };
  const title = day ? mode === "month" ? mortgageDayLabel(day, { month: "long", year: "numeric" }) : mode === "day" ? mortgageDayLabel(day, { day: "numeric", month: "long", year: "numeric" }) : `${mortgageDayLabel(days[0])} - ${mortgageDayLabel(days[6], { day: "numeric", month: "long", year: "numeric" })}` : "Календарь";
  return <PageLayout><div className="grid w-full min-w-0 gap-5" style={{ letterSpacing: 0 }}>
    <MortgagePageHeader title="Календарь встреч" caption={timeZone ? `Baspana · ${timeZone}` : "Baspana"}>
      <MortgageIconButton icon={RefreshCw} label="Обновить" onClick={workspace.refresh} disabled={workspace.loading} />
      <button type="button" className={mortgagePrimaryClass} disabled={!workspace.data} onClick={() => setEditor({})}><Plus className="h-4 w-4" />Новая встреча</button>
    </MortgagePageHeader>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <MortgageIconButton icon={ChevronLeft} label="Предыдущий период" disabled={!day} onClick={() => move(-1)} />
          <MortgageIconButton icon={ChevronRight} label="Следующий период" disabled={!day} onClick={() => move(1)} />
          <button type="button" className={mortgageButtonClass} disabled={!today} onClick={() => setDay(today)}>Сегодня</button>
        </div>
        <label className="sr-only" htmlFor="mortgage-calendar-date">Дата</label><input id="mortgage-calendar-date" type="date" className={`${mortgageFieldClass} !w-40`} value={day} onInput={(event) => { if (event.currentTarget.value) setDay(event.currentTarget.value); }} onChange={(event) => { if (event.target.value) setDay(event.target.value); }} disabled={!timeZone} />
      </div>
      <div role="group" aria-label="Вид календаря" className="inline-flex max-w-full items-center rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-0.5">{modes.map((option) => <button type="button" key={option.value} aria-pressed={mode === option.value} className={mortgageSegmentClass} onClick={() => setMode(option.value)}>{option.label}</button>)}</div>
    </div>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 className="min-w-0 break-words text-base font-semibold capitalize">{title}</h2>
      <label className="grid w-full min-w-0 gap-1 text-xs text-[var(--negis-muted)] sm:w-64"><span>Ответственный</span><select aria-label="Ответственный" className={mortgageFieldClass} value={managerId} onChange={(event) => setManagerId(event.target.value)}><option value="all">Все ответственные</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}{manager.status !== "active" ? " (неактивен)" : ""}</option>)}</select></label>
    </div>
    {leadId && <div className="flex flex-wrap items-center gap-3 text-sm"><Link href={`/clients?leadId=${encodeURIComponent(leadId)}`} className="font-medium text-[var(--negis-primary)] underline underline-offset-2">Карточка клиента</Link><Link href="/appointments" className="text-[var(--negis-muted)] underline underline-offset-2">Все клиенты</Link></div>}
    <MortgageNotice loading={workspace.loading} error={workspace.error} refresh={workspace.refresh} truncated={workspace.data?.activitiesTruncated} />
    {workspace.data && day && (mode === "month" ? <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)]" role="region" tabIndex={0} aria-label="Календарь встреч, месяц">
      <div className="grid min-w-[700px] grid-cols-7">
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((name) => <div key={name} className="border-b border-[var(--negis-border)] py-2 text-center text-xs font-medium text-[var(--negis-muted)]">{name}</div>)}
        {days.map((date) => {
          const entries = meetings.filter((item) => mortgageMeetingOnDay(item, date, timeZone));
          return <div key={date} className={`min-h-32 min-w-0 border-b border-r border-[var(--negis-border)] p-1.5 ${date.slice(0, 7) !== day.slice(0, 7) ? "bg-[var(--negis-surface-2)]" : ""}`}>
            <div className="mb-1 flex items-center justify-between gap-1"><button type="button" className={`h-8 min-w-8 rounded text-sm ${date === today ? "bg-[var(--negis-primary-soft)] font-semibold text-[var(--negis-primary)]" : ""}`} title={mortgageDayLabel(date)} onClick={() => { setDay(date); setMode("day"); }}>{Number(date.slice(8))}</button><button type="button" className="flex h-8 w-8 items-center justify-center rounded hover:bg-[var(--negis-surface-2)]" title={`Создать встречу: ${mortgageDayLabel(date)}`} aria-label={`Создать встречу: ${mortgageDayLabel(date)}`} onClick={() => newAt(date)}><Plus className="h-3.5 w-3.5" /></button></div>
            <div className="grid gap-1">{entries.slice(0, 3).map((item) => <button type="button" key={item.id} className={`min-w-0 rounded border px-1.5 py-1 text-left text-xs ${tone(item.status)}`} title={`${item.title}, ${item.contactName}, ${mortgageStatusLabels[item.status]}`} onClick={() => setEditor({ activity: item })}><span className="block truncate font-medium">{mortgageLocalTime(item.startsAt, timeZone)} {item.title}</span><span className="block truncate">{item.contactName}</span></button>)}{entries.length > 3 && <button type="button" className="py-1 text-left text-xs text-[var(--negis-primary)]" onClick={() => { setDay(date); setMode("day"); }}>Ещё {entries.length - 3}</button>}</div>
          </div>;
        })}
      </div>
    </div> : <div ref={scheduleRef} className="max-h-[620px] min-w-0 max-w-full overflow-auto rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)]" role="region" tabIndex={0} aria-label="Расписание встреч, 24 часа">
      <div style={{ minWidth: mode === "week" ? 850 : 280 }}>
        <div className="sticky top-0 z-20 grid border-b border-[var(--negis-border)] bg-[var(--negis-surface)]" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="py-3 text-center text-xs text-[var(--negis-muted)]"><Clock3 className="mx-auto h-4 w-4" /></div>
          {days.map((date) => <button type="button" key={date} className={`min-w-0 border-l border-[var(--negis-border)] px-1 py-3 text-center text-xs ${date === today ? "bg-[var(--negis-primary-soft)] font-semibold text-[var(--negis-primary)]" : "text-[var(--negis-muted)]"}`} title={mortgageDayLabel(date)} onClick={() => { setDay(date); setMode("day"); }}>{mortgageDayLabel(date, { weekday: "short", day: "numeric", month: "short" })}</button>)}
        </div>
        <div className="grid" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="relative" style={{ height: 1440 * 1.1 }}>{Array.from({ length: 24 }, (_, hour) => <span key={hour} className="absolute right-2 text-[10px] text-[var(--negis-muted)]" style={{ top: hour * 66 + 2 }}>{formatSlot(hour * 60)}</span>)}</div>
          {days.map((date) => <div key={date} className={`relative border-l border-[var(--negis-border)] ${date === today ? "bg-emerald-50/40" : ""}`} style={{ height: 1440 * 1.1 }}>
            {Array.from({ length: 48 }, (_, slot) => <button type="button" key={slot} title={`${mortgageDayLabel(date)}, ${formatSlot(slot * 30)}: новая встреча`} aria-label={`${mortgageDayLabel(date)}, ${formatSlot(slot * 30)}: новая встреча`} className={`absolute left-0 min-h-0 w-full text-left hover:bg-[var(--negis-surface-2)] ${slot % 2 === 0 ? "border-t border-[var(--negis-border)]" : "border-t border-dashed border-[var(--negis-border)]/50"}`} style={{ top: slot * 33, height: 33 }} onClick={() => newAt(date, slot * 30)} />)}
            {mortgageMeetingColumn(meetings, date, timeZone).map(({ item, startMinute, endMinute, lane, lanes }) => <button type="button" key={item.id} className={`absolute z-10 min-h-0 overflow-hidden rounded border text-left text-[11px] leading-tight ${tone(item.activity.status)}`} style={{ top: startMinute * 1.1, height: (endMinute - startMinute) * 1.1, left: `calc(${lane / lanes * 100}% + 1px)`, width: `calc(${100 / lanes}% - 2px)` }} title={`${item.activity.title}; ${item.activity.contactName}; ${mortgageInstantLabel(item.activity.startsAt, timeZone)} - ${mortgageInstantLabel(item.activity.endsAt, timeZone)}; ${item.activity.responsibleName || "Без менеджера"}; ${mortgageStatusLabels[item.activity.status]}`} aria-label={`${item.activity.title}, ${item.activity.contactName}, ${mortgageInstantLabel(item.activity.startsAt, timeZone)}`} onClick={() => setEditor({ activity: item.activity })}>{endMinute - startMinute >= 20 && <span className="block px-1 py-0.5"><span className="block truncate font-semibold">{formatSlot(startMinute)} {item.activity.title}</span><span className="block truncate">{item.activity.contactName}</span>{endMinute - startMinute >= 45 && <span className="block truncate">{item.activity.responsibleName}</span>}</span>}</button>)}
          </div>)}
        </div>
      </div>
    </div>)}
    {action && <section role="alertdialog" aria-labelledby="mortgage-meeting-action" className="grid gap-3 border-y border-[var(--negis-border)] py-4">
      <h3 id="mortgage-meeting-action" className="break-words text-sm font-medium">{mortgageStatusLabels[action.status]}: {action.activity.title}?</h3>
      <div className="flex flex-wrap gap-2"><button type="button" className={mortgagePrimaryClass} disabled={busy} onClick={() => void changeStatus()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Подтвердить</button><button type="button" className={mortgageButtonClass} disabled={busy} onClick={() => { setAction(null); setActionError(""); }}>Назад</button></div>
      {actionError && <p role="alert" className="break-words text-sm text-red-700">{actionError}</p>}
    </section>}
    {workspace.data && <section className="min-w-0" aria-labelledby="mortgage-meetings-list">
      <h2 id="mortgage-meetings-list" className="mb-3 flex items-center gap-2 text-base font-semibold"><CalendarDays className="h-4 w-4" />Встречи <span className="text-sm font-normal text-[var(--negis-muted)]">{visibleMeetings.length}</span></h2>
      {!visibleMeetings.length ? <p className="border-y border-[var(--negis-border)] py-8 text-center text-sm text-[var(--negis-muted)]">В этом периоде встреч нет</p> : <ul className="space-y-2">{visibleMeetings.map((item) => <li key={item.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-3 md:flex-row md:items-center">
        <div className="w-full shrink-0 text-sm md:w-44"><p>{mortgageInstantLabel(item.startsAt, timeZone)}</p><p className="text-xs text-[var(--negis-muted)]">до {mortgageInstantLabel(item.endsAt, timeZone)}</p></div>
        <div className="min-w-0 flex-1"><button type="button" className="block max-w-full break-words text-left text-sm font-semibold" onClick={() => setEditor({ activity: item })}>{item.title}</button><Link href={`/clients?leadId=${encodeURIComponent(item.leadId)}`} className="break-words text-sm text-[var(--negis-primary)] underline underline-offset-2">{item.contactName || "Клиент"}</Link><div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--negis-muted)]"><span className="break-words">{item.responsibleName || "Без менеджера"}</span><MortgageActivityBadge activity={item} /></div></div>
        <div className="flex shrink-0 flex-wrap gap-2"><MortgageIconButton icon={Pencil} label={`Редактировать: ${item.title}`} onClick={() => setEditor({ activity: item })} />{item.status === "open" && <>
          <MortgageIconButton icon={Check} label={`Завершить: ${item.title}`} disabled={busy} onClick={() => { setAction({ activity: item, status: "done" }); setActionError(""); }} />
          <MortgageIconButton icon={UserRoundX} label={`Неявка: ${item.title}`} disabled={busy} onClick={() => { setAction({ activity: item, status: "missed" }); setActionError(""); }} />
          <MortgageIconButton icon={X} label={`Отменить: ${item.title}`} disabled={busy} onClick={() => { setAction({ activity: item, status: "cancelled" }); setActionError(""); }} />
        </>}</div>
      </li>)}</ul>}
    </section>}
    {editor && <ActivityDialog open onOpenChange={(open) => { if (!open) setEditor(null); }} workspace={workspace} kind="meeting" activity={editor.activity} leadId={leadId} initialStartsAt={editor.initialStartsAt} />}
  </div></PageLayout>;
}

function mortgageLocalTime(iso: string | null, timeZone: string): string {
  const minute = iso ? minuteOfClinicDay(iso, timeZone) : null;
  return minute === null ? "" : formatSlot(minute);
}

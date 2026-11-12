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
const calendarMinutes = Array.from({ length: 49 }, (_, index) => index * 30);
const calendarMinuteHeight = 1;
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

export function mortgageMeetingColumn(items: MortgageActivity[], day: string, timeZone: string, bounds: readonly [number, number] = [0, 1440]) {
  const projected = items.filter((item) => mortgageMeetingOnDay(item, day, timeZone)).flatMap((activity) => {
    const startDay = dayKeyInZone(Date.parse(activity.startsAt!), timeZone);
    const endDay = dayKeyInZone(Date.parse(activity.endsAt!), timeZone);
    const start = startDay < day ? 0 : minuteOfClinicDay(activity.startsAt!, timeZone);
    const end = endDay > day ? 1440 : minuteOfClinicDay(activity.endsAt!, timeZone);
    if (start === null || end === null || end <= start) return [];
    const visibleStart = Math.max(start, bounds[0]), visibleEnd = Math.min(end, bounds[1]);
    if (visibleEnd <= visibleStart) return [];
    // Project already-zoned wall minutes onto UTC for the existing pure lane layout.
    return [{ id: activity.id, doctorId: "", doctor: "", activity, startsAt: `${day}T${formatSlot(visibleStart)}:00Z`, durationMinutes: visibleEnd - visibleStart }];
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
  const [workingHours, setWorkingHours] = useState<[number, number]>([8 * 60, 19 * 60]);
  const [allHours, setAllHours] = useState(false);
  const [dayStart, dayEnd] = allHours ? [0, 1440] : workingHours;
  const gridHeight = (dayEnd - dayStart) * calendarMinuteHeight;
  const hourMarks = calendarMinutes.filter((minute) => minute >= dayStart && minute <= dayEnd && (minute === dayStart || minute === dayEnd || minute % 60 === 0));
  const slots = calendarMinutes.filter((minute) => minute >= dayStart && minute < dayEnd);
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
    const key = `${day}:${mode}:${dayStart}:${dayEnd}`;
    if (!workspace.data || !scheduleRef.current || scrolledPeriod.current === key) return;
    scheduleRef.current.scrollTop = 0;
    scrolledPeriod.current = key;
  }, [day, mode, workspace.data, dayStart, dayEnd]);
  const meetings = (workspace.data?.activities ?? []).filter((item) => item.kind === "meeting" && (managerId === "all" || item.responsibleUserId === managerId))
    .sort((left, right) => Date.parse(left.startsAt!) - Date.parse(right.startsAt!) || left.id.localeCompare(right.id));
  const visibleMeetings = meetings.filter((item) => days.some((date) => mortgageMeetingOnDay(item, date, timeZone)));
  const outsideHours = visibleMeetings.filter((item) => days.some((date) => mortgageMeetingColumn([item], date, timeZone)
    .some(({ startMinute, endMinute }) => startMinute < workingHours[0] || endMinute > workingHours[1]))).length;
  const managers = workspace.data?.members.filter((member) => member.role === "lead_manager" || (member.role === "admin" && member.status === "active")) ?? [];
  const newAt = (date: string, minute = dayStart) => setEditor({ initialStartsAt: `${date}T${formatSlot(minute)}` });
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
      <button type="button" className={mortgagePrimaryClass} disabled={!workspace.data || !day} onClick={() => newAt(day)}><Plus className="h-4 w-4" />Новая встреча</button>
    </MortgagePageHeader>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <MortgageIconButton icon={ChevronLeft} label="Предыдущий период" disabled={!day} onClick={() => move(-1)} />
          <MortgageIconButton icon={ChevronRight} label="Следующий период" disabled={!day} onClick={() => move(1)} />
          <button type="button" className={`${mortgageButtonClass} !px-2 sm:!px-4`} disabled={!today} onClick={() => setDay(today)}>Сегодня</button>
        </div>
        <label className="sr-only" htmlFor="mortgage-calendar-date">Дата</label><input id="mortgage-calendar-date" type="date" className={`${mortgageFieldClass} !w-36 sm:!w-40`} value={day} onInput={(event) => { if (event.currentTarget.value) setDay(event.currentTarget.value); }} onChange={(event) => { if (event.target.value) setDay(event.target.value); }} disabled={!timeZone} />
      </div>
      <div role="group" aria-label="Вид календаря" className="inline-flex max-w-full items-center rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-0.5">{modes.map((option) => <button type="button" key={option.value} aria-pressed={mode === option.value} className={mortgageSegmentClass} onClick={() => setMode(option.value)}>{option.label}</button>)}</div>
    </div>
    {mode !== "month" && <div className="flex min-w-0 flex-wrap items-end gap-2 sm:gap-3" role="group" aria-label="Часы календаря">
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]"><span>С</span><select aria-label="Начало отображаемого дня" className={`${mortgageFieldClass} !w-24 sm:!w-28`} disabled={allHours} value={workingHours[0]} onChange={(event) => setWorkingHours(([start, end]) => { const minute = Number(event.target.value); return Number.isInteger(minute) && minute >= 0 && minute < end && minute % 30 === 0 ? [minute, end] : [start, end]; })}>{calendarMinutes.filter((minute) => minute < workingHours[1]).map((minute) => <option key={minute} value={minute}>{formatSlot(minute)}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-xs text-[var(--negis-muted)]"><span>До</span><select aria-label="Конец отображаемого дня" className={`${mortgageFieldClass} !w-24 sm:!w-28`} disabled={allHours} value={workingHours[1]} onChange={(event) => setWorkingHours(([start, end]) => { const minute = Number(event.target.value); return Number.isInteger(minute) && minute > start && minute <= 1440 && minute % 30 === 0 ? [start, minute] : [start, end]; })}>{calendarMinutes.filter((minute) => minute > workingHours[0]).map((minute) => <option key={minute} value={minute}>{formatSlot(minute)}</option>)}</select></label>
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--negis-primary)]" checked={allHours} onChange={(event) => setAllHours(event.target.checked)} />Все сутки</label>
      {!allHours && outsideHours > 0 && <span role="status" className="self-center text-xs text-[var(--negis-muted)]">Встреч вне диапазона: {outsideHours}</span>}
    </div>}
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 className="min-w-0 flex-1 break-words text-sm font-semibold capitalize sm:text-base">{title}</h2>
      <label className="grid w-40 min-w-0 gap-1 text-xs text-[var(--negis-muted)] sm:w-64"><span className="sr-only sm:not-sr-only">Ответственный</span><select aria-label="Ответственный" className={mortgageFieldClass} value={managerId} onChange={(event) => setManagerId(event.target.value)}><option value="all">Все ответственные</option>{managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}{manager.status !== "active" ? " (неактивен)" : ""}</option>)}</select></label>
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
    </div> : <div ref={scheduleRef} className="max-h-[720px] min-w-0 max-w-full overflow-auto rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)]" role="region" tabIndex={0} aria-label={`Расписание встреч, ${formatSlot(dayStart)}–${formatSlot(dayEnd)}`}>
      <div style={{ minWidth: mode === "week" ? 850 : 280 }}>
        <div className="sticky top-0 z-20 grid border-b border-[var(--negis-border)] bg-[var(--negis-surface)]" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="sticky left-0 z-30 bg-[var(--negis-surface)] py-3 text-center text-xs text-[var(--negis-muted)]"><Clock3 className="mx-auto h-4 w-4" /></div>
          {days.map((date) => <button type="button" key={date} className={`min-w-0 border-l border-[var(--negis-border)] px-1 py-3 text-center text-xs ${date === today ? "bg-[var(--negis-primary-soft)] font-semibold text-[var(--negis-primary)]" : "text-[var(--negis-muted)]"}`} title={mortgageDayLabel(date)} onClick={() => { setDay(date); setMode("day"); }}>{mortgageDayLabel(date, { weekday: "short", day: "numeric", month: "short" })}</button>)}
        </div>
        <div className="grid" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="sticky left-0 z-10 bg-[var(--negis-surface)]" style={{ height: gridHeight }}>{hourMarks.map((minute) => <span key={minute} className="absolute right-2 text-[10px] leading-none text-[var(--negis-muted)]" style={{ top: Math.min(gridHeight - 12, (minute - dayStart) * calendarMinuteHeight + 2) }}>{formatSlot(minute)}</span>)}</div>
          {days.map((date) => <div key={date} className={`relative border-l border-[var(--negis-border)] ${date === today ? "bg-emerald-50/40" : ""}`} style={{ height: gridHeight }}>
            {slots.map((minute) => <button type="button" key={minute} title={`${mortgageDayLabel(date)}, ${formatSlot(minute)}: новая встреча`} aria-label={`${mortgageDayLabel(date)}, ${formatSlot(minute)}: новая встреча`} className={`absolute left-0 min-h-0 w-full text-left hover:bg-[var(--negis-surface-2)] ${minute % 60 === 0 ? "border-t border-[var(--negis-border)]" : "border-t border-dashed border-[var(--negis-border)]/50"}`} style={{ top: (minute - dayStart) * calendarMinuteHeight, height: 30 * calendarMinuteHeight }} onClick={() => newAt(date, minute)} />)}
            {mortgageMeetingColumn(meetings, date, timeZone, [dayStart, dayEnd]).map(({ item, startMinute, endMinute, lane, lanes }) => <button type="button" key={item.id} className={`absolute z-10 min-h-0 overflow-hidden rounded border text-left text-[11px] leading-tight ${tone(item.activity.status)}`} style={{ top: (startMinute - dayStart) * calendarMinuteHeight, height: (endMinute - startMinute) * calendarMinuteHeight, left: `calc(${lane / lanes * 100}% + 1px)`, width: `calc(${100 / lanes}% - 2px)` }} title={`${item.activity.title}; ${item.activity.contactName}; ${mortgageInstantLabel(item.activity.startsAt, timeZone)} - ${mortgageInstantLabel(item.activity.endsAt, timeZone)}; ${item.activity.responsibleName || "Без менеджера"}; ${mortgageStatusLabels[item.activity.status]}`} aria-label={`${item.activity.title}, ${item.activity.contactName}, ${mortgageInstantLabel(item.activity.startsAt, timeZone)}`} onClick={() => setEditor({ activity: item.activity })}>{endMinute - startMinute >= 20 && <span className="block px-1 py-0.5"><span className="block truncate font-semibold">{mortgageLocalTime(item.activity.startsAt, timeZone)} {item.activity.title}</span><span className="block truncate">{item.activity.contactName}</span>{endMinute - startMinute >= 45 && <span className="block truncate">{item.activity.responsibleName}</span>}</span>}</button>)}
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

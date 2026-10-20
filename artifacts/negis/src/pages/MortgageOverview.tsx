import { useEffect, useState } from "react";
import { AlarmClock, ArrowDownLeft, ArrowUpRight, BarChart3, CalendarDays, Check, CheckSquare, ChevronRight, Clock3, Inbox, ListFilter, RefreshCw, Users, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { MortgageScope, useMortgageWorkspace } from "@/lib/mortgage-workspace";
import { formatPhone, toTelHref } from "@/lib/phone";
import { dayKeyInZone } from "@/lib/clinicDay";
import type { MortgageActivity } from "../../../../lib/crm/mortgage-contract";
import {
  MortgageIconButton, MortgageState, mortgageActivityHref, mortgagePrimaryClass,
  mortgageContactStatus, mortgageDate, mortgageErrorMessage,
} from "@/components/mortgage/MortgagePrimitives";

export default function MortgageOverview() {
  return <PageLayout><MortgageScope><MortgageOverviewBody /></MortgageScope></PageLayout>;
}

function MortgageOverviewBody() {
  const { clinicId, userRole, availableWorkspaces } = useAuth();
  const workspace = useMortgageWorkspace();
  const [now, setNow] = useState(Date.now);
  const [agenda, setAgenda] = useState<"meetings" | "tasks">("meetings");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const teamAccess = userRole === "owner" || userRole === "admin";
  const data = workspace.isCurrent() && !workspace.loading && !workspace.error ? workspace.data : null;
  const workspaceName = availableWorkspaces?.find((item) => item.id === clinicId)?.name || "Baspana";
  const meetings = data?.activities.filter((activity) => activity.kind === "meeting"
    && (activity.status === "open" || activity.status === "in_progress") && activity.startsAt
    && (Date.parse(activity.startsAt) >= now || Boolean(activity.endsAt && Date.parse(activity.endsAt) > now)))
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!)).slice(0, 5) || [];
  const tasks = data?.activities.filter((activity) => activity.kind === "task"
    && (activity.status === "open" || activity.status === "in_progress"))
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
      || a.id.localeCompare(b.id)).slice(0, 5) || [];
  const unassigned = teamAccess ? data?.contacts.filter((contact) => !contact.responsibleUserId).slice(0, 5) || [] : [];
  const recent = teamAccess ? unassigned : data?.contacts.filter((contact) => Boolean(contact.responsibleUserId)).slice(0, 5) || [];
  const memberRows = teamAccess ? data?.memberMetrics || [] : [];
  const maxLoad = Math.max(1, ...memberRows.map((member) => member.assignedLeads));
  const completedTasks = memberRows.reduce((sum, member) => sum + member.doneTasks, 0);
  const completedMeetings = memberRows.reduce((sum, member) => sum + member.doneMeetings, 0);
  const dateLabel = data ? new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(now) : "";

  return <div className="mx-auto w-full min-w-0 max-w-[1440px] space-y-6" style={{ letterSpacing: 0 }}>
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="mb-1.5 text-xs font-medium text-[var(--negis-muted)]">{teamAccess ? "Рабочее пространство команды" : "Мой рабочий день"}</p>
        <h1 className="break-words text-2xl font-semibold text-[var(--negis-text)]">{workspaceName}</h1>
        {data && <p className="mt-1.5 text-sm capitalize text-[var(--negis-muted)]">{dateLabel}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <MortgageIconButton icon={RefreshCw} label="Обновить обзор" className="max-sm:h-11 max-sm:w-11" disabled={workspace.loading || !workspace.isCurrent()} onClick={() => { if (workspace.isCurrent()) void workspace.refresh(); }} />
        <Link href="/leads" className={`${mortgagePrimaryClass} !hidden sm:!inline-flex`}><ListFilter size={15} aria-hidden="true" />Заявки<ArrowUpRight size={15} aria-hidden="true" /></Link>
      </div>
    </header>

    {!clinicId ? <MortgageState kind="denied">Рабочее пространство не выбрано.</MortgageState>
      : workspace.loading ? <MortgageState kind="loading">Загрузка обзора...</MortgageState>
      : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
      : !data ? <MortgageState kind="empty">Обзор недоступен.</MortgageState>
      : <>
        <dl className="grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Показатели рабочего пространства">
          <OverviewMetric label={teamAccess ? "Всего заявок" : "Мои заявки"} value={data.metrics.totalLeads} icon={Inbox} href="/leads" tone="neutral" />
          <OverviewMetric label="В работе" value={data.metrics.inProgressLeads} icon={ListFilter} href="/leads" tone="green" />
          <OverviewMetric label="Встречи сегодня" value={data.metrics.meetingsToday} icon={CalendarDays} href="/appointments" tone="blue" />
          <OverviewMetric label="Просроченные задачи" value={data.metrics.overdueTasks} icon={AlarmClock} href="/tasks" tone={data.metrics.overdueTasks ? "red" : "neutral"} />
        </dl>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-3 border-y border-[var(--negis-border)] py-3 text-sm">
          {teamAccess ? <Link href="/leads" className="flex min-w-0 items-center gap-2.5 font-medium hover:underline">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${data.metrics.unassignedLeads ? "bg-amber-100 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>
              {data.metrics.unassignedLeads ? <ArrowDownLeft size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            </span>
            <span className="min-w-0 break-words">{data.metrics.unassignedLeads ? <><strong className="tabular-nums">{data.metrics.unassignedLeads.toLocaleString("ru-RU")}</strong> без ответственного</> : "Все заявки назначены"}</span>
            <ArrowUpRight size={14} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" />
          </Link> : <span className="flex items-center gap-2 text-[var(--negis-muted)]"><Users size={16} aria-hidden="true" />Только назначенные вам заявки</span>}
          <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--negis-muted)]">
            {teamAccess && <span className="flex items-center gap-1.5"><Users size={14} aria-hidden="true" />Активные менеджеры: <strong className="font-medium text-[var(--negis-text)]">{data.metrics.activeManagers}</strong></span>}
            <span>{data.timeZone}</span>
          </div>
        </div>

        {data.activitiesTruncated && <p role="status" className="border-l-2 border-amber-500 pl-3 text-sm text-amber-800">Встречи и задачи: неполная выборка. Счётчики полные.</p>}

        <div className={`grid min-w-0 gap-7 ${teamAccess ? "xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]" : "lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,1fr)]"}`}>
          <section className="min-w-0" aria-labelledby="mortgage-agenda">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
              <h2 id="mortgage-agenda" className="text-base font-semibold">Ближайшие дела</h2>
              <Link href={agenda === "meetings" ? "/appointments" : "/tasks"} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--negis-primary)] hover:underline">{agenda === "meetings" ? "Календарь" : "Все задачи"}<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
            <div role="group" aria-label="Вид ближайших дел" className="mb-1 flex gap-5 border-b border-[var(--negis-border)]">
              {([{ key: "meetings", label: "Встречи", icon: CalendarDays }, { key: "tasks", label: "Задачи", icon: CheckSquare }] as const).map(({ key, label, icon: Icon }) =>
                <button key={key} type="button" aria-pressed={agenda === key} onClick={() => { if (workspace.isCurrent()) setAgenda(key); }}
                  className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] ${agenda === key ? "border-[var(--negis-primary)] text-[var(--negis-primary)]" : "border-transparent text-[var(--negis-muted)]"}`}>
                  <Icon size={15} aria-hidden="true" />{label}
                </button>)}
            </div>
            {(agenda === "meetings" ? meetings : tasks).length ? <ul className="divide-y divide-[var(--negis-border)]">
              {(agenda === "meetings" ? meetings : tasks).map((activity) => <OverviewActivity key={activity.id} activity={activity} timeZone={data.timeZone} now={now} />)}
            </ul> : <div className="flex min-h-44 flex-col items-center justify-center gap-2 py-8 text-center text-[var(--negis-muted)]" role="status">
              {agenda === "meetings" ? <CalendarDays size={24} strokeWidth={1.5} aria-hidden="true" /> : <CheckSquare size={24} strokeWidth={1.5} aria-hidden="true" />}
              <p className="text-sm font-medium">{agenda === "meetings" ? "В выборке нет ближайших встреч" : "В выборке нет открытых задач"}</p>
              <Link href={agenda === "meetings" ? "/appointments" : "/tasks"} className="text-xs text-[var(--negis-primary)] hover:underline">{agenda === "meetings" ? "Открыть календарь" : "Открыть задачи"}</Link>
            </div>}
          </section>

          {teamAccess ? <section className="min-w-0 border-t border-[var(--negis-border)] pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0" aria-labelledby="mortgage-team-load">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <h2 id="mortgage-team-load" className="text-base font-semibold">Нагрузка команды</h2>
              <Link href="/analytics" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--negis-primary)] hover:underline">Аналитика<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
            <p className="mb-4 text-xs text-[var(--negis-muted)]">Назначенные заявки · сейчас</p>
            {memberRows.length ? <ul className="space-y-4">{memberRows.map((member, index) => <li key={member.id} className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${index % 2 ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-800"}`}>{initials(member.name)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-2 text-sm"><span className="min-w-0 break-words font-medium">{member.name || "Без имени"}</span><strong className="shrink-0 font-semibold tabular-nums">{member.assignedLeads.toLocaleString("ru-RU")}</strong></div>
                <div className="mb-1.5 mt-1 h-1.5 overflow-hidden rounded-sm bg-[var(--negis-border)]" aria-hidden="true"><div className={`h-full rounded-sm ${index % 2 ? "bg-blue-500" : "bg-emerald-500"}`} style={{ width: `${member.assignedLeads / maxLoad * 100}%` }} /></div>
                <p className="break-words text-xs text-[var(--negis-muted)]">Задач: {member.openTasks} · Плановых встреч: {member.plannedMeetings}{Boolean(member.overdueTasks) && <span className="text-red-700"> · Просрочено: {member.overdueTasks}</span>}</p>
              </div>
            </li>)}</ul> : <MortgageState kind="empty">Нет данных по сотрудникам.</MortgageState>}
            <div className="mt-5 border-t border-[var(--negis-border)] pt-4">
              <h3 className="flex items-center gap-2 text-xs font-medium text-[var(--negis-muted)]"><BarChart3 size={14} aria-hidden="true" />Отметки сотрудников · {data.periodDays} дней</h3>
              <dl className="mt-3 grid grid-cols-2 gap-3"><div><dt className="text-xs text-[var(--negis-muted)]">Завершили задач</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{completedTasks.toLocaleString("ru-RU")}</dd></div><div><dt className="text-xs text-[var(--negis-muted)]">Завершили встреч</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{completedMeetings.toLocaleString("ru-RU")}</dd></div></dl>
            </div>
          </section> : <section className="min-w-0 border-t border-[var(--negis-border)] pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0" aria-labelledby="mortgage-own-work">
            <h2 id="mortgage-own-work" className="mb-4 text-base font-semibold">Моя работа</h2>
            <nav aria-label="Моя работа" className="divide-y divide-[var(--negis-border)]">
              {([{ href: "/clients", label: "Клиенты", icon: Users }, { href: "/appointments", label: "Календарь", icon: CalendarDays }, { href: "/tasks", label: "Задачи", icon: CheckSquare }]).map(({ href, label, icon: Icon }) => <Link key={href} href={href} className="flex min-h-14 items-center gap-3 py-3 text-sm font-medium hover:text-[var(--negis-primary)]"><Icon size={18} className="text-[var(--negis-muted)]" aria-hidden="true" />{label}<ChevronRight size={16} className="ml-auto" aria-hidden="true" /></Link>)}
            </nav>
          </section>}
        </div>

        <section className="min-w-0 border-t border-[var(--negis-border)] pt-5" aria-labelledby="mortgage-overview-contacts">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h2 id="mortgage-overview-contacts" className="text-base font-semibold">{teamAccess ? "Заявки без ответственного" : "Последние заявки"}</h2><p className="mt-1 text-xs text-[var(--negis-muted)]">{teamAccess ? `Показано: ${recent.length} · Всего без ответственного: ${data.metrics.unassignedLeads.toLocaleString("ru-RU")}` : `Показано ${recent.length} из ${data.contactsTotal.toLocaleString("ru-RU")}`}</p></div>
            <Link href={teamAccess ? "/leads" : "/clients"} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--negis-primary)] hover:underline">{teamAccess ? "Распределение заявок" : "Все клиенты"}<ArrowUpRight size={14} aria-hidden="true" /></Link>
          </div>
          {recent.length ? <ul className="divide-y divide-[var(--negis-border)]">{recent.map((contact) => <li key={contact.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="min-w-0"><Link href={`/clients?leadId=${encodeURIComponent(contact.id)}`} className="block break-words text-sm font-medium hover:text-[var(--negis-primary)] hover:underline">{contact.name || "Без имени"}</Link><span className="mt-1 block text-xs text-[var(--negis-muted)]">{contact.source === "manual" ? "Вручную" : contact.source === "whatsapp" || contact.source === "wazzup" ? "WhatsApp" : contact.source || "Источник не указан"}</span></div>
            <div className="col-start-1 min-w-0 text-xs md:col-start-auto md:text-sm">{contact.phone ? <a href={toTelHref(contact.phone)} className="break-words text-[var(--negis-muted)] hover:text-[var(--negis-primary)] hover:underline">{formatPhone(contact.phone)}</a> : <span className="text-[var(--negis-muted)]">Без телефона</span>}</div>
            <time dateTime={contact.createdAt} className="hidden text-xs text-[var(--negis-muted)] md:block">{mortgageDate(contact.createdAt, data.timeZone)}</time>
            <Link href={`/clients?leadId=${encodeURIComponent(contact.id)}`} aria-label={`Карточка: ${contact.name || "Без имени"}`} className="col-start-2 row-start-1 inline-flex max-w-40 items-center justify-end gap-2 text-xs md:col-start-auto md:row-start-auto"><span className={`min-w-0 break-words rounded border px-2 py-1 ${contact.status === "new" ? "border-blue-100 bg-blue-50 text-blue-800" : "border-[var(--negis-border)] text-[var(--negis-muted)]"}`}>{mortgageContactStatus(contact.status)}</span><ChevronRight size={15} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" /></Link>
          </li>)}</ul> : <div role="status" className="flex min-h-24 items-center gap-3 text-sm text-[var(--negis-muted)]"><Inbox size={20} className="shrink-0" aria-hidden="true" /><p>{teamAccess ? data.metrics.unassignedLeads > 0 ? "Неназначенные заявки вне текущей страницы контактов." : "Все заявки назначены." : "Назначенных заявок пока нет."}</p></div>}
        </section>
      </>}
  </div>;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase("ru-RU") || "?";
}

function OverviewMetric({ label, value, icon: Icon, href, tone }: { label: string; value: number; icon: LucideIcon; href: string; tone: "neutral" | "green" | "blue" | "red" }) {
  const colors = { neutral: "bg-[var(--negis-surface-2)] text-[var(--negis-text-2)]", green: "bg-emerald-50 text-emerald-700", blue: "bg-blue-50 text-blue-700", red: "bg-red-50 text-red-700" };
  return <div className="relative min-w-0 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-3 transition-colors hover:border-[var(--negis-primary)] sm:p-4">
    <div className="mb-2 flex items-center justify-between gap-2 sm:mb-3"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8 ${colors[tone]}`}><Icon size={17} aria-hidden="true" /></span><ArrowUpRight size={15} className="text-[var(--negis-muted)]" aria-hidden="true" /></div>
    <dt className="min-h-8 break-words text-xs text-[var(--negis-muted)] sm:min-h-5">{label}</dt>
    <dd className={`mt-1 text-2xl font-semibold tabular-nums sm:text-3xl ${tone === "red" ? "text-red-700" : "text-[var(--negis-text)]"}`}><Link href={href} aria-label={`${label}: ${value.toLocaleString("ru-RU")}`} className="after:absolute after:inset-0 after:rounded-lg hover:text-[var(--negis-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)]">{value.toLocaleString("ru-RU")}</Link></dd>
  </div>;
}

function OverviewActivity({ activity, timeZone, now }: { activity: MortgageActivity; timeZone: string; now: number }) {
  const instant = activity.kind === "meeting" ? activity.startsAt : activity.dueAt;
  const overdue = activity.kind === "task" && instant && Date.parse(instant) < now;
  const today = instant && dayKeyInZone(Date.parse(instant), timeZone) === dayKeyInZone(now, timeZone);
  const time = instant ? new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(Date.parse(instant)) : "—";
  const date = instant ? today ? "Сегодня" : new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "short" }).format(Date.parse(instant)) : "Без срока";
  return <li className="flex min-w-0 items-start gap-3 py-4 sm:gap-4">
    <div className={`w-16 shrink-0 border-r border-[var(--negis-border)] pr-3 sm:w-20 ${overdue ? "text-red-700" : "text-[var(--negis-text)]"}`}><time dateTime={instant || undefined} className="block text-base font-semibold tabular-nums">{time}</time><span className="mt-1 block text-[11px] text-[var(--negis-muted)]">{date}</span></div>
    <div className="min-w-0 flex-1"><Link href={mortgageActivityHref(activity)} className="block break-words text-sm font-semibold hover:text-[var(--negis-primary)] hover:underline">{activity.title}</Link><Link href={`/clients?leadId=${encodeURIComponent(activity.leadId)}`} className="mt-1 block break-words text-xs text-[var(--negis-muted)] hover:text-[var(--negis-primary)] hover:underline">{activity.contactName || "Без имени"}</Link><div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--negis-muted)]">{activity.responsibleName && <span className="break-words">{activity.responsibleName}</span>}{activity.kind === "meeting" && activity.endsAt && <span className="inline-flex items-center gap-1"><Clock3 size={12} aria-hidden="true" />до {new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(Date.parse(activity.endsAt))}</span>}{overdue && <span className="font-medium text-red-700">Просрочено</span>}{activity.kind === "task" && activity.priority === "high" && <span className="text-amber-800">Высокий приоритет</span>}</div></div>
    <Link href={mortgageActivityHref(activity)} aria-label={`Открыть: ${activity.title}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--negis-muted)] hover:bg-[var(--negis-surface-2)] hover:text-[var(--negis-primary)] sm:h-8 sm:w-8"><ChevronRight size={16} aria-hidden="true" /></Link>
  </li>;
}

import { useEffect, useState, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import { AlarmClock, ArrowDownLeft, ArrowUpRight, BarChart3, CalendarDays, Check, CheckSquare, ChevronRight, Clock3, Inbox, ListFilter, RefreshCw, Users, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { MortgageScope, useMortgageWorkspace } from "@/lib/mortgage-workspace";
import { formatPhone, toTelHref } from "@/lib/phone";
import { dayKeyInZone } from "@/lib/clinicDay";
import type { MortgageActivity, MortgageContact } from "../../../../lib/crm/mortgage-contract";
import {
  MortgageState, mortgageActivityHref,
  mortgageContactStatus, mortgageDate, mortgageErrorMessage,
} from "@/components/mortgage/MortgagePrimitives";

export default function MortgageOverview() {
  return <PageLayout><MortgageScope><MortgageOverviewBody /></MortgageScope></PageLayout>;
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const readReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;
const serverReducedMotion = () => true;

function subscribeReducedMotion(listener: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function MortgageOverviewBody() {
  const { clinicId, userRole, availableWorkspaces } = useAuth();
  const workspace = useMortgageWorkspace();
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
  const [now, setNow] = useState(Date.now);
  const [agendaSelection, setAgenda] = useState<"meetings" | "tasks" | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const teamAccess = userRole === "owner" || userRole === "admin";
  const data = workspace.isCurrent() && !workspace.loading && !workspace.error ? workspace.data : null;
  const agenda = agendaSelection ?? (data?.metrics.overdueTasks ? "tasks" : "meetings");
  const workspaceName = availableWorkspaces?.find((item) => item.id === clinicId)?.name || "Baspana";
  const meetings = data?.activities.filter((activity) => activity.kind === "meeting"
    && (activity.status === "open" || activity.status === "in_progress") && activity.startsAt
    && (Date.parse(activity.startsAt) >= now || Boolean(activity.endsAt && Date.parse(activity.endsAt) > now)))
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!)).slice(0, 5) || [];
  const tasks = data?.activities.filter((activity) => activity.kind === "task"
    && (activity.status === "open" || activity.status === "in_progress"))
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
      || a.id.localeCompare(b.id)).slice(0, 5) || [];
  const unassigned = teamAccess ? data?.contacts.filter((contact) => !contact.responsibleUserId).slice(0, 3) || [] : [];
  const recent = teamAccess ? unassigned : data?.contacts.filter((contact) => Boolean(contact.responsibleUserId)).slice(0, 3) || [];
  const memberRows = teamAccess ? data?.memberMetrics || [] : [];
  const maxLoad = Math.max(1, ...memberRows.map((member) => member.assignedLeads));
  const completedTasks = memberRows.reduce((sum, member) => sum + member.doneTasks, 0);
  const completedMeetings = memberRows.reduce((sum, member) => sum + member.doneMeetings, 0);
  const dateLabel = data ? new Intl.DateTimeFormat("ru-RU", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(now) : "";

  return <div className="mx-auto w-full min-w-0 max-w-[1440px] space-y-5 sm:space-y-6" style={{ letterSpacing: 0 }}>
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="mb-1.5 text-xs font-medium text-[var(--negis-text-2)]">{workspaceName}</p>
        <h1 className="break-words text-2xl font-semibold text-[var(--negis-text)]">{teamAccess ? "Обзор команды" : "Мой рабочий день"}</h1>
        {data && <p className="mt-1.5 text-sm text-[var(--negis-text-2)]">{dateLabel.charAt(0).toLocaleUpperCase("ru-RU") + dateLabel.slice(1)}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" title="Обновить обзор" aria-label="Обновить обзор" className="neu-icon-btn !h-11 !w-11 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50" disabled={workspace.loading || !workspace.isCurrent()} onClick={() => { if (workspace.isCurrent()) void workspace.refresh(); }}><RefreshCw size={16} aria-hidden="true" /></button>
        <Link href="/leads" className="neu-btn-primary !hidden motion-reduce:transition-none sm:!inline-flex"><ListFilter size={15} aria-hidden="true" />Заявки<ArrowUpRight size={15} aria-hidden="true" /></Link>
      </div>
    </header>

    {!clinicId ? <MortgageState kind="denied">Рабочее пространство не выбрано.</MortgageState>
      : workspace.loading ? <MortgageState kind="loading">Загрузка обзора...</MortgageState>
      : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
      : !data ? <MortgageState kind="empty">Обзор недоступен.</MortgageState>
      : <>
        <dl className="medina-overview-metrics min-w-0" aria-label="Показатели рабочего пространства">
          <OverviewMetric accent reducedMotion={reducedMotion} label={teamAccess ? "Всего заявок" : "Мои заявки"} value={data.metrics.totalLeads} icon={Inbox} href="/leads" tone="neutral" />
          <OverviewMetric reducedMotion={reducedMotion} label="В работе" value={data.metrics.inProgressLeads} icon={ListFilter} href="/leads" tone="green" />
          {teamAccess && <OverviewMetric reducedMotion={reducedMotion} label="Без ответственного" value={data.metrics.unassignedLeads} icon={ArrowDownLeft} href="/leads" tone="amber" />}
          <OverviewMetric reducedMotion={reducedMotion} label="Встречи сегодня" value={data.metrics.meetingsToday} icon={CalendarDays} href="/appointments" tone="blue" />
          <OverviewMetric reducedMotion={reducedMotion} label="Просроченные задачи" value={data.metrics.overdueTasks} icon={AlarmClock} href="/tasks" tone={data.metrics.overdueTasks ? "red" : "neutral"} />
          {teamAccess && <OverviewMetric reducedMotion={reducedMotion} label="Активные менеджеры" value={data.metrics.activeManagers} icon={Users} href="/analytics" tone="green" />}
        </dl>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 border-y border-[var(--negis-border)] py-2.5 text-sm">
          {teamAccess ? <Link href="/leads" className="flex min-w-0 items-center gap-2.5 font-medium hover:underline">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${data.metrics.unassignedLeads ? "badge-warning" : "bg-[var(--negis-primary-soft)] text-[var(--negis-primary)]"}`}>
              {data.metrics.unassignedLeads ? <ArrowDownLeft size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            </span>
            <span className="min-w-0 break-words">{data.metrics.unassignedLeads ? <><strong className="tabular-nums">{data.metrics.unassignedLeads.toLocaleString("ru-RU")}</strong> без ответственного</> : "Все заявки назначены"}</span>
            <ArrowUpRight size={14} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" />
          </Link> : <span className="flex items-center gap-2 text-[var(--negis-muted)]"><Users size={16} aria-hidden="true" />Только назначенные вам заявки</span>}
          <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--negis-text-2)]">
            {teamAccess && <span className="flex items-center gap-1.5"><Users size={14} aria-hidden="true" />Активные менеджеры: <strong className="font-medium text-[var(--negis-text)]">{data.metrics.activeManagers}</strong></span>}
            <span>{data.timeZone}</span>
          </div>
        </div>

        {data.activitiesTruncated && <p role="status" className="border-l-2 border-amber-500 pl-3 text-sm text-amber-800">Встречи и задачи: неполная выборка. Счётчики полные.</p>}

        <div className="medina-overview-work min-w-0">
          {teamAccess && <OverviewContacts contacts={recent} teamAccess total={data.metrics.unassignedLeads} timeZone={data.timeZone} />}
          <section className={`min-w-0 ${teamAccess ? "border-t border-[var(--negis-border)] pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0" : ""}`} aria-labelledby="mortgage-agenda">
            <div className="medina-section-heading flex flex-wrap items-center justify-between gap-3">
              <h2 id="mortgage-agenda" className="inline-flex items-center gap-2 text-base font-semibold"><CalendarDays size={17} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" />Ближайшие дела</h2>
              <Link href={agenda === "meetings" ? "/appointments" : "/tasks"} className="neu-btn !min-h-11 !px-3 !py-2 !text-xs motion-reduce:transition-none sm:!min-h-9">{agenda === "meetings" ? "Календарь" : "Все задачи"}<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
            <div role="group" aria-label="Вид ближайших дел" className="mb-3 flex flex-wrap gap-2">
              {([{ key: "meetings", label: "Встречи", icon: CalendarDays }, { key: "tasks", label: "Задачи", icon: CheckSquare }] as const).map(({ key, label, icon: Icon }) =>
                <button key={key} type="button" aria-pressed={agenda === key} onClick={() => { if (workspace.isCurrent()) setAgenda(key); }}
                  className={`relative isolate inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] motion-reduce:transition-none ${agenda === key ? "border-transparent text-[var(--negis-mint-ink)]" : "border-[var(--negis-border)] bg-white text-[var(--negis-ink-2)] hover:bg-[var(--negis-plate)]"}`}>
                  <Icon size={15} aria-hidden="true" />{label}{key === "tasks" && data.metrics.overdueTasks > 0 && <span className="badge badge-error !px-1.5 !py-0.5 !text-[11px] !tracking-normal tabular-nums" aria-label={`Просрочено: ${data.metrics.overdueTasks}`}>{data.metrics.overdueTasks.toLocaleString("ru-RU")}</span>}
                  {agenda === key && <motion.span layoutId="mortgage-overview-agenda-active" initial={false} aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-[var(--negis-mint)]" transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }} />}
                </button>)}
            </div>
            {(agenda === "meetings" ? meetings : tasks).length ? <motion.ul key={agenda} initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }} className="divide-y divide-[var(--negis-border)] rounded-lg border border-[var(--negis-border)] bg-white px-3">
              {(agenda === "meetings" ? meetings : tasks).map((activity) => <OverviewActivity key={activity.id} activity={activity} timeZone={data.timeZone} now={now} />)}
            </motion.ul> : <div className="flex min-h-44 flex-col items-center justify-center gap-2 py-8 text-center text-[var(--negis-muted)]" role="status">
              {agenda === "meetings" ? <CalendarDays size={24} strokeWidth={1.5} aria-hidden="true" /> : <CheckSquare size={24} strokeWidth={1.5} aria-hidden="true" />}
              <p className="text-sm font-medium">{agenda === "meetings" ? "В выборке нет ближайших встреч" : "В выборке нет открытых задач"}</p>
              <Link href={agenda === "meetings" ? "/appointments" : "/tasks"} className="text-xs text-[var(--negis-primary)] hover:underline">{agenda === "meetings" ? "Открыть календарь" : "Открыть задачи"}</Link>
            </div>}
          </section>

          {!teamAccess && <section className="min-w-0 border-t border-[var(--negis-border)] pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0" aria-labelledby="mortgage-own-work">
            <h2 id="mortgage-own-work" className="mb-4 text-base font-semibold">Моя работа</h2>
            <nav aria-label="Моя работа" className="divide-y divide-[var(--negis-border)]">
              {([{ href: "/clients", label: "Клиенты", icon: Users }, { href: "/appointments", label: "Календарь", icon: CalendarDays }, { href: "/tasks", label: "Задачи", icon: CheckSquare }]).map(({ href, label, icon: Icon }) => <Link key={href} href={href} className="flex min-h-14 items-center gap-3 py-3 text-sm font-medium hover:text-[var(--negis-primary)]"><Icon size={18} className="text-[var(--negis-muted)]" aria-hidden="true" />{label}<ChevronRight size={16} className="ml-auto" aria-hidden="true" /></Link>)}
            </nav>
          </section>}
        </div>

        {teamAccess ? <section className="min-w-0 border-t border-[var(--negis-border)] pt-5" aria-labelledby="mortgage-team-load">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <h2 id="mortgage-team-load" className="inline-flex items-center gap-2 text-base font-semibold"><Users size={17} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" />Нагрузка команды</h2>
              <Link href="/analytics" className="neu-btn !min-h-11 !px-3 !py-2 !text-xs motion-reduce:transition-none sm:!min-h-9">Аналитика<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
            <p className="mb-4 text-xs text-[var(--negis-text-2)]">Назначенные заявки · сейчас</p>
            {memberRows.length ? <ul className="grid min-w-0 gap-x-7 gap-y-5 md:grid-cols-2 xl:grid-cols-3">{memberRows.map((member) => <li key={member.id} className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--negis-primary-soft)] text-xs font-semibold text-[var(--negis-primary)]">{initials(member.name)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start justify-between gap-2 text-sm"><span className="min-w-0 break-words font-medium">{member.name || "Без имени"}</span><strong className="shrink-0 font-semibold tabular-nums">{member.assignedLeads.toLocaleString("ru-RU")}</strong></div>
                <div className="mb-1.5 mt-1.5 h-1.5 overflow-hidden rounded-sm bg-[var(--negis-border)]" aria-hidden="true"><motion.div initial={reducedMotion ? false : { scaleX: 0 }} animate={{ scaleX: member.assignedLeads / maxLoad }} transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }} className="h-full w-full origin-left rounded-sm bg-[var(--negis-primary)]" /></div>
                <p className="break-words text-xs text-[var(--negis-text-2)]">Задач: {member.openTasks} · Плановых встреч: {member.plannedMeetings}{Boolean(member.overdueTasks) && <span className="text-[var(--negis-danger)]"> · Просрочено: {member.overdueTasks}</span>}</p>
              </div>
            </li>)}</ul> : <MortgageState kind="empty">Нет данных по сотрудникам.</MortgageState>}
            <div className="mt-5 border-t border-[var(--negis-border)] pt-4">
              <h3 className="flex items-center gap-2 text-xs font-medium text-[var(--negis-text-2)]"><BarChart3 size={14} aria-hidden="true" />Отметки сотрудников · {data.periodDays} дней</h3>
              <dl className="mt-3 grid max-w-lg grid-cols-2 gap-3"><div><dt className="text-xs text-[var(--negis-text-2)]">Завершили задач</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{completedTasks.toLocaleString("ru-RU")}</dd></div><div><dt className="text-xs text-[var(--negis-text-2)]">Завершили встреч</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{completedMeetings.toLocaleString("ru-RU")}</dd></div></dl>
            </div>
          </section> : <OverviewContacts contacts={recent} teamAccess={false} total={data.contactsTotal} timeZone={data.timeZone} className="border-t border-[var(--negis-border)] pt-5" />}
      </>}
  </div>;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase("ru-RU") || "?";
}

function OverviewMetric({ label, value, icon: Icon, href, tone, reducedMotion, accent = false }: { label: string; value: number; icon: LucideIcon; href: string; tone: "neutral" | "green" | "blue" | "red" | "amber"; reducedMotion: boolean; accent?: boolean }) {
  const colors = { neutral: "badge-muted", green: "bg-[var(--negis-primary-soft)] text-[var(--negis-primary)]", blue: "badge-blue", red: "badge-error", amber: "badge-warning" };
  return <motion.div initial={false} whileHover={reducedMotion ? undefined : { y: -2 }} whileTap={reducedMotion ? undefined : { scale: 0.99 }} transition={{ duration: reducedMotion ? 0 : 0.16, ease: "easeOut" }} className="medina-overview-metric neu-sm relative min-w-0 p-3 motion-reduce:transition-none sm:p-4" style={accent ? { background: "var(--negis-mint)", boxShadow: "none" } : undefined}>
    <dt className={`min-h-8 break-words text-xs font-semibold sm:min-h-5 ${accent ? "text-[var(--negis-mint-deep)]" : "text-[var(--negis-muted)]"}`}>{label}</dt>
    <dd className={`mt-1 flex min-w-0 items-center justify-between gap-2 text-2xl font-semibold tabular-nums sm:text-3xl ${tone === "red" ? "text-[var(--negis-danger)]" : accent ? "text-[var(--negis-mint-ink)]" : "text-[var(--negis-text)]"}`}><Link href={href} aria-label={`${label}: ${value.toLocaleString("ru-RU")}`} className="min-w-0 break-words after:absolute after:inset-0 after:rounded-lg hover:text-[var(--negis-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)]">{value.toLocaleString("ru-RU")}</Link><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg sm:h-8 sm:w-8 ${accent ? "bg-white/60 text-[var(--negis-mint-deep)]" : colors[tone]}`}><Icon size={17} aria-hidden="true" /></span></dd>
  </motion.div>;
}

function OverviewContacts({ contacts, teamAccess, total, timeZone, className = "" }: {
  contacts: MortgageContact[]; teamAccess: boolean; total: number; timeZone: string; className?: string;
}) {
  return <section className={`min-w-0 ${className}`} aria-labelledby="mortgage-overview-contacts">
    <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
      <div className="min-w-0"><h2 id="mortgage-overview-contacts" className="flex items-start gap-2 break-words text-base font-semibold"><Inbox size={17} className="mt-0.5 shrink-0 text-[var(--negis-muted)]" aria-hidden="true" />{teamAccess ? "Заявки без ответственного" : "Последние заявки"}</h2><p className="mt-1 text-xs text-[var(--negis-text-2)]">{teamAccess ? `Показано: ${contacts.length} · Всего без ответственного: ${total.toLocaleString("ru-RU")}` : `Показано ${contacts.length} из ${total.toLocaleString("ru-RU")}`}</p></div>
      <Link href={teamAccess ? "/leads" : "/clients"} aria-label={teamAccess ? "Открыть распределение заявок" : "Все клиенты"} title={teamAccess ? "Открыть распределение заявок" : "Все клиенты"} className="neu-btn !min-h-9 !px-3 !py-2 !text-xs motion-reduce:transition-none max-sm:!h-11 max-sm:!w-11 max-sm:!p-0"><span className="hidden sm:inline">{teamAccess ? "Распределить" : "Все клиенты"}</span><ArrowUpRight size={16} className="shrink-0" aria-hidden="true" /></Link>
    </div>
    {contacts.length ? <ul className="divide-y divide-[var(--negis-border)] rounded-lg border border-[var(--negis-border)] bg-white px-3">{contacts.map((contact) => <li key={contact.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-md py-3.5 transition-colors hover:bg-[var(--negis-surface-2)] focus-within:bg-[var(--negis-surface-2)] motion-reduce:transition-none">
      <Link href={`/clients?leadId=${encodeURIComponent(contact.id)}`} className="min-w-0 break-words text-sm font-medium hover:text-[var(--negis-primary)] hover:underline">{contact.name || "Без имени"}</Link>
      <Link href={`/clients?leadId=${encodeURIComponent(contact.id)}`} aria-label={`Карточка: ${contact.name || "Без имени"}`} className="col-start-2 row-span-2 row-start-1 inline-flex min-h-11 max-w-32 items-center justify-end gap-1 text-xs"><span className={`badge min-w-0 break-words !tracking-normal ${contact.status === "new" ? "badge-blue" : "badge-muted"}`}>{mortgageContactStatus(contact.status)}</span><ChevronRight size={15} className="shrink-0 text-[var(--negis-muted)]" aria-hidden="true" /></Link>
      <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--negis-text-2)]">
        {contact.phone ? <a href={toTelHref(contact.phone)} className="inline-flex min-h-11 items-center break-words hover:text-[var(--negis-primary)] hover:underline sm:min-h-6">{formatPhone(contact.phone)}</a> : <span>Без телефона</span>}
        <span>{contact.source === "manual" ? "Вручную" : contact.source === "whatsapp" || contact.source === "wazzup" ? "WhatsApp" : contact.source || "Источник не указан"}</span>
      </div>
      <time dateTime={contact.createdAt} className="col-span-2 hidden text-[11px] text-[var(--negis-text-2)] sm:block">{mortgageDate(contact.createdAt, timeZone)}</time>
    </li>)}</ul> : <div role="status" className="flex min-h-24 items-center gap-3 text-sm text-[var(--negis-muted)]"><Inbox size={20} className="shrink-0" aria-hidden="true" /><p>{teamAccess ? total > 0 ? "Неназначенные заявки вне текущей страницы контактов." : "Все заявки назначены." : "Назначенных заявок пока нет."}</p></div>}
  </section>;
}

function OverviewActivity({ activity, timeZone, now }: { activity: MortgageActivity; timeZone: string; now: number }) {
  const instant = activity.kind === "meeting" ? activity.startsAt : activity.dueAt;
  const overdue = activity.kind === "task" && instant && Date.parse(instant) < now;
  const today = instant && dayKeyInZone(Date.parse(instant), timeZone) === dayKeyInZone(now, timeZone);
  const time = instant ? new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(Date.parse(instant)) : "—";
  const date = instant ? today ? "Сегодня" : new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "short" }).format(Date.parse(instant)) : "Без срока";
  return <li className="flex min-w-0 items-start gap-3 rounded-md py-4 transition-colors hover:bg-[var(--negis-surface)] focus-within:bg-[var(--negis-surface)] motion-reduce:transition-none sm:gap-4">
    <div className={`w-16 shrink-0 border-r border-[var(--negis-border)] pr-3 sm:w-20 ${overdue ? "text-[var(--negis-danger)]" : "text-[var(--negis-text)]"}`}><time dateTime={instant || undefined} className="block text-base font-semibold tabular-nums">{time}</time><span className="mt-1 block text-[11px] text-[var(--negis-text-2)]">{date}</span></div>
    <div className="min-w-0 flex-1"><Link href={mortgageActivityHref(activity)} className="block break-words text-sm font-semibold hover:text-[var(--negis-primary)] hover:underline">{activity.title}</Link><Link href={`/clients?leadId=${encodeURIComponent(activity.leadId)}`} className="mt-1 block break-words text-xs text-[var(--negis-text-2)] hover:text-[var(--negis-primary)] hover:underline">{activity.contactName || "Без имени"}</Link><div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--negis-text-2)]">{activity.responsibleName && <span className="break-words">{activity.responsibleName}</span>}{activity.kind === "meeting" && activity.endsAt && <span className="inline-flex items-center gap-1"><Clock3 size={12} aria-hidden="true" />до {new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(Date.parse(activity.endsAt))}</span>}{overdue && <span className="font-medium text-[var(--negis-danger)]">Просрочено</span>}{activity.kind === "task" && activity.priority === "high" && <span className="text-amber-800">Высокий приоритет</span>}</div></div>
    <Link href={mortgageActivityHref(activity)} aria-label={`Открыть: ${activity.title}`} className="neu-icon-btn !h-11 !w-11 shrink-0 motion-reduce:transition-none sm:!h-9 sm:!w-9"><ChevronRight size={16} aria-hidden="true" /></Link>
  </li>;
}

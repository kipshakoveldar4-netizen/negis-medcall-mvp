import { useEffect, useState } from "react";
import { BarChart3, CalendarDays, CheckSquare, RefreshCw, Users, ListFilter } from "lucide-react";
import { Link } from "wouter";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { MortgageScope, useMortgageWorkspace } from "@/lib/mortgage-workspace";
import { formatPhone, toTelHref } from "@/lib/phone";
import {
  MortgageActivityTable, MortgageIconButton, MortgageMetricStrip, MortgagePageHeader, MortgageState,
  mortgageButtonClass, mortgageContactStatus, mortgageDate, mortgageErrorMessage,
} from "@/components/mortgage/MortgagePrimitives";

export default function MortgageOverview() {
  return <PageLayout><MortgageScope><MortgageOverviewBody /></MortgageScope></PageLayout>;
}

function MortgageOverviewBody() {
  const { clinicId, userRole } = useAuth();
  const workspace = useMortgageWorkspace();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const teamAccess = userRole === "owner" || userRole === "admin";
  const data = workspace.isCurrent() && !workspace.loading && !workspace.error ? workspace.data : null;
  const meetings = data?.activities.filter((activity) => activity.kind === "meeting"
    && (activity.status === "open" || activity.status === "in_progress") && activity.startsAt
    && (Date.parse(activity.startsAt) >= now || Boolean(activity.endsAt && Date.parse(activity.endsAt) > now)))
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!)).slice(0, 8) || [];
  const overdue = data?.activities.filter((activity) => activity.kind === "task"
    && (activity.status === "open" || activity.status === "in_progress")
    && activity.dueAt && Date.parse(activity.dueAt) < now)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!)).slice(0, 8) || [];
  const unassigned = teamAccess ? data?.contacts.filter((contact) => !contact.responsibleUserId).slice(0, 8) || [] : [];

  return <div className="min-w-0 space-y-5">
    <MortgagePageHeader title="Обзор Baspana" caption={data ? `${teamAccess ? "Команда" : "Моя работа"} · ${mortgageDate(new Date(now).toISOString(), data.timeZone)} · ${data.timeZone}` : undefined}>
      <MortgageIconButton icon={RefreshCw} label="Обновить обзор" disabled={workspace.loading} onClick={() => void workspace.refresh()} />
    </MortgagePageHeader>

    <div className="flex flex-wrap gap-2" aria-label="Разделы CRM">
      {[
        { href: "/leads", label: "Заявки", icon: ListFilter },
        { href: "/clients", label: "Клиенты", icon: Users },
        { href: "/appointments", label: "Встречи", icon: CalendarDays },
        { href: "/tasks", label: "Задачи", icon: CheckSquare },
        ...(teamAccess ? [{ href: "/analytics", label: "Аналитика", icon: BarChart3 }] : []),
      ].map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={mortgageButtonClass}>
        <Icon size={15} aria-hidden="true" />{label}
      </Link>)}
    </div>

    {!clinicId ? <MortgageState kind="denied">Рабочее пространство не выбрано.</MortgageState>
      : workspace.loading ? <MortgageState kind="loading">Загрузка обзора...</MortgageState>
      : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
      : !data ? <MortgageState kind="empty">Обзор недоступен.</MortgageState>
      : <>
        <MortgageMetricStrip items={[
          { label: teamAccess ? "Всего заявок" : "Мои заявки", value: data.metrics.totalLeads, href: "/leads" },
          { label: "В работе", value: data.metrics.inProgressLeads, href: "/leads" },
          { label: "Встречи сегодня", value: data.metrics.meetingsToday, href: "/appointments" },
          { label: "Просроченные задачи", value: data.metrics.overdueTasks, href: "/tasks", tone: "error" },
          ...(teamAccess ? [
            { label: "Без ответственного", value: data.metrics.unassignedLeads, href: "/leads" },
            { label: "Активные менеджеры", value: data.metrics.activeManagers, href: "/analytics" },
          ] : []),
        ]} />

        {data.activitiesTruncated && <p role="status" className="text-xs text-[var(--negis-warning)]">Встречи и задачи: неполная выборка. Счётчики полные.</p>}

        <section className="min-w-0" aria-labelledby="mortgage-upcoming">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="mortgage-upcoming" className="text-sm font-semibold">Ближайшие встречи</h2>
            <Link href="/appointments" className="text-xs text-[var(--negis-primary)] hover:underline">Все встречи</Link>
          </div>
          {meetings.length ? <MortgageActivityTable activities={meetings} timeZone={data.timeZone} />
            : <MortgageState kind="empty">{data.activitiesTruncated ? "В выборке нет ближайших встреч." : "Ближайших встреч нет."}</MortgageState>}
        </section>

        <section className="min-w-0 border-t border-[var(--negis-border)] pt-4" aria-labelledby="mortgage-overdue">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="mortgage-overdue" className="text-sm font-semibold">Просроченные задачи <span className="ml-1 text-[var(--negis-error)]">{data.metrics.overdueTasks.toLocaleString("ru-RU")}</span></h2>
            <Link href="/tasks" className="text-xs text-[var(--negis-primary)] hover:underline">Все задачи</Link>
          </div>
          {overdue.length ? <MortgageActivityTable activities={overdue} timeZone={data.timeZone} />
            : <MortgageState kind="empty">{data.metrics.overdueTasks > 0 ? "Просроченные задачи вне текущей выборки." : "Просроченных задач нет."}</MortgageState>}
        </section>

        {teamAccess && <section className="min-w-0 border-t border-[var(--negis-border)] pt-4" aria-labelledby="mortgage-unassigned">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="mortgage-unassigned" className="text-sm font-semibold">Без ответственного <span className="ml-1 text-[var(--negis-muted)]">{data.metrics.unassignedLeads.toLocaleString("ru-RU")}</span></h2>
            <Link href="/leads" className="text-xs text-[var(--negis-primary)] hover:underline">Все заявки</Link>
          </div>
          {unassigned.length ? <div className="max-w-full overflow-x-auto" role="region" aria-label="Заявки без ответственного" tabIndex={0}>
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-[var(--negis-muted)]"><tr>{["Клиент", "Телефон", "Источник", "Статус", "Создана"].map((label) => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}</tr></thead>
              <tbody>{unassigned.map((contact) => <tr key={contact.id} className="border-t border-[var(--negis-border)] align-top">
                <th scope="row" className="max-w-56 break-words px-2 py-3 font-medium"><Link href={`/clients?leadId=${encodeURIComponent(contact.id)}`} className="hover:underline">{contact.name || "Без имени"}</Link></th>
                <td className="whitespace-nowrap px-2 py-3">{contact.phone ? <a href={toTelHref(contact.phone)} className="hover:underline">{formatPhone(contact.phone)}</a> : "-"}</td>
                <td className="max-w-40 break-words px-2 py-3">{contact.source === "manual" ? "Вручную" : contact.source || "Не указан"}</td>
                <td className="px-2 py-3">{mortgageContactStatus(contact.status)}</td>
                <td className="px-2 py-3">{mortgageDate(contact.createdAt, data.timeZone)}</td>
              </tr>)}</tbody>
            </table>
            <p className="py-2 text-xs text-[var(--negis-muted)]">Показано: {unassigned.length} из {data.metrics.unassignedLeads.toLocaleString("ru-RU")}</p>
          </div> : <MortgageState kind="empty">{data.metrics.unassignedLeads > 0 ? "Неназначенные заявки вне текущей страницы контактов." : "Все заявки назначены."}</MortgageState>}
        </section>}
      </>}
  </div>;
}

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { LeadTeamAnalytics } from "@/components/crm/lead-team-analytics";
import { MortgageResults } from "@/components/mortgage/MortgageResults";
import { useAuth } from "@/contexts/AuthContext";
import { roleLabels, type StaffRole } from "@/lib/permissions";
import { MortgageScope, useMortgageWorkspace } from "@/lib/mortgage-workspace";
import type { MortgageMemberMetrics } from "../../../../lib/crm/mortgage-contract";
import {
  MortgageIconButton, MortgageMetricStrip, MortgagePageHeader, MortgageState, mortgageErrorMessage,
  mortgageSegmentClass, mortgageTableClass,
} from "@/components/mortgage/MortgagePrimitives";

const periods = [7, 30, 90] as const;

export default function MortgageAnalytics() {
  return <PageLayout><MortgageScope><MortgageAnalyticsAccess /></MortgageScope></PageLayout>;
}

function MortgageAnalyticsAccess() {
  const { clinicId, userRole, user } = useAuth();
  if (!clinicId || (userRole !== "owner" && userRole !== "admin")) {
    return <div className="min-w-0 space-y-5">
      <MortgagePageHeader title="Аналитика команды" />
      <MortgageState kind="denied">{!clinicId ? "Рабочее пространство не выбрано." : "Отчёт доступен владельцу и администратору."}</MortgageState>
    </div>;
  }
  return <MortgageAnalyticsReport key={JSON.stringify([clinicId, userRole, user?.id])} workspaceId={clinicId} />;
}

function MortgageAnalyticsReport({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<number>(30);
  const workspace = useMortgageWorkspace({ days });
  const { isCurrent, request } = workspace;
  const data = isCurrent() && !workspace.loading && !workspace.error && workspace.data?.periodDays === days ? workspace.data : null;
  const access = useMemo(() => ({
    isCurrent,
    loadTeamAnalytics: (period: number) => request(`/api/crm/lead-team-analytics?${new URLSearchParams({ workspaceId, days: String(period) })}`),
  }), [isCurrent, request, workspaceId]);

  return <div className="min-w-0 space-y-5">
    <MortgagePageHeader title="Аналитика команды" caption={data ? `Baspana · ${data.timeZone}` : "Baspana"}>
      <MortgageIconButton icon={RefreshCw} label="Обновить нагрузку и действия" disabled={workspace.loading} onClick={() => {
        if (!isCurrent()) return;
        void workspace.refresh();
      }} />
    </MortgagePageHeader>

    {isCurrent() && <MortgageResults workspaceId={workspaceId} request={workspace.request} isCurrent={isCurrent} />}
    {isCurrent() && <LeadTeamAnalytics key={workspaceId} access={access} initiallyExpanded heading="Результаты по заявкам и конверсия" />}

    <section className="min-w-0" aria-labelledby="mortgage-member-report">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="mortgage-member-report" className="text-sm font-semibold">Нагрузка и действия сотрудников</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--negis-muted)]">Период действий</span>
          <div role="group" aria-label="Период действий сотрудников" className="inline-flex max-w-full rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] p-0.5">
            {periods.map((period) => <button type="button" key={period} aria-pressed={days === period}
              className={mortgageSegmentClass}
              onClick={() => { if (isCurrent()) setDays(period); }}>{period} дней</button>)}
          </div>
        </div>
      </div>

      {workspace.loading ? <MortgageState kind="loading">Загрузка отчёта...</MortgageState>
        : workspace.error ? <MortgageState kind="error" onRetry={() => void workspace.refresh()}>{mortgageErrorMessage(workspace.error)}</MortgageState>
        : !data ? <MortgageState kind="empty">Отчёт недоступен.</MortgageState>
        : data && <div className="min-w-0 space-y-4">
          <MortgageMetricStrip items={[
            { label: "Заявки · всего", value: data.metrics.totalLeads, href: "/leads" },
            { label: "Заявки · в работе", value: data.metrics.inProgressLeads, href: "/leads" },
            { label: "Без ответственного", value: data.metrics.unassignedLeads, href: "/leads" },
            { label: "Просроченные задачи", value: data.metrics.overdueTasks, href: "/tasks", tone: "error" },
            { label: "Встречи сегодня", value: data.metrics.meetingsToday, href: "/appointments" },
            { label: "Активные менеджеры", value: data.metrics.activeManagers },
          ]} />

          {data.memberMetrics.length > 0 && <div className="grid min-w-0 gap-5 border-y border-[var(--negis-border)] py-4 lg:grid-cols-2">
            <MortgageMemberBars title="Назначенные заявки по сотрудникам" members={data.memberMetrics} metric="assignedLeads" />
            <MortgageMemberBars title={`Завершённые задачи · ${data.periodDays} дней`} members={data.memberMetrics} metric="doneTasks" />
          </div>}

          {data.memberMetrics.length ? <div className={mortgageTableClass} role="region" aria-label="Нагрузка и действия по сотрудникам" tabIndex={0}>
            <table className="w-full min-w-[1120px] text-left text-xs">
              <thead className="bg-[var(--negis-surface-2)] text-[var(--negis-muted)]">
                <tr>
                  <th scope="col" rowSpan={2} className="sticky left-0 z-20 min-w-44 max-w-60 bg-[var(--negis-surface)] px-2 py-2 font-medium">Сотрудник</th>
                  <th scope="colgroup" colSpan={4} className="px-2 py-2 font-medium">Текущая нагрузка · по ответственному за заявку</th>
                  <th scope="colgroup" colSpan={3} className="px-2 py-2 font-medium">Действия исполнителя · {data.periodDays} дней</th>
                </tr>
                <tr>{["Назначено заявок", "Открытые задачи", "Просроченные задачи", "Плановые встречи", "Завершил задач", "Отметил встреч завершёнными", "Отметил неявок"].map((label) =>
                  <th key={label} scope="col" className="max-w-44 px-2 py-2 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>{data.memberMetrics.map((member) => <tr key={member.id} className="border-t border-[var(--negis-border)] align-top hover:bg-[var(--negis-surface-2)]">
                <th scope="row" className="sticky left-0 z-10 min-w-44 max-w-60 bg-[var(--negis-surface)] px-2 py-3 font-medium">
                  <span className="block break-words">{member.name || "Без имени"}</span>
                  <span className="mt-1 block break-words font-normal text-[var(--negis-muted)]">{Object.hasOwn(roleLabels, member.role) ? roleLabels[member.role as StaffRole] : member.role}</span>
                </th>
                <td className="px-2 py-3 tabular-nums">{member.assignedLeads.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums">{member.openTasks.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums" style={{ color: member.overdueTasks > 0 ? "var(--negis-error)" : undefined }}>{member.overdueTasks.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums">{member.plannedMeetings.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums">{member.doneTasks.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums">{member.doneMeetings.toLocaleString("ru-RU")}</td>
                <td className="px-2 py-3 tabular-nums">{member.missedMeetings.toLocaleString("ru-RU")}</td>
              </tr>)}</tbody>
            </table>
          </div> : <MortgageState kind="empty">Нет данных по сотрудникам.</MortgageState>}
        </div>}
    </section>

  </div>;
}

function MortgageMemberBars({ title, members, metric }: {
  title: string; members: MortgageMemberMetrics[]; metric: "assignedLeads" | "doneTasks";
}) {
  const maximum = Math.max(1, ...members.map((member) => member[metric]));
  return <section className="min-w-0" aria-label={title}>
    <h3 className="mb-3 break-words text-xs font-semibold">{title}</h3>
    <dl className="space-y-3">{members.map((member) => <div key={member.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
      <dt className="min-w-0 break-words text-xs text-[var(--negis-text-2)]">{member.name || "Без имени"}</dt>
      <dd className="text-xs font-semibold tabular-nums">{member[metric].toLocaleString("ru-RU")}</dd>
      <dd className="col-span-2 min-w-0">
        <meter min={0} max={maximum} value={member[metric]} aria-label={`${title}: ${member.name || "Без имени"}`}
          className={`block h-2 w-full appearance-none overflow-hidden rounded-sm bg-[var(--negis-surface-2)] [&::-webkit-meter-bar]:h-2 [&::-webkit-meter-bar]:rounded-sm [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-[var(--negis-surface-2)] [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-none [&::-moz-meter-bar]:bg-none ${metric === "assignedLeads" ? "[&::-webkit-meter-optimum-value]:bg-[var(--negis-primary)] [&::-moz-meter-bar]:bg-[var(--negis-primary)]" : "[&::-webkit-meter-optimum-value]:bg-sky-500 [&::-moz-meter-bar]:bg-sky-500"}`}>
          {member[metric].toLocaleString("ru-RU")}
        </meter>
      </dd>
    </div>)}</dl>
  </section>;
}

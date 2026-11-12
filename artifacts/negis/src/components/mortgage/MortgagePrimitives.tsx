import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, ShieldX, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MortgageActivity } from "../../../../../lib/crm/mortgage-contract";

export const mortgageInputClass = "min-h-11 min-w-0 w-full max-w-full rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 py-2 text-sm max-sm:text-base text-[var(--negis-text)] placeholder:text-[var(--negis-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--negis-primary)] disabled:opacity-50";
export const mortgageButtonClass = "mortgage-control inline-flex min-h-10 max-sm:min-h-11 max-sm:min-w-11 min-w-0 max-w-full items-center justify-center gap-2 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 py-2 text-sm font-medium text-[var(--negis-text)] transition-colors hover:bg-[var(--negis-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0";
export const mortgagePrimaryClass = "mortgage-control inline-flex min-h-10 max-sm:min-h-11 max-sm:min-w-11 min-w-0 max-w-full items-center justify-center gap-2 rounded-lg border border-[var(--negis-black)] bg-[var(--negis-black)] px-3 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0";
export const mortgageSegmentClass = "mortgage-control min-h-9 min-w-0 rounded-md px-3 py-2 text-xs font-medium text-[var(--negis-muted)] transition-colors hover:bg-[var(--negis-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] aria-pressed:bg-[var(--negis-primary-soft)] aria-pressed:text-[var(--negis-primary)]";
export const mortgageTableClass = "min-w-0 max-w-full overflow-x-auto rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)]";
const mortgageBadgeClass = "inline-flex max-w-full items-center rounded px-2 py-1 text-[11px] font-medium leading-tight [overflow-wrap:anywhere]";

export function mortgageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : "Не удалось загрузить данные.";
}

export function mortgageDate(value: string | null | undefined, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "-";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function mortgageActivityHref(activity: MortgageActivity): string {
  return `${activity.kind === "meeting" ? "/appointments" : "/tasks"}?leadId=${encodeURIComponent(activity.leadId)}`;
}

const contactStatuses: Record<string, string> = {
  new: "Новая", in_progress: "В работе", booked: "Записана", postponed: "Отложена", lost: "Потеряна",
};

export function mortgageContactStatus(status: string): string {
  return Object.hasOwn(contactStatuses, status) ? contactStatuses[status] : status || "Не указан";
}

export function MortgageContactBadge({ status }: { status: string }) {
  const tone = status === "new" ? "badge-blue" : status === "in_progress" ? "badge-warning" : status === "booked" ? "badge-success" : "badge-muted";
  return <span className={`${mortgageBadgeClass} ${tone}`}>{mortgageContactStatus(status)}</span>;
}

export function MortgageIconButton({ icon: Icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon; label: string;
}) {
  return <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} title={label}
          className={`mortgage-control inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] text-[var(--negis-text)] transition-colors hover:bg-[var(--negis-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50 ${className}`} {...props}>
          <Icon size={16} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>;
}

export function MortgagePageHeader({ title, caption, children }: { title: string; caption?: string; children?: ReactNode }) {
  return <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h1 className="break-words text-2xl font-semibold tracking-normal">{title}</h1>
      {caption && <p className="mt-1 break-words text-xs text-[var(--negis-muted)]">{caption}</p>}
    </div>
    {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>}
  </header>;
}

export function MortgageState({ kind, children, onRetry }: {
  kind: "loading" | "error" | "empty" | "denied"; children: ReactNode; onRetry?: () => void;
}) {
  const Icon = kind === "loading" ? Loader2 : kind === "error" ? AlertCircle : kind === "denied" ? ShieldX : Inbox;
  return <div className="flex min-w-0 flex-wrap items-center gap-3 py-8 text-sm"
    role={kind === "error" || kind === "denied" ? "alert" : "status"}
    style={{ color: kind === "error" || kind === "denied" ? "var(--negis-error)" : "var(--negis-muted)" }}>
    <Icon size={18} className={kind === "loading" ? "shrink-0 animate-spin" : "shrink-0"} aria-hidden="true" />
    <span className="min-w-0 break-words">{children}</span>
    {onRetry && <button type="button" className={mortgageButtonClass} onClick={onRetry}>Повторить</button>}
  </div>;
}

export function MortgageMetricStrip({ items }: { items: Array<{ label: string; value: number; href?: string; tone?: "error" | "warning" }> }) {
  return <dl className={`grid min-w-0 gap-2.5 ${items.length === 3 ? "grid-cols-3" : items.length === 4 ? "grid-cols-2 xl:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"}`}>
    {items.map((item) => <div key={item.label} className="min-w-0 rounded-lg border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 py-3">
      <dt className="break-words text-xs text-[var(--negis-muted)]">{item.label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: item.tone ? `var(--negis-${item.tone})` : "var(--negis-text)" }}>
        {item.href ? <Link href={item.href} className="hover:underline">{item.value.toLocaleString("ru-RU")}</Link> : item.value.toLocaleString("ru-RU")}
      </dd>
    </div>)}
  </dl>;
}

export function MortgageActivityStatus({ activity }: { activity: MortgageActivity }) {
  const labels = {
    open: activity.kind === "meeting" ? "Запланирована" : "Открыта",
    in_progress: "В работе", done: "Завершена", cancelled: "Отменена", missed: "Неявка",
  };
  const tone = activity.status === "done" ? "badge-success" : activity.status === "missed" ? "badge-error" : activity.status === "in_progress" ? "badge-warning" : activity.status === "open" ? "badge-blue" : "badge-muted";
  return <span className={`${mortgageBadgeClass} ${tone}`}>{labels[activity.status]}</span>;
}

export function MortgageActivityTable({ activities, timeZone, showContact = true }: {
  activities: MortgageActivity[]; timeZone: string; showContact?: boolean;
}) {
  return <div className={mortgageTableClass} role="region" aria-label="Встречи и задачи" tabIndex={0}>
    <table className={`w-full text-left text-xs ${showContact ? "min-w-[640px]" : "min-w-[480px]"}`}>
      <thead className="bg-[var(--negis-surface-2)] text-[var(--negis-muted)]">
        <tr>
          <th scope="col" className="px-2 py-2 font-medium">Встреча / задача</th>
          {showContact && <th scope="col" className="px-2 py-2 font-medium">Клиент</th>}
          <th scope="col" className="px-2 py-2 font-medium">Дата и время</th>
          <th scope="col" className="px-2 py-2 font-medium">Ответственный</th>
          <th scope="col" className="px-2 py-2 font-medium">Статус</th>
        </tr>
      </thead>
      <tbody>{activities.map((activity) => <tr key={activity.id} className="border-t border-[var(--negis-border)] align-top hover:bg-[var(--negis-surface-2)]">
        <th scope="row" className="max-w-64 break-words px-2 py-3 font-medium">
          <Link href={mortgageActivityHref(activity)} className="hover:underline">{activity.title}</Link>
          <span className="mt-1 block text-xs font-normal text-[var(--negis-muted)]">
            {activity.kind === "meeting" ? "Встреча" : "Задача"}{activity.priority === "high" ? " · Высокий приоритет" : ""}
          </span>
        </th>
        {showContact && <td className="max-w-48 break-words px-2 py-3">
          <Link href={`/clients?leadId=${encodeURIComponent(activity.leadId)}`} className="hover:underline">{activity.contactName || "Без имени"}</Link>
        </td>}
        <td className="px-2 py-3 tabular-nums">
          <time dateTime={(activity.kind === "meeting" ? activity.startsAt : activity.dueAt) || undefined}>
            {mortgageDate(activity.kind === "meeting" ? activity.startsAt : activity.dueAt, timeZone)}
          </time>
          {activity.kind === "meeting" && activity.endsAt && <span className="mt-1 block text-[var(--negis-muted)]">до {mortgageDate(activity.endsAt, timeZone)}</span>}
        </td>
        <td className="max-w-48 break-words px-2 py-3">{activity.responsibleName || (activity.responsibleUserId ? "Имя не указано" : "Не назначен")}</td>
        <td className="px-2 py-3"><MortgageActivityStatus activity={activity} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

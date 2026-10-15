import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, Inbox, Loader2, ShieldX, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MortgageActivity } from "../../../../../lib/crm/mortgage-contract";

export const mortgageInputClass = "min-w-0 w-full rounded-md border border-[var(--negis-border)] bg-[var(--negis-surface)] px-3 py-2 text-sm text-[var(--negis-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] disabled:opacity-50";
export const mortgageButtonClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-[var(--negis-border)] px-3 py-2 text-sm font-medium text-[var(--negis-text)] hover:bg-[var(--negis-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50";
export const mortgagePrimaryClass = "inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-[var(--negis-primary)] px-3 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50";

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
  new: "Новая", in_progress: "В работе", booked: "Записана", lost: "Потеряна",
};

export function mortgageContactStatus(status: string): string {
  return Object.hasOwn(contactStatuses, status) ? contactStatuses[status] : status || "Не указан";
}

export function MortgageIconButton({ icon: Icon, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon; label: string;
}) {
  return <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} title={label}
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--negis-border)] text-[var(--negis-text)] hover:bg-[var(--negis-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--negis-primary)] disabled:pointer-events-none disabled:opacity-50 ${className}`} {...props}>
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
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
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
  return <dl className={`grid min-w-0 grid-cols-2 gap-x-5 gap-y-4 border-y border-[var(--negis-border)] py-4 ${items.length === 4 ? "xl:grid-cols-4" : "sm:grid-cols-3 xl:grid-cols-6"}`}>
    {items.map((item) => <div key={item.label} className="min-w-0">
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
  const tone = activity.status === "done" ? "success" : activity.status === "missed" ? "error" : "muted";
  return <span className="inline-block max-w-full break-words rounded-sm border border-[var(--negis-border)] px-1.5 py-0.5 text-xs"
    style={{ color: `var(--negis-${tone})` }}>{labels[activity.status]}</span>;
}

export function MortgageActivityTable({ activities, timeZone, showContact = true }: {
  activities: MortgageActivity[]; timeZone: string; showContact?: boolean;
}) {
  return <div className="min-w-0 max-w-full overflow-x-auto" role="region" aria-label="Встречи и задачи" tabIndex={0}>
    <table className={`w-full text-left text-xs ${showContact ? "min-w-[640px]" : "min-w-[480px]"}`}>
      <thead className="text-[var(--negis-muted)]">
        <tr>
          <th scope="col" className="px-2 py-2 font-medium">Встреча / задача</th>
          {showContact && <th scope="col" className="px-2 py-2 font-medium">Клиент</th>}
          <th scope="col" className="px-2 py-2 font-medium">Дата и время</th>
          <th scope="col" className="px-2 py-2 font-medium">Ответственный</th>
          <th scope="col" className="px-2 py-2 font-medium">Статус</th>
        </tr>
      </thead>
      <tbody>{activities.map((activity) => <tr key={activity.id} className="border-t border-[var(--negis-border)] align-top">
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

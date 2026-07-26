import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import type { QueueItem } from "@/lib/dashboardData";

// Medina OS work queue: compact operational rows with one navigation action.
// Loading shows stable skeleton rows; a legitimately empty queue explains
// itself instead of implying failure.
export function WorkQueue({
  title,
  items,
  loading,
  emptyText,
  href,
  linkLabel = "Все",
}: {
  title: string;
  items: QueueItem[];
  loading: boolean;
  emptyText: string;
  href: string;
  linkLabel?: string;
}) {
  return (
    <section className="neu flex min-w-0 flex-col p-4" aria-label={title}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold" style={{ color: "var(--ng-text)" }}>{title}</h3>
        <Link href={href}>
          <span className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold" style={{ color: "var(--ng-primary)" }}>
            {linkLabel}
            <ArrowRight size={12} aria-hidden />
          </span>
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-12 animate-pulse rounded-lg" style={{ background: "var(--ng-plate)" }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg p-3 text-sm" style={{ background: "var(--ng-surface-2)", color: "var(--ng-muted)" }}>
          {emptyText}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={href}>
                <span className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-[var(--ng-surface-2)]" style={{ borderColor: "var(--ng-border)" }}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium" style={{ color: "var(--ng-text)" }}>{item.title}</span>
                    <span className="block truncate text-xs" style={{ color: "var(--ng-muted)" }}>{item.subtitle}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge tone={item.statusTone}>{item.statusLabel}</StatusBadge>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--ng-muted)" }}>{item.meta}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

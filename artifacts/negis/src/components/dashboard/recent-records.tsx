import { Link } from "wouter";
import type { RecentRecord } from "@/lib/dashboardData";
import { formatQueueDate } from "@/lib/dashboardData";

// Honest recency list assembled from real record timestamps. Deliberately
// labeled "Недавно созданные записи" — this is not an audit log.
export function RecentRecords({ records, loading }: { records: RecentRecord[]; loading: boolean }) {
  return (
    <section className="neu min-w-0 p-4" aria-label="Недавно созданные записи">
      <h3 className="mb-3 text-sm font-semibold" style={{ color: "var(--ng-text)" }}>Недавно созданные записи</h3>
      {loading ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="h-9 animate-pulse rounded-lg" style={{ background: "var(--ng-plate)" }} />
          ))}
        </div>
      ) : records.length === 0 ? (
        <p className="rounded-lg p-3 text-sm" style={{ background: "var(--ng-surface-2)", color: "var(--ng-muted)" }}>
          Нет данных за выбранный период.
        </p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--ng-border)" }}>
          {records.map((record) => (
            <li key={`${record.kind}-${record.id}`}>
              <Link href={record.href}>
                <span className="flex cursor-pointer items-center justify-between gap-3 py-2 transition-colors hover:bg-[var(--ng-surface-2)]">
                  <span className="min-w-0 items-baseline gap-2 sm:flex">
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ color: "var(--ng-primary)" }}>
                      {record.kindLabel}
                    </span>
                    <span className="block truncate text-sm font-medium" style={{ color: "var(--ng-text)" }}>{record.title}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--ng-muted)" }}>
                    {formatQueueDate(record.createdAt)}
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

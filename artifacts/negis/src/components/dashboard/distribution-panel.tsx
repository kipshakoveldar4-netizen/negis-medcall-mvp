import type { SourceSlice } from "@/lib/dashboardData";

// Accessible distribution panel: semantic text bars with exact counts — no
// chart library, no interpolation, colour is never the only indicator.
export function DistributionPanel({
  title,
  hint,
  slices,
  loading,
}: {
  title: string;
  hint?: string;
  slices: SourceSlice[];
  loading: boolean;
}) {
  return (
    <section className="neu min-w-0 p-4" aria-label={title}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--ng-text)" }}>{title}</h3>
      {hint ? <p className="mt-0.5 text-xs" style={{ color: "var(--ng-muted)" }}>{hint}</p> : null}
      {loading ? (
        <div className="mt-3 space-y-2" aria-hidden>
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-6 animate-pulse rounded" style={{ background: "var(--ng-plate)" }} />
          ))}
        </div>
      ) : slices.length === 0 ? (
        <p className="mt-3 rounded-lg p-3 text-sm" style={{ background: "var(--ng-surface-2)", color: "var(--ng-muted)" }}>
          Нет данных за выбранный период.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {slices.map((slice) => (
            <li key={slice.label}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium" style={{ color: "var(--ng-text)" }}>{slice.label}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--ng-muted)" }}>
                  {slice.count} · {slice.share}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--ng-plate)" }} aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, slice.share))}%`, background: "var(--ng-primary)" }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

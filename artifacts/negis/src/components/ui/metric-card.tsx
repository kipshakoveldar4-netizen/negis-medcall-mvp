import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

// Medina OS metric card. Real data only: `value` renders with tabular numerals;
// `loading` shows a skeleton; an undefined/null value renders an honest "—".
export function MetricCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
  delta,
  loading = false,
}: {
  label: string;
  value: number | string | null | undefined;
  icon?: LucideIcon;
  tone?: "primary" | "info" | "success" | "warning" | "error" | "muted";
  delta?: ReactNode;
  loading?: boolean;
}) {
  const toneColor: Record<string, { fg: string; bg: string }> = {
    primary: { fg: "var(--ng-primary)", bg: "var(--negis-primary-soft)" },
    info: { fg: "#1D4ED8", bg: "#EFF6FF" },
    success: { fg: "#047857", bg: "#ECFDF5" },
    warning: { fg: "#B45309", bg: "#FFFBEB" },
    error: { fg: "#B91C1C", bg: "#FEF2F2" },
    muted: { fg: "var(--ng-muted)", bg: "#F3F4F6" },
  };
  const palette = toneColor[tone] ?? toneColor.primary;
  const shown = value === null || value === undefined || value === "" ? "—" : value;

  return (
    <div className="neu-sm p-4">
      <div className="flex items-center gap-2.5">
        {Icon ? (
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: palette.bg, color: palette.fg }}>
            <Icon size={15} />
          </span>
        ) : null}
        <p className="text-xs font-semibold leading-tight" style={{ color: "var(--ng-muted)" }}>
          {label}
        </p>
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-16" />
      ) : (
        <p data-metric-value className="mt-2 text-2xl font-semibold tabular-nums" style={{ color: "var(--ng-text)" }}>
          {shown}
        </p>
      )}
      {delta && !loading ? (
        <p className="mt-1 text-xs font-medium" style={{ color: "var(--ng-muted)" }}>
          {delta}
        </p>
      ) : null}
    </div>
  );
}

import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

// Honest error state with an optional safe retry. Never shows raw errors.
export function ErrorState({
  title = "Не удалось загрузить данные",
  description,
  onRetry,
  retryLabel = "Повторить",
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section role="alert" className="neu flex flex-col items-center gap-3 p-8 text-center">
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "#FEF2F2", color: "#B91C1C" }}>
        <AlertTriangle size={22} />
      </span>
      <h2 className="text-lg font-semibold" style={{ color: "var(--ng-text)" }}>
        {title}
      </h2>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed" style={{ color: "var(--ng-muted)" }}>
          {description}
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" className="neu-btn" onClick={onRetry}>
          <RefreshCw size={15} />
          {retryLabel}
        </button>
      ) : null}
    </section>
  );
}

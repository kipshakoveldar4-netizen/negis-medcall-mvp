import type { ReactNode } from "react";

// Medina OS page header: kicker (section context), title, optional description,
// and a right-aligned actions slot. Plain section — intentionally not a card.
export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-5 xl:flex-row xl:items-end xl:justify-between" style={{ borderColor: "var(--ng-border)" }}>
      <div className="min-w-0">
        {kicker ? (
          <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--ng-primary)" }}>
            {kicker}
          </p>
        ) : null}
        <h1 className="mt-1 text-2xl font-semibold leading-tight" style={{ color: "var(--ng-text)" }}>
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--ng-muted)" }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center xl:justify-end">{actions}</div> : null}
    </header>
  );
}

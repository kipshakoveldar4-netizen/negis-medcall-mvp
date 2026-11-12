import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Honest empty state: explains what will appear here and offers a real action.
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="neu flex flex-col items-center gap-3 p-8 text-center">
      {Icon ? (
        <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
          <Icon size={22} />
        </span>
      ) : null}
      <h2 className="text-lg font-semibold" style={{ color: "var(--negis-text)" }}>
        {title}
      </h2>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
          {description}
        </p>
      ) : null}
      {action}
    </section>
  );
}

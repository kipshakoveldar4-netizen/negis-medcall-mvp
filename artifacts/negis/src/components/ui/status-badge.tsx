import type { ReactNode } from "react";

export type StatusToneKey = "info" | "warning" | "success" | "error" | "neutral" | "primary";

// Medina OS status vocabulary: one semantic palette for every status pill.
// info = new/informational, warning = in progress/attention, success = confirmed,
// error = failed/lost/destructive, neutral = inactive, primary = brand-accented.
const STATUS_TONES: Record<StatusToneKey, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-red-200 bg-red-50 text-red-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
  primary: "border-teal-200 bg-teal-50 text-teal-800",
};

export function StatusBadge({ tone, children }: { tone: StatusToneKey; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONES[tone]}`}>
      {children}
    </span>
  );
}

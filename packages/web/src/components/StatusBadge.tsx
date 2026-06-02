import { cn } from "../lib/cn";

export type StatusLevel = "healthy" | "warning" | "urgent" | "critical" | "emergency" | "unknown";

const levelMeta: Record<StatusLevel, { label: string; classes: string; dot: string }> = {
  healthy: {
    label: "Healthy",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  warning: {
    label: "Warning",
    classes: "bg-amber-50 text-amber-800 border-amber-200",
    dot: "bg-amber-500",
  },
  urgent: {
    label: "Urgent",
    classes: "bg-orange-50 text-orange-800 border-orange-200",
    dot: "bg-orange-500",
  },
  critical: {
    label: "Critical",
    classes: "bg-rose-50 text-rose-800 border-rose-200",
    dot: "bg-rose-500",
  },
  emergency: {
    label: "Expired",
    classes: "bg-red-100 text-red-900 border-red-300",
    dot: "bg-red-600",
  },
  unknown: {
    label: "Unknown",
    classes: "bg-slate-50 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
};

export function statusLevelFromDays(daysRemaining: number | null | undefined): StatusLevel {
  if (daysRemaining === null || daysRemaining === undefined) return "unknown";
  if (daysRemaining <= 0) return "emergency";
  if (daysRemaining <= 1) return "critical";
  if (daysRemaining <= 7) return "urgent";
  if (daysRemaining <= 30) return "warning";
  return "healthy";
}

export interface StatusBadgeProps {
  daysRemaining?: number | null;
  level?: StatusLevel;
  className?: string;
  showLabel?: boolean;
}

export function StatusBadge({
  daysRemaining,
  level,
  className,
  showLabel = true,
}: StatusBadgeProps) {
  const resolved = level ?? statusLevelFromDays(daysRemaining);
  const meta = levelMeta[resolved];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        meta.classes,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {showLabel ? meta.label : null}
    </span>
  );
}

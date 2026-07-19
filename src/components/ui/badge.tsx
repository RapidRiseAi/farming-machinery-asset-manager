import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "brand" | "ok" | "warning" | "danger" | "info";

// Tint bg + dark text — every pairing clears WCAG-AA on the tint.
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-sand-100 text-sand-700",
  brand: "bg-brand-50 text-brand-700",
  ok: "bg-green-50 text-green-800",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
  info: "bg-blue-50 text-blue-700",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

/** Small pill label for categories/counts. */
export function Badge({ tone = "neutral", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export type ServiceStatus = "ok" | "due_soon" | "overdue";

const STATUS_STYLES: Record<ServiceStatus, { wrap: string; dot: string }> = {
  ok: { wrap: "bg-green-50 text-green-800", dot: "bg-status-ok" },
  due_soon: { wrap: "bg-amber-50 text-amber-800", dot: "bg-status-due" },
  overdue: { wrap: "bg-red-50 text-red-700", dot: "bg-status-overdue" },
};

export type StatusPillProps = {
  status: ServiceStatus;
  /** Translated label. Pass `t("ui.statusOverdue", locale)` etc. for i18n. */
  label?: ReactNode;
  className?: string;
};

/**
 * Traffic-light service status pill (Scope §4.3): coloured dot + tinted label.
 * Colour is never the sole signal — the text label always accompanies it.
 */
export function StatusPill({ status, label, className }: StatusPillProps) {
  const s = STATUS_STYLES[status];
  const fallback = status === "due_soon" ? "Due soon" : status === "overdue" ? "Overdue" : "OK";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        s.wrap,
        className,
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", s.dot)} aria-hidden />
      {label ?? fallback}
    </span>
  );
}

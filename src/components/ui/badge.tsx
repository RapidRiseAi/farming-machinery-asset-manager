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

/** Small pill label for categories/counts. Not for status — use `StatusBadge`. */
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

// ── Status: shape + word + colour ────────────────────────────────────────────
//
// The audit's sixth pattern. The machines list rendered all six machine statuses as
// `tone="neutral"`, so a broken machine and a working one were identical rows; the
// job-card list collapsed reported / open / in progress into one blue. And where
// colour did carry meaning it carried it alone.
//
// This product is used in direct sunlight, by colour-blind users, on cracked screens.
// So every status carries three independent signals: a SHAPE you can tell apart in
// silhouette, a WORD in plain language, and a COLOUR. Remove any one and the state is
// still readable.

/** The shape vocabulary. Distinguishable in silhouette, not just by hue. */
export type StatusShape =
  | "dot" // ● running / fine
  | "ring" // ○ not started / idle
  | "half" // ◐ under way
  | "triangle" // ▲ needs attention soon
  | "square" // ■ stopped / overdue
  | "check" // ✓ done
  | "clock" // ◔ waiting on someone else
  | "dash"; // — not in play (retired, sold)

function ShapeGlyph({ shape, className }: { shape: StatusShape; className?: string }) {
  const common = { className: cn("h-2.5 w-2.5 shrink-0", className), "aria-hidden": true };
  switch (shape) {
    case "ring":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "half":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 1.4a3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
        </svg>
      );
    case "triangle":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="currentColor">
          <path d="M5 1 9.3 8.6H0.7z" />
        </svg>
      );
    case "square":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="currentColor">
          <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1.2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.3 3.9 7.7 8.5 2.6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "clock":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="3.8" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5 2.9V5l1.7 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "dash":
      return (
        <svg {...common} viewBox="0 0 10 10" fill="none">
          <path d="M1.6 5h6.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "dot":
    default:
      return (
        <svg {...common} viewBox="0 0 10 10" fill="currentColor">
          <circle cx="5" cy="5" r="3.4" />
        </svg>
      );
  }
}

/** Colour of the shape itself — stronger than the label, so it reads at a glance. */
const SHAPE_INK: Record<BadgeTone, string> = {
  neutral: "text-sand-500",
  brand: "text-brand-600",
  ok: "text-status-ok",
  warning: "text-status-due",
  danger: "text-status-overdue",
  info: "text-blue-600",
};

export type StatusBadgeProps = {
  /** Translated, plain-language wording. Never an enum value. */
  label: ReactNode;
  tone: BadgeTone;
  shape: StatusShape;
  /** `sm` for dense table rows, `md` for cards and headers. */
  size?: "sm" | "md";
  className?: string;
};

/**
 * The one way to render a status anywhere in the app: shape + word + colour, always
 * all three. Pass a translated label; the shape and tone come from the per-enum maps
 * below so the same state looks the same on every screen.
 */
export function StatusBadge({
  label,
  tone,
  shape,
  size = "sm",
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        TONES[tone],
        className,
      )}
    >
      <ShapeGlyph shape={shape} className={SHAPE_INK[tone]} />
      {label}
    </span>
  );
}

export type StatusLook = { tone: BadgeTone; shape: StatusShape };

const NEUTRAL: StatusLook = { tone: "neutral", shape: "ring" };

/** Service due state (Scope §4.3) — the traffic light the whole product turns on. */
export const SERVICE_LOOK: Record<string, StatusLook> = {
  ok: { tone: "ok", shape: "dot" },
  due_soon: { tone: "warning", shape: "triangle" },
  overdue: { tone: "danger", shape: "square" },
};

/** Machine status. Every one of the six now looks different from the other five. */
export const MACHINE_LOOK: Record<string, StatusLook> = {
  active: { tone: "ok", shape: "dot" },
  standby: { tone: "neutral", shape: "ring" },
  in_workshop: { tone: "info", shape: "half" },
  out_of_service: { tone: "danger", shape: "square" },
  retired: { tone: "neutral", shape: "dash" },
  sold: { tone: "neutral", shape: "dash" },
};

/** Job-card lifecycle — the three states a mechanic moves between stay distinct. */
export const JOB_LOOK: Record<string, StatusLook> = {
  reported: { tone: "info", shape: "ring" },
  open: { tone: "info", shape: "ring" },
  in_progress: { tone: "warning", shape: "half" },
  waiting_parts: { tone: "warning", shape: "clock" },
  completed: { tone: "ok", shape: "check" },
  approved: { tone: "brand", shape: "check" },
};

/** Fault lifecycle. */
export const FAULT_LOOK: Record<string, StatusLook> = {
  open: { tone: "danger", shape: "square" },
  acknowledged: { tone: "warning", shape: "triangle" },
  scheduled: { tone: "info", shape: "clock" },
  in_job: { tone: "info", shape: "half" },
  in_progress: { tone: "warning", shape: "half" },
  resolved: { tone: "ok", shape: "check" },
};

/** How badly the machine is hurt, in the driver's words. */
export const URGENCY_LOOK: Record<string, StatusLook> = {
  can_work: { tone: "ok", shape: "dot" },
  limping: { tone: "warning", shape: "triangle" },
  stopped: { tone: "danger", shape: "square" },
};

/** Work-request lifecycle — all eight states, each distinguishable. */
export const WORK_LOOK: Record<string, StatusLook> = {
  requested: { tone: "info", shape: "ring" },
  viewed: { tone: "info", shape: "half" },
  quoted: { tone: "warning", shape: "triangle" },
  accepted: { tone: "brand", shape: "check" },
  in_progress: { tone: "warning", shape: "half" },
  completed: { tone: "ok", shape: "check" },
  invoiced: { tone: "danger", shape: "triangle" },
  closed: { tone: "neutral", shape: "dash" },
};

/** Priority on a work request. */
export const PRIORITY_LOOK: Record<string, StatusLook> = {
  urgent: { tone: "danger", shape: "square" },
  high: { tone: "warning", shape: "triangle" },
  normal: { tone: "neutral", shape: "dot" },
  low: { tone: "neutral", shape: "ring" },
};

/** Paper about to run out (licence, warranty). */
export const EXPIRY_LOOK: Record<string, StatusLook> = {
  ok: { tone: "ok", shape: "dot" },
  expiring: { tone: "warning", shape: "triangle" },
  expired: { tone: "danger", shape: "square" },
};

/** Budget against actual spend. */
export const BUDGET_LOOK: Record<string, StatusLook> = {
  under: { tone: "ok", shape: "dot" },
  near: { tone: "warning", shape: "triangle" },
  over: { tone: "danger", shape: "square" },
};

/** Traffic fine (AARTO) lifecycle. */
export const FINE_LOOK: Record<string, StatusLook> = {
  received: { tone: "info", shape: "ring" },
  nominated: { tone: "warning", shape: "half" },
  paid: { tone: "ok", shape: "check" },
  disputed: { tone: "warning", shape: "triangle" },
  overdue: { tone: "danger", shape: "square" },
  closed: { tone: "neutral", shape: "dash" },
};

/** Partner quote/invoice lifecycle (F14). One vocabulary across both kinds. */
export const DOC_LOOK: Record<string, StatusLook> = {
  draft: { tone: "neutral", shape: "ring" },
  sent: { tone: "info", shape: "clock" },
  accepted: { tone: "ok", shape: "check" },
  declined: { tone: "danger", shape: "square" },
  part_paid: { tone: "warning", shape: "half" },
  paid: { tone: "ok", shape: "check" },
  cancelled: { tone: "neutral", shape: "dash" },
  expired: { tone: "warning", shape: "triangle" },
  void: { tone: "neutral", shape: "dash" },
  written_off: { tone: "danger", shape: "dash" },
};

/** Look up a state's look in a map, falling back to a neutral ring. */
export function look(map: Record<string, StatusLook>, value: string | null | undefined): StatusLook {
  return (value && map[value]) || NEUTRAL;
}

// ── Back-compat ──────────────────────────────────────────────────────────────

export type ServiceStatus = "ok" | "due_soon" | "overdue";

export type StatusPillProps = {
  status: ServiceStatus;
  /** Translated label. Pass `t("ui.statusOverdue", locale)` etc. for i18n. */
  label?: ReactNode;
  className?: string;
};

/**
 * Traffic-light service status pill (Scope §4.3). Kept as a named entry point for the
 * service board; it now renders through `StatusBadge`, so it carries a shape too.
 */
export function StatusPill({ status, label, className }: StatusPillProps) {
  const fallback = status === "due_soon" ? "Due soon" : status === "overdue" ? "Overdue" : "OK";
  const l = look(SERVICE_LOOK, status);
  return (
    <StatusBadge
      label={label ?? fallback}
      tone={l.tone}
      shape={l.shape}
      size="md"
      className={className}
    />
  );
}

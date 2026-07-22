import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, WarningIcon, InfoIcon } from "./icons";

export type FlashTone = "success" | "error" | "info" | "warning";

const TONES: Record<FlashTone, { wrap: string; icon: ReactNode }> = {
  success: {
    wrap: "border-green-200 bg-green-50 text-green-800",
    icon: <CheckIcon />,
  },
  error: {
    wrap: "border-red-200 bg-red-50 text-red-700",
    icon: <WarningIcon />,
  },
  warning: {
    wrap: "border-amber-200 bg-amber-50 text-amber-800",
    icon: <WarningIcon />,
  },
  info: {
    wrap: "border-blue-200 bg-blue-50 text-blue-700",
    icon: <InfoIcon />,
  },
};

export type FlashProps = {
  /** The message to display. Render nothing when empty/undefined. */
  message?: ReactNode;
  tone?: FlashTone;
  className?: string;
};

/**
 * Server-rendered inline alert (no JS). Feed it a message derived from
 * searchParams, e.g. the existing `?saved=1` / `?error=` pattern:
 *
 *   <Flash tone="success" message={searchParams.saved ? t("ui.saved", locale) : undefined} />
 *
 * For a dismissible/auto-hiding transient alert, use `Toast` (client) instead.
 */
export function Flash({ message, tone = "info", className }: FlashProps) {
  if (!message) return null;
  const s = TONES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm font-medium",
        s.wrap,
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-[1.15rem]" aria-hidden>
        {s.icon}
      </span>
      <span className="min-w-0">{message}</span>
    </div>
  );
}

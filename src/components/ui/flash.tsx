import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, WarningIcon, InfoIcon } from "./icons";

export type FlashTone = "success" | "error" | "info" | "warning";

/**
 * The four tones, on the FleetWise palette.
 *
 * These were previously stock Tailwind — green-200/red-50/amber-800/blue-700 —
 * four colour families that appear nowhere in the brand, on the most widely
 * rendered component in the product (143 call sites).
 *
 * Each triple is verified: the text clears 4.5:1 on its own tint, and the tint
 * is distinguishable from both the cream page ground and a white card. Note
 * `info` is a warm neutral rather than a blue — there is no blue in this
 * palette, and an informational notice does not need a hue of its own when it
 * already has an icon and words.
 */
const TONES: Record<FlashTone, { wrap: string; icon: ReactNode }> = {
  success: {
    wrap: "border-callout-ok-edge bg-callout-ok-bg text-callout-ok-ink",
    icon: <CheckIcon />,
  },
  error: {
    wrap: "border-callout-danger-edge bg-callout-danger-bg text-callout-danger-ink",
    icon: <WarningIcon />,
  },
  warning: {
    wrap: "border-callout-warn-edge bg-callout-warn-bg text-callout-warn-ink",
    icon: <WarningIcon />,
  },
  info: {
    wrap: "border-callout-info-edge bg-callout-info-bg text-callout-info-ink",
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
      <span className="mt-0.5 shrink-0 text-lg" aria-hidden>
        {s.icon}
      </span>
      <span className="min-w-0">{message}</span>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { CheckIcon } from "@/components/ui/icons";

/**
 * Which stretch of time a books screen is showing, as one row of chips.
 *
 * `/money`, `/vat`, `/accounting` and `/cashflow` each drew this as a card titled "Which
 * period?" holding a row of buttons, the chosen one a FILLED green button. That put a
 * second primary on every one of those screens, competing with the action the screen
 * exists for, and spent a whole card on a choice that is made once a visit. These are
 * plain links (they work before hydration and with no JavaScript), and the chosen one is
 * marked with a tick and a tint, so it reads as "selected" rather than "press me".
 *
 * Server component. Each chip is 48px tall on a phone and steps down at `sm`.
 */
export type PeriodChip = {
  key: string;
  href: string;
  label: ReactNode;
  active: boolean;
};

export function PeriodChips({
  items,
  label,
  className,
}: {
  items: readonly PeriodChip[];
  /** Names the group for a screen reader, e.g. "Which period?". */
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("flex min-w-0 flex-wrap gap-2", className)}>
      {items.map((p) => (
        <Link
          key={p.key}
          href={p.href}
          scroll={false}
          aria-current={p.active ? "true" : undefined}
          className={cn(
            "focus-ring inline-flex min-h-[48px] max-w-full items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-[40px]",
            p.active
              ? "border-brand-600 bg-brand-tint text-brand-ink"
              : "border-sand-200 bg-surface text-sand-700 hover:border-sand-300 hover:bg-sand-50",
          )}
        >
          {p.active ? <CheckIcon className="shrink-0" /> : null}
          <span className="min-w-0">{p.label}</span>
        </Link>
      ))}
    </nav>
  );
}

import type { ReactNode } from "react";
import { ChevronDownIcon } from "./icons";
import { cn } from "./cn";

/**
 * Secondary content, collapsed until asked for.
 *
 * == Why this exists as a component ==========================================
 * Thirteen pages had grown their own `<details>`, and they had grown apart: three
 * distinct treatments were in the tree at once, a `rounded-2xl` card with a rotating
 * chevron on `/tyres` and `/incidents`, a bare `text-xs` link on `/fines`, a
 * `min-h-[2.75rem]` inline summary on `/suppliers`. Same control, same job, three
 * looks, so nothing taught you what a collapsed thing looks like on this product.
 *
 * == Why native `<details>` and not a client component =======================
 * It needs no JavaScript, which keeps it usable on the first paint and inside a
 * server-rendered page with no client boundary at all, and the browser gives the
 * correct semantics and keyboard behaviour for free. `DialogForm` is the client
 * component for CAPTURE; this is for READING, where a dialog would be the wrong
 * shape: history, breakdowns, reference tables, the detail under a summary figure.
 *
 * Rule of thumb, stated so the next person does not have to guess:
 *   · fields to fill in         → `DialogForm`
 *   · actions on one row        → `ActionMenu`
 *   · more detail to read       → `Disclosure`
 */

export type DisclosureProps = {
  summary: ReactNode;
  /** Right-aligned in the summary row, e.g. a count or a total. */
  meta?: ReactNode;
  /** `card` stands alone on the page; `inline` sits inside one. */
  variant?: "card" | "inline";
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
};

export function Disclosure({
  summary,
  meta,
  variant = "card",
  defaultOpen = false,
  children,
  className,
}: DisclosureProps) {
  const card = variant === "card";
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group",
        card && "rounded-2xl border border-sand-200 bg-surface shadow-xs",
        className,
      )}
    >
      <summary
        className={cn(
          // `list-none` plus the webkit pseudo-element: Safari keeps drawing its own
          // triangle from `::-webkit-details-marker` even once `list-style` is gone,
          // so the row rendered with two arrows on iOS.
          "focus-ring flex cursor-pointer list-none items-center justify-between gap-3",
          "[&::-webkit-details-marker]:hidden",
          card ? "p-4 sm:p-5" : "min-h-[48px] rounded-lg px-1 sm:min-h-[36px]",
        )}
      >
        <span className={cn("min-w-0", card ? "font-semibold text-ink" : "text-sm font-medium text-brand-ink")}>
          {summary}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {meta ? <span className="text-sm text-sand-600">{meta}</span> : null}
          <ChevronDownIcon className="shrink-0 text-sand-500 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className={cn(card ? "px-4 pb-4 sm:px-5 sm:pb-5" : "px-1 pb-2 pt-1")}>{children}</div>
    </details>
  );
}

import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Label-and-value rows: what a thing IS, rather than a box to type it into.
 *
 * == Why a screen needs this at all ===========================================
 * `/settings` could not answer "what is this farm configured to do?". It rendered
 * twenty-two input boxes, so reading a setting meant reading the current contents of a
 * text field, and there is no glance that takes that in. Worse, an input box is an
 * invitation: the page looked like work outstanding rather than a record of decisions
 * already made.
 *
 * A settings page, a supplier, a machine's identity: all of them are mostly READ, and
 * occasionally edited. So the page states them, and an `Edit` button opens the fields
 * for one group at a time. The number of things on screen drops by about two thirds and
 * nothing is lost, because a value you can read is strictly more informative than the
 * same value inside a control.
 *
 * `<dl>` and not a table, deliberately: these are name/value pairs, not rows of a
 * dataset, and a screen reader announces them as pairs. On a phone the value sits under
 * its label; from `sm` up they share a line, which is where the compactness comes from.
 */

export type FactProps = {
  label: ReactNode;
  /** The value. Pass a `<Badge>` or a formatted amount, not a form control. */
  value: ReactNode;
  /** One short line under the value, for a unit or a caveat. */
  hint?: ReactNode;
  /** Dim the value when nothing is set, so "not set" does not read as data. */
  muted?: boolean;
};

export function Fact({ label, value, hint, muted = false }: FactProps) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-sand-600">{label}</dt>
      <dd
        className={cn(
          "text-sm font-medium sm:text-right",
          muted ? "text-sand-500" : "text-sand-900",
        )}
      >
        {value}
        {hint ? <span className="block text-xs font-normal text-sand-500">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function FactList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <dl className={cn("divide-y divide-sand-100", className)}>{children}</dl>;
}

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * One stated preference: what it is, what it is set to, and (optionally) the one button
 * that changes it. The value is text, never an input box; the button opens the dialog
 * that asks for something new.
 *
 * Renders a `<div>` of `<dt>`/`<dd>`, so put rows inside a `FactList` (a `<dl>`).
 * The button keeps its own column beside the label and value, which wrap within theirs.
 */
export function PrefRow({
  label,
  value,
  hint,
  action,
  muted = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3", className)}>
      <dt className="col-start-1 text-sm text-sand-600">{label}</dt>
      <dd
        className={cn(
          "col-start-1 mt-0.5 min-w-0 break-words text-sm font-medium",
          muted ? "text-sand-500" : "text-sand-900",
        )}
      >
        {value}
        {hint ? <span className="mt-0.5 block text-xs font-normal text-sand-500">{hint}</span> : null}
      </dd>
      {action ? <dd className="col-start-2 row-span-2 row-start-1">{action}</dd> : null}
    </div>
  );
}

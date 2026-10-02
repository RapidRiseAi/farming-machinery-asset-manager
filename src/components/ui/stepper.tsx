import { cn } from "./cn";

/**
 * Where a piece of work is, as one slim bar.
 *
 * The job card and the work request each used to explain their stage in a paragraph,
 * and the work request drew eight status chips in a strip that scrolled sideways on a
 * phone. A person only needs three things: how far along it is, what the current step is
 * called, and how many are left. So the bar shows every step as a segment, names the
 * current one, and only lays out every label from `sm` up, where they fit.
 *
 * The current step is gold: docs/DESIGN.md reserves gold for "the current step", and
 * done steps are brand green. Shape carries it as well as colour: a done segment is
 * full, the current one is full and gold, an upcoming one is a pale track.
 */
export function Stepper({
  steps,
  current,
  label,
  progressLabel,
  className,
}: {
  /** Step labels, already translated, in order. */
  steps: string[];
  /** Index of the current step. */
  current: number;
  /** Accessible name for the whole bar, e.g. "Job progress". */
  label: string;
  /** "Step 2 of 4", already translated; shown on phones beside the current label. */
  progressLabel: string;
  className?: string;
}) {
  const at = Math.max(0, Math.min(current, steps.length - 1));
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3 sm:hidden">
        <p className="text-sm font-semibold text-sand-900">{steps[at]}</p>
        <p className="text-xs text-sand-500">{progressLabel}</p>
      </div>
      <ol aria-label={label} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((step, i) => {
          const state = i < at ? "done" : i === at ? "current" : "upcoming";
          return (
            <li key={step} aria-current={state === "current" ? "step" : undefined} className="flex min-w-0 flex-col gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 rounded-full",
                  state === "done" && "bg-brand-600",
                  state === "current" && "bg-gold-500",
                  state === "upcoming" && "bg-sand-200",
                )}
              />
              <span
                className={cn(
                  "hidden truncate text-xs sm:block",
                  state === "current" ? "font-semibold text-sand-900" : state === "done" ? "text-sand-600" : "text-sand-400",
                )}
              >
                {step}
              </span>
              <span className="sr-only sm:hidden">{step}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

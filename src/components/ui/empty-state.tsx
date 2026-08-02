import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, SearchIcon } from "./icons";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** Primary action (e.g. a Button or a link styled with `buttonVariants`). */
  action?: ReactNode;
  className?: string;
};

/**
 * Generic placeholder. Prefer one of the three below — empty means different things
 * on different screens and they need opposite treatments (audit, Phase 1 item 4).
 */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-sand-300 bg-sand-50/60 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-[1.5rem] text-brand-600">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold text-sand-900">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-sand-500">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Empty is the GOOD outcome: no faults, nothing in the inbox, the bench is clear.
 * This should feel like a result, not a gap — green, calm, and it does not nag you to
 * create something.
 */
export function AllClear({
  title,
  hint,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-brand-100 bg-brand-50/70 px-6 py-9 text-center",
        className,
      )}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-[1.5rem] text-brand-700">
        {icon ?? <CheckIcon />}
      </div>
      <p className="text-base font-semibold text-brand-900">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-brand-800/80">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Empty because the farm hasn't set this up yet. Encouraging, with a single obvious
 * next step and — where it helps — a ghost preview of what the filled screen looks
 * like, so the value is visible before any work is done.
 */
export function GetStarted({
  title,
  hint,
  icon,
  action,
  secondaryAction,
  preview,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** Faded, non-interactive sample of the populated state. */
  preview?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-sand-200 bg-white",
        className,
      )}
    >
      <div className="flex flex-col items-center px-6 py-8 text-center">
        {icon ? (
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-[1.7rem] text-brand-600">
            {icon}
          </div>
        ) : null}
        <p className="text-lg font-bold tracking-tight text-sand-900">{title}</p>
        {hint ? <p className="mt-1.5 max-w-md text-sm leading-relaxed text-sand-600">{hint}</p> : null}
        {action || secondaryAction ? (
          <div className="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center">
            {action}
            {secondaryAction}
          </div>
        ) : null}
      </div>
      {preview ? (
        <div
          className="pointer-events-none select-none border-t border-sand-100 bg-sand-50/70 px-4 py-4 opacity-45 [mask-image:linear-gradient(to_bottom,black,transparent)]"
          aria-hidden
        >
          {preview}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Empty because a filter or a search hid everything. The fix is to clear the filter,
 * NOT to add a machine — the old shared empty state offered "Add machine" here, which
 * sent people to create a duplicate of something they already had.
 */
export function NoMatches({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** Should clear the filter — that is the actual fix. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-sand-300 bg-sand-50/60 px-6 py-9 text-center",
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-sand-100 text-[1.35rem] text-sand-500">
        <SearchIcon />
      </div>
      <p className="text-base font-semibold text-sand-900">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-sand-500">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

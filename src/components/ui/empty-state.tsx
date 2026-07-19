import type { ReactNode } from "react";
import { cn } from "./cn";

export type EmptyStateProps = {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** Primary action (e.g. a Button or a link styled with `buttonVariants`). */
  action?: ReactNode;
  className?: string;
};

/** Friendly placeholder for empty lists/sections. */
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

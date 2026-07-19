import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { ChevronRightIcon } from "./icons";

export type StatTone = "default" | "brand" | "ok" | "due" | "overdue";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-sand-900",
  brand: "text-brand-700",
  ok: "text-status-ok",
  due: "text-status-due",
  overdue: "text-status-overdue",
};

export type StatProps = {
  label: ReactNode;
  value: ReactNode;
  /** Small qualifier under the value, e.g. "vs R3,200 last month". */
  delta?: ReactNode;
  tone?: StatTone;
  icon?: ReactNode;
  /** When set, the whole tile becomes a link with a chevron affordance. */
  href?: string;
  className?: string;
};

/**
 * KPI tile: label, big value, optional delta/icon. Colours the value by `tone`
 * (used for the traffic-light service board). Renders as a link when `href` set.
 */
export function Stat({ label, value, delta, tone = "default", icon, href, className }: StatProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-sand-500">{label}</span>
        {icon ? <span className="text-[1.25rem] text-sand-400">{icon}</span> : null}
        {!icon && href ? (
          <ChevronRightIcon className="text-[1.1rem] text-sand-400" />
        ) : null}
      </div>
      <div className={cn("mt-1.5 text-3xl font-bold leading-none tracking-tight", VALUE_TONE[tone])}>
        {value}
      </div>
      {delta ? <div className="mt-1.5 text-xs text-sand-500">{delta}</div> : null}
    </>
  );

  const base = "block rounded-xl border border-sand-200 bg-white p-4 shadow-card";

  if (href) {
    return (
      <Link
        href={href}
        className={cn(base, "focus-ring transition-shadow hover:shadow-soft", className)}
      >
        {inner}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{inner}</div>;
}

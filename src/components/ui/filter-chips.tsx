"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

export type ChipOption = {
  /** Empty string clears the param. */
  value: string;
  label: string;
  /** Optional count shown after the label ("In workshop 2"). */
  count?: number;
};

/**
 * Filter chips that apply on tap.
 *
 * Four screens (machines, work requests, parts, job cards) opened with a card of
 * dropdowns and a *Search* button. On a phone that card ate the whole first screen and
 * did nothing at all until submitted — you scrolled past a form to reach the list you
 * came for (audit pattern 5).
 *
 * Chips write EXACTLY the same URL params the old forms did, so every server query,
 * sort and CSV route is untouched. Selecting the already-selected chip clears it.
 *
 * `search` is the current query string, passed from the server — deliberately not
 * `useSearchParams()`, which would drag the page into a Suspense boundary.
 */
export function FilterChips({
  paramName,
  current,
  options,
  path,
  search,
  label,
  /** Params to drop when this filter changes (e.g. a page cursor). */
  resets = [],
  className,
}: {
  paramName: string;
  current: string | undefined;
  options: ChipOption[];
  path: string;
  search: string;
  label: string;
  resets?: string[];
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(value: string) {
    const params = new URLSearchParams(search);
    if (value) params.set(paramName, value);
    else params.delete(paramName);
    for (const r of resets) params.delete(r);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${path}?${qs}` : path));
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        pending && "opacity-70",
        className,
      )}
    >
      {options.map((o) => {
        const active = (current ?? "") === o.value;
        return (
          <button
            key={o.value || "__all"}
            type="button"
            aria-pressed={active}
            onClick={() => apply(active && o.value ? "" : o.value)}
            className={cn(
              "focus-ring inline-flex min-h-[44px] shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors",
              active
                ? "border-brand-600 bg-brand-600 text-white shadow-xs"
                : "border-sand-200 bg-white text-sand-700 hover:border-sand-300 hover:bg-sand-50",
            )}
          >
            {o.label}
            {o.count != null ? (
              <span
                className={cn(
                  "tabular-nums",
                  active ? "text-white/75" : "text-sand-400",
                )}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A summary of what is currently filtered, with a one-tap way out. Pairs with the
 * chips above: the audit found screens that hid rows with no indication anything was
 * hidden, and a "no results" state whose only button made the problem worse.
 */
export function ActiveFilters({
  chips,
  clearLabel,
  path,
  className,
}: {
  chips: { paramName: string; label: string }[];
  clearLabel: string;
  path: string;
  className?: string;
}) {
  const router = useRouter();
  if (chips.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {chips.map((c) => (
        <span
          key={c.paramName}
          className="inline-flex items-center gap-1 rounded-full bg-sand-100 px-2.5 py-1 text-xs font-medium text-sand-700"
        >
          {c.label}
        </span>
      ))}
      <button
        type="button"
        onClick={() => router.push(path)}
        className="focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
      >
        <CloseIcon className="text-[1rem]" />
        {clearLabel}
      </button>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cn } from "./cn";
import { CloseIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon } from "./icons";
import type { ChipOption } from "./filter-chips";

export type FilterGroup = {
  /** URL param this group writes — unchanged from the original form. */
  paramName: string;
  /** Visible group name. The old chip rows had an aria-label and nothing on screen. */
  label: string;
  current: string | undefined;
  options: ChipOption[];
};

/**
 * One filter control for a whole screen.
 *
 * The machines list stacked four separate chip rows — type, status, cost centre,
 * department — each an unlabelled horizontal scroller. On a phone that was roughly
 * 200px of identical-looking controls before the first machine, and no way to tell
 * which row filtered what: the group names existed only as `aria-label`.
 *
 * Now: search and one *Filters* button on a single line; what is actually filtering
 * shown as named, individually removable pills; and the groups themselves behind a
 * disclosure, each with a visible heading. Collapsed by default, because the list is
 * what people came for — and it opens already showing what they set.
 *
 * The URL params written are exactly the ones the old rows wrote, so every server
 * query, sort link and CSV route is untouched.
 */
export function FilterBar({
  path,
  search,
  groups,
  filtersLabel,
  clearLabel,
  searchSlot,
  extra,
}: {
  path: string;
  /** Current query string, from the server — avoids dragging the page into Suspense. */
  search: string;
  groups: FilterGroup[];
  filtersLabel: string;
  clearLabel: string;
  /** The search form, which needs a keyboard and so stays a real form. */
  searchSlot?: ReactNode;
  /** Anything trailing the summary line (result count, "show retired", …). */
  extra?: ReactNode;
}) {
  const active = groups.filter((g) => (g.current ?? "") !== "");
  const [open, setOpen] = useState(false);

  /**
   * Every chip is a real `<Link>`, not a button calling `router.push`.
   *
   * Two reasons, one of which was a live bug found by driving the built app: the
   * router call was silently doing nothing here — the handler ran, the target was
   * correct, and the URL never changed. A link cannot fail that way; the browser
   * navigates whether or not our JavaScript has run. On a mid-range Android that
   * pre-hydration window is long enough to matter, and it is exactly when an impatient
   * thumb hits a filter.
   */
  const hrefWith = (changes: Record<string, string>) => {
    const params = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };

  const clearAllHref = hrefWith(Object.fromEntries(groups.map((g) => [g.paramName, ""])));

  const labelOf = (g: FilterGroup) =>
    g.options.find((o) => o.value === (g.current ?? ""))?.label ?? g.current ?? "";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {searchSlot ? <div className="min-w-[12rem] flex-1">{searchSlot}</div> : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "focus-ring inline-flex min-h-[48px] shrink-0 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors sm:min-h-[44px]",
            active.length > 0
              ? "border-brand-600 bg-brand-50 text-brand-800"
              : "border-sand-300 bg-white text-sand-700 hover:bg-sand-50",
          )}
        >
          <SearchIcon className="text-[1.05rem]" />
          {filtersLabel}
          {active.length > 0 ? (
            <span className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-bold tabular-nums text-white">
              {active.length}
            </span>
          ) : null}
          {open ? <ChevronUpIcon className="text-[1rem]" /> : <ChevronDownIcon className="text-[1rem]" />}
        </button>
      </div>

      {/* What is filtering, in words, each removable on its own — previously you had to
          find the right chip in the right unlabelled row and press it again. */}
      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {active.map((g) => (
            <Link
              key={g.paramName}
              href={hrefWith({ [g.paramName]: "" })}
              className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-sand-300 bg-white px-3 text-sm font-medium text-sand-800 hover:bg-sand-50 sm:min-h-[36px]"
            >
              <span className="text-sand-500">{g.label}:</span>
              {labelOf(g)}
              <CloseIcon className="text-[0.95rem] text-sand-400" />
            </Link>
          ))}
          <Link
            href={clearAllHref}
            className="focus-ring inline-flex min-h-[48px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 sm:min-h-[36px]"
          >
            {clearLabel}
          </Link>
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-3 rounded-xl border border-sand-200 bg-white p-3">
          {groups.map((g) => (
            <div key={g.paramName}>
              {/* The visible heading the stacked rows never had. */}
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-sand-500">
                {g.label}
              </p>
              <div
                role="group"
                aria-label={g.label}
                className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {g.options.map((o) => {
                  const on = (g.current ?? "") === o.value;
                  return (
                    <Link
                      key={o.value || "__all"}
                      href={hrefWith({ [g.paramName]: on && o.value ? "" : o.value })}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "focus-ring inline-flex min-h-[48px] shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-[40px]",
                        on
                          ? "border-brand-600 bg-brand-600 text-white shadow-xs"
                          : "border-sand-200 bg-white text-sand-700 hover:border-sand-300 hover:bg-sand-50",
                      )}
                    >
                      {o.label}
                      {o.count != null ? (
                        <span className={cn("tabular-nums", on ? "text-white/75" : "text-sand-400")}>
                          {o.count}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {extra ? <div className="flex flex-wrap items-center gap-3 text-sm text-sand-500">{extra}</div> : null}
    </div>
  );
}

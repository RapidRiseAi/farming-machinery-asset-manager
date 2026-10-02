"use client";

/**
 * One filter control for a whole list screen. Client component.
 *
 *   <FilterBar
 *     path="/jobcards" search={qs} groups={groups}
 *     filtersLabel={t("filters.filters", locale)} clearLabel={t("filters.clear", locale)}
 *     searchField={{ label: t(SEARCH_KEY, locale), clearLabel: t("common.clearSearch", locale) }}
 *     rememberKey="jobcards"
 *   />
 *
 * Props: `path`, `search` (current query string, from the server), `groups:
 * FilterGroup[]`, `filtersLabel`, `clearLabel`, `searchField?` ({ label, clearLabel,
 * placeholder?, name? = "q" }: renders a kit `SearchField` wired to this URL),
 * `searchSlot?` (a hand-built search form, the older way), `rememberKey?` (remember
 * the last filters on this device, see below), `extra?` (trailing line: result count,
 * "show retired").
 *
 * For the empty list under a filter use `filterState()` + `FilteredEmpty` from
 * `./filter-state` and `./empty-state`: those are server-safe, this module is not.
 * `FilterGroup` and `ChipOption` are re-exported here for existing imports.
 *
 * == Remembering filters (`rememberKey`) ======================================
 * An owner who always reads "Open" job cards, or a mechanic filtering Work to "Mine",
 * set the same chips on every visit. With `rememberKey` the active filters are kept
 * in this browser's localStorage (`fw:filters:<key>`). Arriving with NO filter params
 * in the URL restores them with `router.replace`, so they show as the usual removable
 * pills and one tap on Clear undoes them; Clear (or removing the last pill) forgets
 * them too. The search text is not remembered, and a remembered value that is no
 * longer one of the options (a deleted cost centre) is dropped rather than applied.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { CloseIcon, ChevronDownIcon, ChevronUpIcon, FilterIcon } from "./icons";
import { SearchField } from "./search-field";
import { hrefWithParams, type FilterGroup } from "./filter-state";

export type { ChipOption, FilterGroup } from "./filter-state";

const STORAGE_PREFIX = "fw:filters:";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null; // private mode, storage disabled: simply nothing remembered
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(STORAGE_PREFIX + key, value);
    else window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* storage unavailable or full: remembering is a convenience, not a requirement */
  }
}

export type FilterBarSearchField = {
  label: string;
  clearLabel: string;
  placeholder?: string;
  /** URL param. Default "q". */
  name?: string;
};

/**
 * The machines list stacked four separate chip rows, type, status, cost centre,
 * department, each an unlabelled horizontal scroller. On a phone that was roughly
 * 200px of identical-looking controls before the first machine, and no way to tell
 * which row filtered what: the group names existed only as `aria-label`.
 *
 * Now: search and one *Filters* button; what is actually filtering shown as named,
 * individually removable pills; and the groups themselves behind a disclosure, each
 * with a visible heading. Collapsed by default, because the list is what people came
 * for, and it opens already showing what they set.
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
  searchField,
  rememberKey,
  extra,
}: {
  path: string;
  /** Current query string, from the server, avoids dragging the page into Suspense. */
  search: string;
  groups: FilterGroup[];
  filtersLabel: string;
  clearLabel: string;
  /** A hand-built search form. Prefer `searchField`. */
  searchSlot?: ReactNode;
  /** Renders a kit `SearchField` (search as you type) for this list. */
  searchField?: FilterBarSearchField;
  /** Remember the last filters for this list on this device. A stable per-list id. */
  rememberKey?: string;
  /** Anything trailing the summary line (result count, "show retired", …). */
  extra?: ReactNode;
}) {
  const router = useRouter();
  const active = groups.filter((g) => (g.current ?? "") !== "");
  const [open, setOpen] = useState(false);

  /**
   * Every chip is a real `<Link>`, not a button calling `router.push`.
   *
   * A link cannot fail the way a router call can: the browser navigates whether or not
   * our JavaScript has loaded or hydrated. On a mid-range Android that pre-hydration
   * window is long enough to matter, and it is exactly when an impatient thumb hits a
   * filter. It also prefetches, and it survives being opened in a new tab.
   *
   * (This replaced a `router.push` version that was observed not navigating. The cause
   * was never established, `router.push` behaves correctly everywhere else in this
   * app, including same-route query changes on a segment with a `loading.tsx`, so
   * treat that as unexplained rather than as a known Next.js defect.)
   */
  const hrefWith = (changes: Record<string, string>) => hrefWithParams(path, search, changes);

  const clearAllHref = hrefWith(Object.fromEntries(groups.map((g) => [g.paramName, ""])));

  const labelOf = (g: FilterGroup) =>
    g.options.find((o) => o.value === (g.current ?? ""))?.label ?? g.current ?? "";

  // == Remember / restore ==
  const firstRun = useRef(true);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  useEffect(() => {
    if (!rememberKey) return;
    const gs = groupsRef.current;
    const params = new URLSearchParams(search);
    const present = gs.filter((g) => params.get(g.paramName));

    if (firstRun.current) {
      firstRun.current = false;
      if (present.length === 0) {
        const saved = readStored(rememberKey);
        if (!saved) return;
        const stored = new URLSearchParams(saved);
        const changes: Record<string, string> = {};
        for (const g of gs) {
          const v = stored.get(g.paramName);
          if (v && g.options.some((o) => o.value === v)) changes[g.paramName] = v;
        }
        if (Object.keys(changes).length > 0) {
          router.replace(hrefWithParams(path, search, changes), { scroll: false });
        } else {
          writeStored(rememberKey, null);
        }
        return;
      }
    }

    // After arrival, the URL is the truth: remember what is set, forget when cleared.
    const keepParams = new URLSearchParams();
    for (const g of present) keepParams.set(g.paramName, params.get(g.paramName) ?? "");
    writeStored(rememberKey, keepParams.toString() || null);
  }, [rememberKey, search, path, router]);

  const searchName = searchField?.name ?? "q";
  const searchNode = searchField ? (
    <SearchField
      label={searchField.label}
      clearLabel={searchField.clearLabel}
      placeholder={searchField.placeholder}
      name={searchName}
      action={path}
      defaultValue={new URLSearchParams(search).get(searchName) ?? ""}
      keep={Object.fromEntries(
        Array.from(new URLSearchParams(search).entries()).filter(([k]) => k !== searchName && k !== "page"),
      )}
    />
  ) : (
    searchSlot
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* A full row on a phone, so the box is not squeezed to "Search na…" beside
            the Filters button; side by side once there is room. */}
        {searchNode ? <div className="w-full min-w-0 sm:w-auto sm:min-w-[12rem] sm:flex-1">{searchNode}</div> : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "focus-ring inline-flex min-h-[48px] shrink-0 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors sm:min-h-[44px]",
            active.length > 0
              ? "border-brand-600 bg-brand-tint text-brand-ink"
              : "border-sand-300 bg-surface text-sand-700 hover:bg-sand-50",
          )}
        >
          <FilterIcon className="text-base" />
          {filtersLabel}
          {active.length > 0 ? (
            <span className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-bold tabular-nums text-white">
              {active.length}
            </span>
          ) : null}
          {open ? <ChevronUpIcon className="text-base" /> : <ChevronDownIcon className="text-base" />}
        </button>
      </div>

      {/* What is filtering, in words, each removable on its own, previously you had to
          find the right chip in the right unlabelled row and press it again. */}
      {active.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {active.map((g) => (
            <Link
              key={g.paramName}
              href={hrefWith({ [g.paramName]: "" })}
              className="focus-ring inline-flex min-h-[48px] min-w-0 items-center gap-1.5 rounded-full border border-sand-300 bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-50 sm:min-h-[36px]"
            >
              <span className="text-sand-500">{g.label}:</span>
              <span className="min-w-0 break-words">{labelOf(g)}</span>
              <CloseIcon className="shrink-0 text-base text-sand-400" />
            </Link>
          ))}
          <Link
            href={clearAllHref}
            onClick={() => {
              if (rememberKey) writeStored(rememberKey, null);
            }}
            className="focus-ring inline-flex min-h-[48px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-ink hover:bg-brand-tint sm:min-h-[36px]"
          >
            {clearLabel}
          </Link>
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-3 rounded-xl border border-sand-200 bg-surface p-3">
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
                          : "border-sand-200 bg-surface text-sand-700 hover:border-sand-300 hover:bg-sand-50",
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

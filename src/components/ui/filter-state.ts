/**
 * Server-safe filter helpers and types for `FilterBar`, `SearchField` and `NoMatches`.
 *
 *   const groups: FilterGroup[] = [{ paramName: "status", label, current: sp.status, options }];
 *   const f = filterState("/jobcards", qs, groups, { searchParam: "q" });
 *   ...
 *   <FilteredEmpty filtered={rows.length === 0 && f.active} clearHref={f.clearHref}
 *     title={t("empty.noMatchTitle", locale)} hint={t("empty.noMatchHint", locale)}
 *     clearLabel={t("empty.clearFilters", locale)}>
 *     <GetStarted ... />   // what an unfiltered empty list shows
 *   </FilteredEmpty>
 *
 * No "use client" on purpose: `filter-bar.tsx` is a client module, and a plain function
 * exported from one is a client reference that throws when a Server Component calls it.
 * Pages call these; the client `FilterBar` imports them too.
 */

/** One chip. Empty `value` clears the param. */
export type ChipOption = {
  value: string;
  label: string;
  /** Optional count shown after the label ("In workshop 2"). */
  count?: number;
};

export type FilterGroup = {
  /** URL param this group writes, unchanged from the original form. */
  paramName: string;
  /** Visible group name. The old chip rows had an aria-label and nothing on screen. */
  label: string;
  current: string | undefined;
  options: ChipOption[];
};

type GroupLike = Pick<FilterGroup, "paramName" | "current">;

/** `path?search` with `changes` applied: an empty value deletes the param. */
export function hrefWithParams(path: string, search: string, changes: Record<string, string>): string {
  const params = new URLSearchParams(search);
  for (const [k, v] of Object.entries(changes)) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * True when any group is filtering, or when the free-text search (`searchValue`) is
 * set. This is what decides between NoMatches ("clear the filter") and the first-run
 * or all-clear state: an empty list under a filter is not an empty farm.
 */
export function hasActiveFilters(groups: readonly GroupLike[], searchValue?: string | null): boolean {
  return groups.some((g) => (g.current ?? "") !== "") || !!(searchValue && searchValue.trim());
}

/**
 * Where "Clear filters" goes: the same list with every group's param removed (and the
 * search param, and a pagination param, when named), every other param kept.
 */
export function clearFiltersHref(
  path: string,
  search: string,
  groups: readonly GroupLike[],
  also: readonly string[] = [],
): string {
  const changes: Record<string, string> = {};
  for (const g of groups) changes[g.paramName] = "";
  for (const p of also) changes[p] = "";
  return hrefWithParams(path, search, changes);
}

/**
 * Both answers in one call, for a list page:
 *   `active`   any group or the search is filtering,
 *   `clearHref` the list with all of it removed.
 * `searchParam` (e.g. "q") counts the search box as a filter and clears it too;
 * `pageParam` (e.g. "page") is dropped by Clear so it does not land on page 7 of 1.
 */
export function filterState(
  path: string,
  search: string,
  groups: readonly GroupLike[],
  opts: { searchParam?: string; pageParam?: string } = {},
): { active: boolean; clearHref: string } {
  const params = new URLSearchParams(search);
  const q = opts.searchParam ? params.get(opts.searchParam) : null;
  const also = [opts.searchParam, opts.pageParam].filter((p): p is string => !!p);
  return {
    active: hasActiveFilters(groups, q),
    clearHref: clearFiltersHref(path, search, groups, also),
  };
}

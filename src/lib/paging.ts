/** Rows on one page of a history list. */
export const PAGE_SIZE = 50;

/** The page number in a `?page=` value: a whole number from 1, anything else is page 1. */
export function pageNumber(value: string | undefined): number {
  return Math.min(10000, Math.max(1, Math.floor(Number(value) || 1)));
}

/**
 * The `.range()` of one page, one row longer than the page: the extra row only says whether
 * an older page exists, and is never shown.
 */
export function pageRange(page: number, size = PAGE_SIZE): [number, number] {
  return [(page - 1) * size, page * size];
}

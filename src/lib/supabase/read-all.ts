/**
 * Every row of a read the API would otherwise cut at a thousand.
 *
 * Supabase's API returns at most 1 000 rows per request (Settings, API, max rows) and says
 * nothing when it stops, so a total summed over an uncapped read is silently wrong once a
 * farm has more rows than that: a year of fuel draws, a busy workshop's documents. This
 * reads page after page until a short one, sorted by a unique column so that no row is
 * read twice or skipped between pages.
 *
 * `query` must build a FRESH query on every call: a PostgREST builder runs once per await
 * and its ORDER BY accumulates. The caller's own ordering is kept; the key is appended as
 * the final tie-break. The result has the shape of a single read, so it drops into a
 * `Promise.all` destructure unchanged: on an error `data` is null and the error is
 * returned, exactly as one request would.
 *
 * `src/lib/supabase/read-all.test.ts` fails the build on a new uncapped read of a table
 * that grows with use.
 */

/** Must not exceed the API's max rows, or a full page would look like the last one. */
export const PAGE_ROWS = 1000;

/** A ceiling, so a runaway read cannot pull a whole table into one function. */
export const READ_ALL_MAX_ROWS = 100_000;

type PageResult = PromiseLike<{ data: unknown; error: unknown }>;

export type Pageable = {
  order(column: string, options?: { ascending?: boolean }): Pageable;
  range(from: number, to: number): PageResult;
};

export type ReadAllResult<T> = { data: T[] | null; error: unknown; truncated: boolean };

export async function readAll<T>(
  query: () => Pageable,
  options: { key?: string; maxRows?: number } = {},
): Promise<ReadAllResult<T>> {
  const key = options.key ?? "id";
  const maxRows = Math.max(1, options.maxRows ?? READ_ALL_MAX_ROWS);
  const data: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_ROWS) {
    const to = Math.min(from + PAGE_ROWS, maxRows) - 1;
    const { data: page, error } = await query().order(key, { ascending: true }).range(from, to);
    if (error) return { data: null, error, truncated: false };
    const rows = Array.isArray(page) ? (page as T[]) : [];
    data.push(...rows);
    if (rows.length < to - from + 1) return { data, error: null, truncated: false };
  }
  return { data, error: null, truncated: true };
}

/** Ids per request when filtering on a list: each UUID adds about 40 characters to the URL,
 *  and a long enough list is refused before it reaches the database. */
export const ID_CHUNK = 100;

/**
 * Rows matching a list of ids, at most `ID_CHUNK` ids a request and every page of each.
 * `query(chunk)` must build a fresh query filtered to that chunk. An empty list makes no
 * request at all.
 */
export async function readByIds<T>(
  ids: readonly string[],
  query: (chunk: string[]) => Pageable,
  options: { key?: string } = {},
): Promise<ReadAllResult<T>> {
  const unique = [...new Set(ids)];
  const data: T[] = [];
  let truncated = false;
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const result = await readAll<T>(() => query(chunk), options);
    if (result.error) return { data: null, error: result.error, truncated: false };
    data.push(...(result.data ?? []));
    truncated ||= result.truncated;
  }
  return { data, error: null, truncated };
}

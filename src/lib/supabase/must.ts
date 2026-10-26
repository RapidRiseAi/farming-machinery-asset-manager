import { captureError } from "@/lib/observability";

/**
 * A read that failed is a failure, not an empty table.
 *
 * About 230 reads destructured `{ data }` and dropped `error`, so a dropped connection or a
 * policy refusal rendered as "no machines", "R0 VAT", "nothing overdue": the most
 * reassuring answer, and false. Reports, statements and invoices built that way were
 * downloaded or emailed as the real thing with a 200.
 *
 * `must` throws instead. In a page that is the error screen (and Next's `onRequestError`
 * reports it); in a file route it is a 500, which `DownloadLink` explains rather than
 * saving; in a scheduled run it is a failed run. A paged read that hit its row cap
 * (`readAll`'s `truncated`) is reported but still used: the largest farms get a report,
 * and we hear that it was cut short.
 */
export class ReadFailed extends Error {
  readonly code: string | null;
  constructor(where: string, cause: { message?: string; code?: string }) {
    super(`${where}: read failed (${cause.code ?? "no code"})`);
    this.name = "ReadFailed";
    this.code = cause.code ?? null;
  }
}

type ReadResult<T> = { data: T; error: unknown; truncated?: boolean };

export function must<T>(result: ReadResult<T>, where: string): T {
  if (result.error) throw new ReadFailed(where, result.error as { message?: string; code?: string });
  if (result.truncated) captureError(new Error(`${where}: read cut short at its row cap`), { where });
  return result.data;
}

/** `must` for the results of one `Promise.all`, named `where#index` in the error. */
export function mustAll(results: ReadonlyArray<ReadResult<unknown>>, where: string): void {
  results.forEach((result, index) => must(result, `${where}#${index}`));
}

/**
 * For a read the page can do without (a count in a header, a name beside a title): the
 * failure is reported, and the page goes on without that piece instead of stopping. Use
 * `must` for the page's own data and anything a decision is made from; `soft` only where
 * showing nothing is honest because nothing depends on it.
 */
export function soft<T>(result: ReadResult<T>, where: string): T | null {
  if (result.error) {
    captureError(new ReadFailed(where, result.error as { message?: string; code?: string }), { where });
    return null;
  }
  if (result.truncated) captureError(new Error(`${where}: read cut short at its row cap`), { where });
  return result.data;
}

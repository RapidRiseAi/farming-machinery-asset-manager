import "server-only";

import { captureError } from "@/lib/observability";

/**
 * What a server action puts in `?error=` when a database call fails, and who hears of it.
 *
 * Every action used to redirect with the database's own words, `?error=${error.message}`,
 * 105 times across 34 files, and report nothing: `onRequestError` only sees errors that
 * are thrown, and these were caught. So a failure was invisible to us, and the person saw
 * either the generic apology or, on pages that printed the code, raw Postgres text.
 *
 * Now: a refusal our own SQL raises on purpose (a meter reading that goes backwards, a
 * document number already used) keeps its words for `errorMessage()` to map, as before.
 * Anything else is ours: it is reported with where it happened, and the person is told to
 * try again in their own language, never shown the database's message.
 */
export type DbFailure = { message?: string; code?: string } | null | undefined;

/**
 * Postgres codes our functions and constraints raise to refuse a request: `raise exception`
 * (P0001), invalid parameter (22023), unique (23505) and check (23514) violations.
 */
const REFUSALS = new Set(["P0001", "22023", "23505", "23514"]);

export type Classified = { report: boolean; code: string };

/** Pure: what to show for `error`, and whether it must be reported. */
export function classifyFailure(error: DbFailure | Error, fallback?: string): Classified {
  if (!error) return { report: !fallback, code: fallback ?? "try-again" };
  const failure = error as { message?: string; code?: string; status?: unknown };
  if (typeof failure.code === "string" && REFUSALS.has(failure.code) && failure.message) {
    return { report: false, code: failure.message };
  }
  // Supabase Auth and Storage refuse with an HTTP status: a wrong password, a link that has
  // expired, too many emails. The request's fault, said in their words as before.
  if (typeof failure.status === "number" && failure.status >= 400 && failure.status < 500 && failure.message) {
    return { report: false, code: failure.message };
  }
  if (failure.code === "42501") return { report: true, code: "forbidden" };
  return { report: true, code: "try-again" };
}

/**
 * The `?error=` value for a failed call, URL-encoded, reporting it when it is ours.
 * `fallback` is the code for a missing error object (no row came back), which is an
 * expected refusal and not reported.
 *
 *   redirect(`/fuel?error=${errorCode(error, "fuel:delivery")}`)
 */
export function errorCode(error: DbFailure | Error, where: string, fallback?: string): string {
  const { report, code } = classifyFailure(error, fallback);
  if (report) {
    captureError(error ?? new Error(`${where}: failed with no error`), {
      where,
      extra: { code: (error as { code?: string } | null | undefined)?.code ?? null },
    });
  }
  return encodeURIComponent(code);
}

/**
 * Report `error` when it is ours, for a site that keeps its own slug for the person (a
 * "save-failed" the page already translates). A refusal our SQL raises on purpose is the
 * person's to fix and is not reported; anything else is, with where it happened.
 */
export function reportUnlessRefused(error: DbFailure | Error, where: string): void {
  if (!error || !classifyFailure(error).report) return;
  captureError(error, { where, extra: { code: (error as { code?: string }).code ?? null } });
}

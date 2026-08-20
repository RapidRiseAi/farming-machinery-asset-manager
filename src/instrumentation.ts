/**
 * Next's server-error hook (NFR-6).
 *
 * `onRequestError` fires for every uncaught error thrown while rendering a Server Component,
 * running a server action, or handling a route handler — which is where essentially all of
 * this product's logic lives. Catching it here means no `try/catch` had to be sprinkled
 * through 40 route segments to get coverage.
 *
 * Deliberately server-only: this file is never bundled for the browser, so the shared
 * first-load JS is unchanged at 102 kB. Browser errors are reported separately by the error
 * boundaries, which POST to `/api/observability`.
 */
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { captureError } = await import("@/lib/observability");
  captureError(err, {
    // The PATH, never the query string — a query string in this codebase has carried a
    // login credential before, and an error reporter must not be what leaks the next one.
    where: `${context.routerKind}:${request.path.split("?")[0]}`,
    extra: {
      method: request.method,
      routeType: context.routeType,
      // `revalidate` and friends run with no user; say so rather than implying a session.
      renderSource: context.renderSource ?? "unknown",
    },
  });
};

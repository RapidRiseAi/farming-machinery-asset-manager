"use client";

/**
 * Tell the server about an error the browser hit (NFR-6).
 *
 * Called only from error boundaries, which are already client components and already only
 * load once something has gone wrong — so this adds nothing to the shared first-load bundle.
 *
 * `keepalive` matters: a person whose screen just broke very often closes the tab, and
 * without it the report is cancelled at unload — losing exactly the errors bad enough to
 * make someone leave.
 *
 * Every failure path here is swallowed on purpose. A reporting call that throws would turn
 * one broken screen into two, and the second one would have no boundary left to catch it.
 */
export function reportClientError(error: Error & { digest?: string }, where: string): void {
  try {
    void fetch("/api/observability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        where,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* reporting must never be the thing that breaks */
  }
}
